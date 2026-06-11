# ADR-0201: SDK ledger CLI persistence (Phase 3 P3.46)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0200 (sdk-clients-pg ledger), ADR-0198 (release pipeline), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.45 added the persisted SDK ledger (`@crossengin/sdk-clients-pg`), but nothing
wrote to it from the pipeline — the `openapi-client --release-version` path produced
a `ClientRelease` + `CompatibilityEntry` only in memory / to a file. The ledger was
a queryable store with no producer wired in.

## Decision

Wire the `openapi-client` release path to the ledger behind a `--persist` flag.

- **`apps/operate-server openapi-client --persist`** (requires `--release-version`):
  after planning the release + compatibility entry (P3.43), `executeOpenApiClient`
  opens a PG connection (`parsePgEnvConfig`), records the `ClientRelease` via
  `PostgresClientReleaseStore.record` + the `CompatibilityEntry` via
  `PostgresSdkCompatibilityStore.record`, and closes the connection (in a `finally`).
  It composes with the existing file/stdout output — `--persist` is purely
  additive. A **draft** release (no `--publish-by`) persists with `published_by`
  NULL (no users FK needed); a **published** release's `--publish-by` actor must be
  a `meta.users` UUID (the column's FK). The app gained a dependency on
  `@crossengin/sdk-clients-pg`.

## Consequences

- **65 packages + 4 apps, 126 meta-schema tables, ~7,216 offline tests + 54 gated
  real-Postgres integration tests + five CI gates.** New tests: an
  `openapi-client-cli.test.ts` parser case (`--persist` + its `--release-version`
  requirement) + a gated `integration-sdk-ledger.test.ts` (drives
  `--release-version --persist` end-to-end over real Postgres, reads the release +
  compatibility entry back through the stores, asserts idempotent re-persist). No
  new META_ tables (P3.45's `sdk_compatibility_entries` + the existing
  `sdk_client_releases`).
- The SDK pipeline now runs all the way to durable storage from one command:
  OpenAPI → emit → `GenerationRun` → `ClientRelease` + `CompatibilityEntry` →
  persisted ledger. Registry publication (npm/PyPI/Go proxy/Packagist) + a `releases`
  read/verify CLI over the ledger are the remaining follow-ups.
