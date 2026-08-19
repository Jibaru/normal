import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { makeStoredMediaContainer } from "@whatsapp-mcp/api/encryption/stored-media-container";
import { oauthClientCacheRecordFor } from "@whatsapp-mcp/api/oauth-client-cache";
import {
  decodeQuarterlyRecoveryChecks,
  decodeQuarterlyRecoveryExecutionReceipt,
  decodeQuarterlyRecoveryExecutionRequest,
  decodeQuarterlyRecoveryVerificationRequest,
  type QuarterlyRecoveryExecutionRequest,
} from "@whatsapp-mcp/contracts/recovery";
import { Effect } from "effect";
import { required, safeHttpsUrl } from "./config";

const prefix = "production-recovery/game-day/";
const retainedOAuthKey = "production-recovery/retained/oauth-kv-v1.json";
const encoder = new TextEncoder();

export interface RecoveryGameDayEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly AWS_KMS_REGION: string;
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly KMS_RECOVERY_GAME_DAY_KEY_ARN: string;
  readonly RECOVERY_KV: RecoveryKvNamespace;
  readonly PAGER_RECEIPT_TOKEN: string;
  readonly PAGER_RECEIPT_URL: string;
  readonly PAGER_WEBHOOK_TOKEN: string;
  readonly PAGER_WEBHOOK_URL: string;
  readonly QUARTERLY_RECEIPT_SECRET: string;
  readonly RECOVERY_FIXTURES: RecoveryBucket;
  readonly RECOVERY_REPLAY_QUEUE: RecoveryQueue;
}

export interface RecoveryKvNamespace {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (
    key: string,
    type?: "json",
  ) => Promise<string | Record<string, unknown> | null>;
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number },
  ) => Promise<void>;
}

export interface RecoveryBucket {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (
    key: string,
  ) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (
    key: string,
    value: string,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
    },
  ) => Promise<unknown | null>;
}

export interface RecoveryQueue {
  readonly send: (body: unknown) => Promise<void>;
}

export interface RecoveryMessage {
  readonly body: unknown;
  readonly ack: () => void;
}

export interface RecoveryMessageBatch {
  readonly messages: ReadonlyArray<RecoveryMessage>;
}

type Env = RecoveryGameDayEnvironment;

interface ExecutionState {
  readonly version: 1;
  readonly operation: string;
  readonly receipt: string;
  readonly alertObservedAt: string;
  readonly oauthKvReconstructed: true;
  readonly kmsAccess: true;
  readonly mediaLossFailedClosed: boolean;
  readonly queueComplete: boolean;
  readonly r2Access: true;
}

interface ReplayMessage {
  readonly version: 1;
  readonly operation: string;
  readonly receipt: string;
}

interface RetainedOAuthFixture {
  readonly version: 1;
  readonly purpose: "oauth-kv-reconstruction";
  readonly capturedAt: string;
  readonly expirationTtl: 7_776_000;
  readonly key: string;
  readonly record: {
    readonly clientId: string;
    readonly clientName: string;
    readonly grantTypes: readonly ["authorization_code", "refresh_token"];
    readonly redirectUris: ReadonlyArray<string>;
    readonly responseTypes: readonly ["code"];
    readonly tokenEndpointAuthMethod: "none";
  };
}

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const toBase64 = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const digest = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const stateKey = async (operation: string) =>
  `${prefix}state/${await digest(operation)}`;
const objectKey = async (operation: string) =>
  `${prefix}object/${await digest(operation)}`;

