---
spec_id: docmost-mcp-vector
title: Docmost MCP and Vector Search Test Plan
doc_type: test-plan
owner: zeyu.wang
status: draft
version: v1
source:
  - design: specs/docmost-mcp-vector/design.md
  - local-smoke: "2026-07-09 local run with PostgreSQL, Redis, MCP enabled, vector search disabled"
external_review:
  claude_cli: "attempted on 2026-07-09; unavailable with 403 Request not allowed"
---

# Docmost MCP and Vector Search Test Plan

## 1. Objective

Validate that the Docmost MCP implementation is safe, usable, and observable before deployment. The test scope covers MCP JSON-RPC transport, token authentication, per-space permissions, page tools, vector indexing/search, audit logs, idempotency, rate limiting, database migration, and local deployment behavior.

This plan uses full test mode because the feature is stateful, permission-sensitive, and has multiple destructive or high-risk operations.

## 2. Current Local Baseline

Already verified locally on 2026-07-09:

- Server starts with PostgreSQL and Redis.
- `GET /api/health` reports database and Redis up.
- Missing MCP bearer token returns JSON-RPC error `-32001`.
- `initialize`, `tools/list`, `list_spaces`, `list_pages` work with a valid MCP token.
- `create_page`, `get_page`, `search_docs`, `append_page`, `update_page`, `delete_page`, and `restore_page` work.
- `delete_page` without `confirm: true` is rejected.
- Admin audit-log query returns MCP write and token events.
- Token rotation returns a new token; the old token is rejected and the new token works.
- Blank request IPs are normalized to `null` before writing the `inet` audit-log column.
- `VECTOR_SEARCH_ENABLED=false` returns a clear `Vector search is disabled` error for vector-only search and keyword fallback warnings for hybrid search.

Known baseline limitations:

- The previous local smoke did not exercise a real embedding provider.
- The previous local smoke used one workspace, one user, one space, and one all-permission client.
- The previous local smoke did not run migration rollback.
- The previous local smoke did not test rate-limit boundaries with reduced limits.

## 3. Coverage Matrix

| Source rule or scenario                                                    | Covered by case IDs          | Notes                                                                      |
| -------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| MCP endpoint requires bearer authentication                                | T-01, T-02, T-03             | Covers missing, malformed, invalid, expired, disabled tokens               |
| MCP JSON-RPC dispatch supports initialize, tools/list, tools/call          | T-04, T-05, T-06             | Include notification and batch request behavior                            |
| Unknown or malformed JSON-RPC requests return correct JSON-RPC errors      | T-07, T-08                   | Check code mapping and safe messages                                       |
| Token management supports create, list, update, disable, delete, rotate    | T-09, T-10, T-11, T-12       | Admin API with workspace admin authorization                               |
| Per-space permission switches gate every tool                              | T-13, T-14, T-15, T-16       | Must test positive and negative for each action                            |
| Page read/search/list tools respect allowed spaces                         | T-17, T-18, T-19             | Cross-space read prevention is critical                                    |
| Write tools create, update, append, delete, restore pages                  | T-20, T-21, T-22, T-23, T-24 | Verify page content and metadata after each action                         |
| High-risk tools require explicit confirmation                              | T-25                         | Delete, restore, reindex space, reindex workspace, retry job               |
| Idempotency prevents duplicate writes                                      | T-26, T-27                   | Same key should replay result; different key should create a new operation |
| Audit logs record high-risk and admin operations                           | T-28, T-29                   | Validate resource ids, request ids, actor, metadata, and IP null handling  |
| Rate limiting blocks excessive tool calls per client                       | T-30                         | Use low limit in local env                                                 |
| Keyword search works when vector search is disabled                        | T-31                         | Current local baseline                                                     |
| Semantic search and hybrid ranking work when vector search is enabled      | T-32, T-33, T-34             | Requires embedding provider or deterministic mock                          |
| Vector indexing jobs handle page, space, workspace, retry, and failure     | T-35, T-36, T-37, T-38       | Verify DB rows and tool responses                                          |
| Migration creates required tables, indexes, checks, and pgvector extension | T-39                         | Include Supabase-compatible checks                                         |
| Migration rollback removes MCP/vector artifacts safely                     | T-40                         | Run only on disposable local DB                                            |
| Environment switches fail closed when required secrets are missing         | T-41, T-42                   | MCP disabled, hash secret missing, vector provider missing                 |
| Observability is useful during failures                                    | T-43                         | Logs should be safe and actionable                                         |
| No project secrets or generated MCP tokens are committed                   | T-44                         | Git and grep hygiene                                                       |

## 4. Parameter Matrix

