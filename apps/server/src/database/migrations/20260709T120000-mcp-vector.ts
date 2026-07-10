import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await db.schema
    .createTable('mcp_clients')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('token_hash', 'varchar', (col) => col.notNull())
    .addColumn('token_last_four', 'varchar(4)', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('active'))
    .addColumn('global_scopes', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('created_by_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint(
      'mcp_clients_status_check',
      sql`status IN ('active', 'disabled', 'expired')`,
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_clients_token_hash_alive
    ON mcp_clients (token_hash)
    WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('idx_mcp_clients_workspace_status')
    .ifNotExists()
    .on('mcp_clients')
    .columns(['workspace_id', 'status'])
    .execute();

  await db.schema
    .createIndex('idx_mcp_clients_expires_at')
    .ifNotExists()
    .on('mcp_clients')
    .column('expires_at')
    .execute();

  await db.schema
    .createTable('mcp_client_space_permissions')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('client_id', 'uuid', (col) =>
      col.notNull().references('mcp_clients.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('can_search', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_semantic_search', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('can_read', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_create', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_update', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_append', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_delete', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_restore', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('can_index', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    .execute();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_client_space_permissions_alive
    ON mcp_client_space_permissions (client_id, space_id)
    WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('idx_mcp_client_space_permissions_workspace_space')
    .ifNotExists()
    .on('mcp_client_space_permissions')
    .columns(['workspace_id', 'space_id'])
    .execute();

  await db.schema
    .createTable('mcp_audit_logs')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('client_id', 'uuid', (col) =>
      col.references('mcp_clients.id').onDelete('set null'),
    )
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('event', 'varchar', (col) => col.notNull())
    .addColumn('resource_type', 'varchar', (col) => col.notNull())
    .addColumn('resource_id', 'uuid')
    .addColumn('space_id', 'uuid')
    .addColumn('tool_name', 'varchar', (col) => col.notNull())
    .addColumn('request_id', 'varchar')
    .addColumn('before', 'jsonb')
    .addColumn('after', 'jsonb')
    .addColumn('metadata', 'jsonb')
    .addColumn('ip_address', sql`inet`)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_mcp_audit_logs_workspace_created')
    .ifNotExists()
    .on('mcp_audit_logs')
    .columns(['workspace_id', 'created_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_mcp_audit_logs_client_created')
    .ifNotExists()
    .on('mcp_audit_logs')
    .columns(['client_id', 'created_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_mcp_audit_logs_resource_created')
    .ifNotExists()
    .on('mcp_audit_logs')
    .columns(['resource_type', 'resource_id', 'created_at desc'])
    .execute();

  await db.schema
    .createTable('mcp_idempotency_keys')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('client_id', 'uuid', (col) =>
      col.notNull().references('mcp_clients.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('idempotency_key', 'varchar', (col) => col.notNull())
    .addColumn('action', 'varchar', (col) => col.notNull())
    .addColumn('request_hash', 'varchar')
    .addColumn('response', 'jsonb')
    .addColumn('resource_type', 'varchar')
    .addColumn('resource_id', 'uuid')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    .execute();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_idempotency_keys_alive
    ON mcp_idempotency_keys (client_id, action, idempotency_key)
    WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('idx_mcp_idempotency_keys_workspace_created')
    .ifNotExists()
    .on('mcp_idempotency_keys')
    .columns(['workspace_id', 'created_at desc'])
    .execute();

  await db.schema
    .createTable('docmost_mcp_chunks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('chunk_index', 'integer', (col) => col.notNull())
    .addColumn('title', 'text')
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('embedding', sql`vector(1536)`, (col) => col.notNull())
    .addColumn('embedding_model', 'varchar', (col) => col.notNull())
    .addColumn('embedding_dimensions', 'integer', (col) =>
      col.notNull().defaultTo(1536),
    )
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('indexed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    .execute();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_docmost_mcp_chunks_page_chunk_alive
    ON docmost_mcp_chunks (workspace_id, page_id, embedding_model, chunk_index)
    WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('idx_docmost_mcp_chunks_workspace_space_page')
    .ifNotExists()
    .on('docmost_mcp_chunks')
    .columns(['workspace_id', 'space_id', 'page_id'])
    .execute();

  await db.schema
    .createIndex('idx_docmost_mcp_chunks_workspace_updated')
    .ifNotExists()
    .on('docmost_mcp_chunks')
    .columns(['workspace_id', 'updated_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_docmost_mcp_chunks_content_hash')
    .ifNotExists()
    .on('docmost_mcp_chunks')
    .columns(['workspace_id', 'page_id', 'content_hash'])
    .execute();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_docmost_mcp_chunks_embedding_hnsw
    ON docmost_mcp_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createTable('docmost_mcp_index_jobs')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('set null'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('job_type', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued'))
    .addColumn('requested_by_client_id', 'uuid', (col) =>
      col.references('mcp_clients.id').onDelete('set null'),
    )
    .addColumn('requested_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('stats', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addCheckConstraint(
      'docmost_mcp_index_jobs_type_check',
      sql`job_type IN ('page', 'space', 'workspace', 'delete', 'restore')`,
    )
    .addCheckConstraint(
      'docmost_mcp_index_jobs_status_check',
      sql`status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    )
    .execute();

  await db.schema
    .createIndex('idx_docmost_mcp_index_jobs_workspace_status')
    .ifNotExists()
    .on('docmost_mcp_index_jobs')
    .columns(['workspace_id', 'status', 'created_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_docmost_mcp_index_jobs_workspace_page')
    .ifNotExists()
    .on('docmost_mcp_index_jobs')
    .columns(['workspace_id', 'page_id', 'created_at desc'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('docmost_mcp_index_jobs').ifExists().execute();
  await db.schema.dropTable('docmost_mcp_chunks').ifExists().execute();
  await db.schema.dropTable('mcp_idempotency_keys').ifExists().execute();
  await db.schema.dropTable('mcp_audit_logs').ifExists().execute();
  await db.schema
    .dropTable('mcp_client_space_permissions')
    .ifExists()
    .execute();
  await db.schema.dropTable('mcp_clients').ifExists().execute();
}
