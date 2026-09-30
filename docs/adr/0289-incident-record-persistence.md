# ADR-0289: Giving a declared incident somewhere to live (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-30 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0288 (integrity incident escalation), ADR-0060 (SLO enforcement runtime), ADR-0286 (audit-log anchoring), ADR-0284 / 0285 (reconciling dead declarations) |

## Context

ADR-0288 left the load-bearing gap: *"nothing persists an `IncidentRecord`. `incident-response`
has no `-pg` sibling — the SLO loop has the same gap — so the declared record exists in memory, in
a log line and in the audit row's summary, but the incident's own lifecycle (triage, roles,
mitigation, postmortem) has nowhere to live."*

**Investigating that turned out to falsify its premise.** `meta.incidents` has existed since the
Phase-1 contracts, with a column for every field of `IncidentRecordSchema` — along
`incident_runbook_executions`, `incident_postmortems` and `incident_communications`. All four have
**zero consumers**: nothing in `packages/` or `apps/` reads or writes any of them. The table was
not missing. It was dead.

And it could not have worked. `declared_by` was `UUID NOT NULL REFERENCES meta.users(id)`, while
`IncidentRecord.declaredBy` is any non-empty string and **every incident this platform declares
automatically is declared by `"operate-server"`** — a scheduler with no user row. The one table
meant to store incidents was structurally incapable of storing the only incidents anything
produces.

## Decision

- **Reconcile the dead table; do not add a parallel one.** This is the ADR-0284 / 0285 pattern: a
  declared artifact with no consumers is resolved by making it the real one, not by shipping a
  second table with the same purpose. `meta.incidents` keeps its name, its 8-state status check and
  its normalized columns. Net meta-schema growth: **zero new tables, still 139.**
- **`declared_by` becomes `TEXT`.** The store must accept every record the contract accepts. A FK
  to `meta.users` narrows the column below the contract and excludes exactly the automated
  declarers, so it goes rather than the contract bending to it.
- **The database allocates incident ids.** `year` + `sequence_number` are derived from
  `incident_id` under a `UNIQUE (year, sequence_number)` constraint, and `allocateIncidentId` takes
  `MAX(sequence_number) + 1` under an advisory lock. This closes ADR-0288's *"open-incident state
  is per-process, so a restart re-declares"* on the id half: a restart continues the year's
  sequence instead of reusing `INC-YYYY-0001`, and a collision is impossible in the database rather
  than merely unlikely in a counter.
- **One answer to "may this incident move to that status?", and it is the schema.**
  `incidentTransitionBlockers` builds the record the transition would produce and asks
  `IncidentRecordSchema.safeParse`, then maps the issues to blockers. Re-listing the role /
  status-page / root-cause requirements in the runtime would be a second copy that drifts from the
  first. `transitionIncident` throws with the same list it would have reported.
- **A target status stamps the timestamps it implies, transitively.** `INCIDENT_TRANSITIONS` allows
  `mitigating -> resolved`, skipping the state where `mitigatedAt` is normally set, while the
  schema requires `mitigatedAt` before `resolvedAt` and `ackedAt` before `mitigatedAt`. A resolve
  therefore back-fills every earlier stamp it lacks, or it produces a record the schema rejects for
  a reason unrelated to the caller's intent.
- **An automatic recovery cancels; it never resolves.** `triaged` requires the on-call roles to be
  assigned — five of them at sev1 — which no automated declarer can do, so `cancelled` is the only
  status reachable from `declared` without a human. That is not a workaround: an incident nobody
  took is not an incident that was mitigated, and recording it as resolved would claim a response
  that never happened. Once the status has moved past `declared` a human owns the record and
  `cancelIfUntriaged` returns null.
- **Optimistic concurrency, failing closed.** Two schedulers can hold one incident. Every write
  states the revision it read and a zero-row update raises `IncidentRevisionConflictError` rather
  than silently discarding the other writer's transition.
- **The timeline is append-only, enforced in the engine.** A mutator that edits or drops an
  already-recorded entry is refused before any SQL runs. The timeline is the incident's account of
  itself; an update that edits history is not an append.
- **The replayer re-parses rows rather than re-deriving them.** There is no event log to fold — the
  row *is* the record. What the replayer adds is the check the database cannot perform: a CHECK
  constraint can say `status` is one of eight values, but not that a triaged sev1 has five active
  role holders or that a closed incident carries a root cause. Those live in `superRefine`, so a
  row edited by hand is invalid in ways only a re-parse finds. `sla_breached_while_open` is not
  corruption but the question persistence makes cheap: which open incident is past its window with
  nobody on it.
- **`formatIncidentId` moves to the contracts package**, beside the pattern it must satisfy and the
  `parseIncidentId` a store needs to derive `year`/`sequence_number` by the same rule.
  `observability-runtime` re-exports it, so no caller changes and there is one definition instead
  of the two a new package would have created.
- **Platform-wide, no RLS.** An incident may name many tenants or none; confining it to one would
  hide exactly the cross-tenant events incidents describe. Same class as deployments and
  e-discovery requests — and the reason nothing tenant-facing is wired to this store.

## Consequences

