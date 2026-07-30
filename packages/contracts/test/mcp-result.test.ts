import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  makeExecutionErrorResult,
  SafeExecutionErrorContract,
} from "../src/mcp-error";
import { makeSuccessResultBuilder } from "../src/mcp-result";
import { makePublicObjectContract } from "../src/mcp-schema";

describe("MCP result builders", () => {
  const ExampleContract = makePublicObjectContract({
    value: Schema.String,
    unknown_value: Schema.NullOr(Schema.String),
  });

  test("validates structured content and emits the identical compact JSON text", () => {
    const build = makeSuccessResultBuilder(ExampleContract);
    const result = build({
      value: "ready",
      unknown_value: null,
    });

    expect(result.structuredContent).toEqual({
      value: "ready",
      unknown_value: null,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent),
      },
    ]);
  });

  test("keeps the parity text first when protected resource links are appended", () => {
    const build = makeSuccessResultBuilder(ExampleContract);
    const result = build(
      {
        value: "ready",
        unknown_value: null,
      },
      [
        {
          type: "resource_link",
          uri: "whatsapp-media://connections/example",
        },
      ],
    );

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[1]).toEqual({
      type: "resource_link",
      uri: "whatsapp-media://connections/example",
    });
  });

  test("rejects an output that is outside the closed structured contract", () => {
    const build = makeSuccessResultBuilder(ExampleContract);

    expect(() =>
      build({
        value: "ready",
        unknown_value: null,
        provider_id: "secret",
      }),
    ).toThrow();
  });

  test("builds safe execution errors with only the agreed fields", () => {
    const result = makeExecutionErrorResult({
      error_code: "rate_limited",
      message: "Try again later.",
      retryable: true,
      retry_after_seconds: 10,
      resets_at: "2026-07-30T12:00:00Z",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      JSON.stringify(result.structuredContent),
    );
    expect(() =>
      SafeExecutionErrorContract.decodeUnknown({
        error_code: "rate_limited",
        message: "Try again later.",
        retryable: true,
        internal_cause: "database timeout",
      }),
    ).toThrow();
    expect(() =>
      SafeExecutionErrorContract.decodeUnknown({
        error_code: "rate_limited",
        message: "Try again later.",
        retryable: true,
        resets_at: "2026-02-31T12:00:00Z",
      }),
    ).toThrow();
  });
});