| Parameter                   | Values to cover                                                                             | Constraints or notes                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| MCP token state             | missing, malformed prefix, unknown hash, active, disabled, expired, deleted                 | Active token is required for all tool calls                                                            |
| Client actor mapping        | valid actor user, missing actor user, deactivated/deleted user if supported                 | Write tools must fail safely without actor user                                                        |
| Space permission            | allowed, denied, deleted permission, wrong workspace                                        | Test each action column: search, semantic search, read, create, update, append, delete, restore, index |
| Space scope input           | omitted, one allowed space, multiple allowed spaces, denied space, mixed allowed and denied | Mixed scope must not leak denied space content                                                         |
| Page selector               | pageId, slugId, both, neither, nonexistent, deleted page                                    | `get_page` should be deterministic when both are provided                                              |
| Page content format         | markdown, html, json, omitted, invalid                                                      | Verify conversion, validation, and safe errors                                                         |
| Search mode                 | keyword, semantic, hybrid, invalid                                                          | Hybrid should degrade clearly if vector is unavailable                                                 |
| Confirm flag                | omitted, false, true                                                                        | Required for high-risk tools only                                                                      |
| Idempotency key             | omitted, reused same action, reused different action, very long key                         | Same key/action/client should not duplicate writes                                                     |
| Request IP                  | valid IPv4, valid IPv6, blank string, null                                                  | Blank/null must write `null` to `inet`                                                                 |
| Vector feature flag         | disabled, enabled with provider, enabled without provider                                   | Disabled should not break keyword search                                                               |
| Embedding provider response | valid dimensions, wrong count, wrong dimensions, non-numeric values, timeout/error          | Existing unit tests cover part; add integration-style checks                                           |
| Rate limit                  | below limit, at limit, above limit, after window reset                                      | Use reduced local config for deterministic smoke                                                       |

## 5. Test Cases

