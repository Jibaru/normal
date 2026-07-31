import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ConnectionId,
  ConnectionSetupId,
  ContactId,
  ConversationId,
  GroupId,
  IdempotencyKey,
  MediaId,
  MessageId,
  makeConnectionId,
  makeConnectionSetupId,
  makeContactId,
  makeConversationId,
  makeGroupId,
  makeIdempotencyKey,
  makeMediaId,
  makeMessageId,
  makeSendId,
  SendId,
} from "../src/handles";

const suffix = "123456789012345678901";

describe("public handles", () => {
  test("accepts exactly the agreed type prefixes and NanoID suffix", () => {
    expect(
      [
        Schema.decodeUnknownSync(ConnectionId)(`con_${suffix}`),
        Schema.decodeUnknownSync(ConnectionSetupId)(`cst_${suffix}`),
        Schema.decodeUnknownSync(ContactId)(`ctc_${suffix}`),
        Schema.decodeUnknownSync(GroupId)(`grp_${suffix}`),
        Schema.decodeUnknownSync(ConversationId)(`cvs_${suffix}`),
        Schema.decodeUnknownSync(MessageId)(`msg_${suffix}`),
        Schema.decodeUnknownSync(MediaId)(`med_${suffix}`),
        Schema.decodeUnknownSync(SendId)(`snd_${suffix}`),
      ].map(String),
    ).toEqual([
      `con_${suffix}`,
      `cst_${suffix}`,
      `ctc_${suffix}`,
      `grp_${suffix}`,
      `cvs_${suffix}`,
      `msg_${suffix}`,
      `med_${suffix}`,
      `snd_${suffix}`,
    ]);
  });

  test("rejects wrong types, lengths, and non-default-alphabet characters", () => {
    const decodeConnectionId = Schema.decodeUnknownSync(ConnectionId);

    for (const invalid of [
      `ctc_${suffix}`,
      `con_${suffix.slice(1)}`,
      `con_${suffix}a`,
      `con_${suffix.slice(0, -1)}.`,
      `con_${suffix.slice(0, -1)}é`,
      `con_${suffix}\n`,
    ]) {
      expect(() => decodeConnectionId(invalid)).toThrow();
    }
  });

  test("generates standard 21-character NanoID handles without an identity input", () => {
    const generated = [
      makeConnectionId(),
      makeConnectionSetupId(),
      makeContactId(),
      makeGroupId(),
      makeConversationId(),
      makeMessageId(),
      makeMediaId(),
      makeSendId(),
    ];

    expect(generated).toHaveLength(new Set(generated).size);
    for (const handle of generated) {
      expect(handle).toMatch(
        /^(con|cst|ctc|grp|cvs|msg|med|snd)_[A-Za-z0-9_-]{21}$/,
      );
    }
  });

  test("validates caller-generated idempotency keys without an entity prefix", () => {
    const decode = Schema.decodeUnknownSync(IdempotencyKey);

    expect(String(decode(suffix))).toBe(suffix);
    expect(() => decode(`snd_${suffix}`)).toThrow();
    expect(() => decode(suffix.slice(1))).toThrow();
    expect(String(makeIdempotencyKey())).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });
});
