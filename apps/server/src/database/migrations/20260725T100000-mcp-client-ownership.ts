import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('mcp_clients')
    .addColumn('scope', 'varchar')
    .addColumn('owner_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .execute();

  await sql`
    UPDATE mcp_clients
    SET
      scope = CASE
        WHEN created_by_id IS NOT NULL
          AND (actor_user_id IS NULL OR actor_user_id = created_by_id)
          THEN 'personal'
        ELSE 'workspace'
      END,
      owner_user_id = CASE
        WHEN created_by_id IS NOT NULL
          AND (actor_user_id IS NULL OR actor_user_id = created_by_id)
          THEN created_by_id
        ELSE NULL
      END
  `.execute(db);

  await sql`
    ALTER TABLE mcp_clients
      ALTER COLUMN scope SET DEFAULT 'personal',
      ALTER COLUMN scope SET NOT NULL
  `.execute(db);

  await db.schema
    .alterTable('mcp_clients')
    .addCheckConstraint(
      'mcp_clients_scope_check',
      sql`scope IN ('personal', 'workspace')`,
    )
    .execute();

  await sql`
    CREATE INDEX idx_mcp_clients_workspace_owner
    ON mcp_clients (workspace_id, scope, owner_user_id)
    WHERE deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('idx_mcp_clients_workspace_owner')
    .ifExists()
    .execute();

  await db.schema
    .alterTable('mcp_clients')
    .dropConstraint('mcp_clients_scope_check')
    .execute();

  await db.schema
    .alterTable('mcp_clients')
    .dropColumn('owner_user_id')
    .dropColumn('scope')
    .execute();
}
