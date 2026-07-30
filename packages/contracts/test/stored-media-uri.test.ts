import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { ConnectionId, MediaId, MessageId } from "../src/handles";
import {
  makeStoredMediaUri,
  parseStoredMediaUri,
} from "../src/stored-media-uri";

const connectionId = Schema.decodeUnknownSync(ConnectionId)(
  "con_123456789012345678901",
);
const messageId = Schema.decodeUnknownSync(MessageId)(
  "msg_123456789012345678901",
);
const mediaId = Schema.decodeUnknownSync(MediaId)("med_123456789012345678901");
const validUri =
  "whatsapp-media://connections/con_123456789012345678901/messages/msg_123456789012345678901/media/med_123456789012345678901";

describe("Stored Media URI", () => {
  test("formats and parses the exact protected resource template", () => {
    expect(
      String(makeStoredMediaUri({ connectionId, messageId, mediaId })),
    ).toBe(validUri);
    expect(Option.getOrThrow(parseStoredMediaUri(validUri))).toEqual({
      connectionId,
      messageId,
      mediaId,
    });
  });

  test("rejects extra path, query, fragment, encoding ambiguity, and traversal", () => {
    const invalidUris = [
      `${validUri}/extra`,
      `${validUri}/`,
      `${validUri}?download=1`,
      `${validUri}#fragment`,
      validUri.replace("/messages/", "/%6dessag%65s/"),
      validUri.replace("/messages/", "/%2e%2e/messages/"),
      validUri.replace("/messages/", "/./messages/"),
      validUri.replace("/messages/", "/../messages/"),
      validUri.replace("/messages/", "\\messages\\"),
      `${validUri}\n`,
    ];

    for (const invalidUri of invalidUris) {
      expect(Option.isNone(parseStoredMediaUri(invalidUri))).toBe(true);
    }
  });

  test("rejects a valid handle of the wrong public type", () => {
    expect(
      Option.isNone(
        parseStoredMediaUri(
          validUri.replace(
            "msg_123456789012345678901",
            "med_123456789012345678901",
          ),
        ),
      ),
    ).toBe(true);
  });
});
