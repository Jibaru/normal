import { Schema } from "effect";
import { nanoid } from "nanoid";

const nanoIdSuffixPattern = "[A-Za-z0-9_-]{21}(?![\\s\\S])";

const connectionIdPattern = new RegExp(`^con_${nanoIdSuffixPattern}$`);
const contactIdPattern = new RegExp(`^ctc_${nanoIdSuffixPattern}$`);
const groupIdPattern = new RegExp(`^grp_${nanoIdSuffixPattern}$`);
const conversationIdPattern = new RegExp(`^cvs_${nanoIdSuffixPattern}$`);
const messageIdPattern = new RegExp(`^msg_${nanoIdSuffixPattern}$`);
const mediaIdPattern = new RegExp(`^med_${nanoIdSuffixPattern}$`);
const sendIdPattern = new RegExp(`^snd_${nanoIdSuffixPattern}$`);
const idempotencyKeyPattern = new RegExp(`^${nanoIdSuffixPattern}$`);

export const ConnectionId = Schema.String.pipe(
  Schema.pattern(connectionIdPattern),
  Schema.brand("ConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;

export const ContactId = Schema.String.pipe(
  Schema.pattern(contactIdPattern),
  Schema.brand("ContactId"),
);
export type ContactId = typeof ContactId.Type;

export const GroupId = Schema.String.pipe(
  Schema.pattern(groupIdPattern),
  Schema.brand("GroupId"),
);
export type GroupId = typeof GroupId.Type;

export const ConversationId = Schema.String.pipe(
  Schema.pattern(conversationIdPattern),
  Schema.brand("ConversationId"),
);
export type ConversationId = typeof ConversationId.Type;

export const MessageId = Schema.String.pipe(
  Schema.pattern(messageIdPattern),
  Schema.brand("MessageId"),
);
export type MessageId = typeof MessageId.Type;

export const MediaId = Schema.String.pipe(
  Schema.pattern(mediaIdPattern),
  Schema.brand("MediaId"),
);
export type MediaId = typeof MediaId.Type;

export const SendId = Schema.String.pipe(
  Schema.pattern(sendIdPattern),
  Schema.brand("SendId"),
);
export type SendId = typeof SendId.Type;

export const IdempotencyKey = Schema.String.pipe(
  Schema.pattern(idempotencyKeyPattern),
  Schema.brand("IdempotencyKey"),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;

export const makeConnectionId = (): ConnectionId =>
  ConnectionId.make(`con_${nanoid()}`);

export const makeContactId = (): ContactId => ContactId.make(`ctc_${nanoid()}`);

export const makeGroupId = (): GroupId => GroupId.make(`grp_${nanoid()}`);

export const makeConversationId = (): ConversationId =>
  ConversationId.make(`cvs_${nanoid()}`);

export const makeMessageId = (): MessageId => MessageId.make(`msg_${nanoid()}`);

export const makeMediaId = (): MediaId => MediaId.make(`med_${nanoid()}`);

export const makeSendId = (): SendId => SendId.make(`snd_${nanoid()}`);
