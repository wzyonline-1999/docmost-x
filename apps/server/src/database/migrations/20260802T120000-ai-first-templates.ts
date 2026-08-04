import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('templates')
    .addColumn('key', 'varchar')
    .addColumn('purpose', 'text')
    .addColumn('use_when', 'text')
    .addColumn('tags', sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`ARRAY[]::text[]`),
    )
    .addColumn('input_schema', 'jsonb', (col) =>
      col
        .notNull()
        .defaultTo(
          sql`'{"type":"object","properties":{},"additionalProperties":false}'::jsonb`,
        ),
    )
    .addColumn('title_template', 'text')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('draft'))
    .addColumn('draft_revision', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('current_version', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('published_at', 'timestamptz')
    .addColumn('published_by_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('source_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .execute();

  await sql`
    UPDATE templates
    SET key = 'template-' || replace(id::text, '-', '')
    WHERE key IS NULL
  `.execute(db);

  await db.schema
    .alterTable('templates')
    .alterColumn('key', (col) => col.setNotNull())
    .execute();

  await sql`
    ALTER TABLE templates
      ADD CONSTRAINT templates_status_check
      CHECK (status IN ('draft', 'published', 'archived')),
      ADD CONSTRAINT templates_version_check
      CHECK (draft_revision > 0 AND current_version >= 0)
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_templates_workspace_key_alive
      ON templates (workspace_id, key)
      WHERE deleted_at IS NULL
  `.execute(db);

  await db.schema
    .createIndex('idx_templates_workspace_status_updated')
    .on('templates')
    .columns(['workspace_id', 'status', 'updated_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_templates_tags')
    .on('templates')
    .using('GIN')
    .column('tags')
    .execute();

  await db.schema
    .createTable('template_versions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('template_id', 'uuid', (col) =>
      col.notNull().references('templates.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('set null'),
    )
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('key', 'varchar', (col) => col.notNull())
    .addColumn('title', 'varchar', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('purpose', 'text', (col) => col.notNull())
    .addColumn('use_when', 'text')
    .addColumn('tags', sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`ARRAY[]::text[]`),
    )
    .addColumn('input_schema', 'jsonb', (col) => col.notNull())
    .addColumn('title_template', 'text')
    .addColumn('content', 'jsonb', (col) => col.notNull())
    .addColumn('text_content', 'text')
    .addColumn('icon', 'varchar')
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('created_by_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_template_versions_template_version')
    .unique()
    .on('template_versions')
    .columns(['template_id', 'version'])
    .execute();

  await db.schema
    .createIndex('idx_template_versions_workspace_created')
    .on('template_versions')
    .columns(['workspace_id', 'created_at desc'])
    .execute();

  await db.schema
    .createTable('template_instances')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('template_id', 'uuid', (col) =>
      col.notNull().references('templates.id').onDelete('cascade'),
    )
    .addColumn('template_version_id', 'uuid', (col) =>
      col.notNull().references('template_versions.id').onDelete('restrict'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('client_id', 'uuid', (col) =>
      col.references('mcp_clients.id').onDelete('set null'),
    )
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('variables', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('input_hash', 'varchar', (col) => col.notNull())
    .addColumn('request_id', 'varchar')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_template_instances_page')
    .unique()
    .on('template_instances')
    .column('page_id')
    .execute();

  await db.schema
    .createIndex('idx_template_instances_template_created')
    .on('template_instances')
    .columns(['template_id', 'created_at desc'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('template_instances').ifExists().execute();
  await db.schema.dropTable('template_versions').ifExists().execute();

  await sql`DROP INDEX IF EXISTS idx_templates_tags`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_templates_workspace_status_updated`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_templates_workspace_key_alive`.execute(db);

  await sql`
    ALTER TABLE templates
      DROP CONSTRAINT IF EXISTS templates_version_check,
      DROP CONSTRAINT IF EXISTS templates_status_check
  `.execute(db);

  await db.schema
    .alterTable('templates')
    .dropColumn('source_page_id')
    .dropColumn('published_by_id')
    .dropColumn('published_at')
    .dropColumn('current_version')
    .dropColumn('draft_revision')
    .dropColumn('status')
    .dropColumn('title_template')
    .dropColumn('input_schema')
    .dropColumn('tags')
    .dropColumn('use_when')
    .dropColumn('purpose')
    .dropColumn('key')
    .execute();
}
