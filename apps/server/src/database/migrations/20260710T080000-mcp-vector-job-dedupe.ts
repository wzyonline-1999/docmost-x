import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE docmost_mcp_index_jobs
    ADD COLUMN IF NOT EXISTS dedupe_key varchar
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_docmost_mcp_index_jobs_active_dedupe
    ON docmost_mcp_index_jobs (dedupe_key)
    WHERE status IN ('queued', 'running')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_active_dedupe
  `.execute(db);
  await sql`
    ALTER TABLE docmost_mcp_index_jobs
    DROP COLUMN IF EXISTS dedupe_key
  `.execute(db);
}
