# Catalog Bundle v2

Catalog v2 is a read-only, permission-scoped MCP extension for resolving a
current `qts-fact-catalog.v1` reference closure in one PostgreSQL
`REPEATABLE READ READ ONLY` transaction. The published v1 tools and schemas
remain unchanged.

## Tools and schemas

| Tool                        | Response schema              |
| --------------------------- | ---------------------------- |
| `resolve_catalog_bundle_v2` | `catalog-bundle.v2`          |
| `resolve_catalog_delta_v2`  | `catalog-delta.v2`           |
| Both                        | `catalog-freshness-proof.v2` |

The request contract selector remains `qts-fact-catalog.v1`. A v2 page is
recognized only from the first complete fenced `yaml` block. Legacy document
front matter and later example blocks are ignored. Unsupported, malformed, and
ambiguous identities remain unresolved; they are never inferred from titles or
search snippets.

The response schemas are stored in `apps/server/src/core/mcp/schemas`. The
`docmost-knowledge` plugin ships the same files and applies an additional
strict validator before returning a remote result.

## Reference extractor

`qts-fact-catalog-extractor.v2.0.0` declares explicit fields for each supported
`document_type/schema_version` pair:

| Document schema                                    | Scanned references                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `service_profile/service-profile.v2`               | `fact_sources`, `query_profile_refs`, `environments.{environment}.gateway_routes`                   |
| `infrastructure_profile/infrastructure-profile.v2` | `fact_sources`, `query_profile_refs`, `gateway_observability.*.query_profile_id`                    |
| `gateway_route/gateway-route.v1`                   | `fact_sources`, gateway profile and query-profile references, reverse `backend_services` validation |
| `fact_source_profile/fact-source-profile.v2`       | `fact_sources`, default query profiles, reverse query-profile-set validation                        |
| `query_profile_set/query-profile-set.v1`           | `fact_sources`, `fact_source`, `query_profiles`                                                     |
| `known_root_cause/known-root-cause.v1`             | reverse candidate discovery through `affected_entities`                                             |

Known-root-cause pages are candidates only when they are active, confirmed,
environment-compatible, and affect at least one resolved root entity. A
candidate is not an incident conclusion.

## Fingerprint

The bundle fingerprint is lowercase SHA-256 over canonical JSON. Object keys
are sorted lexicographically, arrays use the contract's canonical ordering, and
no insignificant whitespace is emitted. It covers the contract, bundle schema,
Catalog root, environment, roots, known-root-cause candidates, page manifest,
edges, unresolved references, closure status, and extractor version. Exact
Markdown UTF-8 bytes enter through each manifest `content_sha256`.

## Freshness proof

The server derives an Ed25519 seed with HKDF-SHA-256 from
`MCP_CATALOG_SIGNING_SECRET`, falling back to `APP_SECRET`. The salt is
`docmost-mcp-catalog` and the info string is
`catalog-freshness-proof.v2/ed25519`. Replicas sharing that secret therefore
publish the same SPKI DER base64url public key and key ID.

The signature is Ed25519 over canonical JSON for every proof field except
`signature`. It binds the server-generated start time, verification time,
elapsed time, one-use challenge, Catalog scope, opaque authorization-context
hash, requested roots, repeatable-read/read-only assertions, page manifest,
extractor version, and bundle fingerprint.

Redis `SET NX EX` rejects challenge replay across replicas. Delta also verifies
the previous signature against the active key or an explicitly configured old
public key, then checks its authorization context, roots, scope, manifest, and
fingerprint before taking a new snapshot.

Neither v2 tool is transparently retryable with the same request. The challenge
is consumed before the Catalog snapshot begins, so an ambiguous transport
failure requires a new call with a fresh challenge.

The plugin verifies the self-contained Ed25519 proof over the authenticated
HTTPS response. Operators may additionally pin one or more `(key_id,
public_key)` pairs per profile. Keep both old and new public keys pinned during
a planned rotation, then remove the old key after the Delta acceptance window.

## Delta and cache boundary

Delta recomputes the complete current closure. `added`, `updated`, `removed`,
and `unchanged` are mutually exclusive and cover the previous/current page-ID
union. A page is updated when either timestamp or hash changes. Cached Markdown
is reusable only after a current proof revalidates the exact
`(page_id, updated_at, content_sha256)` tuple. Runtime facts and prior diagnosis
conclusions are outside this cache boundary.

## Limits and failure behavior

The shared Catalog limits are 32 roots, 64 tree levels, 2,000 scanned subtree
pages, 512 closure pages, 4,096 edges, 1 MiB Markdown per page, 32 MiB scanned
content, an 8 MiB server response, and 10 seconds of trusted server resolution
time. PostgreSQL statements receive the same 10-second timeout. The local
plugin accepts at most 32 MiB and defaults to 16 MiB. Limit overflow fails
explicitly; it never truncates a closure.

Missing and unauthorized Catalog roots use the same not-found response. Reads
remain inside the requested subtree, workspace, actor membership, page access,
and MCP client space permissions. The proof exposes only an opaque hash of that
authorization context.
