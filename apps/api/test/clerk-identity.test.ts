import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  type ClerkTokenClaims,
  InvalidHumanIdentity,
  makeClerkHumanIdentity,
} from "../src/auth/clerk";

const now = 1_800_000_000;
const configuration = {
  audience: "https://api.example.test",
  authorizedParty: "https://app.example.test",
  issuer: "https://clerk.example.test",
  jwtKey:
    "-----BEGIN PUBLIC KEY-----\nproduction-public-key\n-----END PUBLIC KEY-----",
};
const validClaims = (): ClerkTokenClaims => ({
  aud: configuration.audience,
  azp: configuration.authorizedParty,
  exp: now + 60,
  fva: [0, -1],
  iat: now,
  iss: configuration.issuer,
  nbf: now - 5,
  sub: "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb",
});
const request = (
  overrides: {
    readonly authorization?: string | undefined;
    readonly origin?: string | undefined;
  } = {},
) =>
  new Request("https://api.example.test/v1/personal-account/bootstrap", {
    headers: {
      authorization: overrides.authorization ?? "Bearer signed.clerk.token",
      origin: overrides.origin ?? configuration.authorizedParty,
    },
    method: "POST",
  });

const verify = async (
  claims: ClerkTokenClaims,
  overrides: Parameters<typeof request>[0] = {},
) => {
  const verificationCalls: Array<{
    readonly options: unknown;
    readonly token: string;
  }> = [];
  const identity = makeClerkHumanIdentity({
    ...configuration,
    now: () => now,
    verifyToken: async (token, options) => {
      verificationCalls.push({ options, token });
      return claims;
    },
  });
  const result = await Effect.runPromise(
    Effect.either(identity.verify(request(overrides))),
  );
  return { result, verificationCalls };
};

describe("Clerk human identity", () => {
  test("verifies the exact audience and authorized party before returning a safe User identity", async () => {
    const { result, verificationCalls } = await verify(validClaims());

    expect(result).toMatchObject({
      _tag: "Right",
      right: "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb",
    });
    expect(verificationCalls).toEqual([
      {
        options: {
          audience: configuration.audience,
          authorizedParties: [configuration.authorizedParty],
          clockSkewInMs: 5_000,
          jwtKey: configuration.jwtKey,
        },
        token: "signed.clerk.token",
      },
    ]);
  });

  test("requires a first-factor reverification less than five minutes old for consent", async () => {
    const identity = makeClerkHumanIdentity({
      ...configuration,
      now: () => now,
      verifyToken: async () => validClaims(),
    });

    await expect(
      Effect.runPromise(identity.verifyRecently(request())),
    ).resolves.toEqual({
      clerkUserId: "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb",
      reverifiedAt: new Date(now * 1_000),
    });
  });

  test.each([
    ["missing verification age", { fva: undefined }],
    ["five-minute-old verification", { fva: [5, -1] }],
    ["malformed verification age", { fva: ["0", -1] }],
  ] as const)("rejects %s for consent", async (_name, replacement) => {
    const identity = makeClerkHumanIdentity({
      ...configuration,
      now: () => now,
      verifyToken: async () => ({ ...validClaims(), ...replacement }),
    });

    await expect(
      Effect.runPromise(Effect.either(identity.verifyRecently(request()))),
    ).resolves.toMatchObject({
      _tag: "Left",
      left: { _tag: "RecentHumanVerificationRequired" },
    });
  });

  test.each([
    ["issuer", { iss: "https://other-clerk.example.test" }],
    ["audience", { aud: "https://other-api.example.test" }],
    ["authorized party", { azp: "https://other-app.example.test" }],
    ["expired token", { exp: now }],
    ["future token", { iat: now + 6 }],
    ["not-before after issuance", { nbf: now + 1 }],
    ["long-lived token", { exp: now + 301 }],
    ["pending identity", { sts: "pending" }],
    ["unsafe User identity", { sub: "organization_123" }],
  ] as const)("rejects an invalid %s claim", async (_name, replacement) => {
    const { result } = await verify({ ...validClaims(), ...replacement });

    expect(result).toMatchObject({
      _tag: "Left",
      left: new InvalidHumanIdentity(),
    });
  });

  test.each([
    ["missing Origin", { origin: "" }],
    ["wrong Origin", { origin: "https://other-app.example.test" }],
    ["missing bearer token", { authorization: "" }],
    ["wrong authorization scheme", { authorization: "Basic credential" }],
  ] as const)(
    "rejects %s before token verification",
    async (_name, headers) => {
      const { result, verificationCalls } = await verify(
        validClaims(),
        headers,
      );

      expect(result).toMatchObject({
        _tag: "Left",
        left: new InvalidHumanIdentity(),
      });
      expect(verificationCalls).toEqual([]);
    },
  );

  test("maps signature verification failures to the same safe identity boundary", async () => {
    const identity = makeClerkHumanIdentity({
      ...configuration,
      now: () => now,
      verifyToken: async () => {
        throw new Error("signature detail must not escape");
      },
    });

    const result = await Effect.runPromise(
      Effect.either(identity.verify(request())),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidHumanIdentity" },
    });
  });
});
