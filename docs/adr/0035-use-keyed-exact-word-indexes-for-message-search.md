# Use keyed exact-word indexes for Stored Message search

Previously numbered 0028. That number is reserved for the WhatsApp Recipient Exclusion journal ADR.

## Decision

Search the latest retained Stored Message text and media captions with a versioned, keyed exact-word blind index. Each WhatsApp Connection owns a dedicated random 256-bit message-search key wrapped through the existing Personal Account and WhatsApp Connection KMS hierarchy. This key is not reused for Directory indexes, webhook identity, provider references, cursors, send fingerprints, deletion markers, or any other purpose.

Tokenizer and index version `v1` validates Unicode scalar input, applies NFKC, applies locale-independent Unicode default lowercase mapping, applies NFKC again, and extracts maximal words matching `Letter-or-Number (Letter-or-Mark-or-Number)*`. It deduplicates terms and sorts them by unsigned UTF-8 byte order. Unicode punctuation, symbols, separators, controls, and leading Marks are boundaries. The deployed runtime's normalization, casing, and Unicode property tables are part of `v1` and are pinned by deterministic compatibility vectors. A runtime upgrade that changes a vector requires a new index version and migration; it must not silently reinterpret retained `v1` indexes. The same rule applies to any change in token boundaries, HMAC framing, or key purpose.

For every unique term, the API computes the full 32-byte HMAC-SHA-256 value over `normal.message-search.index` followed by a zero byte, one version byte equal to `1`, a four-byte unsigned big-endian UTF-8 byte length and UTF-8 bytes for the internal WhatsApp Connection identifier, then the same length-and-bytes framing for the normalized term. Neon stores only opaque base64url values and index version beside application-encrypted content. Query terms use AND semantics. The API decrypts only a bounded candidate page and verifies every normalized query term against the latest plaintext before release. An index/ciphertext mismatch fails closed rather than returning the candidate.

## Leakage and limits

A database observer can determine which Stored Messages within one WhatsApp Connection contain the same unknown normalized word, how frequently that unknown word occurs, the number of distinct indexed words in a message, and database query access patterns. Repeated words within one message are deduplicated. Connection binding and independent keys prevent equality correlation across WhatsApp Connections. The index does not reveal plaintext without the per-Connection key, but low-entropy or guessed content can be tested by an actor who obtains that key; envelope encryption does not remove this searchable-encryption leakage.

Version `v1` supports complete normalized words only. It does not provide substring, prefix, phrase, order, adjacency, stemming, morphology, synonym, fuzzy, or relevance search. Search results are ordered by `sent_at DESC, message_id DESC`, not relevance.

## Rejected alternatives

- Plaintext search columns, database full-text search, and database-visible encryption keys were rejected because they expose message content or decryption authority to Neon.
- Decrypting and scanning every retained Stored Message for every request was rejected because latency, Worker memory and CPU, KMS use, and read amplification grow with retained history.
- Shared or environment-wide blind-index keys were rejected because they permit cross-Connection equality correlation and enlarge one key's compromise scope.
- Truncated digests, Bloom filters, and n-gram indexes were rejected because they add collisions or substantially more equality leakage without serving the exact-word first-version contract.
- ORAM, PIR, trusted hardware, and searchable-encryption schemes that hide equality or access patterns were rejected for the private beta because their infrastructure and operational complexity are disproportionate to the bounded lexical-search requirement.

## Lifecycle and backfill

Stored Message ciphertext and `v1` tokens become visible atomically on creation. An edit atomically replaces all tokens from the latest verified content, so prior words stop matching. A Deleted Message Tombstone and Message Retention Policy expiry clear tokens in the same lifecycle transition that removes readable content. Connection Deletion and Personal Account Deletion stop search-key use immediately and purge tokens with Stored Messages. Restore gates must prevent terminally deleted or expired ciphertext, key envelopes, or tokens from becoming searchable again.

Existing retained content is indexed by an application-level, bounded, newest-to-oldest backfill because SQL cannot decrypt it. Normal ingestion and edits maintain the current version while backfill runs. Coverage records identify a contiguous searchable-history start; responses report incomplete coverage and never describe unindexed retained history as searched. Rotation or tokenizer migration writes a distinct key/index version, tracks its own coverage, and cuts reads over only after the required retained range is complete. Versions and keys are never silently mixed.
