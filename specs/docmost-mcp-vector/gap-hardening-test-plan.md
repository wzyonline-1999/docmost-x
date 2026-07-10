---
spec_id: docmost-mcp-vector-gap-hardening
title: Docmost MCP and Vector Search Gap Hardening Test Plan
doc_type: test-plan
owner: zeyu.wang
status: draft
version: v1
source:
  - base-plan: specs/docmost-mcp-vector/test-plan.md
  - design: specs/docmost-mcp-vector/design.md
  - coverage-audit: "2026-07-09 gap review after local disabled/vector smoke runs"
---

# Docmost MCP and Vector Search Gap Hardening Test Plan

## 1. Objective

This plan covers the remaining high-value gaps after the first local MCP/vector smoke run. The base plan already proves the main happy path, core authentication, selected permission denials, page CRUD, audit events, rate-limit smoke, vector-disabled fallback, vector-enabled search, index retry, migration-up schema, config guards, and repository hygiene.

This gap-hardening plan focuses on confidence before deployment:

- Real workspace isolation rather than nonexistent-id smoke tests.
- Complete token and permission state matrices.
- Actor-user fail-closed behavior for write tools.
- Parameter boundaries around page selectors, content formats, idempotency, optimistic locking, pagination, and limits.
- Migration rollback on a disposable database.
- More realistic vector-indexing failure, replacement, deletion, and async listener behavior.
- Strict audit-log and log-safety assertions.
- JSON-RPC batch compatibility.

## 2. Current Baseline

Verified in the previous run:

- `T-01` through `T-31` disabled-vector runner passed: `32 pass / 0 fail / 0 skip`.
- `T-32` through `T-39` vector runner passed: `9 pass / 0 fail / 1 skip`.
- `T-40` was intentionally skipped because migration rollback must use a disposable DB.
- `T-41` and `T-42` config guard checks passed.
- MCP unit tests, TypeScript, `git diff --check`, and secret hygiene scan passed.

Known caveats:

- Postgres local DB reports a collation-version warning from image/host mismatch. It did not affect the smoke result.
- Vector E2E used a deterministic mock embedding provider, not a production provider.
- Some checks were broad smoke assertions rather than exhaustive branch assertions.

## 3. Coverage Matrix

| Gap area                                 | New case IDs                       | Priority | Notes                                                                    |
| ---------------------------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------ |
| Migration rollback and repeatability     | G-01, G-02                         | P0       | Must use a disposable DB or schema, never shared local data              |
| Real cross-workspace isolation           | G-03, G-04, G-05                   | P0       | Create two workspaces and real pages/spaces                              |
| Token states and token hygiene           | G-06, G-07, G-08, G-09, G-10       | P0       | Includes expired token and format-correct unknown token                  |
| Full permission-denial matrix            | G-11, G-12, G-13, G-14, G-15, G-16 | P0       | Cover every action column and high-risk index tools                      |
| Actor-user mapping failures              | G-17, G-18, G-19, G-20             | P0       | Write tools must fail closed                                             |
| Admin API edge behavior                  | G-21, G-22, G-23, G-24, G-25       | P1       | Permission upsert/delete, duplicate spaces, invalid actor, audit filters |
| Page selector and content boundaries     | G-26, G-27, G-28, G-29, G-30, G-31 | P1       | Slug/page id precedence and invalid content                              |
| Optimistic locking and write boundaries  | G-32, G-33, G-34, G-35             | P1       | `expectedUpdatedAt`, oversized content, parent validation                |
| Search scope and mode boundaries         | G-36, G-37, G-38, G-39             | P1       | Mixed allowed/denied spaces, invalid mode, long/blank query              |
| Rate-limit boundaries                    | G-40, G-41, G-42                   | P1       | At limit, over limit, reset, separate clients                            |
| JSON-RPC protocol compatibility          | G-43, G-44, G-45, G-46             | P1       | Batch and malformed request variants                                     |
| Vector provider and indexing robustness  | G-47, G-48, G-49, G-50, G-51, G-52 | P1       | Bad JSON/count/dimensions/non-numeric/timeout, chunk replacement         |
| Vector deletion and async event indexing | G-53, G-54, G-55                   | P1       | Page events and soft-deleted chunks                                      |
| Audit and log-safety strictness          | G-56, G-57, G-58, G-59             | P1       | Shape, filters, no token/content leak                                    |
| Repository and local-artifact hygiene    | G-60, G-61                         | P2       | Temp files and generated tokens remain outside repo                      |

