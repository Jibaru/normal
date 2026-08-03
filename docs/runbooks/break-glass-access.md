# Two-person break-glass access

This path is for a scoped incident only. Support, engineering, database,
observability, provider-control, deletion-coordinator, and ordinary-operator
credentials cannot use it and must never receive its database or AWS roles.

1. From the incident system, create a random request UUID and opaque actor
   references. Using only the `whatsapp_break_glass_requester` database role,
   call `app_private.create_break_glass_request` with the incident reference,
   detailed reason, exact Personal Account UUID, one capability
   (`message_content` or `stored_media`), and an expiry no more than one hour
   away. Record a specific legal prohibition only when counsel requires one.
2. Two separately authenticated authorized responders use only the
   `whatsapp_break_glass_approver` role to call
   `app_private.approve_break_glass_request`. The database rejects the
   requester, a repeated approver, late approval, or approval after issuance.
3. The credential broker generates a 256-bit random secret, stores only its
   SHA-256 hexadecimal digest through `issue_break_glass_credential`, and
   assumes `BreakGlassRole` with MFA. Limit the STS duration to the database
   expiry and tag the session with the exact `personalAccountId` and
   `breakGlassRequestId`. Never print or persist the secret or STS credentials.
4. Before each decryption, the isolated incident process calls
   `authorize_break_glass_attempt` through `whatsapp_break_glass_runtime` with
   the secret digest, exact account, and exact capability. Continue only when
   it returns true. Use the normal authenticated envelope/container code and
   the tagged AWS session; the KMS policy rejects another Personal Account.
   Immediately call `record_break_glass_decryption_result` with the actual
   success or failure before continuing. Do not copy plaintext into tickets,
   logs, audit, shell history, or metrics.
5. Each allowed use appends an immutable non-content audit event. It also
   creates one `break_glass_user_notifications` outbox row unless the request
   recorded a legal prohibition. The notification delivery job must tell the
   affected User that incident access occurred, without including content or
   internal actor identity, and set `delivered_at`; undelivered rows page the
   privacy on-call. A legal prohibition is reviewed at incident closure.
6. Stop at expiry, terminate the AWS session, destroy local plaintext and
   credentials, verify CloudTrail request-ID/account tags against database
   events, verify notification delivery or the prohibition, and attach only
   non-content evidence to the incident.

The audit tables are append-only to every runtime role. Schema owners are for
migrations only; modifying an audit event is itself a security incident.
