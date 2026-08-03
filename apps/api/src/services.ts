import type {
  DeployableName,
  DeploymentEnvironment,
} from "@whatsapp-mcp/domain/deployment";
import { Context, type Effect } from "effect";
import type { DeletionCapsuleWriter } from "./deletion/capsule";
import type { DeletionMarkerStore } from "./deletion/marker";
import type { StoredMediaContainerEvent } from "./encryption/stored-media-container";

export interface ApplicationConfig {
  readonly environment: DeploymentEnvironment;
  readonly service: DeployableName;
}

export const ApplicationConfig = Context.GenericTag<ApplicationConfig>(
  "@whatsapp-mcp/api/ApplicationConfig",
);

export interface DatabaseReadiness {
  readonly check: Effect.Effect<void, unknown>;
}

export const DatabaseReadiness = Context.GenericTag<DatabaseReadiness>(
  "@whatsapp-mcp/api/DatabaseReadiness",
);

export interface RestoreSafeDeletion {
  readonly capsules: DeletionCapsuleWriter;
  readonly markers: DeletionMarkerStore;
}

export const RestoreSafeDeletion = Context.GenericTag<RestoreSafeDeletion>(
  "@whatsapp-mcp/api/RestoreSafeDeletion",
);

export interface HttpCompletedEvent {
  readonly event: "http.request.completed";
  readonly method: string;
  readonly route: "health" | "ready" | "unmatched";
  readonly service: DeployableName;
  readonly status: number;
}

export interface PersonalAccountBootstrapCompletedEvent {
  readonly event: "personal_account.bootstrap.completed";
  readonly outcome: "created" | "recovered" | "waitlisted";
  readonly service: "api";
}

export interface PersonalAccountDeletionCompletedEvent {
  readonly event: "personal_account.deletion.completed";
  readonly outcome: "deleting" | "unknown_identity";
  readonly service: "api";
  readonly source: "clerk_webhook" | "product";
}

export interface ConnectionSetupStartCompletedEvent {
  readonly event: "connection_setup.start.completed";
  readonly outcome:
    | "connection_limit_reached"
    | "created"
    | "idempotency_conflict"
    | "number_unavailable"
    | "replay";
  readonly service: "api";
}

export interface ConnectionSetupCancelCompletedEvent {
  readonly event: "connection_setup.cancel.completed";
  readonly outcome: "cancelled" | "replay";
  readonly service: "api";
}

export interface ConnectionSetupCleanupCompletedEvent {
  readonly event: "connection_setup.cleanup.completed";
  readonly failureCode?: string | undefined;
  readonly outcome: "complete" | "ignored" | "retry";
  readonly service: "api";
}

export interface ConnectionSetupCleanupRecoveryEnqueuedEvent {
  readonly candidateCount: number;
  readonly event: "connection_setup.cleanup.recovery_enqueued";
  readonly expiredCount: number;
  readonly service: "api";
}

export interface ConnectionSetupProvisionCompletedEvent {
  readonly event: "connection_setup.provision.completed";
  readonly failureCode?: string | undefined;
  readonly outcome:
    | "failed"
    | "ignored"
    | "provisioned"
    | "quarantined"
    | "retry";
  readonly service: "api";
}

export interface ConnectionSetupProvisionRecoveryEnqueuedEvent {
  readonly candidateCount: number;
  readonly event: "connection_setup.provision.recovery_enqueued";
  readonly service: "api";
}

export interface ConnectionSetupQrCompletedEvent {
  readonly event: "connection_setup.qr.completed";
  readonly outcome:
    | "connected"
    | "connecting"
    | "pending"
    | "provisioning_failed"
    | "provisioning_quarantined"
    | "qr_available";
  readonly service: "api";
}

export interface WhatsAppConnectionListCompletedEvent {
  readonly connectionCount: number;
  readonly event: "whatsapp_connection.list.completed";
  readonly service: "api";
}

export interface WebhookIngressCompletedEvent {
  readonly event: "webhook_ingress.completed";
  readonly outcome:
    | "accepted"
    | "authentication_failed"
    | "invalid_payload"
    | "not_found"
    | "too_large"
    | "unavailable";
  readonly service: "api";
}

export interface WebhookIngressRecoveryCompletedEvent {
  readonly candidateCount: number;
  readonly enqueuedCount: number;
  readonly event: "webhook_ingress.recovery.completed";
  readonly invalidObjectCount: number;
  readonly service: "api";
}