## 4. Parameter Matrix

| Parameter                   | Values to cover                                                                                                                       | Constraints or notes                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Workspace                   | workspace A, workspace B, wrong workspace page id, wrong workspace space id                                                           | Cross-workspace real data must never leak title/content/snippet          |
| Token state                 | missing, malformed prefix, format-correct unknown, active, disabled, expired by timestamp, expired status, deleted, rotated old token | Active token is required for all tool calls                              |
| Actor user                  | valid, missing, deactivated, deleted, other workspace                                                                                 | All write tools require a valid same-workspace actor                     |
| Space permission action     | search, semantic search, read, create, update, append, delete, restore, index                                                         | Test both allowed and denied for each high-risk action                   |
| Space scope input           | omitted, one allowed, one denied, mixed allowed/denied, duplicated ids, wrong workspace id                                            | Mixed scope expected behavior should be no leak; decide reject vs filter |
| Page selector               | pageId, slugId, both same page, both disagree, neither, invalid uuid-like id, deleted page                                            | `pageId` precedence must be explicit                                     |
| Content format              | markdown, html, json, invalid format, omitted content, string content, object content, array content, null content, oversized content | Write path and read path both need coverage                              |
| Confirm flag                | omitted, false, true, non-boolean truthy value                                                                                        | High-risk tools require literal `true`                                   |
| Idempotency key             | absent, reused same request, reused changed request, same key across actions, very long key, same key across clients                  | Key scope is client + action + key                                       |
| Search mode                 | keyword, semantic, hybrid, invalid, omitted                                                                                           | Hybrid fallback should be explicit and safe                              |
| Query                       | normal, blank, too long, special tsquery chars, non-English text                                                                      | Long and blank queries must fail safely                                  |
| Pagination                  | omitted, zero, negative, decimal, huge limit, huge offset                                                                             | Limits clamp; invalid offset rejects                                     |
| Embedding provider response | valid, HTTP 502, invalid JSON, wrong vector count, wrong dimensions, non-numeric, timeout                                             | Provider failures must not produce unsafe 500 in hybrid keyword fallback |
| Vector index job            | queued, running, succeeded, failed, cancelled, missing page, deleted page, batch space, batch workspace                               | Retry rules must respect permission and state                            |
| Audit/log data              | IPv4, IPv6, blank/null IP, request id, resource id, before/after, metadata, search filters                                            | Must not store full tokens or unnecessary content                        |

## 5. Test Cases

