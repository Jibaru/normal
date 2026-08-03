# Deletion primitives and restore recovery

This runbook covers the restore-safe primitives. Connection Deletion, Personal
Account Deletion, provider cleanup scheduling, and the traffic restore gate are
separate workflows, but they must preserve this ordering and authority split.

## Deleted Message Tombstones

Message-deletion webhook items are terminal Message Store evidence. Operators
must not repair a Deleted Message Tombstone by replaying an older message
upsert, edit, or media job: replay must converge to the existing content-free
row. A healthy tombstone retains ordering and its opaque message identity, has
`deleted_at` set, and has every content ciphertext field null. `read_messages`
still counts and returns that row with null text and media.

If those invariants fail after a deployment or restore, stop webhook replay,
retain only metadata-safe incident references, and use a forward migration or
projector fix. Never copy ciphertext from a Webhook Event into a tombstone.

## Active deletion ordering

1. Resolve the Personal Account and WhatsApp Connection only inside the
   restricted transaction-local Personal Account context.
2. Derive the marker object key with `DELETION_MARKER_HMAC_SECRET`. Write the
   version-1 marker with only `deletionKind`, `requestedAt`,
   `keyUnavailableAt`, and `version`, using create-if-absent. An existing
   byte-identical marker is a successful replay; different bytes at the same
   marker key are an integrity failure.
3. Before making the tenant key unavailable, copy only the opaque provider
   session locator needed for cleanup into a Deletion Capsule. Encrypt it with
   `KMS_DELETION_COORDINATOR_KEY_ARN` and the exact context `environment`,
   `purpose=deletion-capsule`, `deletionMarkerId`, and `keyVersion`. Never add a
   phone number, identity, credential, content value, provider payload, or
   tenant key to the capsule.
4. In the tenant transaction, invoke
   `app_private.make_whatsapp_connection_key_unavailable` or
   `app_private.make_personal_account_key_unavailable`. These functions are
   idempotent and leave an unavailable tombstone even if no envelope existed.
   Ordinary runtime can insert and load an initial available envelope, but
   cannot update, delete, or replace the tombstone.
5. Start asynchronous provider reconciliation. The marker is never removed.
   The Deletion Capsule remains until the isolated deletion coordinator
   confirms provider absence and durably records that fact through its narrow
   database function.
6. The API cleanup schedule deletes encrypted Webhook Event sources and Stored
   Media objects. It acknowledges each Stored Media deletion before quota is
   released, then purges connection-owned Neon rows and releases the WhatsApp
   Number reservation. The public handle is copied to a content-free tombstone
   before the Connection row is removed, so it can never be reused.

The deletion coordinator receives only its Deletion Capsule KMS decrypt
authority, provider cleanup seam, Deletion Capsule binding, and the
`whatsapp_deletion_runtime` database role. It must not receive the content-root role,
content key ARN, Personal Account key envelopes, WhatsApp Connection key
envelopes, Stored Media binding, Webhook Event binding, or an ordinary
application database role. A `present` provider observation retains the
capsule for another bounded reconciliation. An `absent` observation first
records provider absence and then destroys the capsule; replay after destruction
is complete. The separate API cleanup schedule owns active R2 and Neon purge.

Alert before the 24-hour active-cleanup deadline on an overdue capsule,
provider ambiguity, denied KMS operation, marker write failure, or attempted
marker overwrite. Telemetry may include the deletion marker identity,
operation class, normalized outcome, attempt count, and duration. It must not
include the opaque entity identifier used to derive the marker, provider
session locator, KMS plaintext/ciphertext, phone number, credential, or
content.

## Restore enumeration

No restored Neon branch may receive verification or application traffic before
the restore gate completes:

1. Keep public and internal data-plane routes disabled.
2. Enumerate every `markers/v1/` object from the locked marker bucket across all
   R2 list pages. Reject an invalid object key, missing object, malformed body,
   extra body field, unsupported version, or non-canonical timestamp.
3. Scan the restored branch's opaque Personal Account and WhatsApp Connection
   identifiers, derive each expected marker ID with the dedicated HMAC, and
   match those IDs against the enumerated marker set. Marker bodies deliberately
   contain no reversible identifier. Make every match's key unavailable first,
   then re-purge its restored rows and active object references.
4. Run the same `app_private.purge_expired_message_content` wall-clock expiry
   gate used by the hourly worker until it returns fewer than the batch limit,
   then drain `stored_media_object_deletions`, before verification access or
   serving traffic. This applies current per-connection policy as required by
   ADR 0021 without reopening content from the restored snapshot.
5. Verify no marked identifier has an available key envelope or readable
   content. Record marker count, normalized outcomes, RPO, and elapsed RTO
   without recording tenant or provider identifiers.
6. Enable verification access, and later traffic, only after every marker and
   expiry operation succeeds.

Do not sample marker replay, skip a malformed marker, substitute a database
copy of marker state, or unlock/delete the marker bucket to recover from an
error. Restore the marker/KMS authority or forward-fix the replay code while
traffic remains closed.

## Rollback and authority recovery

Never delete, unlock, rename, or replace the marker bucket, its indefinite lock,
the dedicated marker HMAC secret, or either KMS key during application rollback.
Do not age-delete Deletion Capsules: unexplained capsule loss can strand a
provider session after tenant keys are unavailable. Restore a failed
coordinator from the last known-good production artifact with its separate
short-lived role credentials, reconcile absence, and then let the normal
primitive destroy the capsule.