const readRetainedOAuthFixture = async (
  env: Env,
): Promise<RetainedOAuthFixture> => {
  const source = await env.RECOVERY_FIXTURES.get(retainedOAuthKey);
  if (!source)
    throw new Error("Retained OAuth reconstruction fixture is unavailable");
  const serialized = await source.text();
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    throw new Error("Retained OAuth reconstruction fixture is invalid");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 6
  )
    throw new Error("Retained OAuth reconstruction fixture is invalid");
  const fixture = candidate as Partial<RetainedOAuthFixture>;
  const capturedAt = Date.parse(fixture.capturedAt ?? "");
  const age = Date.now() - capturedAt;
  if (
    fixture.version !== 1 ||
    fixture.purpose !== "oauth-kv-reconstruction" ||
    fixture.expirationTtl !== 7_776_000 ||
    typeof fixture.key !== "string" ||
    !fixture.key.startsWith("client:https://chatgpt.com/oauth/") ||
    typeof fixture.record !== "object" ||
    fixture.record === null ||
    Object.keys(fixture.record).length !== 6 ||
    fixture.record.clientId !== fixture.key.slice("client:".length) ||
    fixture.record.clientName !== "ChatGPT" ||
    fixture.record.tokenEndpointAuthMethod !== "none" ||
    JSON.stringify(fixture.record.grantTypes) !==
      JSON.stringify(["authorization_code", "refresh_token"]) ||
    JSON.stringify(fixture.record.responseTypes) !== JSON.stringify(["code"]) ||
    !Array.isArray(fixture.record.redirectUris) ||
    fixture.record.redirectUris.length !== 1 ||
    typeof fixture.record.redirectUris[0] !== "string" ||
    !fixture.record.redirectUris[0].startsWith(
      "https://chatgpt.com/connector/oauth/",
    ) ||
    !Number.isFinite(capturedAt) ||
    new Date(capturedAt).toISOString() !== fixture.capturedAt ||
    age < 3_600_000 ||
    age > 14 * 86_400_000
  )
    throw new Error("Retained OAuth reconstruction fixture is invalid");
  return fixture as RetainedOAuthFixture;
};

export const prepareRetainedRecoveryFixtures = async (
  env: Env,
  capturedAt = new Date().toISOString(),
) => {
  if (env.DEPLOYMENT_ENVIRONMENT !== "production") return;
  await env.RECOVERY_FIXTURES.put(
    retainedOAuthKey,
    JSON.stringify({
      version: 1,
      purpose: "oauth-kv-reconstruction",
      capturedAt,
      expirationTtl: 7_776_000,
      key: "client:https://chatgpt.com/oauth/recovery-game-day/client.json",
      record: oauthClientCacheRecordFor({
        clientId: "https://chatgpt.com/oauth/recovery-game-day/client.json",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/connector/oauth/recovery-game-day"],
      }),
    } satisfies RetainedOAuthFixture),
  );
};

const receiptFor = async (
  env: Env,
  input: QuarterlyRecoveryExecutionRequest,
) => {
  const secret = required(
    env.QUARTERLY_RECEIPT_SECRET,
    "Quarterly receipt secret",
  );
  if (!/^[a-f0-9]{64}$/u.test(secret))
    throw new Error("Quarterly receipt secret is invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../gu) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = JSON.stringify([
    input.version,
    input.operation,
    input.recoveryBranchId,
    input.verificationNonce,
    input.replayDigest,
  ]);
  return `quarterly_receipt_${toHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  )}`;
};

const kms = (env: Env) =>
  new KMSClient({
    credentials: {
      accessKeyId: required(env.AWS_ACCESS_KEY_ID, "AWS access key"),
      secretAccessKey: required(env.AWS_SECRET_ACCESS_KEY, "AWS secret key"),
      sessionToken: required(env.AWS_SESSION_TOKEN, "AWS session token"),
    },
    region:
      required(env.AWS_KMS_REGION, "AWS KMS region") === "us-east-1"
        ? "us-east-1"
        : "invalid",
  });

const encryptionContext = (env: Env, operation: string) => ({
  environment: required(env.DEPLOYMENT_ENVIRONMENT, "Deployment environment"),
  purpose: "recovery-game-day",
  operation,
});

