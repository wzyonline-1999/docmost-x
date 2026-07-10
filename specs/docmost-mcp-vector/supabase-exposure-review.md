---
spec_id: docmost-mcp-vector-supabase-review
title: Supabase MCP Exposure Review
doc_type: security-review
status: verified-predeployment
version: v1
verified_at: 2026-07-10
project_ref: qpgiwaiwnhaybsakqvhp
---

# Supabase MCP Exposure Review

## Result

The planned MCP tables are not deployed yet. The production-safe target remains
the private `docmost` schema, accessed through the direct application role. No
Supabase schema or grant changes were made during this review.

Read-only verification returned:

- `docmost_app` has `search_path=docmost` and schema `USAGE`.
- `anon`, `authenticated`, and `service_role` have no `USAGE` on `docmost`.
- `information_schema.role_table_grants` returned zero `docmost` table grants
  for those three Data API roles.
- None of the six planned MCP tables currently exist in Supabase.

This matches Supabase's documented two-layer model: grants determine whether a
Data API role can reach an object, while RLS limits rows after access is granted.
See [Securing your API](https://supabase.com/docs/guides/api/securing-your-api).

RLS being disabled on internal `docmost` tables is not an MCP blocker in this
direct-connection/private-schema architecture because the Data API roles cannot
use the schema or its tables. RLS can still be added later as defense in depth,
but it must be tested against Docmost's application role before production use.

## Deployment Assertions

After running the MCP migrations, repeat these checks before enabling either
feature switch:

1. All six MCP tables exist in `docmost`, not `public`.
2. `docmost_app` still has `search_path=docmost`.
3. `anon`, `authenticated`, and `service_role` still have zero schema/table
   access to `docmost`.
4. The Data API exposed-schema configuration does not include `docmost`.
5. `MCP_ENABLED=false` and `VECTOR_SEARCH_ENABLED=false` remain in effect until
   application health and migration checks pass.

## Unrelated Existing Risk

The Supabase security advisor currently reports separate high-severity findings
in the exposed `public` schema, including tables with RLS disabled and sensitive
columns such as `public.sys_user.password` and
`public.blog_article_access.access_token`. It also reports mutable function
`search_path` warnings in existing `docmost` functions.

Those objects predate this MCP work and are outside this implementation plan.
They were not modified because enabling RLS or changing function execution
context without an application-specific migration could break other services.
They require a separate reviewed remediation plan. Advisor reference:
[Supabase database linter](https://supabase.com/docs/guides/database/database-linter).
