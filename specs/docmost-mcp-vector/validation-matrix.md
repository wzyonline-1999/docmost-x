---
spec_id: docmost-mcp-vector-validation
title: Docmost MCP and Vector Search Validation Matrix
doc_type: validation
status: production-canary
version: v1
verified_at: 2026-07-11
---

# MCP and Vector Validation Matrix

## Gate Summary

- T14 scope: every P0/P1 case in `G-01` through `G-59` has repository-owned automated evidence.
- T15 scope: the disposable PostgreSQL rehearsal passed in the private `docmost` schema with `latest -> down x5 -> latest`.
- T17 scope: real `codex-cli 0.142.5` completed search/read, CRUD, idempotency replay, rate-limit reset, audit verification, and token rotation against a production build.
- Coverage gate: the seven core security services exceed 90% line and 80% branch coverage.
- Repository hygiene: generated browser snapshots were removed and the high-entropy secret scan returned no matches.
- Dark boot: the production build starts without embedding credentials when both feature flags are false, and `/mcp` rejects bearer requests as disabled.
- Production keyword canary: RC5 is healthy on the Hong Kong VPS with `MCP_ENABLED=true` and `VECTOR_SEARCH_ENABLED=false`; HTTPS CRUD, replay safety, deny-by-default behavior, metrics, and audit evidence passed on the empty private `General` space.
- Production Codex: isolated `codex-cli 0.144.0-alpha.4` used official ChatGPT authentication and only the Docmost MCP to complete `search_docs` and `get_page` against the canary page.
- T18 remains in progress: the 24-hour observation window and vector/semantic canary are not complete.

## Case Evidence

