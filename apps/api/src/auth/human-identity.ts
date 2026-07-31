import { Context, Data, type Effect } from "effect";

export class InvalidHumanIdentity extends Data.TaggedError(
  "InvalidHumanIdentity",
) {}

export class RecentHumanVerificationRequired extends Data.TaggedError(
  "RecentHumanVerificationRequired",
) {}

export interface RecentlyVerifiedHumanIdentity {
  readonly clerkUserId: string;
  readonly reverifiedAt: Date;
}

export interface HumanIdentityService {
  readonly verify: (
    request: Request,
  ) => Effect.Effect<string, InvalidHumanIdentity>;
  readonly verifyRecently: (
    request: Request,
  ) => Effect.Effect<
    RecentlyVerifiedHumanIdentity,
    InvalidHumanIdentity | RecentHumanVerificationRequired
  >;
}

export const HumanIdentity = Context.GenericTag<HumanIdentityService>(
  "@whatsapp-mcp/api/HumanIdentity",
);
