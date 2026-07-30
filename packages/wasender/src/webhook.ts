import { Context } from "effect";
import type { AdapterEffect, AdapterReference, UtcTimestamp } from "./common";
import type { LifecycleConnectionState } from "./control";
import type {
  ContactLocator,
  ConvergenceVersion,
  DirectoryContact,
  DirectoryGroup,
  IdentityBearingSendStatus,
  MediaSource,
  RecipientLocator,
  StableMessageIdentity,
} from "./session";

export type {
  AdapterFailureCode,
  OperationClass,
  ProviderNeutralFailure,
  RetryDecision,
} from "./common";

export type WebhookItemIdentity = AdapterReference<"WebhookItemIdentity">;

export interface ConvergenceEvidence {
  readonly occurredAt: UtcTimestamp | null;
  /**
   * An adapter-private equality token, never a raw provider version.
   */
  readonly version: ConvergenceVersion | null;
}

export type NormalizedContentType =
  | "audio"
  | "document"
  | "image"
  | "sticker"
  | "text"
  | "unknown"
  | "video";

export interface NormalizedMessageContent {
  readonly mediaSource: MediaSource | null;
  readonly text: string | null;
  readonly type: NormalizedContentType;
}

interface NormalizedItemBase {
  readonly evidence: ConvergenceEvidence;
  readonly itemIdentity: WebhookItemIdentity | null;
  readonly itemIndex: number;
}

export interface NormalizedMessageUpsert extends NormalizedItemBase {
  readonly content: NormalizedMessageContent;
  readonly direction: "inbound" | "outbound";
  readonly kind: "message_upsert";
  readonly messageIdentity: StableMessageIdentity;
  readonly recipient: RecipientLocator;
  readonly sender: ContactLocator | null;
  readonly sentAt: UtcTimestamp;
}

export interface NormalizedMessageEdit extends NormalizedItemBase {
  readonly content: NormalizedMessageContent;
  readonly editedAt: UtcTimestamp;
  readonly kind: "message_edit";
  readonly messageIdentity: StableMessageIdentity;
}

export interface NormalizedMessageDeletion extends NormalizedItemBase {
  readonly deletedAt: UtcTimestamp;
  readonly kind: "message_delete";
  readonly messageIdentity: StableMessageIdentity;
}

export interface NormalizedSendEvidence extends NormalizedItemBase {
  readonly direction: "outbound";
  readonly kind: "send_evidence";
  readonly messageIdentity: StableMessageIdentity;
  readonly status: IdentityBearingSendStatus | "failed";
}

export interface NormalizedDirectoryContact extends NormalizedItemBase {
  readonly contact: DirectoryContact;
  readonly kind: "directory_contact";
}

export interface NormalizedDirectoryGroup extends NormalizedItemBase {
  readonly group: DirectoryGroup;
  readonly kind: "directory_group";
}

export interface NormalizedConnectionState extends NormalizedItemBase {
  readonly kind: "connection_state";
  readonly state: LifecycleConnectionState;
}

export interface UnsupportedWebhookItem {
  readonly classification: "unsupported_item_kind";
  readonly itemIndex: number;
  readonly kind: "unsupported";
}

export interface MalformedWebhookItem {
  readonly classification:
    | "invalid_item_shape"
    | "invalid_top_level_shape"
    | "missing_required_identity";
  readonly itemIndex: number | null;
  readonly kind: "malformed";
}

export type NormalizedWebhookItem =
  | MalformedWebhookItem
  | NormalizedConnectionState
  | NormalizedDirectoryContact
  | NormalizedDirectoryGroup
  | NormalizedMessageDeletion
  | NormalizedMessageEdit
  | NormalizedMessageUpsert
  | NormalizedSendEvidence
  | UnsupportedWebhookItem;

export interface NormalizedWebhookDelivery {
  readonly items: ReadonlyArray<NormalizedWebhookItem>;
}

/**
 * Raw bytes enter only here. Unsupported and malformed logical items are
 * returned as safe classifications so valid siblings remain processable.
 */
export interface WebhookNormalization {
  readonly normalize: (request: {
    readonly payload: Uint8Array;
    readonly receivedAt: UtcTimestamp;
  }) => AdapterEffect<NormalizedWebhookDelivery>;
}

export const WebhookNormalization = Context.GenericTag<WebhookNormalization>(
  "@whatsapp-mcp/wasender/WebhookNormalization",
);

export const webhookNormalizationPolicy = {
  maximumPayloadBytes: 1_048_576,
  operationClass: "webhook-normalization",
} as const;
