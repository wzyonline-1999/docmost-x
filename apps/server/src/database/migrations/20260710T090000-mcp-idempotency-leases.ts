import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE mcp_idempotency_keys
      ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'in_progress',
      ADD COLUMN IF NOT EXISTS lease_owner varchar,
      ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS completed_at timestamptz
  `.execute(db);

  await sql`
    UPDATE mcp_idempotency_keys
    SET status = CASE
      WHEN response IS NULL THEN 'needs_reconciliation'
      ELSE 'completed'
    END,
    completed_at = CASE WHEN response IS NULL THEN NULL ELSE updated_at END,
    expires_at = COALESCE(expires_at, updated_at + interval '7 days')
    WHERE status = 'in_progress'
      AND lease_expires_at IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
    ADD CONSTRAINT mcp_idempotency_keys_status_check
    CHECK (status IN ('in_progress', 'completed', 'needs_reconciliation'))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_keys_status_lease
    ON mcp_idempotency_keys (status, lease_expires_at)
    WHERE deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_mcp_idempotency_keys_status_lease
  `.execute(db);
  await sql`
    ALTER TABLE mcp_idempotency_keys
      DROP CONSTRAINT IF EXISTS mcp_idempotency_keys_status_check,
      DROP COLUMN IF EXISTS completed_at,
      DROP COLUMN IF EXISTS lease_expires_at,
      DROP COLUMN IF EXISTS lease_owner,
      DROP COLUMN IF EXISTS status
  `.execute(db);
}
