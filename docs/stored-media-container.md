# Encrypted Stored Media container

Stored Media is persisted in the private `STORED_MEDIA` R2 bucket as one
versioned binary container. The API production composition root constructs the
container service only from the real R2 binding and the AWS KMS-rooted envelope
encryption service. Deterministic random bytes and storage implementations are
injected only by tests; there is no environment value or production branch that
selects them.

## Version 1 format

All integers are unsigned, big-endian values. Version 1 uses AES-256-GCM and a
fixed production plaintext chunk ceiling of 1 MiB.

The container header contains:

| Offset | Bytes | Value |
| --- | ---: | --- |
| 0 | 8 | Magic `WAMR2ENC` |
| 8 | 1 | Container version `1` |
| 9 | 1 | Algorithm `1` (AES-256-GCM) |
| 10 | 2 | Reserved zero bytes |
| 12 | 4 | Plaintext chunk size |
| 16 | 4 | WhatsApp Connection key version |
| 20 | 12 | Nonce for the wrapped per-media key |
| 32 | 2 | Wrapped-key ciphertext length |
| 34 | variable | Connection-encrypted random 256-bit per-media key |

The per-media key envelope uses the existing versioned application-ciphertext
format and is bound to the Personal Account, WhatsApp Connection, Stored Media
object, `stored-media` entity, `media-data-key` purpose, and WhatsApp Connection
key version.

Each following frame contains:

| Offset | Bytes | Value |
| --- | ---: | --- |
| 0 | 1 | `0` for data or `1` for the terminal frame |
| 1 | 4 | Zero-based chunk index |
| 5 | 4 | Plaintext byte length |
| 9 | 12 | Frame nonce |
| 21 | variable | AES-GCM ciphertext followed by its 16-byte tag |

Each frame authenticates the deployment environment, Personal Account,
WhatsApp Connection, Stored Media object, container version, algorithm, chunk
size, WhatsApp Connection key version, chunk index, frame role, and plaintext
length. The final frame encrypts an empty plaintext with the next chunk index
and the `terminal` role. Readers accept the object only after authenticating
that terminal frame and proving there are no trailing bytes. This makes
truncation, chunk reordering, bit changes, header substitution, context
substitution, and cross-version use fail closed.

The R2 object has no custom or HTTP metadata. In particular, filename,
normalized MIME type, Personal Account identity, WhatsApp Connection identity,
Stored Media identity, plaintext hashes, and plaintext bytes are never copied
to R2 metadata. Queryable operational fields such as verified plaintext byte
size remain the responsibility of the integrity-protected authoritative
record, not the container object.

## Streaming and resource bounds

Encryption reads at most one 1 MiB plaintext chunk at a time and emits one
authenticated frame at a time. R2 does not accept a generated stream of unknown
total length through a single `put`, so the adapter uses multipart upload and
groups encrypted frames into 5 MiB R2 parts. It aborts an incomplete multipart
upload after any storage or stream failure. This is a bounded transport buffer,
not whole-object buffering.

Decryption first parses and authenticates a bounded header and one declared
frame at a time while discarding plaintext. Only after the terminal frame and
EOF authenticate does it start an ETag-pinned second R2 read and emit
individually authenticated chunks. This prevents truncation or later corruption
from exposing a valid plaintext prefix without concatenating the complete
object in Worker memory. A declared chunk size above 1 MiB is rejected. Raw
per-media key bytes are zeroed immediately after import into a non-extractable
Web Crypto key.

## Telemetry and failure handling

The only container telemetry event is
`stored-media.container.completed`. It records the API service, read or write
operation, normalized outcome, format version, authenticated chunk count, and
plaintext byte count processed so far. It never records an R2 key, Personal
Account, WhatsApp Connection, Stored Media identifier, filename, MIME type,
plaintext, ciphertext, nonce, or key material.

An authentication failure means the object is not readable Stored Media.
Callers must not return partial bytes or retry decryption under a guessed
context. The owning Stored Media workflow should transition the authoritative
record to `failed`, retain only safe operational evidence, and follow incident
response if failures are repeated or correlated. Missing R2 objects likewise
surface as unavailable rather than as recoverable media because R2 is the sole
retained Stored Media copy.