const readState = async (
  env: Env,
  operation: string,
): Promise<ExecutionState> => {
  const candidate = await env.RECOVERY_KV.get(
    await stateKey(operation),
    "json",
  );
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    throw new Error("Quarterly execution state is unavailable");
  const state = candidate as Partial<ExecutionState>;
  if (
    state.version !== 1 ||
    state.operation !== operation ||
    typeof state.receipt !== "string" ||
    typeof state.alertObservedAt !== "string" ||
    state.oauthKvReconstructed !== true ||
    state.kmsAccess !== true ||
    typeof state.mediaLossFailedClosed !== "boolean" ||
    typeof state.queueComplete !== "boolean" ||
    state.r2Access !== true ||
    Object.keys(candidate).length !== 9
  )
    throw new Error("Quarterly execution state is invalid");
  return state as ExecutionState;
};

export const executeGameDay = async (env: Env, candidate: unknown) => {
  if (env.DEPLOYMENT_ENVIRONMENT !== "production")
    throw new Error("Production game day is unavailable outside production");
  const input = decodeQuarterlyRecoveryExecutionRequest(candidate);
  const receipt = await receiptFor(env, input);
  const existingCandidate = await env.RECOVERY_KV.get(
    await stateKey(input.operation),
  );
  if (existingCandidate !== null) {
    const existing = await readState(env, input.operation);
    if (existing.receipt !== receipt)
      throw new Error("Quarterly execution identity changed");
    if (!existing.queueComplete)
      await env.RECOVERY_REPLAY_QUEUE.send({
        version: 1,
        operation: input.operation,
        receipt,
      } satisfies ReplayMessage);
    return decodeQuarterlyRecoveryExecutionReceipt({
      version: 1,
      operation: input.operation,
      receipt,
    });
  }

  const reconstructionSource = await readRetainedOAuthFixture(env);
  const oauth = reconstructionSource.key;
  const object = await objectKey(input.operation);
  await env.RECOVERY_KV.delete(oauth);
  const reconstructedRecord = JSON.stringify(reconstructionSource.record);
  await env.RECOVERY_KV.put(oauth, reconstructedRecord, {
    expirationTtl: reconstructionSource.expirationTtl,
  });
  if ((await env.RECOVERY_KV.get(oauth)) !== reconstructedRecord)
    throw new Error("OAuth KV reconstruction failed");

  const generated = await kms(env).send(
    new GenerateDataKeyCommand({
      EncryptionContext: encryptionContext(env, input.operation),
      KeyId: required(env.KMS_RECOVERY_GAME_DAY_KEY_ARN, "Recovery KMS key"),
      KeySpec: "AES_256",
    }),
  );
  if (!generated.Plaintext || !generated.CiphertextBlob)
    throw new Error("Recovery KMS key generation failed");
  try {
    await env.RECOVERY_FIXTURES.put(
      `${object}/kms`,
      JSON.stringify({ wrappedKey: toBase64(generated.CiphertextBlob) }),
    );
  } finally {
    generated.Plaintext.fill(0);
  }

  const alertObservedAt = new Date().toISOString();
  const alert = await fetch(
    safeHttpsUrl(env.PAGER_WEBHOOK_URL, "Pager webhook URL"),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${required(
          env.PAGER_WEBHOOK_TOKEN,
          "Pager webhook token",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        alert: "recovery-game-day",
        severity: "ticket",
        status: "firing",
        observedAt: alertObservedAt,
      }),
    },
  );
  if (!alert.ok) throw new Error("Recovery alert was rejected");

  const state: ExecutionState = {
    version: 1,
    operation: input.operation,
    receipt,
    alertObservedAt,
    oauthKvReconstructed: true,
    kmsAccess: true,
    mediaLossFailedClosed: false,
    queueComplete: false,
    r2Access: true,
  };
  const replayFixture = JSON.stringify({
    version: 1,
    operation: input.operation,
    receipt,
  } satisfies ReplayMessage);
  const created = await env.RECOVERY_FIXTURES.put(
    `${object}/queue`,
    replayFixture,
    { onlyIf: { etagDoesNotMatch: "*" } },
  );
  if (
    created === null ||
    (await env.RECOVERY_FIXTURES.get(`${object}/queue`)) === null
  )
    throw new Error("Recovery replay fixture is unavailable");
  await env.RECOVERY_FIXTURES.put(`${object}/media-object`, "fixture");
  await env.RECOVERY_KV.put(
    await stateKey(input.operation),
    JSON.stringify(state),
    {
      expirationTtl: 3_600,
    },
  );
  await env.RECOVERY_REPLAY_QUEUE.send({
    version: 1,
    operation: input.operation,
    receipt,
  } satisfies ReplayMessage);
  return decodeQuarterlyRecoveryExecutionReceipt({
    version: 1,
    operation: input.operation,
    receipt,
  });
};

