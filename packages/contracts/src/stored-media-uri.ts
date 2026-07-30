import { Option, Schema } from "effect";
import {
  ConnectionId,
  type ConnectionId as ConnectionIdType,
  MediaId,
  type MediaId as MediaIdType,
  MessageId,
  type MessageId as MessageIdType,
} from "./handles";

const storedMediaUriPattern =
  /^whatsapp-media:\/\/connections\/(con_[A-Za-z0-9_-]{21})\/messages\/(msg_[A-Za-z0-9_-]{21})\/media\/(med_[A-Za-z0-9_-]{21})(?![\s\S])/;

export const StoredMediaUri = Schema.String.pipe(
  Schema.pattern(storedMediaUriPattern),
  Schema.brand("StoredMediaUri"),
);
export type StoredMediaUri = typeof StoredMediaUri.Type;

export type StoredMediaUriParts = {
  readonly connectionId: ConnectionIdType;
  readonly messageId: MessageIdType;
  readonly mediaId: MediaIdType;
};

export const makeStoredMediaUri = ({
  connectionId,
  messageId,
  mediaId,
}: StoredMediaUriParts): StoredMediaUri =>
  StoredMediaUri.make(
    `whatsapp-media://connections/${connectionId}/messages/${messageId}/media/${mediaId}`,
  );

export const parseStoredMediaUri = (
  input: string,
): Option.Option<StoredMediaUriParts> => {
  const match = storedMediaUriPattern.exec(input);
  if (
    match === null ||
    match[0] !== input ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return Option.none();
  }

  return Option.some({
    connectionId: ConnectionId.make(match[1]),
    messageId: MessageId.make(match[2]),
    mediaId: MediaId.make(match[3]),
  });
};
