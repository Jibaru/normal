import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ListChatsOutputContract,
  ListConnectionsOutputContract,
  ListContactsOutputContract,
  ListGroupsOutputContract,
  makePublicObjectContract,
} from "../src/mcp-schema";

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

  test("validates the exact unpaginated list_connections result", () => {
    const output = {
      connections: [
        {
          connection_id: "con_123456789012345678901",
          display_name: null,
          number_last_four: "1234",
          state: "connected",
          state_changed_at: "2026-07-30T12:00:00.000Z",
        },
      ],
    };

    expect(
      ListConnectionsOutputContract.decodeUnknown(output) as unknown,
    ).toEqual(output);
    expect(ListConnectionsOutputContract.jsonSchema).toMatchObject({
      additionalProperties: false,
    });
    expect(() =>
      ListConnectionsOutputContract.decodeUnknown({
        ...output,
        provider_session_id: "must-not-escape",
      }),
    ).toThrow();
    expect(() =>
      ListConnectionsOutputContract.decodeUnknown({
        connections: [
          {
            ...output.connections[0],
            state: "deleting",
          },
        ],
      }),
    ).toThrow();
  });

  test("validates the exact paginated list_groups result without provider data", () => {
    const output = {
      groups: [
        {
          group_id: "grp_123456789012345678901",
          display_name: "Family",
        },
      ],
      has_more: false,
      next_cursor: null,
      as_of: "2026-07-30T12:00:00.000Z",
      stale: false,
      partial: false,
    };

    expect(ListGroupsOutputContract.decodeUnknown(output) as unknown).toEqual(
      output,
    );
    expect(ListGroupsOutputContract.jsonSchema).toMatchObject({
      additionalProperties: false,
    });
    expect(() =>
      ListGroupsOutputContract.decodeUnknown({
        ...output,
        groups: [
          {
            ...output.groups[0],
            roster: ["provider-participant"],
          },
        ],
      }),
    ).toThrow();
  });

  test("validates suffix-only paginated list_contacts results", () => {
    const output = {
      as_of: "2026-07-30T12:00:00.000Z",
      contacts: [
        {
          contact_id: "ctc_123456789012345678901",
          display_name: "Ada",
          phone_last_four: "0199",
        },
      ],
      has_more: true,
      next_cursor: "opaque-cursor",
      partial: false,
      stale: false,
    };

    expect(ListContactsOutputContract.decodeUnknown(output) as unknown).toEqual(
      output,
    );
    expect(ListContactsOutputContract.jsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        contacts: {
          items: expect.objectContaining({ additionalProperties: false }),
          maxItems: 50,
          type: "array",
        },
      },
    });
    expect(() =>
      ListContactsOutputContract.decodeUnknown({
        ...output,
        contacts: [
          {
            ...output.contacts[0],
            phone_number: "+12025550199",
          },
        ],
      }),
    ).toThrow();
  });

  test("validates metadata-only list_chats results", () => {
    const output = {
      chats: [
        {
          conversation_id: "cvs_123456789012345678901",
          kind: "direct",
          recipient_id: "ctc_123456789012345678901",
          display_name: "Ada",
          phone_last_four: "0199",
          last_activity_at: "2026-07-30T11:59:00Z",
          last_activity_direction: "inbound",
        },
      ],
      has_more: false,
      next_cursor: null,
      as_of: "2026-07-30T12:00:00Z",
      stale: false,
      partial: false,
    } as const;
    expect(ListChatsOutputContract.decodeUnknown(output) as unknown).toEqual(
      output,
    );
    expect(() =>
      ListChatsOutputContract.decodeUnknown({
        ...output,
        chats: [{ ...output.chats[0], snippet: "secret" }],
      }),
    ).toThrow();
  });
});
