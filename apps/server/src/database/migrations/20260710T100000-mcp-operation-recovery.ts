import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE mcp_idempotency_keys
      ADD COLUMN IF NOT EXISTS operation_stage varchar NOT NULL DEFAULT 'reserved',
      ADD COLUMN IF NOT EXISTS before_state jsonb,
      ADD COLUMN IF NOT EXISTS target_state jsonb,
      ADD COLUMN IF NOT EXISTS last_error varchar
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
      DROP CONSTRAINT IF EXISTS mcp_idempotency_keys_status_check,
      ADD CONSTRAINT mcp_idempotency_keys_status_check
        CHECK (status IN (
          'in_progress',
          'completed',
          'needs_reconciliation',
          'repair_required'
        ))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE mcp_idempotency_keys
    SET status = 'needs_reconciliation'
    WHERE status = 'repair_required'
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
      DROP CONSTRAINT IF EXISTS mcp_idempotency_keys_status_check,
      ADD CONSTRAINT mcp_idempotency_keys_status_check
        CHECK (status IN ('in_progress', 'completed', 'needs_reconciliation')),
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS target_state,
      DROP COLUMN IF EXISTS before_state,
      DROP COLUMN IF EXISTS operation_stage
  `.execute(db);
}
