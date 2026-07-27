# Docmost MCP deployment

This deployment keeps PostgreSQL in Supabase's private `docmost` schema, runs
Redis locally, and exposes Docmost and the stateless Streamable HTTP MCP endpoint
through Nginx HTTPS. MCP vector jobs are BullMQ processors registered in the
Docmost server process; this release does not require a second worker image.

## Required state

- Use a direct or session-mode PostgreSQL connection for migrations.
- PostgreSQL must have `pgvector` 0.8.0 or newer. Application startup rejects
  older versions because filtered HNSW retrieval depends on iterative scans.
- The application role must have `search_path=docmost` and ownership or DDL
  rights in that schema.
- Do not expose `docmost` through the Supabase Data API. `anon`,
  `authenticated`, and `service_role` must have neither schema `USAGE` nor table
  grants.
- Store `APP_SECRET`, `MCP_TOKEN_HASH_SECRET`, `MCP_METRICS_TOKEN`, database
  credentials, and `EMBEDDING_API_KEY` in Vaultwarden or the deployment
  environment. Never commit `.env.prod`.
- Keep pages containing passwords, private keys, or credentials outside every
  MCP-authorized space.

Start from `.env.example` and set at least:

```dotenv
APP_URL=https://docs.example.com
APP_SECRET=<vault-secret-at-least-32-characters>
DATABASE_URL=<supabase-direct-or-session-mode-url>
REDIS_URL=redis://redis:6379
MCP_PUBLIC_BASE_URL=https://docs.example.com/mcp
MCP_TOKEN_HASH_SECRET=<independent-vault-secret-at-least-32-characters>
MCP_METRICS_TOKEN=<independent-vault-secret-at-least-32-characters>
MCP_ENABLED=false
VECTOR_SEARCH_ENABLED=false
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=<vault-secret>
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
VECTOR_EXACT_CHUNK_THRESHOLD=4000
```

`EMBEDDING_DIMENSIONS` is fixed at 1536 in this release. Changing it requires a
new database migration and a complete vector reindex.

`VECTOR_EXACT_CHUNK_THRESHOLD` selects an exact vector scan when the requested
directory contains no more than that many active chunks for the configured
embedding model. Larger scopes use filtered HNSW retrieval. During upgrades,
the deprecated `VECTOR_EXACT_PAGE_THRESHOLD` is interpreted as ten chunks per
page when the new setting is absent.

## Build and boot

1. Back up the `docmost` schema before changing the image or running migrations.
2. Keep both feature switches false for the first boot. Docmost applies pending
   Kysely migrations during application startup.
3. Build and start the loopback-only service and Redis:

```bash
docker compose -f ops/deployment/compose.mcp.yml build docmost
docker compose -f ops/deployment/compose.mcp.yml up -d redis docmost
docker compose -f ops/deployment/compose.mcp.yml ps
curl --fail http://127.0.0.1:3000/api/health
```

For a disposable local database, set `POSTGRES_PASSWORD`, point
`DATABASE_URL` at host `db`, and add `--profile local-database`.

Copy `nginx/docmost-mcp.conf.example` to the Nginx configuration directory,
replace the example hostname and certificate paths, then run:

```bash
nginx -t
systemctl reload nginx
curl --fail https://docs.example.com/api/health
```

Only `POST /mcp` is accepted by the MCP location. The metrics endpoint is both
bearer-token protected by Docmost and network-restricted by Nginx.

The MCP endpoint also exposes page history and attachment tools. History reads
reuse `read`; version restore, attachment upload, and attachment deletion reuse
`update`. Restore and deletion require `confirm=true`, and restore also requires
the current `expectedUpdatedAt` value.

`get_attachment` returns an expiring signed storage URL when the configured
driver supports it. `upload_attachment` accepts strict Base64 content up to
512 KiB so the JSON request stays below the server body limit. Use the Docmost
web upload for larger files until the separate presigned PUT flow is available.

TXT, Markdown, DOCX, and PDF page attachments are extracted asynchronously and
included in semantic and hybrid MCP search results. Search results identify
attachment-backed matches through `contentSource`; keyword-only search remains
page-text only. Text indexing rejects source files larger than 25 MiB, stores at
most 500,000 extracted characters per attachment, and indexes at most 1,000,000
attachment characters per page.

## Canary sequence

1. Boot with `MCP_ENABLED=false` and `VECTOR_SEARCH_ENABLED=false`.
2. Set `MCP_ENABLED=true`, restart Docmost, and test keyword-only tools with a
   dedicated actor and a non-sensitive test space.
3. Set `VECTOR_SEARCH_ENABLED=true` only after the embedding provider,
   `vector(1536)`, and `pgvector >= 0.8.0` startup checks pass.
4. Grant `canIndex` and `canSemanticSearch` to one test space. Leave all other
   spaces denied by default.
5. Observe MCP error rate, p95 latency, audit failures, queue backlog, provider
   failures, stale pages, and permission denials for at least 24 hours.

Monitoring assets live in `ops/monitoring`. Import the Grafana dashboard and
load the Prometheus alert rules before enabling the canary.

## Rollback

The fast rollback does not touch data:

1. Set `VECTOR_SEARCH_ENABLED=false`; restart Docmost.
2. If the issue is not isolated to vectors, also set `MCP_ENABLED=false` and
   restart Docmost.
3. Restore the previous immutable image tag and verify `/api/health`.

Only roll back database migrations after a fresh schema backup and after the
old application image is stopped. The migration rehearsal rolls back all seven
MCP migrations in reverse timestamp order. The newest ownership-hardening
migration intentionally does not undo its fail-closed data repair: a repaired
personal client stays bound to its owner and a token disabled by that repair is
not silently reactivated. Rolling back the base MCP migration drops MCP
clients, permissions, audit rows, idempotency rows, jobs, and vector chunks;
those vector rows must be rebuilt after reapplying migrations. Normal Docmost
tables are not removed by the rollback, as verified by
`test:mcp:migrations`.

## Supabase exposure check

Before each release, verify that MCP tables are in `docmost`, the application
role has `search_path=docmost`, and Data API roles have zero grants:

```sql
select grantee, table_schema, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'docmost'
  and grantee in ('anon', 'authenticated', 'service_role');
```

The expected result is zero rows. RLS is not the primary boundary for this
private-schema/direct-connection design; schema and table grants are.
