import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { checkRestrictedDatabaseAccess } from "@whatsapp-mcp/db/connectivity";
import type {
  DeploymentSmokeOptions,
  DeploymentSmokeState,
} from "./deployment-smoke";
import type { ApiEnvironment } from "./production";

const prefix = "deployment-smoke/";
const stateKey = (id: string) => `${prefix}state/${id}`;
const objectKey = (id: string) => `${prefix}object/${id}`;
const encoder = new TextEncoder();

interface SmokeMessage {
  readonly canaryId: string;
  readonly type: "deployment-smoke";
}

const isSmokeMessage = (value: unknown): value is SmokeMessage =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>).type === "deployment-smoke" &&
  typeof (value as Record<string, unknown>).canaryId === "string" &&
  /^smk_[A-Za-z0-9_-]{43}$/u.test(
    (value as Record<string, unknown>).canaryId as string,
  );

const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const unbase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const kms = (environment: ApiEnvironment) =>
  new KMSClient({
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? "",
      ...(environment.AWS_SESSION_TOKEN === undefined
        ? {}
        : { sessionToken: environment.AWS_SESSION_TOKEN }),
    },
    region: environment.AWS_KMS_REGION ?? "us-east-1",
  });

const context = (environment: ApiEnvironment, canaryId: string) => ({
  environment: environment.DEPLOYMENT_ENVIRONMENT ?? "invalid",
  purpose: "deployment-smoke",
  canaryId,
});

export const makeProductionDeploymentSmoke = (
  environment: ApiEnvironment,
): DeploymentSmokeOptions => ({
  secret: environment.SMOKE_CHECK_SECRET ?? "",
  start: async () => {
    await checkRestrictedDatabaseAccess(
      environment.HYPERDRIVE?.connectionString ?? "",
    );
    const provider = await (
      environment.PROVIDER_CONTROL as ProviderControlService
    ).listSessions({
      setupMarker: `smoke_${crypto.randomUUID().replaceAll("-", "")}`,
    });
    if (!provider.ok) throw new Error("provider-control unavailable");
    const canaryId = `smk_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;
    const generated = await kms(environment).send(
      new GenerateDataKeyCommand({
        EncryptionContext: context(environment, canaryId),
        KeyId: environment.KMS_CONTENT_ROOT_KEY_ARN,
        KeySpec: "AES_256",
      }),
    );
    if (!generated.Plaintext || !generated.CiphertextBlob)
      throw new Error("KMS unavailable");
    const key = await crypto.subtle.importKey(
      "raw",
      generated.Plaintext,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(canaryId) },
        key,
        encoder.encode(canaryId),
      ),
    );
    generated.Plaintext.fill(0);
    try {
      await (environment.STORED_MEDIA as R2Bucket).put(
        objectKey(canaryId),
        JSON.stringify({
          ciphertext: base64(ciphertext),
          iv: base64(iv),
          wrapped_key: base64(generated.CiphertextBlob),
        }),
      );
      await (environment.OAUTH_KV as KVNamespace).put(
        stateKey(canaryId),
        "pending",
        { expirationTtl: 300 },
      );
      await (environment.INGESTION_QUEUE as Queue).send({
        canaryId,
        type: "deployment-smoke",
      });
    } catch (error) {
      await (environment.STORED_MEDIA as R2Bucket).delete(objectKey(canaryId));
      await (environment.OAUTH_KV as KVNamespace).delete(stateKey(canaryId));
      throw error;
    }
    return canaryId;
  },
  complete: async (canaryId): Promise<DeploymentSmokeState> => {
    const state = await (environment.OAUTH_KV as KVNamespace).get(
      stateKey(canaryId),
    );
    return state === "complete"
      ? {
          status: "complete",
          subsystems: ["database", "provider-control", "queue", "r2-kms"],
        }
      : state === "failed:r2-kms"
        ? { status: "failed", subsystems: ["r2-kms"] }
        : { status: "pending", subsystems: [] };
  },
});

export const handleDeploymentSmokeMessages = async (
  batch: MessageBatch,
  environment: ApiEnvironment,
): Promise<boolean> => {
  const messages = batch.messages.filter((message) =>
    isSmokeMessage(message.body),
  );
  if (messages.length === 0) return false;
  for (const message of messages) {
    const { canaryId } = message.body as SmokeMessage;
    try {
      const object = await (environment.STORED_MEDIA as R2Bucket).get(
        objectKey(canaryId),
      );
      if (!object) throw new Error("canary object unavailable");
      const value = JSON.parse(await object.text()) as {
        ciphertext: string;
        iv: string;
        wrapped_key: string;
      };
      const decrypted = await kms(environment).send(
        new DecryptCommand({
          CiphertextBlob: unbase64(value.wrapped_key),
          EncryptionContext: context(environment, canaryId),
          KeyId: environment.KMS_CONTENT_ROOT_KEY_ARN,
        }),
      );
      if (!decrypted.Plaintext) throw new Error("KMS unavailable");
      const key = await crypto.subtle.importKey(
        "raw",
        decrypted.Plaintext,
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unbase64(value.iv),
          additionalData: encoder.encode(canaryId),
        },
        key,
        unbase64(value.ciphertext),
      );
      decrypted.Plaintext.fill(0);
      if (new TextDecoder().decode(plaintext) !== canaryId)
        throw new Error("canary mismatch");
      await (environment.STORED_MEDIA as R2Bucket).delete(objectKey(canaryId));
      await (environment.OAUTH_KV as KVNamespace).put(
        stateKey(canaryId),
        "complete",
        { expirationTtl: 300 },
      );
      message.ack();
    } catch {
      await (environment.STORED_MEDIA as R2Bucket).delete(objectKey(canaryId));
      await (environment.OAUTH_KV as KVNamespace).put(
        stateKey(canaryId),
        "failed:r2-kms",
        { expirationTtl: 300 },
      );
      message.ack();
    }
  }
  return true;
};
