import { verifyToken as verifyClerkToken } from "@clerk/backend";
import { Effect } from "effect";
import {
  type HumanIdentityService,
  InvalidHumanIdentity,
  RecentHumanVerificationRequired,
} from "./human-identity";

export { InvalidHumanIdentity } from "./human-identity";

const MAX_TOKEN_BYTES = 16_384;
const MAX_TOKEN_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 5;
const clerkUserId = /^user_[A-Za-z0-9]{1,64}$/;

export interface ClerkTokenClaims {
  readonly [claim: string]: unknown;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly exp?: unknown;
  readonly fva?: unknown;
  readonly iat?: unknown;
  readonly iss?: unknown;
  readonly nbf?: unknown;
  readonly sts?: unknown;
  readonly sub?: unknown;
}

export interface ClerkVerificationOptions {
  readonly audience: string;
  readonly authorizedParties: ReadonlyArray<string>;
  readonly clockSkewInMs: number;
  readonly jwtKey: string;
}

export interface ClerkHumanIdentityOptions {
  readonly audience: string;
  readonly authorizedParty: string;
  readonly issuer: string;
  readonly jwtKey: string;
  readonly now?: (() => number) | undefined;
  readonly verifyToken?:
    | ((
        token: string,
        options: ClerkVerificationOptions,
      ) => Promise<ClerkTokenClaims>)
    | undefined;
}

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (
    authorization === null ||
    authorization.length > MAX_TOKEN_BYTES + "Bearer ".length ||
    !authorization.startsWith("Bearer ")
  ) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 && token.length <= MAX_TOKEN_BYTES ? token : null;
};

const isSafeClaims = (
  claims: ClerkTokenClaims,
  options: ClerkHumanIdentityOptions,
  now: number,
): claims is ClerkTokenClaims & { readonly sub: string } => {
  const { aud, azp, exp, iat, iss, nbf, sts, sub } = claims;
  return (
    aud === options.audience &&
    azp === options.authorizedParty &&
    iss === options.issuer &&
    typeof sub === "string" &&
    clerkUserId.test(sub) &&
    Number.isSafeInteger(exp) &&
    Number.isSafeInteger(iat) &&
    Number.isSafeInteger(nbf) &&
    (exp as number) > now &&
    (iat as number) <= now + CLOCK_SKEW_SECONDS &&
    (nbf as number) <= now + CLOCK_SKEW_SECONDS &&
    (nbf as number) <= (iat as number) &&
    (exp as number) - (iat as number) > 0 &&
    (exp as number) - (iat as number) <= MAX_TOKEN_LIFETIME_SECONDS &&
    (sts === undefined || sts === "active")
  );
};

export const makeClerkHumanIdentity = (
  options: ClerkHumanIdentityOptions,
): HumanIdentityService => {
  const verify =
    options.verifyToken ??
    ((token: string, verificationOptions: ClerkVerificationOptions) =>
      verifyClerkToken(token, {
        ...verificationOptions,
        authorizedParties: [...verificationOptions.authorizedParties],
      }));
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));

  const verifiedClaims = (request: Request) =>
    Effect.tryPromise({
      try: async () => {
        if (request.headers.get("origin") !== options.authorizedParty) {
          throw new InvalidHumanIdentity();
        }
        const token = bearerToken(request);
        if (token === null) {
          throw new InvalidHumanIdentity();
        }
        const claims = await verify(token, {
          audience: options.audience,
          authorizedParties: [options.authorizedParty],
          clockSkewInMs: CLOCK_SKEW_SECONDS * 1_000,
          jwtKey: options.jwtKey,
        });
        if (!isSafeClaims(claims, options, now())) {
          throw new InvalidHumanIdentity();
        }
        return claims;
      },
      catch: () => new InvalidHumanIdentity(),
    });

  return {
    verify: (request) =>
      verifiedClaims(request).pipe(Effect.map((claims) => claims.sub)),
    verifyRecently: (request) =>
      verifiedClaims(request).pipe(
        Effect.flatMap((claims) => {
          const firstFactorAge = Array.isArray(claims.fva)
            ? claims.fva[0]
            : undefined;
          if (
            typeof firstFactorAge !== "number" ||
            !Number.isSafeInteger(firstFactorAge) ||
            firstFactorAge < 0 ||
            firstFactorAge >= 5
          ) {
            return Effect.fail(new RecentHumanVerificationRequired());
          }
          return Effect.succeed({
            clerkUserId: claims.sub,
            reverifiedAt: new Date((now() - firstFactorAge * 60) * 1_000),
          });
        }),
      ),
  };
};
