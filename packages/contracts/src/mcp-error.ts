import { Schema } from "effect";
import { makeSuccessResultBuilder } from "./mcp-result";
import { makePublicObjectContract, UtcTimestamp } from "./mcp-schema";

const ErrorCode = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_]*$/),
  Schema.brand("ErrorCode"),
);

export const SafeExecutionErrorContract = makePublicObjectContract({
  error_code: ErrorCode,
  message: Schema.String.pipe(Schema.minLength(1)),
  retryable: Schema.Boolean,
  retry_after_seconds: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  ),
  resets_at: Schema.optional(UtcTimestamp),
});
export type SafeExecutionError = typeof SafeExecutionErrorContract.schema.Type;

const buildSafeExecutionError = makeSuccessResultBuilder(
  SafeExecutionErrorContract,
);

export const makeExecutionErrorResult = (input: unknown) => ({
  ...buildSafeExecutionError(input),
  isError: true as const,
});
