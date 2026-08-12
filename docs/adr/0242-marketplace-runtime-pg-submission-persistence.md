# ADR-0242: Pack-version submission persistence in marketplace-runtime-pg (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0241 (submission pipeline), `marketplace-runtime-pg` (installation persistence), ADR-0077 (Phase 4) |

## Context

The third-party submission pipeline (ADR-0241) drives a pack version through
`draft → in_review → published` in-process, but the `PackVersionRecord`s evaporated at process exit.
`marketplace-runtime-pg` already persists the *install* side; this extends it with the *publish* side so
the version registry survives restarts and is queryable.

## Decision

- **Reuse the existing `meta.pack_versions` table.** The submission engine's `PackVersionRecord` matches
  it exactly (UUID PK, `(pack_id, version)` unique, `signature` JSONB, the status/review/publish/retire
  columns), so the sibling `UPSERT`s into it rather than a purpose-built table. `pack_versions` is
  **platform-wide** (no `tenant_id` — packs are global), so no tenant RLS context is needed (unlike the
  tenant-scoped installation store).
- **`PostgresPackVersionStore`** — `upsert(record)` (`INSERT … ON CONFLICT (pack_id, version) DO UPDATE`
  of every mutable column; a version moving through the pipeline refreshes its one row),
  `getByPackVersion(packId, version)`, `listByPack(packId, status?)`. Reads round-trip the row (JSONB
  signature, snake→camel, null optionals dropped) back through `PackVersionRecordSchema`.
- **`PersistentPackSubmissionEngine`** / `buildPersistentPackSubmissionEngine(conn)` — wraps the pure
  `PackSubmissionEngine` so `submit` / `submitForReview` / `recordReview` / `publish` / `deprecate` /
  `withdraw` each run the engine step then `upsert` the result. The pure engine stays the source of
  truth for the state machine + signature/gate checks; the wrapper is the persistence boundary, so a
  rejected step (bad signature, illegal transition, publish-gate failure) never writes.

## Consequences

- The submission registry is now durable + queryable: "every version of pack X and its status", "all
  versions pending security review" are single queries against `pack_versions`. A version advances
  through the pipeline as a single row (idempotent `UPSERT` on the natural key), so a retried step is a
  no-op refresh.
- Reusing `pack_versions` (vs. a purpose-built table) keeps one source of truth for the registry — the
  contract table already models every column, and the record's `(pack_id, version)` satisfies its unique
  key, so no id resolver is needed. No new META table (count stays 133).
- Persist-after-succeed means the DB never holds a version the pure engine rejected — the signature
  verification, transition guard, and publish gate all run before any write.
- Fake-`PgConnection` tests (UPSERT SQL + JSONB round-trip; the full submit → review → publish flow
  persisting each step; a bad-signature submission writing nothing) keep it offline-testable; the
  live-Postgres path is integration-only, like the other `-pg` siblings.
- +6 tests. Full build + typecheck + workspace tests green. No new META table, no new package (extends
  `marketplace-runtime-pg`), no new dependency.
- Follow-up (open): a third-party submission HTTP edge in `operate-server` (author submits → review →
  publish over the registry), and review-history / audit rows beyond the current version row.
