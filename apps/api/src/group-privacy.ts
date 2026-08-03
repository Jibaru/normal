import { Data, Effect, Encoding } from "effect";

export class GroupDirectoryPrivacyError extends Data.TaggedError(
  "GroupDirectoryPrivacyError",
) {}

const encoder = new TextEncoder();
const connectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const normalizeGroupDisplayName = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("und");

const groupDirectoryIndex = (
  key: CryptoKey,
  connectionId: string,
  normalizedPrefix: string,
): Effect.Effect<string, GroupDirectoryPrivacyError> =>
  connectionIdPattern.test(connectionId)
    ? Effect.tryPromise({
        try: async () => {
          const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(
              `group-directory-index-v1\0${connectionId}\0display-name-prefix\0${normalizedPrefix}`,
            ),
          );
          return `gi1_${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
        },
        catch: () => new GroupDirectoryPrivacyError(),
      })
    : Effect.fail(new GroupDirectoryPrivacyError());

export const importGroupDirectoryIndexKey = (
  secret: Uint8Array,
): Effect.Effect<CryptoKey, GroupDirectoryPrivacyError> =>
  secret.byteLength < 32
    ? Effect.fail(new GroupDirectoryPrivacyError())
    : Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            secret,
            { hash: "SHA-256", name: "HMAC" },
            false,
            ["sign"],
          ),
        catch: () => new GroupDirectoryPrivacyError(),
      });

export const groupSearchIndex = (
  key: CryptoKey,
  connectionId: string,
  search: string,
): Effect.Effect<string, GroupDirectoryPrivacyError> => {
  const normalized = normalizeGroupDisplayName(search);
  const length = Array.from(normalized).length;
  return length < 3 || length > 64
    ? Effect.fail(new GroupDirectoryPrivacyError())
    : groupDirectoryIndex(key, connectionId, normalized);
};

export const groupNamePrefixIndexes = (
  key: CryptoKey,
  connectionId: string,
  displayName: string | null,
): Effect.Effect<ReadonlyArray<string>, GroupDirectoryPrivacyError> => {
  if (displayName === null) return Effect.succeed([]);
  const characters = Array.from(normalizeGroupDisplayName(displayName)).slice(
    0,
    64,
  );
  return Effect.forEach(
    characters
      .slice(2)
      .map((_, index) => characters.slice(0, index + 3).join("")),
    (prefix) => groupDirectoryIndex(key, connectionId, prefix),
  );
};
