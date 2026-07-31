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

Production implementations arrive in issues 12 through 16. The lifecycle
implementation closes over the account-level Provider API Credential and a
stable locator HMAC key in provider-control; neither is a capability input or
output, and no runtime setting can select a fake or alternate provider origin.
The WhatsApp Number required for creation crosses the seam only as a `Redacted`
value. Newly provisioned or adopted per-session authority is returned only as a
log-safe `Redacted` value so the owning Worker can envelope-encrypt it before a
per-session Layer uses it.

The lifecycle adapter calls the documented account endpoints at the fixed
`https://www.wasenderapi.com` origin. Creation uses the deterministic Connection
Setup marker as the provider name and always disables provider message logging
and automatic incoming-message reads. Provider numeric identifiers become
domain-separated HMAC locators; resolving a locator therefore performs a
bounded account list instead of exposing or embedding the raw identifier. A QR
payload is rendered immediately to SVG bytes and the payload is not retained.
List and detail reads enforce the safe-read retry and response limits, while
create, connect, and delete perform one write attempt. Delete reconciles both
before and after a write and returns `present` until a later reconciled attempt
observes absence.

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
