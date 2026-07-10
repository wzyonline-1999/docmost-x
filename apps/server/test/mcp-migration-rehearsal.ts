import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Kysely, Migrator, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';

const MCP_MIGRATION_COUNT = 5;
const SAFE_DATABASE_NAME = /^docmost_mcp_migration_test_[a-z0-9_-]+$/i;
const SAFE_SCHEMA_NAME = /^[a-z][a-z0-9_]*$/;
const MCP_TABLES = [
  'mcp_clients',
  'mcp_client_space_permissions',
  'mcp_audit_logs',
  'mcp_idempotency_keys',
  'docmost_mcp_chunks',
  'docmost_mcp_index_jobs',
];
const REQUIRED_INDEXES = [
  'idx_mcp_clients_token_hash_alive',
  'idx_mcp_clients_workspace_status',
  'idx_mcp_clients_expires_at',
  'idx_mcp_client_space_permissions_alive',
  'idx_mcp_client_space_permissions_workspace_space',
  'idx_mcp_audit_logs_workspace_created',
  'idx_mcp_audit_logs_client_created',
  'idx_mcp_audit_logs_resource_created',
  'idx_mcp_idempotency_keys_alive',
  'idx_mcp_idempotency_keys_workspace_created',
  'idx_mcp_idempotency_keys_status_lease',
  'idx_docmost_mcp_chunks_page_chunk_alive',
  'idx_docmost_mcp_chunks_workspace_space_page',
  'idx_docmost_mcp_chunks_workspace_updated',
  'idx_docmost_mcp_chunks_content_hash',
  'idx_docmost_mcp_chunks_embedding_hnsw',
  'idx_docmost_mcp_index_jobs_workspace_status',
  'idx_docmost_mcp_index_jobs_workspace_page',
  'idx_docmost_mcp_index_jobs_active_dedupe',
];
const REQUIRED_CONSTRAINTS = [
  'mcp_clients_status_check',
  'mcp_idempotency_keys_status_check',
  'docmost_mcp_index_jobs_type_check',
  'docmost_mcp_index_jobs_status_check',
];