export const verifyGameDay = async (env: Env, candidate: unknown) => {
  const input = decodeQuarterlyRecoveryVerificationRequest(candidate);
  const expectedReceipt = await receiptFor(env, input);
  if (input.receipt !== expectedReceipt)
    throw new Error("Quarterly execution receipt is invalid");
  let state: ExecutionState | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    state = await readState(env, input.operation);
    if (state.receipt !== expectedReceipt)
      throw new Error("Quarterly execution state does not match");
    if (state.queueComplete) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!state?.queueComplete)
    throw new Error("Quarterly replay did not complete");

  const receiptUrl = safeHttpsUrl(env.PAGER_RECEIPT_URL, "Pager receipt URL");
  let alertDelivered = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(receiptUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${required(
          env.PAGER_RECEIPT_TOKEN,
          "Pager receipt token",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        alert: "recovery-game-day",
        observed_at: state.alertObservedAt,
      }),
    });
    const receiptBody = response.ok ? await response.json() : null;
    if (
      typeof receiptBody !== "object" ||
      receiptBody === null ||
      Array.isArray(receiptBody) ||
      Object.keys(receiptBody).length !== 2 ||
      typeof (receiptBody as { delivered?: unknown }).delivered !== "boolean" ||
      (receiptBody as { observed_at?: unknown }).observed_at !==
        state.alertObservedAt
    )
      throw new Error("Pager delivery was not confirmed");
    if ((receiptBody as { delivered: boolean }).delivered) {
      alertDelivered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!alertDelivered) throw new Error("Pager delivery was not confirmed");

  return decodeQuarterlyRecoveryChecks({
    oauth_kv_reconstructed: state.oauthKvReconstructed,
    immutable_queue_replay: state.queueComplete,
    kms_access: state.kmsAccess,
    r2_access: state.r2Access,
    media_loss_failed_closed: state.mediaLossFailedClosed,
    alert_delivered: true,
  });
};

export const verifyStoredMediaLossFailsClosed = async (
  env: Env,
  object: string,
) => {
  const mediaObject = `${object}/media-object`;
  await env.RECOVERY_FIXTURES.delete(mediaObject);
  const events: Array<{
    readonly operation: string;
    readonly outcome: string;
  }> = [];
  const container = makeStoredMediaContainer({
    bucket: env.RECOVERY_FIXTURES as unknown as R2Bucket,
    encryption: {} as never,
    environment: "production",
    telemetry: (event) => events.push(event),
  });
  const personalAccountId = "recovery-game-day-account";
  const connectionId = "recovery-game-day-connection";
  const result = await Effect.runPromise(
    Effect.either(
      container.read({
        accountKey: {
          ciphertext: "unused",
          keyVersion: 1,
          kmsKeyId: "unused",
          personalAccountId,
          version: 1,
        },
        connectionKey: {
          accountKeyVersion: 1,
          ciphertext: "unused",
          connectionId,
          keyVersion: 1,
          nonce: "unused",
          personalAccountId,
          version: 1,
        },
        context: {
          connectionId,
          mediaObjectId: "recovery-game-day-media",
          personalAccountId,
        },
        objectKey: mediaObject,
      }),
    ),
  );
  if (
    result._tag !== "Left" ||
    result.left.operation !== "read" ||
    result.left.reason !== "not-found" ||
    events.length !== 1 ||
    events[0]?.operation !== "read" ||
    events[0]?.outcome !== "not-found"
  )
    throw new Error("Stored Media loss did not fail closed");
};

