import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makePublicObjectContract } from "../src/mcp-schema";

describe("makePublicObjectContract", () => {
  const ExampleContract = makePublicObjectContract({
    limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
    note: Schema.NullOr(Schema.String.pipe(Schema.minLength(3))),
  });

  test("publishes a closed JSON Schema 2020-12 object with constraints", () => {
    expect(ExampleContract.jsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["limit", "note"],
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
        },
        note: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: "string", minLength: 3 }),
            expect.objectContaining({ type: "null" }),
          ]),
        },
      },
    });
  });

  test("rejects excess properties at runtime instead of silently dropping them", () => {
    expect(() =>
      ExampleContract.decodeUnknown({
        limit: 20,
        note: null,
        leaked: "provider-id",
      }),
    ).toThrow();
  });
});
