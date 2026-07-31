import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  createWhatsAppConnectionHandler,
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
  WhatsAppConnectionPersistence,
  type WhatsAppConnectionPersistenceService,
  WhatsAppConnectionProvider,
  type WhatsAppConnectionProviderService,
} from "../src/whatsapp-connection";

const browserOrigin = "https://app.example.test";
const setupId = "cst_000000000000000000041";
const qrEndpoint = `https://api.example.test/v1/connection-setups/${setupId}/qr`;
const listEndpoint = "https://api.example.test/v1/whatsapp-connections";
const accountKey = {
  ciphertext: "AQID",
  keyVersion: 1,
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
  personalAccountId: "10000000-0000-4000-8000-000000000041",
  version: 1 as const,
};
const setupKey = {
  accountKeyVersion: 1,
  ciphertext: "BAUG",
  connectionId: setupId,
  keyVersion: 1,
  nonce: "BwgJCgsMDQ4PEA==",
  personalAccountId: accountKey.personalAccountId,
  version: 1 as const,
};
const versionedCiphertext = {
  ciphertext: "ERIT",
  keyVersion: 1,
  nonce: "FBUWFxgZGhscHQ==",
  version: 1 as const,
};
const lifecycleSession = {
  authority: "session-authority-must-not-leak",
  connectionState: "connecting" as const,
  session: "wsl_0000000000000000000000000000000000000000041",
};
const qrBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>',
);

