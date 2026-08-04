import pg from "pg";

const { Client } = pg;

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required");
}

const sourceSchemas = ["app", "app_private"] as const;
const excludedTables = new Set(["drizzle_migrations", "schema_migrations"]);

const identifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

interface TableRow extends Record<string, unknown> {
  readonly schema_name: string;
  readonly table_name: string;
}

interface ColumnRow extends Record<string, unknown> {
  readonly column_name: string;
}

interface ForeignKeyRow extends Record<string, unknown> {
  readonly child_schema: string;
  readonly child_table: string;
  readonly parent_schema: string;
  readonly parent_table: string;
}

const tableKey = (schema: string, table: string): string =>
  `${schema}.${table}`;

const source = new Client({ connectionString: sourceUrl });
const target = new Client({ connectionString: targetUrl });

await source.connect();
await target.connect();

try {
  const tablesResult = await source.query<TableRow>(
    `SELECT schemaname AS schema_name, tablename AS table_name
     FROM pg_catalog.pg_tables
     WHERE schemaname = ANY($1::text[])
     ORDER BY schemaname, tablename`,
    [sourceSchemas],
  );
  const sourceTables = tablesResult.rows.filter(
    ({ table_name }) => !excludedTables.has(table_name),
  );
  if (sourceTables.length === 0)
    throw new Error("source database has no application tables");

  const targetTablesResult = await target.query<{ table_name: string }>(
    `SELECT tablename AS table_name
     FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'`,
  );
  const targetTables = new Set(
    targetTablesResult.rows.map(({ table_name }) => table_name),
  );
  const tables = sourceTables.filter(({ table_name }) =>
    targetTables.has(table_name),
  );
  const requiredConnectionTables = [
    "clerk_identities",
    "personal_account_key_envelopes",
    "personal_accounts",
    "whatsapp_connection_key_envelopes",
    "whatsapp_connection_provider_sessions",
    "whatsapp_connection_secrets",
    "whatsapp_connections",
  ];
  const copiedTableNames = new Set(tables.map(({ table_name }) => table_name));
  for (const tableName of requiredConnectionTables) {
    if (!copiedTableNames.has(tableName)) {
      throw new Error(`required connection table is missing: ${tableName}`);
    }
  }

  const populatedTarget = await target.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'drizzle_migrations'
       AND table_name <> 'schema_migrations'
       AND (xpath('/row/count/text()', query_to_xml(
         format('SELECT count(*) AS count FROM public.%I', table_name),
         false, true, ''
       )))[1]::text::bigint > 0
     LIMIT 1`,
  );
  if (populatedTarget.rowCount !== 0) {
    throw new Error("target application tables must be empty before migration");
  }

  const foreignKeys = await source.query<ForeignKeyRow>(
    `SELECT
       child_namespace.nspname AS child_schema,
       child.relname AS child_table,
       parent_namespace.nspname AS parent_schema,
       parent.relname AS parent_table
     FROM pg_catalog.pg_constraint constraint_record
     JOIN pg_catalog.pg_class child ON child.oid = constraint_record.conrelid
     JOIN pg_catalog.pg_namespace child_namespace
       ON child_namespace.oid = child.relnamespace
     JOIN pg_catalog.pg_class parent ON parent.oid = constraint_record.confrelid
     JOIN pg_catalog.pg_namespace parent_namespace
       ON parent_namespace.oid = parent.relnamespace
     WHERE constraint_record.contype = 'f'
       AND child_namespace.nspname = ANY($1::text[])
       AND parent_namespace.nspname = ANY($1::text[])`,
    [sourceSchemas],
  );

  const remaining = new Map(
    tables.map((table) => [
      tableKey(table.schema_name, table.table_name),
      table,
    ]),
  );
  const ordered: TableRow[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([key]) =>
      foreignKeys.rows.every((foreignKey) => {
        const child = tableKey(foreignKey.child_schema, foreignKey.child_table);
        const parent = tableKey(
          foreignKey.parent_schema,
          foreignKey.parent_table,
        );
        return child !== key || child === parent || !remaining.has(parent);
      }),
    );
    if (ready.length === 0) {
      throw new Error("source table dependencies contain a migration cycle");
    }
    for (const [key, table] of ready) {
      remaining.delete(key);
      ordered.push(table);
    }
  }

  await target.query("BEGIN");
  const counts = new Map<string, number>();
  try {
    for (const { schema_name, table_name } of ordered) {
      const columnsResult = await source.query<ColumnRow>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema_name, table_name],
      );
      const columns = columnsResult.rows.map(({ column_name }) => column_name);
      const columnSql = columns.map(identifier).join(", ");
      const rows = await source.query<Record<string, unknown>>(
        `SELECT ${columnSql} FROM ${identifier(schema_name)}.${identifier(table_name)}`,
      );
      const insertSql = `INSERT INTO public.${identifier(table_name)} (${columnSql}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`;
      for (const row of rows.rows) {
        await target.query(
          insertSql,
          columns.map((column) => row[column]),
        );
      }
      counts.set(table_name, rows.rowCount ?? 0);
    }
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }

  const connectionCount = counts.get("whatsapp_connections") ?? 0;
  const providerSessionCount =
    counts.get("whatsapp_connection_provider_sessions") ?? 0;
  if (connectionCount !== providerSessionCount) {
    throw new Error(
      "migrated WhatsApp Connections and provider sessions do not match",
    );
  }
  console.log(
    JSON.stringify({
      migratedRows: [...counts.values()].reduce((sum, count) => sum + count, 0),
      migratedTables: counts.size,
      providerSessions: providerSessionCount,
      whatsappConnections: connectionCount,
    }),
  );
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