| ID   | Status | Layer                | Repository evidence                                                                                                                       |
| ---- | ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | PASS   | PostgreSQL           | `apps/server/test/mcp-migration-rehearsal.ts` removes all five MCP migrations and asserts MCP tables are absent while base tables remain. |
| G-02 | PASS   | PostgreSQL           | The same rehearsal reapplies latest migrations, checks tables/indexes/constraints/vector typmod, and preserves sentinel data.             |
| G-03 | PASS   | Unit                 | `mcp-permission.service.spec.ts` masks cross-workspace pages; `mcp-tool.service.spec.ts` masks native read denials.                       |
| G-04 | PASS   | Unit                 | `mcp-tool.service.spec.ts` filters mixed allowed/denied search scopes and scans only actor-readable pages.                                |
| G-05 | PASS   | Unit                 | `mcp-tool.service.spec.ts` scopes status/list/retry/reindex operations to the token workspace and active permissions.                     |
| G-06 | PASS   | Unit                 | `mcp-token.service.spec.ts` rejects a generator-shaped unknown token without updating usage.                                              |
| G-07 | PASS   | Unit                 | `mcp-token.service.spec.ts` marks timestamp-expired clients and fails closed if status persistence fails.                                 |
| G-08 | PASS   | Unit                 | `mcp-token.service.spec.ts` rejects clients whose status is already `expired`.                                                            |
| G-09 | PASS   | Unit                 | `mcp-token.service.spec.ts` rejects a formerly valid token after soft deletion.                                                           |
| G-10 | PASS   | Unit                 | Token tests reject the old value after rotation; admin tests expose the new value once and never return/hash-log either token hash.       |
| G-11 | PASS   | Unit                 | `mcp-permission.service.spec.ts` covers every action column; tool tests verify update/append denials precede mutation.                    |
| G-12 | PASS   | Unit                 | Permission and tool suites verify delete/restore denials and explicit confirmation.                                                       |
| G-13 | PASS   | Unit                 | `mcp-tool.service.spec.ts` denies both semantic entry points and prevents provider calls.                                                 |
| G-14 | PASS   | Unit                 | Tool tests reject space/workspace reindex without active index permissions.                                                               |
| G-15 | PASS   | Unit                 | Tool tests recheck permission before retry and leave the denied job untouched.                                                            |
| G-16 | PASS   | Unit                 | Permission queries require `deletedAt IS NULL` and fail closed when no active row remains.                                                |
| G-17 | PASS   | Unit                 | All five write tools reject a missing actor before idempotent execution or mutation.                                                      |
| G-18 | PASS   | Unit                 | `mcp-actor-access.service.spec.ts` loads only active actors and rejects deactivated actors.                                               |
| G-19 | PASS   | Unit                 | Actor lookup requires `deletedAt IS NULL`; deleted actors fail closed.                                                                    |
| G-20 | PASS   | Unit                 | `mcp-admin.service.boundaries.spec.ts` rejects a cross-workspace actor before transaction/mutation.                                       |
| G-21 | PASS   | Unit                 | Admin boundary tests reject duplicate space permissions before database mutation.                                                         |
| G-22 | PASS   | Unit                 | Admin service tests insert then update one active permission and audit both transitions.                                                  |
| G-23 | PASS   | Unit                 | Admin tests soft-delete transactionally; permission tests prove deleted rows no longer authorize access.                                  |
| G-24 | PASS   | Unit                 | Admin boundary tests combine client/space/event/tool/resource/date/text filters under the authenticated workspace.                        |
| G-25 | PASS   | Unit                 | `mcp-admin.controller.spec.ts` table-tests all ten admin actions against a non-admin ability.                                             |
| G-26 | PASS   | Unit                 | Tool tests resolve `get_page` by slug.                                                                                                    |
| G-27 | PASS   | Unit                 | Tool tests document deterministic `pageId` precedence when selectors disagree.                                                            |
| G-28 | PASS   | Unit                 | Tool and JSON-RPC controller tests map a missing selector to invalid params.                                                              |
| G-29 | PASS   | Unit                 | Tool tests return not found for normally deleted pages without content leakage.                                                           |
| G-30 | PASS   | Unit                 | Tool tests return markdown, HTML, and JSON page formats.                                                                                  |
| G-31 | PASS   | Unit                 | Tool tests reject null/array content and unsupported formats before idempotent execution.                                                 |
| G-32 | PASS   | Unit                 | Tool, page-service, and page-repository tests cover successful atomic optimistic locking.                                                 |
| G-33 | PASS   | Unit                 | Page-service/repository tests reject stale compare-and-set writes before follow-up work.                                                  |
| G-34 | PASS   | Unit                 | Tool tests reject invalid optimistic-lock timestamps before idempotency.                                                                  |
| G-35 | PASS   | Unit                 | Tool tests reject missing, deleted, and cross-space parent pages before creation.                                                         |
| G-36 | PASS   | Unit                 | Tool tests filter mixed search scope without leaking the denied space.                                                                    |
| G-37 | PASS   | Unit                 | Tool tests reject invalid search modes before permission/provider calls.                                                                  |
| G-38 | PASS   | Unit                 | Tool tests reject blank/over-limit queries before permission/provider calls.                                                              |
| G-39 | PASS   | Unit + PostgreSQL    | Tool tests accept tsquery metacharacters; the migration rehearsal executes the real PostgreSQL safe-query assertion.                      |
| G-40 | PASS   | Unit                 | Rate-limit tests allow exactly the configured maximum and reject the next request.                                                        |
| G-41 | PASS   | Unit                 | Rate-limit tests advance time and prove bucket reset.                                                                                     |
| G-42 | PASS   | Unit                 | Rate-limit tests isolate buckets by workspace and client.                                                                                 |
| G-43 | PASS   | Unit                 | Controller tests preserve request order in a mixed-success JSON-RPC batch.                                                                |
| G-44 | PASS   | Unit + SDK           | Notifications authenticate successfully and return Streamable HTTP `202 Accepted` with an empty response body.                            |
| G-45 | PASS   | Unit                 | Controller tests reject JSON-RPC 1.0 and malformed envelopes before authentication.                                                       |
| G-46 | PASS   | Unit                 | Controller/tool tests reject non-object params and arguments.                                                                             |
| G-47 | PASS   | Unit                 | Embedding tests reject invalid JSON/missing data; hybrid search falls back with a safe warning.                                           |
| G-48 | PASS   | Unit                 | Embedding tests reject vector-count mismatch; index tests prevent partial chunk writes.                                                   |
| G-49 | PASS   | Unit                 | Embedding tests reject strings, null, NaN, and infinity in vectors.                                                                       |
| G-50 | PASS   | Unit                 | Embedding tests abort on timeout, retry only transient failures, and keep public errors safe.                                             |
| G-51 | PASS   | Unit                 | Vector-index tests soft-delete stale trailing chunks after content shrinks.                                                               |
| G-52 | PASS   | Unit                 | Tool tests keep one highest-scoring semantic result per page and deduplicate hybrid results.                                              |
| G-53 | PASS   | Unit                 | Delete tools enqueue `delete` jobs; vector-index tests soft-delete all active chunks.                                                     |
| G-54 | PASS   | Unit                 | Restore tools enqueue `restore` jobs; vector-index tests rebuild eligible page chunks.                                                    |
| G-55 | PASS   | Unit                 | Listener tests map create/update/delete/restore events to durable page/delete/restore jobs.                                               |
| G-56 | PASS   | Unit                 | Tool tests assert strict create/update/append/delete/restore audit fields and exclude raw write content.                                  |
| G-57 | PASS   | Unit                 | Audit list construction always starts with the authenticated `workspaceId`; combined-filter tests assert that predicate.                  |
| G-58 | PASS   | Unit + scan          | Error, token, audit, embedding, processor, listener, and tool suites reject message/content leakage; repository secret scan is clean.     |
| G-59 | PASS   | Unit + PostgreSQL    | Audit tests cover IPv4/IPv6/blank values; migration rehearsal inserts and reads real `inet` values.                                       |
| G-60 | PASS   | Hygiene              | `.playwright-cli` snapshots were removed; intended source/spec/ops files are the only new repository artifacts.                           |
| G-61 | PASS   | Hygiene              | Repository scan found no high-entropy MCP token, provider key, or private-key header.                                                     |
| G-62 | PASS   | Real Codex           | `mcp-codex-acceptance.ts` proves search/read, five write operations, replay safety, limit reset, audit events, and token rotation.        |
| G-63 | PASS   | Unit + production    | Write-path tests accept Yjs-normalized content, reject missing nodes, and isolate post-persistence side-effect failures.                  |
| G-64 | PASS   | Unit + configuration | MCP and vector search default off; vector search activates only when both feature flags are explicitly true.                              |
| G-65 | PASS   | Production boot      | With both feature flags false, health reports PostgreSQL/Redis up and bearer-authenticated MCP requests return `MCP is disabled`.         |
| G-66 | PASS   | Production HTTPS     | Keyword search/read/create/update/append and idempotency replay passed through Nginx; delete, semantic, and index paths failed closed.    |
| G-67 | PASS   | Production Codex     | Isolated `codex-cli 0.144.0-alpha.4` found and read the expected canary page through the public Streamable HTTP endpoint.                 |
| G-68 | PASS   | Production isolation | Canary evidence shows 26 MCP requests, zero Embedding calls, zero active vector chunks, and zero vector jobs while vector stays disabled. |