type DatabaseRow = { currentDatabase: string };
type NameRow = { name: string };

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert(databaseUrl, 'DATABASE_URL is required');

  const parsedUrl = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
  const schemaName = process.env.MCP_MIGRATION_TEST_SCHEMA ?? 'public';
  assert(
    SAFE_DATABASE_NAME.test(databaseName),
    `Refusing to run against non-disposable database "${databaseName}"`,
  );
  assert(
    SAFE_SCHEMA_NAME.test(schemaName),
    `Refusing to use unsafe test schema "${schemaName}"`,
  );

  const postgresClient = postgres(databaseUrl, { max: 1 });
  const db = new Kysely<any>({
    dialect: new PostgresJSDialect({ postgres: postgresClient }),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(__dirname, '../src/database/migrations'),
    }),
  });

  try {
    const currentDatabase = await sql<DatabaseRow>`
      SELECT current_database() AS "currentDatabase"
    `.execute(db);
    assert.equal(currentDatabase.rows[0]?.currentDatabase, databaseName);

    if (schemaName !== 'public') {
      await db.schema.createSchema(schemaName).ifNotExists().execute();
    }
    await sql.raw(`SET search_path TO "${schemaName}"`).execute(db);

    await assertMigrationResult(
      'initial migrateToLatest',
      migrator.migrateToLatest(),
    );
    await assertMcpSchema(db, schemaName);

    const sentinelName = `mcp-migration-sentinel-${Date.now()}`;
    const sentinel = await sql<{ id: string }>`
      INSERT INTO workspaces (name) VALUES (${sentinelName})
      RETURNING id::text AS id
    `.execute(db);
    const sentinelWorkspaceId = sentinel.rows[0]?.id;
    assert(sentinelWorkspaceId, 'Failed to create base-data sentinel');
    await assertPostgresBoundaries(db, sentinelWorkspaceId);

    const rolledBackMigrations: string[] = [];
    for (let index = 0; index < MCP_MIGRATION_COUNT; index += 1) {
      const result = await assertMigrationResult(
        `migrateDown ${index + 1}`,
        migrator.migrateDown(),
      );
      const migrationName = result.results?.[0]?.migrationName;
      assert(
        migrationName,
        `migrateDown ${index + 1} did not roll back a migration`,
      );
      rolledBackMigrations.push(migrationName);
    }

    const tablesAfterDown = await getTableNames(db, schemaName);
    for (const table of MCP_TABLES) {
      assert(
        !tablesAfterDown.has(table),
        `${table} still exists after rollback`,
      );
    }
    for (const table of ['workspaces', 'spaces', 'pages', 'users']) {
      assert(
        tablesAfterDown.has(table),
        `${table} was removed by MCP rollback`,
      );
    }

    const sentinelCount = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM workspaces
      WHERE name = ${sentinelName}
    `.execute(db);
    assert.equal(
      sentinelCount.rows[0]?.count,
      1,
      'Base Docmost data was not preserved',
    );

    await assertMigrationResult(
      'second migrateToLatest',
      migrator.migrateToLatest(),
    );
    await assertMcpSchema(db, schemaName);

    process.stdout.write(
      `${JSON.stringify(
        {
          database: databaseName,
          schema: schemaName,
          sequence: 'latest -> down x5 -> latest',
          rolledBackMigrations,
          mcpTableCount: MCP_TABLES.length,
          requiredIndexCount: REQUIRED_INDEXES.length,
          requiredConstraintCount: REQUIRED_CONSTRAINTS.length,
          baseDataPreserved: true,
          exposedRoleGrants: 0,
          status: 'passed',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await db.destroy();
  }
}

async function assertMigrationResult(
  stage: string,
  pendingResult: ReturnType<Migrator['migrateToLatest']>,
) {
  const result = await pendingResult;
  if (result.error) {
    throw new Error(`${stage} failed`);
  }
  const failedMigration = result.results?.find(
    (item) => item.status === 'Error',
  );
  assert(
    !failedMigration,
    `${stage} failed at ${failedMigration?.migrationName}`,
  );
  return result;
}

async function assertMcpSchema(
  db: Kysely<any>,
  schemaName: string,
): Promise<void> {
  const tableNames = await getTableNames(db, schemaName);
  for (const table of MCP_TABLES) {
    assert(tableNames.has(table), `${table} is missing after migration`);
  }

  const extension = await sql<NameRow>`
    SELECT extname AS name FROM pg_extension WHERE extname = 'vector'
  `.execute(db);
  assert.equal(
    extension.rows[0]?.name,
    'vector',
    'pgvector extension is missing',
  );

  const vectorColumn = await sql<{ declaredType: string }>`
    SELECT format_type(attribute.atttypid, attribute.atttypmod) AS "declaredType"
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schemaName}
      AND relation.relname = 'docmost_mcp_chunks'
      AND attribute.attname = 'embedding'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `.execute(db);
  assert.equal(vectorColumn.rows[0]?.declaredType, 'vector(1536)');

  const indexes = await sql<NameRow>`
    SELECT indexname AS name FROM pg_indexes WHERE schemaname = ${schemaName}
  `.execute(db);
  const indexNames = new Set(indexes.rows.map((row) => row.name));
  for (const index of REQUIRED_INDEXES) {
    assert(indexNames.has(index), `${index} is missing after migration`);
  }

  const constraints = await sql<NameRow>`
    SELECT constraint_row.conname AS name
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schemaName}
  `.execute(db);
  const constraintNames = new Set(constraints.rows.map((row) => row.name));
  for (const constraint of REQUIRED_CONSTRAINTS) {
    assert(
      constraintNames.has(constraint),
      `${constraint} is missing after migration`,
    );
  }

  const grants = await sql<{
    grantee: string;
    tableName: string;
    privilegeType: string;
  }>`
    SELECT
      grantee,
      table_name AS "tableName",
      privilege_type AS "privilegeType"
    FROM information_schema.role_table_grants
    WHERE table_schema = ${schemaName}
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  `.execute(db);
  const exposedGrants = grants.rows.filter((row) =>
    MCP_TABLES.includes(row.tableName),
  );
  assert.deepEqual(
    exposedGrants,
    [],
    'MCP tables grant privileges to a Data API/public role',
  );
}

async function assertPostgresBoundaries(
  db: Kysely<any>,
  workspaceId: string,
): Promise<void> {
  const specialQuery = '"alpha beta" OR -secret 中文 & !';
  const parsedQuery = await sql<{ query: string }>`
    SELECT websearch_to_tsquery('english', f_unaccent(${specialQuery}))::text AS query
  `.execute(db);
  assert(
    parsedQuery.rows[0]?.query,
    'Special-character search query was not parsed',
  );

  await sql`
    INSERT INTO mcp_audit_logs (
      workspace_id,
      event,
      resource_type,
      tool_name,
      request_id,
      ip_address
    ) VALUES
      (${workspaceId}::uuid, 'mcp.test.ipv4', 'test', 'migration_rehearsal', 'ipv4', ${'127.0.0.1'}::inet),
      (${workspaceId}::uuid, 'mcp.test.ipv6', 'test', 'migration_rehearsal', 'ipv6', ${'2001:db8::1'}::inet),
      (${workspaceId}::uuid, 'mcp.test.null_ip', 'test', 'migration_rehearsal', 'null', NULL)
  `.execute(db);

  const auditIps = await sql<{ requestId: string; ipAddress: string | null }>`
    SELECT request_id AS "requestId", host(ip_address) AS "ipAddress"
    FROM mcp_audit_logs
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY request_id
  `.execute(db);
  assert.deepEqual(auditIps.rows, [
    { requestId: 'ipv4', ipAddress: '127.0.0.1' },
    { requestId: 'ipv6', ipAddress: '2001:db8::1' },
    { requestId: 'null', ipAddress: null },
  ]);
}

async function getTableNames(
  db: Kysely<any>,
  schemaName: string,
): Promise<Set<string>> {
  const tables = await sql<NameRow>`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = ${schemaName} AND table_type = 'BASE TABLE'
  `.execute(db);
  return new Set(tables.rows.map((row) => row.name));
}

void main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`MCP migration rehearsal failed (${errorType})\n`);
  process.exitCode = 1;
});
