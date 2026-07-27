-- Read-only preflight for the MCP production-hardening migration.
-- Run this against a restored production snapshot before deployment.
BEGIN TRANSACTION READ ONLY;

SELECT 'personal_owner_missing' AS issue, count(*) AS affected
FROM mcp_clients
WHERE scope = 'personal' AND owner_user_id IS NULL
UNION ALL
SELECT 'personal_actor_mismatch', count(*)
FROM mcp_clients
WHERE scope = 'personal'
  AND owner_user_id IS NOT NULL
  AND actor_user_id IS DISTINCT FROM owner_user_id
UNION ALL
SELECT 'workspace_owner_present', count(*)
FROM mcp_clients
WHERE scope = 'workspace' AND owner_user_id IS NOT NULL
UNION ALL
SELECT 'overlong_idempotency_key', count(*)
FROM mcp_idempotency_keys
WHERE char_length(idempotency_key) > 200
UNION ALL
SELECT 'cross_workspace_permission', count(*)
FROM mcp_client_space_permissions AS permission
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
UNION ALL
SELECT 'cross_workspace_chunk', count(*)
FROM docmost_mcp_chunks AS chunk
JOIN pages AS page ON page.id = chunk.page_id
WHERE chunk.workspace_id IS DISTINCT FROM page.workspace_id
   OR chunk.space_id IS DISTINCT FROM page.space_id
UNION ALL
SELECT 'cross_workspace_job', count(*)
FROM docmost_mcp_index_jobs AS job
LEFT JOIN pages AS page ON page.id = job.page_id
LEFT JOIN spaces AS space ON space.id = job.space_id
WHERE (
    page.id IS NOT NULL
    AND (
      job.workspace_id IS DISTINCT FROM page.workspace_id
      OR job.space_id IS DISTINCT FROM page.space_id
    )
  )
  OR (
    page.id IS NULL
    AND space.id IS NOT NULL
    AND job.workspace_id IS DISTINCT FROM space.workspace_id
  );

SELECT
  id,
  name,
  scope,
  status,
  owner_user_id,
  actor_user_id,
  token_last_four
FROM mcp_clients
WHERE (
    scope = 'personal'
    AND (
      owner_user_id IS NULL
      OR actor_user_id IS DISTINCT FROM owner_user_id
    )
  )
  OR (scope = 'workspace' AND owner_user_id IS NOT NULL)
ORDER BY created_at;

ROLLBACK;
