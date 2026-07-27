import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Repair legacy ownership records before enforcing the invariant. Every
  // repaired client remains disabled so a token must be reviewed and reissued.
  await sql`
    UPDATE mcp_clients
    SET
      actor_user_id = owner_user_id,
      status = 'disabled',
      updated_at = now()
    WHERE scope = 'personal'
      AND owner_user_id IS NOT NULL
      AND actor_user_id IS DISTINCT FROM owner_user_id
  `.execute(db);

  await sql`
    UPDATE mcp_clients
    SET
      scope = 'workspace',
      owner_user_id = NULL,
      status = 'disabled',
      updated_at = now()
    WHERE scope = 'personal'
      AND owner_user_id IS NULL
  `.execute(db);

  await sql`
    UPDATE mcp_clients
    SET
      owner_user_id = NULL,
      status = 'disabled',
      updated_at = now()
    WHERE scope = 'workspace'
      AND owner_user_id IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE mcp_clients
      ADD CONSTRAINT mcp_clients_ownership_check
      CHECK (
        (
          scope = 'personal'
          AND owner_user_id IS NOT NULL
          AND actor_user_id IS NOT NULL
          AND actor_user_id = owner_user_id
        )
        OR (
          scope = 'workspace'
          AND owner_user_id IS NULL
        )
      ) NOT VALID
  `.execute(db);
  await sql`
    ALTER TABLE mcp_clients
      VALIDATE CONSTRAINT mcp_clients_ownership_check
  `.execute(db);

  await sql`
    UPDATE mcp_idempotency_keys
    SET
      idempotency_key = 'legacy-overlong:' || id::text,
      status = 'repair_required',
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = 'Legacy idempotency key exceeded the 200 character limit',
      updated_at = now()
    WHERE char_length(idempotency_key) > 200
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
      ADD CONSTRAINT mcp_idempotency_keys_length_check
      CHECK (char_length(idempotency_key) BETWEEN 1 AND 200) NOT VALID
  `.execute(db);
  await sql`
    ALTER TABLE mcp_idempotency_keys
      VALIDATE CONSTRAINT mcp_idempotency_keys_length_check
  `.execute(db);

  // Rows that point across workspace boundaries are not usable grants. Keep an
  // audit trail by soft-deleting them instead of silently changing ownership.
  await sql`
    UPDATE mcp_client_space_permissions AS permission
    SET deleted_at = COALESCE(permission.deleted_at, now()), updated_at = now()
    WHERE permission.deleted_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1
          FROM mcp_clients AS client
          WHERE client.id = permission.client_id
            AND client.workspace_id = permission.workspace_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM spaces AS space
          WHERE space.id = permission.space_id
            AND space.workspace_id = permission.workspace_id
        )
      )
  `.execute(db);

  await sql`
    UPDATE mcp_idempotency_keys AS record
    SET workspace_id = client.workspace_id, updated_at = now()
    FROM mcp_clients AS client
    WHERE client.id = record.client_id
      AND record.workspace_id IS DISTINCT FROM client.workspace_id
  `.execute(db);

  await sql`
    UPDATE docmost_mcp_chunks AS chunk
    SET
      workspace_id = page.workspace_id,
      space_id = page.space_id,
      updated_at = now()
    FROM pages AS page
    WHERE page.id = chunk.page_id
      AND (
        chunk.workspace_id IS DISTINCT FROM page.workspace_id
        OR chunk.space_id IS DISTINCT FROM page.space_id
      )
  `.execute(db);

  await sql`
    UPDATE docmost_mcp_index_jobs AS job
    SET
      workspace_id = page.workspace_id,
      space_id = page.space_id,
      updated_at = now()
    FROM pages AS page
    WHERE page.id = job.page_id
      AND (
        job.workspace_id IS DISTINCT FROM page.workspace_id
        OR job.space_id IS DISTINCT FROM page.space_id
      )
  `.execute(db);

  await sql`
    UPDATE docmost_mcp_index_jobs AS job
    SET workspace_id = space.workspace_id, updated_at = now()
    FROM spaces AS space
    WHERE job.page_id IS NULL
      AND space.id = job.space_id
      AND job.workspace_id IS DISTINCT FROM space.workspace_id
  `.execute(db);

  await sql`
    UPDATE docmost_mcp_index_jobs AS job
    SET requested_by_client_id = NULL, updated_at = now()
    WHERE requested_by_client_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM mcp_clients AS client
        WHERE client.id = job.requested_by_client_id
          AND client.workspace_id = job.workspace_id
      )
  `.execute(db);

  await sql`
    UPDATE mcp_audit_logs AS audit
    SET client_id = NULL
    WHERE client_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM mcp_clients AS client
        WHERE client.id = audit.client_id
          AND client.workspace_id = audit.workspace_id
      )
  `.execute(db);

  await sql`
    UPDATE mcp_audit_logs AS audit
    SET space_id = NULL
    WHERE space_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM spaces AS space
        WHERE space.id = audit.space_id
          AND space.workspace_id = audit.workspace_id
      )
  `.execute(db);

  await sql`
    UPDATE attachments AS attachment
    SET
      workspace_id = page.workspace_id,
      space_id = page.space_id,
      updated_at = now()
    FROM pages AS page
    WHERE page.id = attachment.page_id
      AND (
        attachment.workspace_id IS DISTINCT FROM page.workspace_id
        OR attachment.space_id IS DISTINCT FROM page.space_id
      )
  `.execute(db);

  await sql`
    UPDATE attachments AS attachment
    SET workspace_id = space.workspace_id, updated_at = now()
    FROM spaces AS space
    WHERE attachment.page_id IS NULL
      AND space.id = attachment.space_id
      AND attachment.workspace_id IS DISTINCT FROM space.workspace_id
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX uq_mcp_clients_id_workspace
      ON mcp_clients (id, workspace_id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_spaces_id_workspace
      ON spaces (id, workspace_id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_pages_id_workspace_space
      ON pages (id, workspace_id, space_id)
  `.execute(db);

  await sql`
    ALTER TABLE mcp_client_space_permissions
      ADD CONSTRAINT mcp_permissions_client_workspace_fk
        FOREIGN KEY (client_id, workspace_id)
        REFERENCES mcp_clients (id, workspace_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID,
      ADD CONSTRAINT mcp_permissions_space_workspace_fk
        FOREIGN KEY (space_id, workspace_id)
        REFERENCES spaces (id, workspace_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
      ADD CONSTRAINT mcp_idempotency_client_workspace_fk
        FOREIGN KEY (client_id, workspace_id)
        REFERENCES mcp_clients (id, workspace_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
  `.execute(db);

  await sql`
    ALTER TABLE docmost_mcp_chunks
      ADD CONSTRAINT mcp_chunks_space_workspace_fk
        FOREIGN KEY (space_id, workspace_id)
        REFERENCES spaces (id, workspace_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID,
      ADD CONSTRAINT mcp_chunks_page_workspace_space_fk
        FOREIGN KEY (page_id, workspace_id, space_id)
        REFERENCES pages (id, workspace_id, space_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
  `.execute(db);

  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      ADD COLUMN parent_job_id uuid,
      ADD CONSTRAINT docmost_mcp_index_jobs_parent_fk
        FOREIGN KEY (parent_job_id)
        REFERENCES docmost_mcp_index_jobs (id)
        ON DELETE CASCADE,
      ADD CONSTRAINT mcp_index_jobs_space_workspace_fk
        FOREIGN KEY (space_id, workspace_id)
        REFERENCES spaces (id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID,
      ADD CONSTRAINT mcp_index_jobs_requested_client_workspace_fk
        FOREIGN KEY (requested_by_client_id, workspace_id)
        REFERENCES mcp_clients (id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
  `.execute(db);

  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      DROP CONSTRAINT IF EXISTS docmost_mcp_index_jobs_status_check,
      ADD CONSTRAINT docmost_mcp_index_jobs_status_check
        CHECK (status IN (
          'queued',
          'running',
          'waiting',
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
      WHERE status IN ('queued', 'running', 'waiting', 'paused')
  `.execute(db);

  await sql`
    ALTER TABLE mcp_audit_logs
      ADD CONSTRAINT mcp_audit_client_workspace_fk
        FOREIGN KEY (client_id, workspace_id)
        REFERENCES mcp_clients (id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID,
      ADD CONSTRAINT mcp_audit_space_workspace_fk
        FOREIGN KEY (space_id, workspace_id)
        REFERENCES spaces (id, workspace_id)
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
  `.execute(db);

  for (const constraint of [
    ['mcp_client_space_permissions', 'mcp_permissions_client_workspace_fk'],
    ['mcp_client_space_permissions', 'mcp_permissions_space_workspace_fk'],
    ['mcp_idempotency_keys', 'mcp_idempotency_client_workspace_fk'],
    ['docmost_mcp_chunks', 'mcp_chunks_space_workspace_fk'],
    ['docmost_mcp_chunks', 'mcp_chunks_page_workspace_space_fk'],
    ['docmost_mcp_index_jobs', 'mcp_index_jobs_space_workspace_fk'],
    ['docmost_mcp_index_jobs', 'mcp_index_jobs_requested_client_workspace_fk'],
    ['mcp_audit_logs', 'mcp_audit_client_workspace_fk'],
    ['mcp_audit_logs', 'mcp_audit_space_workspace_fk'],
  ] as const) {
    await sql
      .raw(`ALTER TABLE ${constraint[0]} VALIDATE CONSTRAINT ${constraint[1]}`)
      .execute(db);
  }

  await sql`
    CREATE INDEX idx_docmost_mcp_index_jobs_parent_status
      ON docmost_mcp_index_jobs (parent_job_id, status, created_at)
      WHERE parent_job_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX idx_docmost_mcp_index_jobs_retention
      ON docmost_mcp_index_jobs (status, finished_at, updated_at)
      WHERE status IN ('succeeded', 'failed', 'cancelled')
  `.execute(db);
  await sql`
    CREATE INDEX idx_docmost_mcp_chunks_model_retention
      ON docmost_mcp_chunks (embedding_model, updated_at)
  `.execute(db);
  await sql`
    CREATE INDEX idx_mcp_audit_logs_retention
      ON mcp_audit_logs (created_at)
  `.execute(db);

  await sql`
    CREATE TABLE docmost_mcp_eligibility_reconciliations (
      workspace_id uuid NOT NULL,
      space_id uuid NOT NULL,
      reason varchar(80) NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      lease_owner varchar(100),
      lease_expires_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      PRIMARY KEY (workspace_id, space_id),
      CONSTRAINT mcp_eligibility_space_workspace_fk
        FOREIGN KEY (space_id, workspace_id)
        REFERENCES spaces (id, workspace_id)
        ON DELETE CASCADE,
      CONSTRAINT mcp_eligibility_attempt_count_check
        CHECK (attempt_count >= 0)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_mcp_eligibility_reconciliation_pending
      ON docmost_mcp_eligibility_reconciliations (
        lease_expires_at,
        requested_at
      )
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_request_space_reconciliation(
      target_workspace_id uuid,
      target_space_id uuid,
      target_reason varchar
    )
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF target_workspace_id IS NULL OR target_space_id IS NULL THEN
        RETURN;
      END IF;

      INSERT INTO docmost_mcp_eligibility_reconciliations (
        workspace_id,
        space_id,
        reason,
        requested_at
      )
      VALUES (
        target_workspace_id,
        target_space_id,
        left(COALESCE(target_reason, 'unknown'), 80),
        clock_timestamp()
      )
      ON CONFLICT (workspace_id, space_id)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        requested_at = CASE
          WHEN docmost_mcp_eligibility_reconciliations.requested_at
            >= EXCLUDED.requested_at
          THEN docmost_mcp_eligibility_reconciliations.requested_at
            + interval '1 microsecond'
          ELSE EXCLUDED.requested_at
        END,
        last_error = NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_space_member_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_space_id uuid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        target_space_id := OLD.space_id;
        PERFORM docmost_mcp_request_space_reconciliation(
          space.workspace_id,
          space.id,
          'space_member'
        )
        FROM spaces AS space
        WHERE space.id = target_space_id;
      END IF;

      IF TG_OP <> 'DELETE'
        AND (TG_OP = 'INSERT' OR NEW.space_id IS DISTINCT FROM OLD.space_id)
      THEN
        target_space_id := NEW.space_id;
        PERFORM docmost_mcp_request_space_reconciliation(
          space.workspace_id,
          space.id,
          'space_member'
        )
        FROM spaces AS space
        WHERE space.id = target_space_id;
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_group_user_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target record;
    BEGIN
      FOR target IN
        SELECT DISTINCT space.workspace_id, member.space_id
        FROM space_members AS member
        JOIN spaces AS space ON space.id = member.space_id
        WHERE member.group_id IN (
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.group_id END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.group_id END
        )
      LOOP
        PERFORM docmost_mcp_request_space_reconciliation(
          target.workspace_id,
          target.space_id,
          'group_user'
        );
      END LOOP;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_user_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target record;
      target_user_id uuid;
    BEGIN
      target_user_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD.id
        ELSE NEW.id
      END;

      FOR target IN
        SELECT DISTINCT permission.workspace_id, permission.space_id
        FROM mcp_clients AS client
        JOIN mcp_client_space_permissions AS permission
          ON permission.client_id = client.id
        WHERE client.actor_user_id = target_user_id
          AND permission.deleted_at IS NULL
      LOOP
        PERFORM docmost_mcp_request_space_reconciliation(
          target.workspace_id,
          target.space_id,
          'user_status'
        );
      END LOOP;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_page_access_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_workspace_id uuid;
      target_space_id uuid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        PERFORM docmost_mcp_request_space_reconciliation(
          OLD.workspace_id,
          OLD.space_id,
          'page_access'
        );
      END IF;

      IF TG_OP <> 'DELETE' THEN
        target_workspace_id := NEW.workspace_id;
        target_space_id := NEW.space_id;
        IF TG_OP = 'INSERT'
          OR target_workspace_id IS DISTINCT FROM OLD.workspace_id
          OR target_space_id IS DISTINCT FROM OLD.space_id
          OR NEW.access_level IS DISTINCT FROM OLD.access_level
        THEN
          PERFORM docmost_mcp_request_space_reconciliation(
            target_workspace_id,
            target_space_id,
            'page_access'
          );
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_page_permission_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target record;
    BEGIN
      FOR target IN
        SELECT DISTINCT access.workspace_id, access.space_id
        FROM page_access AS access
        WHERE access.id IN (
          CASE
            WHEN TG_OP = 'INSERT' THEN NULL
            ELSE OLD.page_access_id
          END,
          CASE
            WHEN TG_OP = 'DELETE' THEN NULL
            ELSE NEW.page_access_id
          END
        )
      LOOP
        PERFORM docmost_mcp_request_space_reconciliation(
          target.workspace_id,
          target.space_id,
          'page_permission'
        );
      END LOOP;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_client_permission_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_workspace_id uuid;
      target_space_id uuid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        target_workspace_id := OLD.workspace_id;
        target_space_id := OLD.space_id;
        PERFORM docmost_mcp_request_space_reconciliation(
          space.workspace_id,
          space.id,
          'mcp_permission'
        )
        FROM spaces AS space
        WHERE space.id = target_space_id
          AND space.workspace_id = target_workspace_id;
      END IF;

      IF TG_OP <> 'DELETE'
        AND (
          TG_OP = 'INSERT'
          OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.space_id IS DISTINCT FROM OLD.space_id
          OR NEW.can_index IS DISTINCT FROM OLD.can_index
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
        )
      THEN
        target_workspace_id := NEW.workspace_id;
        target_space_id := NEW.space_id;
        PERFORM docmost_mcp_request_space_reconciliation(
          space.workspace_id,
          space.id,
          'mcp_permission'
        )
        FROM spaces AS space
        WHERE space.id = target_space_id
          AND space.workspace_id = target_workspace_id;
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_client_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target record;
    BEGIN
      FOR target IN
        SELECT DISTINCT permission.workspace_id, permission.space_id
        FROM mcp_client_space_permissions AS permission
        WHERE permission.client_id IN (
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.id END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.id END
        )
          AND permission.deleted_at IS NULL
      LOOP
        PERFORM docmost_mcp_request_space_reconciliation(
          target.workspace_id,
          target.space_id,
          'mcp_client'
        );
      END LOOP;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_page_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        PERFORM docmost_mcp_request_space_reconciliation(
          OLD.workspace_id,
          OLD.space_id,
          'page_lifecycle'
        );
      END IF;

      IF TG_OP <> 'DELETE'
        AND (
          TG_OP = 'INSERT'
          OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.space_id IS DISTINCT FROM OLD.space_id
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
        )
      THEN
        PERFORM docmost_mcp_request_space_reconciliation(
          NEW.workspace_id,
          NEW.space_id,
          'page_lifecycle'
        );
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_mcp_reconcile_space_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM docmost_mcp_request_space_reconciliation(
        NEW.workspace_id,
        NEW.id,
        'space_lifecycle'
      );
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_mcp_reconcile_space_members
      AFTER INSERT OR UPDATE OR DELETE ON space_members
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_space_member_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_group_users
      AFTER INSERT OR UPDATE OR DELETE ON group_users
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_group_user_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_users_status
      AFTER UPDATE OF deactivated_at, deleted_at OR DELETE ON users
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_user_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_page_access
      AFTER INSERT OR UPDATE OR DELETE ON page_access
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_page_access_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_page_permissions
      AFTER INSERT OR UPDATE OR DELETE ON page_permissions
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_page_permission_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_client_permissions
      AFTER INSERT OR UPDATE OR DELETE ON mcp_client_space_permissions
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_client_permission_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_clients
      AFTER INSERT OR UPDATE OF actor_user_id, status, expires_at, deleted_at
        OR DELETE ON mcp_clients
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_client_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_pages
      AFTER INSERT OR UPDATE OF workspace_id, space_id, deleted_at
        OR DELETE ON pages
      FOR EACH ROW
      EXECUTE FUNCTION docmost_mcp_reconcile_page_change()
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_mcp_reconcile_spaces
      AFTER UPDATE OF deleted_at ON spaces
      FOR EACH ROW
      WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
      EXECUTE FUNCTION docmost_mcp_reconcile_space_change()
  `.execute(db);

  await sql`
    INSERT INTO docmost_mcp_eligibility_reconciliations (
      workspace_id,
      space_id,
      reason
    )
    SELECT DISTINCT candidate.workspace_id, candidate.space_id, 'migration'
    FROM (
      SELECT workspace_id, space_id
      FROM mcp_client_space_permissions
      WHERE deleted_at IS NULL AND can_index = true
      UNION
      SELECT workspace_id, space_id
      FROM docmost_mcp_chunks
      WHERE deleted_at IS NULL
    ) AS candidate
    JOIN spaces AS space
      ON space.id = candidate.space_id
      AND space.workspace_id = candidate.workspace_id
    ON CONFLICT (workspace_id, space_id) DO NOTHING
  `.execute(db);

  await sql`
    ALTER TABLE attachments
      ADD COLUMN content_index_status varchar NOT NULL DEFAULT 'pending',
      ADD COLUMN content_index_attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN content_index_error text,
      ADD COLUMN content_indexed_at timestamptz,
      ADD COLUMN content_index_lease_owner varchar,
      ADD COLUMN content_index_lease_expires_at timestamptz,
      ADD COLUMN deletion_status varchar NOT NULL DEFAULT 'active',
      ADD COLUMN deletion_attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN deletion_error text,
      ADD COLUMN deletion_started_at timestamptz,
      ADD CONSTRAINT attachments_content_index_status_check
        CHECK (
          content_index_status IN (
            'pending',
            'indexing',
            'indexed',
            'failed',
            'skipped'
          )
        ),
      ADD CONSTRAINT attachments_deletion_status_check
        CHECK (
          deletion_status IN (
            'active',
            'deleting',
            'storage_deleted',
            'failed',
            'deleted'
          )
        ),
      ADD CONSTRAINT attachments_content_index_attempt_count_check
        CHECK (content_index_attempt_count >= 0),
      ADD CONSTRAINT attachments_deletion_attempt_count_check
        CHECK (deletion_attempt_count >= 0)
  `.execute(db);

  await sql`
    UPDATE attachments
    SET
      content_index_status = CASE
        WHEN deleted_at IS NOT NULL THEN 'skipped'
        WHEN text_content IS NOT NULL THEN 'indexed'
        ELSE 'pending'
      END,
      content_indexed_at = CASE
        WHEN text_content IS NOT NULL THEN updated_at
        ELSE NULL
      END,
      deletion_status = CASE
        WHEN deleted_at IS NOT NULL THEN 'deleted'
        ELSE 'active'
      END
  `.execute(db);

  await sql`
    CREATE INDEX idx_attachments_content_index_recovery
      ON attachments (
        content_index_status,
        content_index_lease_expires_at,
        updated_at
      )
      WHERE deleted_at IS NULL
        AND deletion_status = 'active'
  `.execute(db);

  await sql`
    CREATE INDEX idx_attachments_deletion_recovery
      ON attachments (deletion_status, updated_at)
      WHERE deletion_status IN ('deleting', 'storage_deleted', 'failed')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_spaces ON spaces;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_pages ON pages;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_clients ON mcp_clients;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_client_permissions
      ON mcp_client_space_permissions;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_page_permissions
      ON page_permissions;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_page_access ON page_access;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_users_status ON users;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_group_users ON group_users;
    DROP TRIGGER IF EXISTS trg_mcp_reconcile_space_members ON space_members
  `.execute(db);

  await sql`
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_space_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_page_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_client_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_client_permission_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_page_permission_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_page_access_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_user_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_group_user_change();
    DROP FUNCTION IF EXISTS docmost_mcp_reconcile_space_member_change();
    DROP FUNCTION IF EXISTS docmost_mcp_request_space_reconciliation(
      uuid,
      uuid,
      varchar
    )
  `.execute(db);

  await sql`
    DROP INDEX IF EXISTS idx_mcp_eligibility_reconciliation_pending
  `.execute(db);
  await sql`
    DROP TABLE IF EXISTS docmost_mcp_eligibility_reconciliations
  `.execute(db);

  await sql`DROP INDEX IF EXISTS idx_attachments_deletion_recovery`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_attachments_content_index_recovery`.execute(
    db,
  );

  await sql`
    ALTER TABLE attachments
      DROP CONSTRAINT IF EXISTS attachments_deletion_attempt_count_check,
      DROP CONSTRAINT IF EXISTS attachments_content_index_attempt_count_check,
      DROP CONSTRAINT IF EXISTS attachments_deletion_status_check,
      DROP CONSTRAINT IF EXISTS attachments_content_index_status_check,
      DROP COLUMN IF EXISTS deletion_started_at,
      DROP COLUMN IF EXISTS deletion_error,
      DROP COLUMN IF EXISTS deletion_attempt_count,
      DROP COLUMN IF EXISTS deletion_status,
      DROP COLUMN IF EXISTS content_index_lease_expires_at,
      DROP COLUMN IF EXISTS content_index_lease_owner,
      DROP COLUMN IF EXISTS content_indexed_at,
      DROP COLUMN IF EXISTS content_index_error,
      DROP COLUMN IF EXISTS content_index_attempt_count,
      DROP COLUMN IF EXISTS content_index_status
  `.execute(db);

  await sql`
    ALTER TABLE mcp_audit_logs
      DROP CONSTRAINT IF EXISTS mcp_audit_space_workspace_fk,
      DROP CONSTRAINT IF EXISTS mcp_audit_client_workspace_fk
  `.execute(db);

  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      DROP CONSTRAINT IF EXISTS mcp_index_jobs_requested_client_workspace_fk,
      DROP CONSTRAINT IF EXISTS mcp_index_jobs_space_workspace_fk,
      DROP CONSTRAINT IF EXISTS docmost_mcp_index_jobs_parent_fk
  `.execute(db);
  await sql`
    DROP INDEX IF EXISTS idx_mcp_audit_logs_retention
  `.execute(db);
  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_chunks_model_retention
  `.execute(db);
  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_retention
  `.execute(db);
  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_parent_status
  `.execute(db);
  await sql`
    ALTER TABLE docmost_mcp_index_jobs
      DROP COLUMN IF EXISTS parent_job_id
  `.execute(db);

  await sql`
    UPDATE docmost_mcp_index_jobs
    SET
      status = 'failed',
      last_error = COALESCE(
        last_error,
        'Batch child aggregation was interrupted by migration rollback'
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE status = 'waiting'
  `.execute(db);
  await sql`
    DROP INDEX IF EXISTS idx_docmost_mcp_index_jobs_active_dedupe
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_docmost_mcp_index_jobs_active_dedupe
      ON docmost_mcp_index_jobs (dedupe_key)
      WHERE status IN ('queued', 'running', 'paused')
  `.execute(db);
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
    ALTER TABLE docmost_mcp_chunks
      DROP CONSTRAINT IF EXISTS mcp_chunks_page_workspace_space_fk,
      DROP CONSTRAINT IF EXISTS mcp_chunks_space_workspace_fk
  `.execute(db);

  await sql`
    ALTER TABLE mcp_idempotency_keys
      DROP CONSTRAINT IF EXISTS mcp_idempotency_client_workspace_fk,
      DROP CONSTRAINT IF EXISTS mcp_idempotency_keys_length_check
  `.execute(db);

  await sql`
    ALTER TABLE mcp_client_space_permissions
      DROP CONSTRAINT IF EXISTS mcp_permissions_space_workspace_fk,
      DROP CONSTRAINT IF EXISTS mcp_permissions_client_workspace_fk
  `.execute(db);

  await sql`
    ALTER TABLE mcp_clients
      DROP CONSTRAINT IF EXISTS mcp_clients_ownership_check
  `.execute(db);

  await sql`DROP INDEX IF EXISTS uq_pages_id_workspace_space`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_spaces_id_workspace`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_mcp_clients_id_workspace`.execute(db);
}
