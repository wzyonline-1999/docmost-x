import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE mcp_clients
    SET
      actor_user_id = owner_user_id,
      status = CASE
        WHEN status = 'active' THEN 'disabled'
        ELSE status
      END,
      updated_at = now()
    WHERE scope = 'personal'
      AND owner_user_id IS NOT NULL
      AND actor_user_id IS DISTINCT FROM owner_user_id
  `.execute(db);

  await sql`
    UPDATE mcp_clients
    SET
      owner_user_id = NULL,
      updated_at = now()
    WHERE scope = 'workspace'
      AND owner_user_id IS NOT NULL
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // This fail-closed data repair is intentionally not reversed. Restoring a
  // missing actor or reactivating a token during rollback would be unsafe.
}
