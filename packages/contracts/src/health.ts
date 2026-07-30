import { Schema } from "effect";

export const HealthResponse = Schema.Struct({
  service: Schema.Literal("web", "api", "provider-control"),
  status: Schema.Literal("ok"),
});

export type HealthResponse = typeof HealthResponse.Type;

export const decodeHealthResponse = Schema.decodeUnknownSync(HealthResponse, {
  onExcessProperty: "error",
});

export const ReadinessResponse = Schema.Struct({
  service: Schema.Literal("api"),
  status: Schema.Literal("ready"),
});

export type ReadinessResponse = typeof ReadinessResponse.Type;

export const decodeReadinessResponse = Schema.decodeUnknownSync(
  ReadinessResponse,
  {
    onExcessProperty: "error",
  },
);