| ID   | Scenario                                    | Preconditions                               | Test data / setup                                | Action                                            | Expected result                                                                                       | Expected evidence                                | Type           |
| ---- | ------------------------------------------- | ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| T-01 | Missing token rejected                      | Server running, MCP enabled                 | No `Authorization` header                        | `POST /mcp` initialize                            | JSON-RPC error `-32001`, message says missing bearer token                                            | HTTP 200 wrapper plus JSON-RPC error             | Exception path |
| T-02 | Invalid token rejected                      | Server running                              | `Authorization: Bearer bad`                      | `tools/list`                                      | JSON-RPC error `-32001`                                                                               | No client `lastUsedAt` update                    | Exception path |
| T-03 | Disabled or expired token rejected          | Existing client                             | Disable or expire token via admin API/DB fixture | `tools/list`                                      | Disabled returns forbidden-style error; expired returns invalid/expired auth error per implementation | Admin client status and MCP response             | Exception path |
| T-04 | Initialize succeeds                         | Active token                                | Valid token                                      | `initialize`                                      | Protocol version and serverInfo returned                                                              | JSON-RPC result contains `docmost-mcp`           | Main path      |
| T-05 | Tool registry is complete                   | Active token                                | Valid token                                      | `tools/list`                                      | All expected tools listed with schemas                                                                | Tool names and required `confirm` fields         | Regression     |
| T-06 | Notifications authenticate                  | Active token                                | `notifications/initialized` without id           | Send notification                                 | No JSON-RPC result body for notification                                                              | No server error log                              | Compatibility  |
| T-07 | Unknown method maps correctly               | Active token                                | Unsupported method                               | `POST /mcp`                                       | JSON-RPC error `-32601`                                                                               | Response code/message                            | Exception path |
| T-08 | Malformed tool call rejected                | Active token                                | Missing `params.name`, non-object params         | `tools/call`                                      | JSON-RPC error `-32602`                                                                               | Error message does not expose internals          | Boundary       |
| T-09 | Admin creates client                        | Logged-in workspace admin                   | Client name and one space permission             | `/api/mcp/admin/clients/create`                   | Token returned once, token last four stored                                                           | DB client row, audit event                       | Main path      |
| T-10 | Admin rotates token                         | Existing client                             | Client id                                        | `/api/mcp/admin/clients/rotate-token`             | New token works; old token fails                                                                      | Tool call with both tokens and audit log         | Regression     |
| T-11 | Non-admin blocked from admin API            | Non-admin user session                      | Same client request                              | Call admin endpoints                              | Forbidden                                                                                             | No DB mutation                                   | Exception path |
| T-12 | Disable/delete client blocks access         | Existing client                             | Disable or delete via API                        | `tools/list` with old token                       | MCP access fails                                                                                      | Client status/deletedAt and audit log            | Branch path    |
| T-13 | Read permission gates page read             | Client denied read in target space          | Page in denied space                             | `get_page`                                        | Permission denied                                                                                     | No page content in response                      | Security       |
| T-14 | Search permission gates keyword search      | Client denied search in target space        | Page in denied space                             | `search_docs`                                     | Denied space omitted or forbidden depending input                                                     | Search result has no leaked title/snippet        | Security       |
| T-15 | Write permission gates create/update/append | Client denied one write action              | Allowed space page                               | Call denied write tool                            | Permission denied                                                                                     | Page unchanged, permission audit if implemented  | Security       |
| T-16 | Index permission gates reindex tools        | Client denied index                         | Existing page/space                              | `reindex_page`, `reindex_space`                   | Permission denied                                                                                     | No new index job                                 | Security       |
| T-17 | List spaces returns only permitted spaces   | Client has one of two spaces                | Two spaces in same workspace                     | `list_spaces`                                     | Only permitted space returned                                                                         | Structured content space ids                     | Security       |
| T-18 | List pages respects parent and limit        | Active token                                | Parent/child pages                               | `list_pages` with parent and pagination           | Correct children and meta                                                                             | Result ids and limits                            | Branch path    |
| T-19 | Cross-workspace data isolation              | Two workspaces                              | Client belongs to workspace A                    | Try space/page ids from workspace B               | Not found or forbidden with no data leak                                                              | Response and no audit mutation outside workspace | Security       |
| T-20 | Create page                                 | Client can create                           | Space id, title, markdown content                | `create_page`                                     | Page created; index enqueue follows feature config                                                    | Page DB row, response metadata, audit log        | Main path      |
| T-21 | Update page                                 | Client can update                           | Existing page                                    | `update_page` title/content                       | Metadata and content updated                                                                          | `get_page` content and audit before/after        | Main path      |
| T-22 | Append page                                 | Client can append                           | Existing page                                    | `append_page` heading/content                     | Content appended or replaced according to implementation contract                                     | `get_page` content and audit hash                | Main path      |
| T-23 | Delete page                                 | Client can delete                           | Existing page                                    | `delete_page confirm=true`                        | Soft delete only                                                                                      | `deletedAt` set, no permanent purge              | Main path      |
| T-24 | Restore page                                | Client can restore                          | Soft-deleted page                                | `restore_page confirm=true`                       | Page restored                                                                                         | `deletedAt` null, audit log                      | Main path      |
| T-25 | Confirm required                            | Active token                                | High-risk tools                                  | Call without `confirm:true`                       | Rejected with `-32602`                                                                                | No DB mutation                                   | Regression     |
| T-26 | Idempotent create                           | Client can create                           | Same idempotency key                             | Call `create_page` twice                          | One page created, second returns stored response                                                      | One page row, idempotency row                    | Regression     |
| T-27 | Idempotency action boundary                 | Client can write                            | Same key with different action                   | Create then update with same key                  | No cross-action collision                                                                             | Separate outcomes                                | Boundary       |
| T-28 | Audit log shape                             | Admin session                               | Run create/update/delete/restore/rotate          | Query audit logs                                  | Correct event, resource, requestId, actor, metadata                                                   | `/api/mcp/admin/audit-logs` result               | Observability  |
| T-29 | Blank IP audit regression                   | Request IP blank/null fixture               | Unit or local controller test                    | Write audit log                                   | DB receives `null`, not `""`                                                                          | Unit test and audit row                          | Regression     |
| T-30 | Rate limit                                  | Low rate-limit env                          | Active token                                     | Send calls above limit                            | JSON-RPC error `-32029` after threshold                                                               | Response and no server crash                     | Boundary       |
| T-31 | Keyword fallback when vector disabled       | `VECTOR_SEARCH_ENABLED=false`               | Existing page                                    | `search_docs` hybrid                              | Keyword result plus vector-disabled warning                                                           | Response warnings                                | Compatibility  |
| T-32 | Semantic search enabled                     | Vector enabled and provider configured      | Indexed page                                     | `semantic_search_docs`                            | Similar page returned with semantic score                                                             | Chunk rows and result score                      | Main path      |
| T-33 | Hybrid ranking                              | Vector enabled                              | Pages with keyword and semantic matches          | `search_docs mode=hybrid`                         | Combined ranking follows configured weights                                                           | Result scores include keyword/semantic/final     | Branch path    |
| T-34 | Provider failure fallback                   | Vector enabled but provider fails           | Mock timeout/error                               | `search_docs mode=hybrid`                         | Keyword fallback with warning; no unsafe 500                                                          | Response warning and logs                        | Exception path |
| T-35 | Reindex page                                | Client can index                            | Existing page                                    | `reindex_page`                                    | Chunks rebuilt or job completed                                                                       | chunk count, index status, audit log             | Main path      |
| T-36 | Reindex space/workspace                     | Client can index                            | Multiple pages                                   | `reindex_space`, `reindex_workspace confirm=true` | Jobs queued only for permitted scopes                                                                 | job rows and counts                              | Branch path    |
| T-37 | Retry index job                             | Failed job exists                           | Failed job id                                    | `retry_index_job confirm=true`                    | Job retried or new attempt recorded                                                                   | job status transition                            | Main path      |
| T-38 | Index status                                | Existing page with and without chunks       | Page id                                          | `get_index_status`                                | Accurate chunk count and recent jobs                                                                  | structured content                               | Observability  |
| T-39 | Migration up                                | Disposable DB                               | pgvector-capable PostgreSQL                      | `migration:latest`                                | Tables, indexes, checks, extension exist                                                              | Schema inspection query                          | Compatibility  |
| T-40 | Migration down                              | Disposable DB only                          | After migration up                               | Rollback migration                                | MCP/vector tables removed safely                                                                      | Schema inspection query                          | Regression     |
| T-41 | MCP disabled                                | `MCP_ENABLED=false`                         | Valid-looking token                              | MCP request                                       | Forbidden/disabled error                                                                              | No tool execution                                | Compatibility  |
| T-42 | Missing token hash secret                   | MCP enabled without secret                  | Boot or request                                  | Start server/authenticate                         | Fail closed with clear config error                                                                   | Startup/request log                              | Security       |
| T-43 | Failure logs are safe                       | Trigger bad provider and malformed requests | No secrets in payload                            | Inspect logs                                      | Logs show context without tokens/content leaks                                                        | Server logs                                      | Observability  |
| T-44 | Repository hygiene                          | Working tree after tests                    | Generated tokens and local files                 | `git status`, secret grep                         | No secrets or temp artifacts committed                                                                | Git status and grep result                       | Cleanup        |

