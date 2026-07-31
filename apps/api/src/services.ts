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

export interface SafeTelemetry {
  readonly emit: (event: SafeTelemetryEvent) => Effect.Effect<void>;
}

export type SafeTelemetryEvent =
  | ConnectionSetupProvisionCompletedEvent
  | ConnectionSetupProvisionRecoveryEnqueuedEvent
  | ConnectionSetupQrCompletedEvent
  | ConnectionSetupStartCompletedEvent
  | HttpCompletedEvent
  | OAuthAuthorizationDecisionCompletedEvent
  | OAuthAuthorizationRequestCompletedEvent
  | OAuthProtocolRequestFailedEvent
  | OAuthRefreshCompletedEvent
  | PersonalAccountBootstrapCompletedEvent
  | StoredMediaContainerEvent
  | WhatsAppConnectionListCompletedEvent;

export const SafeTelemetry = Context.GenericTag<SafeTelemetry>(
  "@whatsapp-mcp/api/SafeTelemetry",
);
