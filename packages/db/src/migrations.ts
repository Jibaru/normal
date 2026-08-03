import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL as NodeUrl } from "node:url";

export { EXPECTED_SCHEMA_VERSION } from "./schema-version";

import { EXPECTED_SCHEMA_VERSION } from "./schema-version";

const migrationLockId = "8604232831919288432";

export interface QueryResult<Row extends Record<string, unknown>> {
  readonly rows: Array<Row>;
}

export interface MigrationConnection {
  readonly exec?: (text: string) => Promise<unknown>;
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<QueryResult<Row>>;
}

interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

const loadMigrations = async (): Promise<Array<Migration>> => [
  {
    name: "tenant isolation",
    sql: await readFile(
      new NodeUrl("../migrations/0001_tenant_isolation.sql", import.meta.url),
      "utf8",
    ),
    version: 1,
  },
  {
    name: "restore-safe key unavailability",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0002_restore_safe_key_unavailability.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 2,
  },
  {
    name: "Personal Account bootstrap",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0003_personal_account_bootstrap.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 3,
  },
  {
    name: "private-beta admission",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0004_private_beta_admission.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 4,
  },
  {
    name: "Connection Setups",
    sql: await readFile(
      new NodeUrl("../migrations/0005_connection_setups.sql", import.meta.url),
      "utf8",
    ),
    version: 5,
  },
  {
    name: "explicit MCP Authorizations",
    sql: await readFile(
      new NodeUrl("../migrations/0006_mcp_authorizations.sql", import.meta.url),
      "utf8",
    ),
    version: 6,
  },
  {
    name: "rotating MCP refresh credentials",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0007_rotating_refresh_credentials.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 7,
  },
  {
    name: "reconciled Connection Setup provisioning",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0008_connection_setup_provisioning.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 8,
  },
  {
    name: "MCP Authorization management",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0009_mcp_authorization_management.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 9,
  },
  {
    name: "cancelled and expired Connection Setup cleanup",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0010_connection_setup_cleanup.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 10,
  },
  {
    name: "WhatsApp Connection activation",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0011_whatsapp_connection_activation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 11,
  },
  {
    name: "authenticated Webhook Event ingress",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0012_authenticated_webhook_ingress.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 12,
  },
  {
    name: "WhatsApp Connection lifecycle reconciliation",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0013_whatsapp_connection_lifecycle.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 13,
  },
  {
    name: "Webhook Event normalization and connection-state projection",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0014_webhook_event_projection.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 14,
  },
  {
    name: "connection health reconciliation and Ingestion Gaps",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0015_connection_health_and_ingestion_gaps.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 15,
  },
  {
    name: "Webhook Event orphan and transient recovery",
    sql: await readFile(
      new NodeUrl("../migrations/0016_webhook_recovery.sql", import.meta.url),
      "utf8",
    ),
    version: 16,
  },
  {
    name: "audited MCP tools",
    sql: await readFile(
      new NodeUrl("../migrations/0017_audited_mcp_tools.sql", import.meta.url),
      "utf8",
    ),
    version: 17,
  },
  {
    name: "encrypted WhatsApp group projections",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0018_whatsapp_group_projection.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 18,
  },
  {
    name: "encrypted Directory contact projection",
    sql: await readFile(
      new NodeUrl("../migrations/0019_directory_contacts.sql", import.meta.url),
      "utf8",
    ),
    version: 19,
  },
  {
    name: "per-contact Directory snapshot evidence",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0020_contact_snapshot_evidence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 20,
  },
  {
    name: "atomic text sends",
    sql: await readFile(
      new NodeUrl("../migrations/0021_atomic_text_sends.sql", import.meta.url),
      "utf8",
    ),
    version: 21,
  },
  {
    name: "Stored Messages and WhatsApp Conversations",
    sql: await readFile(
      new NodeUrl("../migrations/0022_stored_messages.sql", import.meta.url),
      "utf8",
    ),
    version: 22,
  },
  {
    name: "Directory freshness and partiality",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0023_directory_freshness.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 23,
  },
  {
    name: "immutable Webhook Event replay and source retention",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0024_webhook_replay_and_retention.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 24,
  },
  {
    name: "core read_messages traversal",
    sql: await readFile(
      new NodeUrl("../migrations/0025_read_messages.sql", import.meta.url),
      "utf8",
    ),
    version: 25,
  },
  {
    name: "contained send dispatch leases",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0026_send_dispatch_leases.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 26,
  },
  {
    name: "message edit convergence and deletion tombstones",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0027_message_convergence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 27,
  },
  {
    name: "Send Status convergence",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0028_send_status_convergence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 28,
  },
  {
    name: "encrypted Stored Media ingestion",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0029_stored_media_ingestion.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 29,
  },
  {
    name: "outbound Stored Message correlation",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0030_outbound_stored_message_correlation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 30,
  },
  {
    name: "protected Stored Media resources",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0031_protected_stored_media.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 31,
  },
  {
    name: "Message Retention Policy management and enforcement",
    sql: await readFile(
      new NodeUrl("../migrations/0032_message_retention.sql", import.meta.url),
      "utf8",
    ),
    version: 32,
  },
  {
    name: "terminal Connection Deletion",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0033_connection_deletion.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 33,
  },
  {
    name: "complete Connection Deletion cleanup",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0034_connection_deletion_cleanup.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 34,
  },
  {
    name: "unified Personal Account Deletion",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0035_personal_account_deletion.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 35,
  },
  {
    name: "Tool Call Log review and expiry",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0036_tool_call_log_review.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 36,
  },
  {
    name: "Tool Call Log review hardening",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0037_tool_call_log_review_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 37,
  },
  {
    name: "two-person break-glass access",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0038_two_person_break_glass.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 38,
  },
  {
    name: "safe Personal Account purge",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0039_personal_account_purge.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 39,
  },
  {
    name: "restore deletion and expiry replay gate",
    sql: await readFile(
      new NodeUrl(
        "../migrations/0040_restore_replay_gate.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    version: 40,
  },
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

export class MigrationDriftError extends Error {
  readonly actualChecksum: string;
  readonly expectedChecksum: string;
  readonly version: number;

  constructor(
    version: number,
    expectedChecksum: string,
    actualChecksum: string,
  ) {
    super(`migration ${version} checksum does not match the applied migration`);
    this.name = "MigrationDriftError";
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export class UnexpectedSchemaVersion extends Error {
  readonly actual: number;
  readonly expected: number;

  constructor(actual: number, expected: number) {
    super(
      `database schema version ${actual} is newer than expected ${expected}`,
    );
    this.name = "UnexpectedSchemaVersion";
    this.actual = actual;
    this.expected = expected;
  }
}

export const runMigrations = async (
  connection: MigrationConnection,
): Promise<void> => {
  const migrations = await loadMigrations();

  await connection.query("SELECT pg_catalog.pg_advisory_lock($1::bigint)", [
    migrationLockId,
  ]);

  try {
    await connection.query("CREATE SCHEMA IF NOT EXISTS app_private");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )
    `);

    const applied = await connection.query<{
      checksum: string;
      version: number;
    }>(
      "SELECT version, checksum FROM app_private.schema_migrations ORDER BY version",
    );
    const latestApplied = applied.rows.at(-1)?.version ?? 0;

    if (latestApplied > EXPECTED_SCHEMA_VERSION) {
      throw new UnexpectedSchemaVersion(latestApplied, EXPECTED_SCHEMA_VERSION);
    }

    for (const migration of migrations) {
      const appliedMigration = applied.rows.find(
        ({ version }) => version === migration.version,
      );
      const expectedChecksum = checksum(migration.sql);

      if (appliedMigration) {
        if (appliedMigration.checksum !== expectedChecksum) {
          throw new MigrationDriftError(
            migration.version,
            expectedChecksum,
            appliedMigration.checksum,
          );
        }
        continue;
      }

      await connection.query("BEGIN");
      try {
        if (connection.exec) {
          await connection.exec(migration.sql);
        } else {
          await connection.query(migration.sql);
        }
        await connection.query(
          `INSERT INTO app_private.schema_migrations
            (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, expectedChecksum],
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await connection.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [
      migrationLockId,
    ]);
  }
};