- **Verified live** against a real Postgres, the whole lifecycle:
  - a declare wrote `declared_by = 'operate-server'` — **the insert the old UUID FK made
    impossible**;
  - ids came from the database: `0001`, `0002`, then `0003` from a *fresh engine instance*, where a
    per-process counter would have restarted at `0001`;
  - re-inserting a stored record was refused by `incidents_year_sequence_key`;
  - a sev1 refused triage with both blockers named — five missing roles *and* the un-flipped status
    page — then walked declared → triaged → mitigating → resolved → closed over 11 revisions, with
    `mitigatedAt` **back-filled** by the skip-state resolve;
  - a role hand-off was one write, so a required role was never briefly vacant;
  - two writers on one revision: the second raised `IncidentRevisionConflictError` and the first
    writer's title was what remained;
  - a timeline rewrite was refused with no `UPDATE` issued;
  - `affected_tenant_ids @> to_jsonb($1::text)` used `idx_incidents_tenants` (**Bitmap Index Scan**,
    confirmed with `enable_seqscan = off` — the seq scan in the plain plan is a three-row cost
    decision, not an unusable index);
  - `UPDATE meta.incidents SET status = 'closed'` — which every CHECK constraint accepts — was
    caught as `unparseable_record: resolvedAt: status 'closed' requires resolvedAt; closedAt: …;
    rootCause: …`, and a tampered `sequence_number` as `id_sequence_mismatch: columns say 2026/99,
    id says 2026/2`;
  - recovery **cancelled** an untaken incident and **returned null** for a triaged one, whose
    status stayed `triaged`.
- **Verified in the real server** with `--integrity-proof-config` carrying an `escalation` block:
  a tamper logged `DECLARED INC-2026-0001 severity=sev1 paged=pagerduty_phone audited=true` and
  wrote the row (`sev1`/`security`/`declared`, `declared_by='operate-server'`, the tenant in
  `affected_tenant_ids`, revision 1); the next pass logged `still compromised under INC-2026-0001`
  with no second row and no second page; repairing the trail logged `recovered, cancelled
  INC-2026-0001` and left the row `cancelled` at revision 2 with the reason and both
  `audit.integrity_*` rows present.
- **A defect in ADR-0288 found by that run.** `auditEmitter` was built only under `--ai-design` /
  `--per-tenant-manifests` / `--design-review`, so a deployment running only
  `--integrity-proof-config` reported `audited=false` for every escalation and the
  `audit.integrity_compromised` row ADR-0288 relies on was never written. The emitter is now built
  for the integrity proof too; the first live run showed `audited=false`, and after the fix
  `audited=true`.
- **Editing an existing meta-schema table breaks `crossengin apply` on an already-applied
  database, and this is a platform-wide gap, not a property of this change.** Statements are keyed
  by hash, `emitCreateTable` emits a bare `CREATE TABLE`, and the applier halts on first failure —
  so a changed definition is a new hash that runs and fails. Measured, by applying the pre-change
  schema and then the new one to the same database: **halted at statement #312, `relation
  "incidents" already exists`, 0 executed, 312 skipped, and the remaining 528 statements never
  applied.** ADR-0286 edited `meta.audit_log` the same way, so `origin/main` already carries this.
  The working remedy, also measured: drop the table (empty and unreferenced here — no data to
  lose), **delete its statements from `meta._meta_migrations`**, then re-apply → 8 executed, 832
  skipped, 0 failed, 10 indexes present. Dropping *without* clearing the log is not enough: the
  five unchanged `CREATE INDEX` statements stay marked applied, and the table comes back with
  **5 of its 10 indexes missing**.
- Two new packages (82 → 84): `incident-response-runtime` (pure executor, transitions, SLA) and
  `incident-response-runtime-pg` (store, persisting engine, replayer). +236 tests
  (incident-response-runtime **104**, -pg **100**, operate-server +18, incident-response +9,
  kernel +5; workspace **9,647** across 595 files). Full workspace build + typecheck + test green.

## Follow-ups

- **The SLO enforcement loop still does not persist its incidents**, and it is blocked by something
  specific rather than unfinished: `SloEnforcementEngine.evaluate()` is synchronous and mints ids
  from a per-process counter, so its `INC-2026-0001` would collide with a database-allocated one.
  Persisting under a second, store-allocated id would leave the log line and the stored row naming
  different incidents — worse than not persisting. Allocating ids from the database means making
  evaluation async, which touches both engines, `observability-runtime-pg` and
  `slo_enforcement_actions`. That is the next increment, and it is what makes the SLO half of
  ADR-0288's follow-up real.
- **Open-episode state is still per-process.** The ids no longer collide across a restart, but
  `IntegrityEscalator.open` is in memory, so a restart re-declares a still-present tamper under a
  *new* id. Hydrating it from the store needs a way to ask "which open incident did this signal
  open?", and `IncidentRecord` has no `surface` field — the surface lives in the declaration
  entry's metadata. A column outside the record would break the property the replayer depends on
  (the row *is* the record), so this wants either a contract field or a JSONB-path query, and
  deserves the decision rather than a quick column.
- **`incident_runbook_executions`, `incident_postmortems` and `incident_communications` are still
  dead**, as they have been since Phase 1. `RunbookExecution`, `Postmortem` and `CustomerComms` all
  exist in contracts with nothing persisting them; whether each is reconciled or deleted is the
  same question this ADR answered for `incidents`.
- Nothing exposes incidents over HTTP, so an operator reads them in SQL — the same shape as
  ADR-0287's open verdict-readability follow-up, and probably the same route when it lands. The
  replayer is a library function, matching every other replayer in the repo, none of which is
  app-wired.
- A tampered `sequence_number` shifts the allocator, since it takes `MAX + 1`: ids stay unique and
  the replayer flags the mismatch, but the sequence jumps (a live run went `0003` → `0100` after a
  column was set to 99).