export interface WebhookEventProcessingCompletedEvent {
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly event: "webhook_event.processing.completed";
  readonly outcome: "completed" | "invalid_message" | "retry";
  readonly quarantinedCount: number;
  readonly service: "api";
  readonly supersededCount: number;
}

export interface WebhookEventDeadLetterCompletedEvent {
  readonly event: "webhook_event.dead_letter.completed";
  readonly incidentReference: string | null;
  readonly outcome:
    | "already_completed"
    | "gap_recorded"
    | "invalid_message"
    | "source_unavailable";
  readonly service: "api";
}

export interface WebhookEventReplayCompletedEvent {
  readonly attemptReference: string | null;
  readonly event: "webhook_event.replay.completed";
  readonly outcome:
    | "already_dispatched"
    | "dispatched"
    | "invalid_message"
    | "source_unavailable";
  readonly service: "api";
}

export interface WebhookEventSourceRetentionCompletedEvent {
  readonly deletedCount: number;
  readonly event: "webhook_event.source_retention.completed";
  readonly service: "api";
}

export interface WhatsAppConnectionLifecycleCompletedEvent {
  readonly event: "whatsapp_connection.lifecycle.completed";
  readonly operation: "disconnect" | "reconnect";
  readonly outcome:
    | "complete"
    | "in_progress"
    | "qr_available"
    | "recovery_required";
  readonly service: "api";
}
export interface WhatsAppConnectionDeletionCompletedEvent {
  readonly event: "whatsapp_connection.deletion.completed";
  readonly outcome: "complete";
  readonly service: "api";
}

export interface WhatsAppConnectionDeletionDeadlineRiskEvent {
  readonly deadlineAt: string;
  readonly event: "whatsapp_connection.deletion.deadline_risk";
  readonly marker: string;
  readonly service: "api";
}

export interface ConnectionHealthReconciliationCompletedEvent {
  readonly event: "connection_health.reconciliation.completed";
  readonly gapEvidence:
    | "healthy"
    | "connection_unavailable"
    | "webhook_configuration"
    | "unknown";
  readonly outcome: "applied" | "superseded";
  readonly service: "api";
  readonly state:
    | "connected"
    | "degraded"
    | "disconnected"
    | "reconnect_required";
}

export interface OAuthAuthorizationRequestCompletedEvent {
  readonly clientClass?: string | undefined;
  readonly event: "oauth.authorization.request.completed";
  readonly outcome: "accepted" | "invalid_request";
  readonly service: "api";
}

export interface OAuthProtocolRequestFailedEvent {
  readonly code: string;
  readonly event: "oauth.protocol.request.failed";
  readonly service: "api";
  readonly status: number;
}

export interface OAuthAuthorizationDecisionCompletedEvent {
  readonly clientClass: string;
  readonly event: "oauth.authorization.decision.completed";
  readonly outcome: "approved" | "denied";
  readonly service: "api";
}

export interface OAuthRefreshCompletedEvent {
  readonly clientClass?: string | undefined;
  readonly event: "oauth.refresh.completed";
  readonly outcome: "invalid" | "reuse" | "rotated" | "unavailable";
  readonly service: "api";
}

export interface McpAuthorizationManagementCompletedEvent {
  readonly event: "mcp_authorization.management.completed";
  readonly operation: "list" | "revoke";
  readonly outcome: "not_found" | "success";
  readonly service: "api";
}

export interface McpToolCallCompletedEvent {
  readonly event: "mcp.tool_call.completed";
  readonly outcome:
    | "audit_unavailable"
    | "authorization_denied"
    | "execution_error"
    | "invalid_cursor"
    | "rate_limited"
    | "service_unavailable"
    | "success";
  readonly resultCount?: number | undefined;
  readonly service: "api";
  readonly tool:
    | "list_connections"
    | "list_contacts"
    | "list_groups"
    | "get_send_status"
    | "send_text_message"
    | "list_chats"
    | "read_messages";
}

export interface ToolCallLogReviewCompletedEvent {
  readonly event: "tool_call_log.review.completed";
  readonly logCount: number;
  readonly service: "api";
}

