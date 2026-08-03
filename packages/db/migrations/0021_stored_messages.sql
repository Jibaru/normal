CREATE TABLE app.whatsapp_conversations (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^cvs_[A-Za-z0-9_-]{21}$'),
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  recipient_locator text NOT NULL CHECK (recipient_locator ~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'),
  recipient_public_id text NOT NULL CHECK (recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'),
  last_activity_at timestamptz NOT NULL,
  last_activity_direction text NOT NULL CHECK (last_activity_direction IN ('inbound', 'outbound')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, whatsapp_connection_id, recipient_locator),
  UNIQUE (personal_account_id, whatsapp_connection_id, id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE
);

CREATE TABLE app.stored_messages (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^msg_[A-Za-z0-9_-]{21}$'),
  message_identity text NOT NULL CHECK (message_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at timestamptz NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('audio','document','image','sticker','text','unknown','video')),
  content_ciphertext_version smallint NOT NULL CHECK (content_ciphertext_version = 1),
  content_key_version integer NOT NULL CHECK (content_key_version > 0),
  content_nonce bytea NOT NULL CHECK (octet_length(content_nonce) = 12),
  content_ciphertext bytea NOT NULL CHECK (octet_length(content_ciphertext) > 16),
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  webhook_event_id uuid,
  webhook_item_identity text NOT NULL CHECK (webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, whatsapp_connection_id, message_identity),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id, conversation_id)
    REFERENCES app.whatsapp_conversations (personal_account_id, whatsapp_connection_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id, webhook_event_id)
    REFERENCES app.webhook_events (personal_account_id, whatsapp_connection_id, id) ON DELETE SET NULL (webhook_event_id),
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512)
);

CREATE INDEX whatsapp_conversations_activity_order ON app.whatsapp_conversations
  (personal_account_id, whatsapp_connection_id, last_activity_at DESC, public_id);

ALTER TABLE app.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.stored_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stored_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_conversations_tenant ON app.whatsapp_conversations
  USING (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid);
CREATE POLICY stored_messages_tenant ON app.stored_messages
  USING (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.whatsapp_conversations, app.stored_messages TO whatsapp_api_runtime;
