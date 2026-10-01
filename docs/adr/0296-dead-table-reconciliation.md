# ADR-0296: Four dead tables, and what they could not store (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0289 (incident record persistence), ADR-0293 (SLO incident persistence), ADR-0294 (open-episode hydration), ADR-0284 / 0285 (reconciling dead declarations) |

## Context

ADR-0289 answered "reconcile or delete?" for `meta.incidents` and left the same question open for
three siblings: *"`incident_runbook_executions`, `incident_postmortems` and `incident_communications`
are still dead, as they have been since Phase 1. `RunbookExecution`, `Postmortem` and `CustomerComms`
all exist in contracts with nothing persisting them."* ADR-0294 then added a fourth, from the other
direction: *"Nothing persists a `KillSwitch`. `meta.feature_flag_kill_switches` exists and the SLO
loop does not write it, so a flag rolled back before a restart stays rolled back with nothing in the
process knowing which flag it was."*

Writing the stores established something ADR-0289 had only seen once. **Every one of these four
tables was not merely unused — it was unable to store the records its contract produces.** The
`declared_by` defect was not a one-off:

| Table | What stopped it |
|---|---|
| `feature_flag_kill_switches` | `flag_id UUID REFERENCES feature_flags(id)`, against a contract `flagId` of `ff_…`. And `meta.feature_flags` has **no column for `FeatureFlag.id` at all**, so the key could not even be retargeted. Four actor columns were `meta.users` FKs. |
| `incident_runbook_executions` | **No business-key column.** Only a UUID surrogate, so a record could be written but never looked up, updated or referred to by the id it carries. Plus two `meta.users` FKs. |
| `incident_communications` | **No business-key column.** Plus three `meta.users` FKs, and `supersedes_id UUID` — which names another communication by *its* contract id, so the supersede chain was unrepresentable. |
| `incident_postmortems` | One `meta.users` FK on `author_user_id` — while `reviewers` beside it was already a JSONB array of free strings, so every reviewer was unconstrained and the author alone was pinned. |

## Decision

- **Reconcile all four; delete none.** The ADR-0284 / 0285 / 0289 pattern: a declared artifact with no
  consumers is resolved by making it the real one. Net new tables: **zero**, still 139.
- **A contract's own id gets a column.** `execution_id` and `communication_id`, both `TEXT NOT NULL`
  with a unique constraint, in the position `postmortem_id` already held. Neither carries a regex
  CHECK, because neither contract puts a pattern on its id — constraining it here would be inventing
  a rule the contract does not have.
- **An actor column is typed as the contract types it, and references nothing.** Six columns across
  the three incident tables become `TEXT`: the contracts type them as any non-empty string and an
  automated actor is a scheduler with no user row. On the kill switch the type was already right —
  the contract demands a UUID — so only the four references go.
- **The kill switch's `flag_id` becomes `TEXT` with the `ff_` pattern**, matching
  `slo_enforcement_actions.flag_id` and `feature_flag_evaluations.flag_id`, so the action row and the
  switch row it names finally agree on how a flag is spelled.
- **Optimistic concurrency on all three incident child tables.** `revision` + `updated_at`, guarded
  exactly as `meta.incidents` is: the write states the revision it read and a zero-row update raises a
  conflict. Not theoretical — a postmortem is edited by humans over days, and two editors from one
  read would have silently discarded one's lessons and action items. Each store names its own conflict
  error rather than reusing `IncidentRevisionConflictError`, which carries an `incidentId` and would
  have made a postmortem conflict report itself as an incident conflict.
- **A kill-switch id is derived from its incident, not counted.** See the Consequences: the per-process
  counter was a live defect the moment the switch became storable.
- **The `NotFoundError` classes are gone** from the three stores: with a revision guard a zero-row
  update is a conflict, so nothing would have thrown them — the same call `incident-store.ts` makes.

## Consequences

