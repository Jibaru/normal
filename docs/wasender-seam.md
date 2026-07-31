# Provider-neutral WhatsApp seam

`@whatsapp-mcp/wasender` is the internal replacement seam around the sole
private-beta provider. It exports no catch-all barrel and has five independent
Effect capabilities:

- `SessionLifecycle` is account-authority lifecycle control.
- `SessionDirectory` is read-only, per-session Directory authority.
- `TextSending` performs one per-session text-send attempt.
- `MediaRetrieval` reads per-session metadata and guarded Effect streams.
- `WebhookNormalization` turns one authenticated delivery into independently
  processable provider-neutral items.

Production implementations arrive in issues 12 through 16. This contract does
not add network access, configuration, credentials, or a selectable fake.
The production lifecycle Layer will close over the account-level Provider API
Credential, which is never a capability input or output. Newly provisioned
per-session authority is returned only as a log-safe `Redacted` value so the
owning Worker can envelope-encrypt it before a per-session Layer uses it.

## Boundary values

Provider payloads enter only the webhook normalizer as bytes. Raw provider
payloads, event names, status strings, identifiers, URLs, credentials, and
transport failures are not contract values. Adapter-produced locators,
identities, and versions are opaque tokens; a concrete adapter must generate a
protected equality or routing value rather than returning a raw provider
value. Session authority and media sources cross the seam only as Effect
`Redacted` values. The owning Worker immediately envelope-encrypts them before
persistence and supplies plaintext only to the applicable adapter Layer.
Failures use the closed `ProviderNeutralFailure` classification and contain no
free-form message, cause, URL, response body, or provider identifier. Its retry
decision is operation-specific rather than a generic retryable flag. Guarded
media stream failures use that same typed error channel, so a late transport
failure cannot escape through an untyped native stream error.

Webhook normalization returns one result per logical item. Unsupported and
malformed items are classified in place, allowing valid siblings from the same
delivery to continue independently. Every supported item carries an opaque
stable or semantic-fallback identity for downstream deduplication. Provider
version tokens remain opaque; ingestion asks the normalization capability to
compare them instead of learning provider version syntax or ordering rules.

## Operation policies

Lifecycle list, QR, and reconciliation plus Directory synchronization use the
safe-read policy. Lifecycle create, connect, and delete use the lifecycle-write
policy. The other capabilities use their named policy directly.

| Class | Attempts and timeout | Ambiguity and reconciliation | Response bound |
| --- | --- | --- | --- |
| Safe JSON read | At most three jittered 10-second attempts within 25 seconds | Safe to repeat; retries network failures, 408, 429, and 5xx | 1 MiB |
| Text send | One 15-second attempt | Acceptance may be unknown; reconcile only through exact identity-bearing evidence | 1 MiB |
| Lifecycle write | One 15-second attempt before reconciliation | Reconcile provider state before any repeat | 1 MiB |
| Media metadata | One 30-second attempt | Safe to repeat, but no implicit retry schedule | 1 MiB |
| Guarded media download | One 60-second attempt | Discard partial bytes; a later attempt restarts at byte zero | Caller bound, at most 100,000,000 bytes |

Safe reads honor `Retry-After` only up to five seconds and only while the
three-attempt, 25-second wall-clock budget remains. Other operation classes do
not gain retries from `Retry-After`. A media caller supplies a validated
positive integer byte limit no greater than the largest ADR 0008 ingestion
limit; the implementation counts streamed bytes rather than trusting
`Content-Length`.

The seam deliberately provides no message-information polling capability:
`get_send_status` is a local domain read and never invokes the provider.

Adapter telemetry may contain only the operation class, normalized outcome,
attempt count, duration, and bounded byte counts. It never contains capability
inputs or outputs, message text, full phone numbers, opaque references,
encrypted adapter values, raw response data, URLs, or credentials.

## Production media retrieval

The real `MediaRetrieval` Layer uses the per-session authority only for the
30-second `POST https://www.wasenderapi.com/api/decrypt-media` metadata call.
The encrypted provider message and the returned one-hour download URL remain
inside versioned Effect `Redacted` adapter values. The download request never
forwards the session authority.

`www.wasenderapi.com` is the only approved metadata and download hostname and
is deliberately not configurable. Before every request, including every
same-host redirect, the adapter resolves both address families through bounded
DNS-over-HTTPS requests and rejects empty answers or any non-global, private,
loopback, link-local, transition, benchmarking, documentation, multicast, or
reserved address. Fetch redirect handling is manual and limited to three
same-host redirects.

Metadata responses are read and counted up to 1 MiB. Downloads are streamed,
count actual bytes independently of `Content-Length`, cancel the response at
the caller's validated hard limit, and use a typed stream failure so partial
bytes are discarded and any later attempt starts at byte zero. The 60-second
budget covers DNS resolution, redirects, response setup, and complete stream
consumption. Production construction validates a non-empty printable session
authority and exposes no runtime fake or host override.
