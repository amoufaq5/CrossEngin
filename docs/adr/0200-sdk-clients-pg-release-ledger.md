# ADR-0200: persisted SDK release ledger (Phase 3 P3.45)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0197/0198 (generation bridge + release pipeline), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.42/P3.43 produce `ClientRelease` + `CompatibilityEntry` records (the SDK publish
pipeline), but only in memory — there was no queryable history of which clients
were generated/published or their per-API-version compatibility.

## Decision

A persisted SDK ledger — a new `@crossengin/sdk-clients-pg` package (the **65th**)
over the meta-schema, following the established `*-pg` pattern.

- **Tables.** `meta.sdk_client_releases` **already existed** (a full column-mapped
  `ClientRelease`, `published_by` a UUID FK to `meta.users`) — reused, not
  duplicated. P3.45 adds **one** new platform-wide table
  `meta.sdk_compatibility_entries` (`entry_key` unique = `<lang>:<version>:<api>`,
  language/client_version/api_version/level/warning_count/notes/determined_at + the
  full entry as JSONB). No tenant_id → no RLS (SDK clients are platform artifacts,
  like `sdk_client_releases`). Meta-schema now has **126** tables.
- **`PostgresClientReleaseStore`** — `record` upserts a `ClientRelease` keyed on
  `release_id` (releases transition status; `DO UPDATE` refreshes the mutable
  lifecycle columns), `get(releaseId)` + `list({language?, channel?, status?,
  limit?})` reconstruct releases from the columns through `ClientReleaseSchema`
  (coercing BIGINT strings + `Date` timestamps, omitting absent optionals).
- **`PostgresSdkCompatibilityStore`** — `record` upserts a `CompatibilityEntry` keyed
  on `entry_key`, `listForApiVersion` / `listForClient` reconstruct from the stored
  JSONB through `CompatibilityEntrySchema`.

## Consequences

- **65 packages + 4 apps, 126 meta-schema tables, ~7,214 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New offline tests (fake
  `PgConnection`): `release-store.test.ts` (upsert SQL/params, schema-name guard,
  get/list filters + limit clamp, row→release coercion) + `compatibility-store.test.ts`
  (entry-key, upsert, JSONB reconstruction). The schema-drift CI gate picks up the
  new table from `META_TABLES` automatically (verified: `emit-bootstrap` emits it).
- A `ClientRelease`/`CompatibilityEntry` (e.g. from `planClientRelease`) now persists
  to a queryable ledger: "every published Go client", "what's compatible with API
  v2". Wiring the operate-server `openapi-client --release-version` path to write the
  ledger (under a `--persist` flag + a real user actor) + a gated PG integration test
  are the deployment-side follow-ups.
