import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Kysely, Migrator, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';

const MCP_MIGRATION_COUNT = 8;
const OWNERSHIP_HARDENING_MIGRATION =
  '20260726T120000-mcp-client-ownership-hardening';
const PRODUCTION_HARDENING_MIGRATION =
  '20260727T120000-mcp-production-hardening';
const MIGRATION_REHEARSAL_EMBEDDING_MODEL =
  'migration-rehearsal-embedding-1536';
const SAFE_DATABASE_NAME = /^docmost_mcp_migration_test_[a-z0-9_-]+$/i;
const SAFE_SCHEMA_NAME = /^[a-z][a-z0-9_]*$/;
const MCP_TABLES = [
  'mcp_clients',
  'mcp_client_space_permissions',
  'mcp_audit_logs',
  'mcp_idempotency_keys',
  'docmost_mcp_chunks',
  'docmost_mcp_index_jobs',
  'docmost_mcp_eligibility_reconciliations',
];
const REQUIRED_INDEXES = [
  'idx_mcp_clients_token_hash_alive',
  'idx_mcp_clients_workspace_status',
  'idx_mcp_clients_expires_at',
  'idx_mcp_clients_workspace_owner',
  'uq_mcp_clients_id_workspace',
  'idx_mcp_client_space_permissions_alive',
  'idx_mcp_client_space_permissions_workspace_space',
  'uq_spaces_id_workspace',
  'uq_pages_id_workspace_space',
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
  'idx_docmost_mcp_index_jobs_parent_status',
  'idx_docmost_mcp_index_jobs_retention',
  'idx_docmost_mcp_chunks_model_retention',
  'idx_mcp_audit_logs_retention',
  'idx_mcp_eligibility_reconciliation_pending',
  'idx_attachments_content_index_recovery',
  'idx_attachments_deletion_recovery',
];
const REQUIRED_CONSTRAINTS = [
  'mcp_clients_status_check',
  'mcp_clients_scope_check',
  'mcp_clients_ownership_check',
  'mcp_permissions_client_workspace_fk',
  'mcp_permissions_space_workspace_fk',
  'mcp_idempotency_keys_status_check',
  'mcp_idempotency_keys_length_check',
  'mcp_idempotency_client_workspace_fk',
  'mcp_chunks_space_workspace_fk',
  'mcp_chunks_page_workspace_space_fk',
  'docmost_mcp_index_jobs_type_check',
  'docmost_mcp_index_jobs_status_check',
  'docmost_mcp_index_jobs_parent_fk',
  'mcp_index_jobs_space_workspace_fk',
  'mcp_index_jobs_requested_client_workspace_fk',
  'mcp_eligibility_space_workspace_fk',
  'mcp_eligibility_attempt_count_check',
  'mcp_audit_client_workspace_fk',
  'mcp_audit_space_workspace_fk',
  'attachments_content_index_status_check',
  'attachments_deletion_status_check',
  'attachments_content_index_attempt_count_check',
  'attachments_deletion_attempt_count_check',
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
    await assertLegacyOwnershipRepair(
      db,
      migrator,
      sentinelWorkspaceId,
      schemaName,
    );
    await assertProductionHardeningBoundaries(db, sentinelWorkspaceId);
    await assertFilteredHnswSearch(db, sentinelWorkspaceId);

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
          sequence: `latest -> down x${MCP_MIGRATION_COUNT} -> latest`,
          rolledBackMigrations,
          mcpTableCount: MCP_TABLES.length,
          requiredIndexCount: REQUIRED_INDEXES.length,
          requiredConstraintCount: REQUIRED_CONSTRAINTS.length,
          baseDataPreserved: true,
          exposedRoleGrants: 0,
          filteredHnswStrictOrder: true,
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

  const extension = await sql<NameRow & { version: string }>`
    SELECT extname AS name, extversion AS version
    FROM pg_extension
    WHERE extname = 'vector'
  `.execute(db);
  assert.equal(
    extension.rows[0]?.name,
    'vector',
    'pgvector extension is missing',
  );
  assert(
    isPgvectorVersionSupported(extension.rows[0]?.version),
    `pgvector 0.8.0 or newer is required, found ${
      extension.rows[0]?.version ?? 'missing'
    }`,
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

async function assertLegacyOwnershipRepair(
  db: Kysely<any>,
  migrator: Migrator,
  workspaceId: string,
  schemaName: string,
): Promise<void> {
  const productionRollback = await assertMigrationResult(
    'production hardening rehearsal down',
    migrator.migrateDown(),
  );
  assert.equal(
    productionRollback.results?.[0]?.migrationName,
    PRODUCTION_HARDENING_MIGRATION,
    'Production hardening must remain the latest migration',
  );

  const rollback = await assertMigrationResult(
    'ownership hardening rehearsal down',
    migrator.migrateDown(),
  );
  assert.equal(
    rollback.results?.[0]?.migrationName,
    OWNERSHIP_HARDENING_MIGRATION,
    'Ownership hardening must remain the latest migration',
  );

  const user = await sql<{ id: string }>`
    INSERT INTO users (email, name, role, workspace_id)
    VALUES (
      ${`mcp-migration-owner-${Date.now()}@example.test`},
      'MCP migration owner',
      'admin',
      ${workspaceId}
    )
    RETURNING id::text AS id
  `.execute(db);
  const ownerUserId = user.rows[0]?.id;
  assert(ownerUserId, 'Failed to create ownership migration user');

  const legacy = await sql<{ id: string }>`
    INSERT INTO mcp_clients (
      workspace_id,
      name,
      token_hash,
      token_last_four,
      status,
      global_scopes,
      actor_user_id,
      created_by_id,
      owner_user_id,
      scope
    )
    VALUES (
      ${workspaceId},
      'Legacy personal client without actor',
      ${`legacy-token-${Date.now()}`},
      'old1',
      'active',
      '{}'::jsonb,
      NULL,
      ${ownerUserId},
      ${ownerUserId},
      'personal'
    )
    RETURNING id::text AS id
  `.execute(db);
  const legacyClientId = legacy.rows[0]?.id;
  assert(legacyClientId, 'Failed to create legacy MCP client');

  const valid = await sql<{ id: string }>`
    INSERT INTO mcp_clients (
      workspace_id,
      name,
      token_hash,
      token_last_four,
      status,
      global_scopes,
      actor_user_id,
      created_by_id,
      owner_user_id,
      scope
    )
    VALUES (
      ${workspaceId},
      'Valid personal client',
      ${`valid-token-${Date.now()}`},
      'new1',
      'active',
      '{}'::jsonb,
      ${ownerUserId},
      ${ownerUserId},
      ${ownerUserId},
      'personal'
    )
    RETURNING id::text AS id
  `.execute(db);
  const validClientId = valid.rows[0]?.id;
  assert(validClientId, 'Failed to create valid MCP client');

  const workspaceClient = await sql<{ id: string }>`
    INSERT INTO mcp_clients (
      workspace_id,
      name,
      token_hash,
      token_last_four,
      status,
      global_scopes,
      actor_user_id,
      created_by_id,
      owner_user_id,
      scope
    )
    VALUES (
      ${workspaceId},
      'Legacy workspace client with owner',
      ${`workspace-token-${Date.now()}`},
      'ws01',
      'active',
      '{}'::jsonb,
      ${ownerUserId},
      ${ownerUserId},
      ${ownerUserId},
      'workspace'
    )
    RETURNING id::text AS id
  `.execute(db);
  const workspaceClientId = workspaceClient.rows[0]?.id;
  assert(workspaceClientId, 'Failed to create legacy workspace MCP client');

  await assertMigrationResult(
    'ownership hardening rehearsal up',
    migrator.migrateToLatest(),
  );
  await assertMcpSchema(db, schemaName);

  const clients = await sql<{
    id: string;
    actorUserId: string | null;
    ownerUserId: string | null;
    status: string;
  }>`
    SELECT
      id::text AS id,
      actor_user_id::text AS "actorUserId",
      owner_user_id::text AS "ownerUserId",
      status
    FROM mcp_clients
    WHERE id IN (${legacyClientId}, ${validClientId}, ${workspaceClientId})
  `.execute(db);
  const byId = new Map(clients.rows.map((client) => [client.id, client]));

  assert.deepEqual(byId.get(legacyClientId), {
    id: legacyClientId,
    actorUserId: ownerUserId,
    ownerUserId,
    status: 'disabled',
  });
  assert.deepEqual(byId.get(validClientId), {
    id: validClientId,
    actorUserId: ownerUserId,
    ownerUserId,
    status: 'active',
  });
  assert.deepEqual(byId.get(workspaceClientId), {
    id: workspaceClientId,
    actorUserId: ownerUserId,
    ownerUserId: null,
    status: 'active',
  });
}

async function assertProductionHardeningBoundaries(
  db: Kysely<any>,
  workspaceId: string,
): Promise<void> {
  const owner = await sql<{ id: string }>`
    INSERT INTO users (email, name, role, workspace_id)
    VALUES (
      ${`mcp-hardening-owner-${Date.now()}@example.test`},
      'MCP hardening owner',
      'admin',
      ${workspaceId}
    )
    RETURNING id::text AS id
  `.execute(db);
  const ownerUserId = owner.rows[0]?.id;
  assert(ownerUserId, 'Failed to create production-hardening owner');

  await assert.rejects(
    sql`
      INSERT INTO mcp_clients (
        workspace_id,
        name,
        token_hash,
        token_last_four,
        status,
        global_scopes,
        actor_user_id,
        owner_user_id,
        scope
      )
      VALUES (
        ${workspaceId},
        'Invalid personal ownership',
        ${`invalid-owner-${Date.now()}`},
        'bad1',
        'disabled',
        '{}'::jsonb,
        NULL,
        ${ownerUserId},
        'personal'
      )
    `.execute(db),
    /mcp_clients_ownership_check/,
  );

  const client = await sql<{ id: string }>`
    INSERT INTO mcp_clients (
      workspace_id,
      name,
      token_hash,
      token_last_four,
      status,
      global_scopes,
      actor_user_id,
      owner_user_id,
      scope
    )
    VALUES (
      ${workspaceId},
      'Hardening boundary client',
      ${`hardening-token-${Date.now()}`},
      'hard',
      'active',
      '{}'::jsonb,
      ${ownerUserId},
      ${ownerUserId},
      'personal'
    )
    RETURNING id::text AS id
  `.execute(db);
  const clientId = client.rows[0]?.id;
  assert(clientId, 'Failed to create hardening boundary client');

  await assert.rejects(
    sql`
      INSERT INTO mcp_idempotency_keys (
        client_id,
        workspace_id,
        idempotency_key,
        action,
        status
      )
      VALUES (
        ${clientId},
        ${workspaceId},
        ${'x'.repeat(201)},
        'migration_rehearsal',
        'in_progress'
      )
    `.execute(db),
    /mcp_idempotency_keys_length_check/,
  );

  const attachmentColumns = await sql<NameRow>`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'attachments'
      AND column_name IN (
        'content_index_status',
        'content_index_lease_owner',
        'content_index_lease_expires_at',
        'deletion_status',
        'deletion_attempt_count'
      )
  `.execute(db);
  assert.deepEqual(
    new Set(attachmentColumns.rows.map((row) => row.name)),
    new Set([
      'content_index_status',
      'content_index_lease_owner',
      'content_index_lease_expires_at',
      'deletion_status',
      'deletion_attempt_count',
    ]),
  );

  const triggerNames = await sql<NameRow>`
    SELECT trigger_name AS name
    FROM information_schema.triggers
    WHERE trigger_schema = current_schema()
      AND trigger_name LIKE 'trg_mcp_reconcile_%'
  `.execute(db);
  assert.deepEqual(
    new Set(triggerNames.rows.map((row) => row.name)),
    new Set([
      'trg_mcp_reconcile_space_members',
      'trg_mcp_reconcile_group_users',
      'trg_mcp_reconcile_users_status',
      'trg_mcp_reconcile_page_access',
      'trg_mcp_reconcile_page_permissions',
      'trg_mcp_reconcile_client_permissions',
      'trg_mcp_reconcile_clients',
      'trg_mcp_reconcile_pages',
      'trg_mcp_reconcile_spaces',
    ]),
  );

  const pageChunkForeignKey = await sql<{ updateAction: string }>`
    SELECT confupdtype::text AS "updateAction"
    FROM pg_constraint
    WHERE conname = 'mcp_chunks_page_workspace_space_fk'
  `.execute(db);
  assert.equal(
    pageChunkForeignKey.rows[0]?.updateAction,
    'c',
    'Page chunk ownership must cascade when a page moves between spaces',
  );

  const suffix = Date.now().toString(36);
  const space = await sql<{ id: string }>`
    INSERT INTO spaces (name, slug, workspace_id)
    VALUES (
      'MCP reconciliation rehearsal',
      ${`mcp-reconciliation-${suffix}`},
      ${workspaceId}::uuid
    )
    RETURNING id::text AS id
  `.execute(db);
  const spaceId = space.rows[0]?.id;
  assert(spaceId, 'Failed to create reconciliation rehearsal space');

  await sql`
    INSERT INTO space_members (space_id, user_id, role)
    VALUES (${spaceId}::uuid, ${ownerUserId}::uuid, 'admin')
  `.execute(db);
  await sql`
    INSERT INTO mcp_client_space_permissions (
      client_id,
      workspace_id,
      space_id,
      can_index
    )
    VALUES (
      ${clientId}::uuid,
      ${workspaceId}::uuid,
      ${spaceId}::uuid,
      true
    )
  `.execute(db);

  const queuedByPermission = await sql<{ reason: string }>`
    SELECT reason
    FROM docmost_mcp_eligibility_reconciliations
    WHERE workspace_id = ${workspaceId}::uuid
      AND space_id = ${spaceId}::uuid
  `.execute(db);
  assert.equal(queuedByPermission.rows[0]?.reason, 'mcp_permission');

  await sql`
    DELETE FROM docmost_mcp_eligibility_reconciliations
    WHERE workspace_id = ${workspaceId}::uuid
      AND space_id = ${spaceId}::uuid
  `.execute(db);
  await sql`
    UPDATE users
    SET deactivated_at = now()
    WHERE id = ${ownerUserId}::uuid
  `.execute(db);

  const queuedByUser = await sql<{ reason: string }>`
    SELECT reason
    FROM docmost_mcp_eligibility_reconciliations
    WHERE workspace_id = ${workspaceId}::uuid
      AND space_id = ${spaceId}::uuid
  `.execute(db);
  assert.equal(queuedByUser.rows[0]?.reason, 'user_status');
}

function isPgvectorVersionSupported(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 8;
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

async function assertFilteredHnswSearch(
  db: Kysely<any>,
  workspaceId: string,
): Promise<void> {
  const suffix = Date.now().toString(36);
  const space = await sql<{ id: string }>`
    INSERT INTO spaces (name, slug, workspace_id)
    VALUES (
      'MCP filtered HNSW rehearsal',
      ${`mcp-filtered-hnsw-${suffix}`},
      ${workspaceId}::uuid
    )
    RETURNING id::text AS id
  `.execute(db);
  const spaceId = space.rows[0]?.id;
  assert(spaceId, 'Failed to create filtered HNSW rehearsal space');

  const pages = await sql<{ id: string; title: string }>`
    INSERT INTO pages (slug_id, title, space_id, workspace_id)
    VALUES
      (
        ${`mcp-hnsw-distractor-${suffix}`},
        'HNSW distractor page',
        ${spaceId}::uuid,
        ${workspaceId}::uuid
      ),
      (
        ${`mcp-hnsw-scoped-${suffix}`},
        'HNSW scoped page',
        ${spaceId}::uuid,
        ${workspaceId}::uuid
      )
    RETURNING id::text AS id, title
  `.execute(db);
  const distractorPageId = pages.rows.find(
    (page) => page.title === 'HNSW distractor page',
  )?.id;
  const scopedPageId = pages.rows.find(
    (page) => page.title === 'HNSW scoped page',
  )?.id;
  assert(distractorPageId, 'Failed to create HNSW distractor page');
  assert(scopedPageId, 'Failed to create HNSW scoped page');

  await sql`
    INSERT INTO docmost_mcp_chunks (
      workspace_id,
      space_id,
      page_id,
      chunk_index,
      title,
      content,
      content_hash,
      embedding,
      embedding_model,
      embedding_dimensions,
      indexed_at
    )
    SELECT
      ${workspaceId}::uuid,
      ${spaceId}::uuid,
      CASE
        WHEN sample <= 96 THEN ${distractorPageId}::uuid
        ELSE ${scopedPageId}::uuid
      END,
      CASE WHEN sample <= 96 THEN sample - 1 ELSE sample - 97 END,
      CASE
        WHEN sample <= 96 THEN 'HNSW distractor'
        ELSE 'HNSW scoped result'
      END,
      'Filtered HNSW migration rehearsal chunk ' || sample,
      ${suffix} || '-chunk-' || sample,
      (
        ARRAY[
          CASE WHEN sample <= 96 THEN 1.0 ELSE 0.65 END::real,
          CASE
            WHEN sample <= 96 THEN sample / 100000.0
            ELSE 0.65 + (sample - 96) / 1000.0
          END::real
        ] || array_fill(0::real, ARRAY[1534])
      )::vector,
      ${MIGRATION_REHEARSAL_EMBEDDING_MODEL},
      1536,
      now()
    FROM generate_series(1, 128) AS sample
  `.execute(db);

  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL hnsw.iterative_scan = strict_order`.execute(trx);
    const setting = await sql<{ value: string }>`
      SELECT current_setting('hnsw.iterative_scan') AS value
    `.execute(trx);
    assert.equal(setting.rows[0]?.value, 'strict_order');

    await sql`SET LOCAL enable_seqscan = off`.execute(trx);
    const queryVector = sql`
      (ARRAY[1::real, 0::real] || array_fill(0::real, ARRAY[1534]))::vector
    `;
    const plan = await sql<Record<string, unknown>>`
      EXPLAIN (COSTS OFF)
      SELECT page_id
      FROM docmost_mcp_chunks
      WHERE workspace_id = ${workspaceId}::uuid
        AND page_id = ${scopedPageId}::uuid
        AND embedding_model = ${MIGRATION_REHEARSAL_EMBEDDING_MODEL}
        AND deleted_at IS NULL
      ORDER BY embedding <=> ${queryVector}
      LIMIT 8
    `.execute(trx);
    const planText = plan.rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .join('\n');
    assert.match(
      planText,
      /idx_docmost_mcp_chunks_embedding_hnsw/,
      `Filtered vector query did not use the HNSW index:\n${planText}`,
    );

    const result = await sql<{ pageId: string; distance: number }>`
      SELECT
        page_id::text AS "pageId",
        embedding <=> ${queryVector} AS distance
      FROM docmost_mcp_chunks
      WHERE workspace_id = ${workspaceId}::uuid
        AND page_id = ${scopedPageId}::uuid
        AND embedding_model = ${MIGRATION_REHEARSAL_EMBEDDING_MODEL}
        AND deleted_at IS NULL
      ORDER BY embedding <=> ${queryVector}
      LIMIT 8
    `.execute(trx);
    assert.equal(result.rows.length, 8);
    assert(
      result.rows.every((row) => row.pageId === scopedPageId),
      'Filtered HNSW query returned a chunk outside the requested page scope',
    );
    for (let index = 1; index < result.rows.length; index += 1) {
      assert(
        result.rows[index - 1].distance <= result.rows[index].distance,
        'Filtered HNSW results are not in strict distance order',
      );
    }
  });
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
  const errorMessage =
    error instanceof Error && error.message ? `: ${error.message}` : '';
  process.stderr.write(
    `MCP migration rehearsal failed (${errorType})${errorMessage}\n`,
  );
  process.exitCode = 1;
});