export const handleGameDayReplay = async (
  env: Env,
  message: RecoveryMessage,
) => {
  const body = message.body as Partial<ReplayMessage>;
  if (
    body.version !== 1 ||
    typeof body.operation !== "string" ||
    typeof body.receipt !== "string"
  )
    throw new Error("Recovery replay message is invalid");
  const state = await readState(env, body.operation);
  if (state.receipt !== body.receipt)
    throw new Error("Recovery replay receipt does not match");
  if (state.queueComplete) {
    message.ack();
    return;
  }
  const object = await objectKey(body.operation);
  const replayFixture = await env.RECOVERY_FIXTURES.get(`${object}/queue`);
  if (!replayFixture || (await replayFixture.text()) !== JSON.stringify(body))
    throw new Error("Recovery replay fixture does not match");
  const stored = await env.RECOVERY_FIXTURES.get(`${object}/kms`);
  if (!stored) throw new Error("Recovery KMS fixture is unavailable");
  const candidate = JSON.parse(await stored.text()) as { wrappedKey?: unknown };
  if (typeof candidate.wrappedKey !== "string")
    throw new Error("Recovery KMS fixture is invalid");
  const decrypted = await kms(env).send(
    new DecryptCommand({
      CiphertextBlob: fromBase64(candidate.wrappedKey),
      EncryptionContext: encryptionContext(env, body.operation),
      KeyId: required(env.KMS_RECOVERY_GAME_DAY_KEY_ARN, "Recovery KMS key"),
    }),
  );
  if (!decrypted.Plaintext) throw new Error("Recovery KMS decrypt failed");
  decrypted.Plaintext.fill(0);
  await verifyStoredMediaLossFailsClosed(env, object);
  await env.RECOVERY_KV.put(
    await stateKey(body.operation),
    JSON.stringify({
      ...state,
      mediaLossFailedClosed: true,
      queueComplete: true,
    }),
    { expirationTtl: 3_600 },
  );
  await env.RECOVERY_FIXTURES.delete(`${object}/kms`);
  await env.RECOVERY_FIXTURES.delete(`${object}/queue`);
  message.ack();
};

const readServiceRequest = async (request: Request) => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 2_048) throw new Error("Game-day request is too large");
  const body = await request.text();
  if (body.length > 2_048) throw new Error("Game-day request is too large");
  return JSON.parse(body) as unknown;
};

export default class RecoveryGameDay extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/json"
      )
        return Response.json({ status: "failed" }, { status: 404 });
      const candidate = await readServiceRequest(request);
      if (url.pathname === "/execute")
        return Response.json(await executeGameDay(this.env, candidate));
      if (url.pathname === "/verify")
        return Response.json(await verifyGameDay(this.env, candidate));
      return Response.json({ status: "failed" }, { status: 404 });
    } catch {
      return Response.json({ status: "failed" }, { status: 503 });
    }
  }

  execute(candidate: unknown) {
    return executeGameDay(this.env, candidate);
  }

  verify(candidate: unknown) {
    return verifyGameDay(this.env, candidate);
  }

  async queue(batch: RecoveryMessageBatch) {
    for (const message of batch.messages)
      await handleGameDayReplay(this.env, message);
  }

  async scheduled() {
    await prepareRetainedRecoveryFixtures(this.env);
  }
}