| ID   | Scenario                                                            | Preconditions                                          | Test data / setup                                    | Action                                                                     | Expected result                                                     | Expected evidence                           | Type           |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | -------------- |
| G-01 | Migration down removes MCP/vector artifacts                         | Disposable DB after all migrations up                  | Fresh local pgvector DB/schema                       | Run `migration:down` for MCP/vector migration                              | MCP/vector tables and indexes removed; base Docmost tables remain   | Schema inspection query                     | Regression     |
| G-02 | Migration down/up is repeatable                                     | Disposable DB                                          | After G-01                                           | Run migration up again                                                     | All MCP/vector tables, constraints, indexes, and extension restored | Schema inspection and app boot              | Compatibility  |
| G-03 | Cross-workspace page read blocked                                   | Two workspaces with real pages                         | Client in workspace A; page in workspace B           | `get_page` with workspace B page id                                        | Not found or forbidden; no title/content leak                       | JSON-RPC error and no B content in response | Security       |
| G-04 | Cross-workspace search scope blocked                                | Two workspaces with unique keywords                    | Client in workspace A; `spaceIds` includes B         | `search_docs` keyword/hybrid                                               | Workspace B result omitted or request rejected; no snippet leak     | Result list and raw response scan           | Security       |
| G-05 | Cross-workspace index job blocked                                   | Two workspaces with real pages                         | Client in A; page/space in B                         | `reindex_page`, `get_index_status`, `list_index_jobs`                      | No access to B job/page details                                     | JSON-RPC errors contain no B metadata       | Security       |
| G-06 | Format-correct unknown token rejected                               | MCP enabled                                            | Token with `dmost_mcp_` prefix but unknown hash      | `tools/list`                                                               | JSON-RPC auth error                                                 | No `lastUsedAt` change and no client match  | Exception path |
| G-07 | Timestamp-expired token rejected and marked expired                 | Existing active client with `expiresAt` in past        | DB fixture or admin API if allowed                   | `tools/list`                                                               | Auth error; client status becomes `expired`                         | Client row status and response              | Regression     |
| G-08 | Status-expired token rejected                                       | Existing client status `expired`                       | DB fixture                                           | `tools/list`                                                               | Auth error distinct from disabled                                   | Response and no tool execution              | Exception path |
| G-09 | Deleted token cannot authenticate after same hash was valid         | Existing client then soft deleted                      | Use old token                                        | `initialize`                                                               | Invalid token error                                                 | Client `deletedAt` and response             | Security       |
| G-10 | Rotated token old value never appears in admin list                 | Client rotated                                         | Old and new token known in memory only               | `/api/mcp/admin/clients`                                                   | Only `tokenLastFour`, no full token/hash                            | Admin response scan                         | Security       |
| G-11 | Update/append permission denied                                     | Client can read but cannot update/append               | Existing allowed-space page                          | `update_page`, `append_page`                                               | Permission denied; page unchanged                                   | Response and DB page content/title          | Security       |
| G-12 | Delete/restore permission denied                                    | Client can read but cannot delete/restore              | Existing page, soft-deleted page                     | `delete_page`, `restore_page`                                              | Permission denied; deleted state unchanged                          | Response and DB `deletedAt`                 | Security       |
| G-13 | Semantic-search permission denied                                   | Client can keyword search but cannot semantic search   | Indexed page                                         | `semantic_search_docs`; `search_docs mode=semantic`                        | Permission denied or empty no-leak result per chosen contract       | Response and no content leak                | Security       |
| G-14 | Reindex-space/workspace denied                                      | Client lacks index permission for target space         | Existing indexed pages                               | `reindex_space`, `reindex_workspace`                                       | Permission denied or queues only allowed spaces                     | Job rows by space                           | Security       |
| G-15 | Retry index job denied across space boundary                        | Failed job in denied space                             | Client lacks index permission                        | `retry_index_job confirm=true`                                             | Permission denied; attempt count unchanged                          | Job row before/after                        | Security       |
| G-16 | Deleted permission row denies access                                | Permission soft-deleted                                | Existing page/space                                  | Any read/write/index tool                                                  | Permission denied                                                   | Permission `deletedAt` and response         | Regression     |
| G-17 | Missing actor blocks write tools                                    | Client has permissions but `actorUserId=null`          | Existing page and space                              | `create_page`, `update_page`, `append_page`, `delete_page`, `restore_page` | Forbidden with actor mapping message; no mutation                   | Response and DB unchanged                   | Security       |
| G-18 | Deactivated actor blocks write tools                                | Actor user deactivated                                 | Client maps to that actor                            | Write tool call                                                            | Forbidden; no mutation                                              | User row and response                       | Security       |
| G-19 | Deleted actor blocks write tools                                    | Actor user soft-deleted                                | Client maps to that actor                            | Write tool call                                                            | Forbidden; no mutation                                              | User row and response                       | Security       |
| G-20 | Cross-workspace actor rejected at admin create/update               | Admin session in workspace A                           | Actor id from workspace B                            | Create/update MCP client                                                   | Bad request; no client mutation                                     | Admin response and DB count                 | Security       |
| G-21 | Duplicate permissions rejected on create                            | Admin session                                          | Same `spaceId` twice in `permissions`                | Create client                                                              | Bad request `Duplicate MCP space permissions`                       | No client row                               | Boundary       |
| G-22 | Upsert permission inserts then updates                              | Admin session, existing client                         | Permission for one space                             | Upsert twice with changed flags                                            | One active permission row; flags updated                            | Permission row and audit events             | Main path      |
| G-23 | Delete permission is soft delete                                    | Admin session, existing permission                     | Active permission                                    | Delete permission                                                          | Permission `deletedAt` set; client loses access                     | DB row, audit, MCP denied call              | Regression     |
| G-24 | Audit log filters work together                                     | Existing audit logs                                    | Multiple clients/events/resources/date ranges        | Query by client, event, tool, resource, date                               | Only matching rows returned                                         | Response item fields                        | Branch path    |
| G-25 | Non-admin logged-in user blocked                                    | Real normal workspace member                           | Authenticated session without API credential ability | Call admin endpoints                                                       | Forbidden; no DB mutation                                           | HTTP response and service not executed      | Security       |
| G-26 | `get_page` by slug id works                                         | Page with slug id                                      | Client can read                                      | `get_page { slugId }`                                                      | Correct page returned                                               | Page id/title/content                       | Main path      |
| G-27 | `get_page` with both pageId and disagreeing slugId is deterministic | Two pages                                              | `pageId` for A, `slugId` for B                       | `get_page`                                                                 | Contract verified: either pageId wins or request rejects            | Response and documented expected behavior   | Boundary       |
| G-28 | Missing page selector rejected                                      | Client can read                                        | No `pageId` or `slugId`                              | `get_page`                                                                 | Bad request                                                         | JSON-RPC `-32602`                           | Boundary       |
| G-29 | Deleted page cannot be read normally                                | Soft-deleted page                                      | Client can read                                      | `get_page`                                                                 | Not found                                                           | Response no content leak                    | Regression     |
| G-30 | Read content formats                                                | Page with markdown/object content                      | Client can read                                      | `get_page` format markdown/html/json                                       | Each format returns expected type and content                       | Response content type/value                 | Main path      |
| G-31 | Invalid content/format rejected                                     | Client can write                                       | content array/null; invalid `format`                 | create/update                                                              | Bad request; no mutation                                            | Response and DB unchanged                   | Boundary       |
| G-32 | Optimistic lock success                                             | Existing page                                          | Correct `expectedUpdatedAt`                          | `update_page`                                                              | Update succeeds                                                     | Page updatedAt changes                      | Main path      |
| G-33 | Optimistic lock conflict                                            | Existing page updated after timestamp                  | Stale `expectedUpdatedAt`                            | `update_page`                                                              | Conflict; page unchanged                                            | Response and DB page unchanged              | Regression     |
| G-34 | Invalid optimistic-lock timestamp rejected                          | Existing page                                          | `expectedUpdatedAt=not-a-date`                       | `update_page`                                                              | Bad request                                                         | Response                                    | Boundary       |
| G-35 | Parent page validation                                              | Existing page in different space and deleted parent    | New child create request                             | `create_page parentPageId=bad parent`                                      | Not found; no page created                                          | Response and page count                     | Security       |
| G-36 | Mixed allowed/denied search scope no leak                           | Client allowed A, denied B                             | Unique keyword in B                                  | `search_docs` with `[A, B]`                                                | No B result/snippet; behavior documented as filter or reject        | Full response scan                          | Security       |
| G-37 | Invalid search mode rejected                                        | Client can search                                      | `mode=bad`                                           | `search_docs`                                                              | Bad request                                                         | JSON-RPC error                              | Boundary       |
| G-38 | Blank and too-long query rejected                                   | Client can search                                      | Blank string and over max length                     | search tools                                                               | Bad request; no provider call for invalid query                     | Response and mock provider call count       | Boundary       |
| G-39 | Special-character query is safe                                     | Client can search                                      | tsquery special chars and non-English text           | `search_docs keyword/hybrid`                                               | No SQL error; results or empty list                                 | Response and server logs                    | Regression     |
| G-40 | Rate limit allows exactly max requests                              | Low limit env                                          | Active token                                         | Send exactly max requests                                                  | All succeed                                                         | Response count                              | Boundary       |
| G-41 | Rate limit resets after window                                      | Low window env                                         | Active token                                         | Exceed, wait window, retry                                                 | Retry succeeds after reset                                          | Response and timing                         | Boundary       |
| G-42 | Rate limit buckets are per client                                   | Two clients same workspace                             | Low limit env                                        | Exhaust client A, call client B                                            | B still succeeds                                                    | Responses                                   | Security       |
| G-43 | JSON-RPC batch mixed success/failure                                | Active token                                           | Batch initialize + bad method + tools/list           | `POST /mcp` array                                                          | Per-request response order and errors correct                       | Response array                              | Compatibility  |
| G-44 | JSON-RPC all-notification batch                                     | Active token                                           | Batch of notification requests                       | `POST /mcp` array                                                          | Empty response array or agreed no body behavior                     | HTTP/body contract                          | Compatibility  |
| G-45 | Invalid JSON-RPC version rejected                                   | Active token                                           | `jsonrpc=1.0`                                        | Any method                                                                 | Bad request JSON-RPC error                                          | Response code/message                       | Boundary       |
| G-46 | Non-object tool arguments rejected                                  | Active token                                           | `arguments` string/array                             | `tools/call`                                                               | Bad request                                                         | Response                                    | Boundary       |
| G-47 | Embedding provider invalid JSON                                     | Vector enabled                                         | Mock returns non-JSON                                | semantic/hybrid search and reindex                                         | Semantic returns provider error; hybrid keyword fallback warns      | Response and logs                           | Exception path |
| G-48 | Embedding provider wrong vector count                               | Vector enabled                                         | Mock returns fewer/more vectors                      | reindex multi-chunk page                                                   | Job failed with safe error                                          | Job `failed`, `lastError` safe              | Exception path |
| G-49 | Embedding provider non-numeric vector value                         | Vector enabled                                         | Mock returns `NaN`/string/null                       | semantic/reindex                                                           | Provider error, no chunk write                                      | Response/job rows                           | Exception path |
| G-50 | Embedding timeout behavior                                          | Vector enabled                                         | Mock delays beyond timeout if timeout implemented    | semantic/hybrid/reindex                                                    | Hybrid falls back; job failed; no crash                             | Response and logs                           | Exception path |
| G-51 | Chunk replacement removes stale chunks                              | Existing page indexed into multiple chunks             | Update content to shorter text                       | Reindex page                                                               | Old extra chunks soft-deleted; active chunk count shrinks           | Chunk rows before/after                     | Regression     |
| G-52 | Multi-chunk search returns page once or contract is explicit        | Long page indexed into multiple chunks                 | Query matching multiple chunks                       | semantic/hybrid search                                                     | Duplicate-page behavior documented and acceptable                   | Result list page ids                        | Branch path    |
| G-53 | Soft delete marks chunks deleted                                    | Indexed page                                           | Client can delete                                    | `delete_page confirm=true` plus async/manual index                         | Active chunks become zero/deleted                                   | Chunk rows and index status                 | Regression     |
| G-54 | Restore reindexes page                                              | Deleted indexed page                                   | Client can restore                                   | `restore_page confirm=true`                                                | Chunks become active again                                          | Chunk rows/index status                     | Regression     |
| G-55 | Page event listener enqueues async jobs                             | Vector enabled                                         | Trigger create/update/delete/restore events          | Wait for listener delay                                                    | Jobs queued with correct job type and workspace                     | Job rows and logs                           | Compatibility  |
| G-56 | Audit write shape is strict                                         | Run create/update/append/delete/restore/reindex/rotate | Known request ids/resources                          | Query audit logs                                                           | Correct event/resource/requestId/before/after/metadata              | Audit response and DB rows                  | Observability  |
| G-57 | Audit filters do not cross workspace                                | Two workspaces with audit logs                         | Admin in A                                           | Query audit logs                                                           | Only A logs returned                                                | Response scan                               | Security       |
| G-58 | Audit and logs do not leak tokens/full content                      | Trigger auth failures and writes                       | Generated token and long content known               | Inspect audit rows and logs                                                | No full token, token hash, or unnecessary full content              | Grep/log scan                               | Security       |
| G-59 | IPv4/IPv6/blank IP audit handling                                   | Controller-level or E2E headers                        | IPv4, IPv6, blank, null                              | Write audited operation                                                    | Valid IPs persisted; blank/null as null                             | DB `inet` rows                              | Regression     |
| G-60 | Temp runner artifacts stay outside repo                             | After local tests                                      | `/private/tmp` scripts and cookies                   | `git status`, repo grep                                                    | No temp files under repo except intended specs/tests                | Git status                                  | Cleanup        |
| G-61 | Generated secrets are absent from tracked files                     | After token creation and vector tests                  | Known generated tokens/provider keys                 | Secret grep                                                                | No full generated MCP token/API key in repo                         | Grep output                                 | Cleanup        |