## 6. Next Local Test Run Order

1. Start Docker PostgreSQL/Redis and run migrations on disposable local DB.
2. Start server with `MCP_ENABLED=true`, `VECTOR_SEARCH_ENABLED=false`.
3. Run baseline health and MCP auth tests: T-01, T-02, T-04, T-05, T-07, T-08.
4. Create fresh admin session, workspace, test spaces, pages, and MCP clients.
5. Run page happy paths: T-17, T-18, T-20, T-21, T-22, T-23, T-24.
6. Run permission-denial matrix: T-13 through T-16, plus cross-workspace T-19 if fixture setup is quick.
7. Run token lifecycle: T-09 through T-12.
8. Run idempotency: T-26 and T-27.
9. Run audit and blank IP regression: T-28 and T-29.
10. Run rate-limit smoke with reduced local thresholds: T-30.
11. Run vector-disabled compatibility: T-31.
12. Restart with vector enabled and a deterministic embedding stub or safe OpenAI-compatible test provider.
13. Run vector indexing/search: T-32 through T-38.
14. On a disposable DB only, run migration down/up checks: T-39 and T-40.
15. Run final verification: server logs, unit tests, TypeScript, `git diff --check`, and repository hygiene.

## 7. Automation Candidates

High priority:

- Unit tests for token auth edge cases: invalid prefix, disabled, expired, deleted.
- Unit tests for permission denial for every action column.
- Unit tests for idempotency replay and action-boundary behavior.
- Unit tests for rate-limit threshold and window reset.
- Integration-style controller tests for malformed JSON-RPC and notification behavior.
- Vector service tests for provider failure, wrong vector dimensions, chunk replacement, and job retry.

Medium priority:

- Local e2e script that creates a workspace/client/page and exercises main MCP HTTP paths.
- Migration schema assertion script for all MCP/vector tables and indexes.
- Secret hygiene test that fails if `dmost_mcp_` tokens or provider keys appear in committed files.
- Audit-log shape snapshot test for create, update, delete, restore, and token rotation.

## 8. Observability And Cleanup Checks

Before ending each manual run:

- Confirm server logs have no unexpected `ERROR` entries.
- Confirm audit logs include write/admin operations and do not expose full sensitive content.
- Confirm generated MCP tokens are not written to tracked files.
- Stop local Nest server if it was started manually.
- Keep Docker volumes only when the next test run needs the same fixture data; otherwise remove disposable volumes explicitly.
- Do not remove production-like or user-created local data without confirmation.

## 9. Open Questions

- Should read operations be audited by default or only sampled? The implementation appears to support read audit behavior; the product decision should be explicit.
- Which embedding provider should be used for deterministic local vector e2e tests?
- Should MCP JSON-RPC batch requests return an empty response for all-notification batches, or the current filtered array behavior?
- Should `get_page` prefer `pageId` or `slugId` when both are provided and disagree?
- Should mixed allowed/denied `spaceIds` in search silently filter denied spaces or reject the whole request?
