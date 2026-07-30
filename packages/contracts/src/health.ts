import { Schema } from "effect";

export const HealthResponse = Schema.Struct({
  service: Schema.Literal("web", "api", "provider-control"),
  status: Schema.Literal("ok"),
});

export type HealthResponse = typeof HealthResponse.Type;

export const decodeHealthResponse = Schema.decodeUnknownSync(HealthResponse, {
  onExcessProperty: "error",
});