export interface GroupDirectoryReconciliationCompletedEvent {
  readonly appliedCount?: number | undefined;
  readonly event: "group_directory.reconciliation.completed";
  readonly outcome: "failed" | "success";
  readonly service: "api";
  readonly unjoinedCount?: number | undefined;
}

export interface ProviderDirectoryCompletedEvent {
  readonly attemptCount: number;
  readonly durationMs: number;
  readonly event: "provider.directory.completed";
  readonly operation: "safe-read";
  readonly outcome: "complete" | "failed" | "partial";
  readonly responseBytes: number;
  readonly service: "api";
}

export interface ContactReconciliationCompletedEvent {
  readonly contactCount: number;
  readonly event: "directory.contacts.reconciliation.completed";
  readonly outcome: "complete" | "failed" | "partial";
  readonly service: "api";
}

export interface DirectoryProviderReadCompletedEvent {
  readonly attempts: number;
  readonly durationMs: number;
  readonly event: "directory.provider_read.completed";
  readonly operation: "safe-read";
  readonly outcome: "complete" | "failed" | "partial";
  readonly responseBytes: number;
  readonly service: "api";
}

export interface ProviderTextSendCompletedEvent {
  readonly attemptCount: 0 | 1;
  readonly durationMs: number;
  readonly event: "provider.text_send.completed";
  readonly operationClass: "text-send";
  readonly outcome:
    | "ambiguous"
    | "definitive_failure"
    | "identity_evidence"
    | "provider_acknowledgement";
  readonly responseBytes: number | null;
  readonly service: "api";
}

export interface SendDispatchLeaseSweepCompletedEvent {
  readonly event: "send.dispatch_lease.sweep_completed";
  readonly expiredCount: number;
  readonly service: "api";
}

export interface MessageRetentionPolicyUpdateCompletedEvent {
  readonly event: "message_retention.policy_update.completed";
  readonly outcome: "conflict_or_not_found" | "success";
  readonly service: "api";
}

export interface MessageRetentionPurgeCompletedEvent {
  readonly event: "message_retention.purge.completed";
  readonly purgedCount: number;
  readonly service: "api";
}

export interface SafeTelemetry {
  readonly emit: (event: SafeTelemetryEvent) => Effect.Effect<void>;
}

export type SafeTelemetryEvent =
  | ContactReconciliationCompletedEvent
  | DirectoryProviderReadCompletedEvent
  | ConnectionHealthReconciliationCompletedEvent
  | ConnectionSetupCancelCompletedEvent
  | ConnectionSetupCleanupCompletedEvent
  | ConnectionSetupCleanupRecoveryEnqueuedEvent
  | ConnectionSetupProvisionCompletedEvent
  | ConnectionSetupProvisionRecoveryEnqueuedEvent
  | ConnectionSetupQrCompletedEvent
  | ConnectionSetupStartCompletedEvent
  | GroupDirectoryReconciliationCompletedEvent
  | HttpCompletedEvent
  | McpAuthorizationManagementCompletedEvent
  | McpToolCallCompletedEvent
  | MessageRetentionPolicyUpdateCompletedEvent
  | MessageRetentionPurgeCompletedEvent
  | OAuthAuthorizationDecisionCompletedEvent
  | OAuthAuthorizationRequestCompletedEvent
  | OAuthProtocolRequestFailedEvent
  | OAuthRefreshCompletedEvent
  | PersonalAccountBootstrapCompletedEvent
  | PersonalAccountDeletionCompletedEvent
  | ProviderDirectoryCompletedEvent
  | ProviderTextSendCompletedEvent
  | SendDispatchLeaseSweepCompletedEvent
  | StoredMediaContainerEvent
  | ToolCallLogReviewCompletedEvent
  | WebhookEventDeadLetterCompletedEvent
  | WebhookEventReplayCompletedEvent
  | WebhookEventSourceRetentionCompletedEvent
  | WebhookEventProcessingCompletedEvent
  | WebhookIngressCompletedEvent
  | WebhookIngressRecoveryCompletedEvent
  | WhatsAppConnectionLifecycleCompletedEvent
  | WhatsAppConnectionDeletionCompletedEvent
  | WhatsAppConnectionDeletionDeadlineRiskEvent
  | WhatsAppConnectionListCompletedEvent;

export const SafeTelemetry = Context.GenericTag<SafeTelemetry>(
  "@whatsapp-mcp/api/SafeTelemetry",
);