## Repeatable Commands

```bash
pnpm exec tsc --noEmit -p apps/server/tsconfig.json
pnpm exec tsc --noEmit -p apps/client/tsconfig.json
pnpm --filter server exec jest --runInBand --testPathPatterns=core/mcp --testPathIgnorePatterns=mcp-sdk-compat.spec.ts
pnpm --filter server exec jest --runInBand src/core/mcp/mcp-sdk-compat.spec.ts
pnpm --filter server test:mcp:write-path
pnpm --filter server exec jest --runInBand src/integrations/environment/environment.service.spec.ts
pnpm --filter server exec jest --runInBand --coverage --coverageProvider=v8 --coverageReporters=json-summary --collectCoverageFrom='core/mcp/**/*.ts' --testPathPatterns=core/mcp --testPathIgnorePatterns=mcp-sdk-compat.spec.ts
pnpm --filter server test:mcp:migrations
```

The SDK compatibility test needs permission to bind a temporary loopback port. The migration rehearsal refuses any database whose name does not match `docmost_mcp_migration_test_*`.

The manual Codex gate is `pnpm --filter server test:mcp:codex`. It uses the local ChatGPT login by default, or an HTTP-only OpenAI-compatible provider when `MCP_ACCEPTANCE_OPENAI_BASE_URL` and `MCP_ACCEPTANCE_OPENAI_API_KEY` are supplied. Provider credentials remain process-local and are redacted from failures.