## 6. Recommended Execution Order

1. Create a disposable Postgres database/schema with pgvector enabled.
2. Run `G-01` and `G-02` migration rollback/reapply checks first.
3. Start the server in deterministic E2E mode with low rate-limit thresholds and mock embedding provider.
4. Create two real workspaces, one admin user per workspace, one normal user, and one disabled/deleted actor fixture.
5. Run cross-workspace security cases `G-03` through `G-05`.
6. Run token-state cases `G-06` through `G-10`.
7. Run full permission and actor matrix `G-11` through `G-20`.
8. Run admin API edge behavior `G-21` through `G-25`.
9. Run page selector/content/write boundaries `G-26` through `G-35`.
10. Run search, rate-limit, and JSON-RPC protocol cases `G-36` through `G-46`.
11. Run vector provider/index robustness cases `G-47` through `G-55`.
12. Run audit/log-safety and repository hygiene cases `G-56` through `G-61`.
13. Finish with unit tests, TypeScript, `git diff --check`, and secret hygiene grep.

## 7. Automation Plan

High-value automation:

- Add a second local E2E runner focused on `G-03` through `G-20`.
- Add unit tests for `McpRateLimitService` window reset and per-client buckets.
- Add unit tests for `McpIdempotencyService` same key across client/action boundaries.
- Add integration-style controller tests for JSON-RPC batch behavior.
- Add vector-index service tests for chunk replacement, deleted chunks, bad provider responses, and retry state transitions.
- Add admin-service tests for duplicate permissions, permission upsert/delete, invalid actors, and audit filters.
- Add migration test script that provisions a disposable DB, runs up/down/up, and asserts schema state.

Manual or semi-manual checks:

- Production embedding provider smoke with a non-sensitive test page.
- Log-safety scan from the actual runtime logger after forced failures.
- Large-content boundary test if local E2E runtime is too slow for repeated runs.

## 8. Exit Criteria

This hardening pass is complete when:

- All P0 cases pass.
- All P1 cases either pass or have a documented product decision for expected behavior.
- Migration rollback has been verified on a disposable DB.
- Cross-workspace and actor-user failure modes have concrete E2E evidence.
- Audit/log checks show no full token, token hash, provider key, or unnecessary full page content leakage.
- Any remaining P2 cleanup items are documented and non-blocking.

## 9. Open Decisions

- For mixed allowed/denied `spaceIds`, should MCP reject the whole request or silently filter denied spaces? Current smoke accepted no-leak behavior; product contract should be explicit.
- For `get_page` with both `pageId` and `slugId` that disagree, should `pageId` win or should the request be rejected?
- For semantic search returning multiple chunks from the same page, should results be deduplicated by page or expose chunk-level results?
- Should read operations be audited by default, sampled, or disabled unless explicitly configured?
- Should timeout behavior be implemented inside `McpEmbeddingService`, or rely on infrastructure-level timeouts?
