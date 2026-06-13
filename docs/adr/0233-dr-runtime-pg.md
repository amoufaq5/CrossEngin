# ADR-0233: DR persistence — dr-runtime-pg (Phase 3 P8.2)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0085 (dr-runtime), ADR-0031 (disaster recovery), ADR-0222 (active-active-runtime-pg pattern) |

## Context

P8 (ADR-0085) shipped `dr-runtime` as a pure failover coordinator + drill assessor, but it
persists nothing. Following the "every pure runtime gets a Postgres sibling" pattern, the
DR runtime needs durable history — "the failovers we ran + their RPO/RTO" and "which drills
are overdue". The meta-schema already has the column-mapped `meta.failover_records` +
`meta.dr_drills` tables, so no new META tables are needed.

## Decision

A new package `@crossengin/dr-runtime-pg` (the **74th**), deps `dr` + `kernel-pg`, over the
**pre-existing** platform-wide `meta.failover_records` + `meta.dr_drills` tables (DR is a
region/platform concern, not tenant-scoped → no RLS). 3 modules:

- **`records.ts`** — `rowToFailoverRecord` / `rowToDrillRecord` (reconstruct through the
  contract schemas: JSONB arrays, BIGINT strings → numbers, `Date` → ISO, null optionals
  omitted) + pure `failoverInsertParams` / `drillInsertParams` projectors.
- **`failover-store.ts`** — `PostgresFailoverStore`: `record` upserts on `id` (refreshing the
  lifecycle columns on a transition), `get`, `listRecent`.
- **`drill-store.ts`** — `PostgresDrillStore`: `record` upserts on `id`, `get`, `listForKind`,
  `listOverdue(asOf)` (the `next_drill_due_at <= asOf` query a scheduler pages on).

Record ids must be UUIDs (the table PKs); the `dr-runtime` coordinator mints them.

## Consequences

- **74 packages + 4 apps, 128 meta-schema tables, ~7,490 offline tests + 63 gated
  real-Postgres integration tests.** No new META_ tables (reuses `failover_records` /
  `dr_drills`). New tests: `store.test.ts` (7, offline with a fake conn — row reconstruction
  + insert-param projection + upsert SQL shape + schema-name rejection + the overdue query)
  + a gated `integration.test.ts` (persist a succeeded failover + a passing drill → read
  back, find the drill overdue past its due date — green on live Postgres 16).
- DR failover + drill outcomes now have a durable, queryable history; a scheduler can find
  overdue drills with one query. The remaining P8 increments: the SLO loop on operate-server's
  real request stream (largely landed P2.32/P2.37) and scheduled access-review campaigns.