- **Verified live** against a real Postgres, 20 checks, after a real migration:
  - a breach wrote the incident, the kill switch and the action together, the action naming the switch
    (`fks_20260001`), the switch carrying `flag_id = 'ff_checkout01'` — **the insert the UUID column
    made impossible** — and `armed_by_user_id` the configured actor with no `meta.users` row;
  - a restart adopted the incident **and recovered which flag it had rolled back**, which ADR-0294
    had to report as null;
  - a runbook execution stored and read back with `invokedBy = 'operate-server'`, a stale revision
    refused, `listUnfinished` excluding a finished one;
  - a communication stored and a second one naming it via `supersedesId` — the chain that a UUID
    column could not express;
  - a postmortem stored with a non-user author, `listUnpublished` finding the draft.
- **The migration is reconcilable, which was not obvious.** Against a database holding the pre-change
  shape the planner produced 25 statements: the foreign-key drops **ordered before** the type changes
  they block, each UUID→TEXT change `[guarded]` by the empty-table re-check, and both `NOT NULL`
  business keys planned rather than refused. Applied in 188 ms, 26/26, then no drift. On a *populated*
  table the `NOT NULL` adds and the type changes would be refused with manual SQL, per ADR-0291 —
  these tables are empty everywhere because nothing ever wrote them, which is the one upside of their
  being dead.
- **An FK removed from the catalog is not removed from the database.** The four kill-switch user
  references are reported as `foreign_key_removed` with manual SQL, never dropped, because ADR-0291
  deliberately refuses to loosen integrity. So a *fresh* install gets the right schema while an
  *existing* one keeps the constraint — and the kill-switch insert keeps failing — until an operator
  runs four `DROP CONSTRAINT` statements. Measured in both directions: the insert failed with a
  foreign-key violation before, and succeeded after. **This is a required manual migration step, not
  an automatic one.**
- **A per-process counter minted the kill-switch id, and persisting the switch turned that into a
  bug.** A second engine instance reissued `fks_auto00000001`, the unique constraint refused it, and
  the failure arrived *after* the incident had been declared — leaving a declared incident with no
  enforcement action naming it, and an `evaluate()` pass that returned no decisions at all while
  having changed the database. Exactly the collision ADR-0293 removed for incident ids, in the one
  place it had been left. `killSwitchIdForIncident` now derives it from the incident id, inheriting
  uniqueness from something a store already allocated. Found by a live check, not by any test.
- **An audit protection was lost.** A test asserted `ON DELETE RESTRICT` on the kill switch's flag FK,
  to stop a flag being deleted while a switch still names it. The FK had to go, so the protection
  went. The test now asserts its *absence*, with a comment saying what it cost and what restoring it
  needs — a `flag_id TEXT` unique column on `meta.feature_flags` — so the FK coming back is a decision
  someone makes rather than a diff nobody notices. Nothing writes `meta.feature_flags` today, so
  nothing relies on the guarantee in the meantime.
- One new package (84 → **85**): `feature-flags-pg`. +174 tests across the four stores.

## Follow-ups

- **`meta.feature_flags` cannot store a `FeatureFlag`'s own id**, which is why no foreign key here can
  be well-formed. It needs a `flag_id TEXT` unique column before any of the three remaining
  `flag_id UUID` references (on rollouts, evaluations' siblings and the kill switch) can be restored.
  Nothing writes that table either, so it is the next instance of this same question.
- **Six indexes now have no reader.** They existed to make `ON DELETE RESTRICT` cheap on the foreign
  keys this removed. Removing them from the catalog would leave them reported as undeclared on every
  drift check until an operator drops them, so they are left in place deliberately — and "find every
  execution this operator invoked" may yet be a query the platform wants.
- **Cross-column rules still have no home in the schema.** `bouncesCount ≤ recipientCount` and
  `publishedAt ≤ breachNotificationDeadlineAt` are two-column comparisons, and `TableDefinition` has
  no table-level CHECK — the limit ADR-0291 recorded for composite foreign keys. Both are enforced
  only by the re-parse on read, which is the argument for re-parsing.
- `blameless_attested` could carry `check: "blameless_attested"`, since the contract makes `false`
  unrepresentable; `storage_sha256 CHAR(64)` would be better as `TEXT`, since `CHAR` blank-pads.
  Both cosmetic, both left.
- Nothing exposes any of these records over HTTP, as with every other store in the repo.
