import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      DROP CONSTRAINT IF EXISTS docmost_mcp_index_jobs_status_check,
      ADD CONSTRAINT docmost_mcp_index_jobs_status_check
        CHECK (status IN (
          'queued',
          'running',
          'paused',
          'succeeded',
          'failed',
          'cancelled'
        ))
  `.execute(db);

  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_active_dedupe
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_docmost_mcp_index_jobs_active_dedupe
    ON docmost_mcp_index_jobs (dedupe_key)
    WHERE status IN ('queued', 'running', 'paused')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE docmost_mcp_index_jobs
    SET status = 'cancelled', updated_at = now()
    WHERE status = 'paused'
  `.execute(db);

  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_active_dedupe
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_docmost_mcp_index_jobs_active_dedupe
    ON docmost_mcp_index_jobs (dedupe_key)
    WHERE status IN ('queued', 'running')
  `.execute(db);

  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      DROP CONSTRAINT IF EXISTS docmost_mcp_index_jobs_status_check,
      ADD CONSTRAINT docmost_mcp_index_jobs_status_check
        CHECK (status IN (
          'queued',
          'running',
          'succeeded',
          'failed',
          'cancelled'
        ))
  `.execute(db);
}
