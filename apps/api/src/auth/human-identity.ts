import { Context, Data, type Effect } from "effect";

export class InvalidHumanIdentity extends Data.TaggedError(
  "InvalidHumanIdentity",
) {}

export interface HumanIdentityService {
  readonly verify: (
    request: Request,
  ) => Effect.Effect<string, InvalidHumanIdentity>;
}

export const HumanIdentity = Context.GenericTag<HumanIdentityService>(
  "@whatsapp-mcp/api/HumanIdentity",
);