const makeHarness = (
  options: {
    readonly identityValid?: boolean;
    readonly initialSetupState?:
      | "activated"
      | "pending"
      | "provisioned"
      | "provisioning_failed"
      | "provisioning_quarantined";
  } = {},
) => {
  const events: SafeTelemetryEvent[] = [];
  const providerCalls: string[] = [];
  const encryptedPurposes: string[] = [];
  const connections: Array<{
    readonly displayName: null;
    readonly numberSuffix: string;
    readonly publicId: string;
    readonly state: "connected";
    readonly stateChangedAt: string;
  }> = [];
  let providerConnected = false;
  let setupState = options.initialSetupState ?? "provisioned";

  const persistence: WhatsAppConnectionPersistenceService = {
    activate: (input) =>
      Effect.sync(() => {
        const existing = connections[0];
        if (existing !== undefined) return existing;
        const connection = {
          displayName: null,
          numberSuffix: input.numberSuffix,
          publicId: input.publicId,
          state: "connected" as const,
          stateChangedAt: input.connectedAt,
        };
        connections.push(connection);
        setupState = "activated";
        return connection;
      }),
    list: () => Effect.succeed(connections),
    loadSetup: ({ clerkUserId }) =>
      Effect.succeed(
        clerkUserId !== "user_connectionowner"
          ? null
          : setupState === "activated"
            ? {
                connection: connections[0] ?? {
                  displayName: null,
                  numberSuffix: "3456",
                  publicId: "con_000000000000000000041",
                  state: "connected" as const,
                  stateChangedAt: "2026-07-31T12:04:00.000Z",
                },
                outcome: "activated" as const,
              }
            : setupState === "provisioned"
              ? {
                  outcome: "provisioned" as const,
                  setup: {
                    accountKey,
                    numberCiphertext: versionedCiphertext,
                    personalAccountId: accountKey.personalAccountId,
                    setupId,
                    setupKey,
                    webhookIngressId: "30000000-0000-4000-8000-000000000041",
                  },
                }
              : { outcome: setupState },
      ),
  };

  const provider: WhatsAppConnectionProviderService = {
    connect: () =>
      Effect.sync(() => {
        providerCalls.push("connectSession");
        return {
          ok: true as const,
          value: lifecycleSession,
        };
      }),
    getQrCode: () =>
      Effect.sync(() => {
        providerCalls.push("getQrCode");
        return {
          ok: true as const,
          value: {
            expiresAt: null,
            image: qrBytes,
            state: "available" as const,
          },
        };
      }),
    reconcile: () =>
      Effect.sync(() => {
        providerCalls.push("reconcileSession");
        return {
          ok: true as const,
          value: {
            outcome: "present" as const,
            session: {
              ...lifecycleSession,
              connectionState: providerConnected
                ? ("connected" as const)
                : ("disconnected" as const),
            },
          },
        };
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () =>
        options.identityValid === false
          ? Effect.fail(new InvalidHumanIdentity())
          : Effect.succeed("user_connectionowner"),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(WhatsAppConnectionPersistence, persistence),
    Layer.succeed(WhatsAppConnectionProvider, provider),
    Layer.succeed(WhatsAppConnectionClock, {
      now: Effect.succeed("2026-07-31T12:04:00.000Z"),
    }),
    Layer.succeed(WhatsAppConnectionIdentifiers, {
      nextConnectionId: Effect.succeed("20000000-0000-4000-8000-000000000041"),
      nextPublicId: Effect.succeed("con_000000000000000000041"),
      nextWebhookIdentityKey: Effect.succeed(new Uint8Array(32).fill(41)),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: ({ accountId, connectionId, keyVersion }) =>
        Effect.succeed({
          accountKeyVersion: 1,
          ciphertext: "ISIj",
          connectionId,
          keyVersion,
          nonce: "JCUmJygpKissLQ==",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "whatsapp-number"
          ? Effect.succeed(new TextEncoder().encode("+15550123456"))
          : Effect.die("unexpected decryption"),
      encrypt: ({ context }) =>
        Effect.sync(() => {
          encryptedPurposes.push(context.fieldOrObjectPurpose);
          return {
            ciphertext: "Li8w",
            keyVersion: 1,
            nonce: "MTIzNDU2Nzg5Og==",
            version: 1 as const,
          };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );

  return {
    connections,
    encryptedPurposes,
    events,
    handler: createWhatsAppConnectionHandler(layer, browserOrigin),
    providerCalls,
    scanQr: () => {
      providerConnected = true;
    },
  };
};

const request = (url: string, method = "GET") =>
  new Request(url, {
    headers: {
      authorization: "Bearer signed-clerk-token",
      origin: browserOrigin,
    },
    method,
  });

describe("WhatsApp Connection HTTP boundary", () => {
  test("streams current QR bytes without retaining or emitting them", async () => {
    const harness = makeHarness();

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(qrBytes);
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "connectSession",
      "getQrCode",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("<svg");
    expect(JSON.stringify(harness.events)).not.toContain("cst_");
    expect(harness.connections).toEqual([]);
  });

  test("activates once from trusted connected state and lists only safe fields", async () => {
    const harness = makeHarness();
    harness.scanQr();

    const observed = await harness.handler(request(qrEndpoint));
    const replay = await harness.handler(request(qrEndpoint));
    const listed = await harness.handler(request(listEndpoint));

    expect(observed.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(harness.connections).toHaveLength(1);
    expect(harness.providerCalls).toEqual(["reconcileSession"]);
    expect(harness.encryptedPurposes).toEqual([
      "provider-session-locator",
      "provider-session-authority",
      "webhook-identity-key",
    ]);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual({
      whatsapp_connections: [
        {
          display_name: null,
          id: "con_000000000000000000041",
          number_suffix: "3456",
          state: "connected",
          state_changed_at: "2026-07-31T12:04:00.000Z",
        },
      ],
    });
    expect(listedText).not.toContain("session-authority");
  });

  test("reports pending provisioning without invoking provider-control", async () => {
    const harness = makeHarness({ initialSetupState: "pending" });

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(202);
    expect(response.headers.get("x-connection-setup-state")).toBe("pending");
    expect(harness.providerCalls).toEqual([]);
  });

  test("fails closed for another User, invalid Origin, and invalid setup handle", async () => {
    const invalidIdentity = makeHarness({ identityValid: false });
    const owner = makeHarness();

    const responses = await Promise.all([
      invalidIdentity.handler(request(qrEndpoint)),
      owner.handler(
        new Request(qrEndpoint, {
          headers: {
            authorization: "Bearer signed-clerk-token",
            origin: "https://attacker.example.test",
          },
        }),
      ),
      owner.handler(
        request("https://api.example.test/v1/connection-setups/not-a-setup/qr"),
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
    expect(invalidIdentity.providerCalls).toEqual([]);
    expect(owner.providerCalls).toEqual([]);
  });
});
