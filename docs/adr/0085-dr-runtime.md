# ADR-0085: DR runtime — failover coordination + drill assessment (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan), ADR-0031 (disaster recovery), ADR-0010 (multi-region) |

## Context

P8 is production hardening + GA. One of its named deliverables is `@crossengin/dr-runtime`
"executing failover records + drills against the deployment". The `dr` package ships the
contracts — tier specs (RPO/RTO targets), the failover lifecycle (`canTransitionFailover`),
drill records + the predicates (`isDrillPassing`, `exceededRpo`, `overdueDrills`, …) — but
nothing drives a failover through its lifecycle or assesses a drill against its tier.
Mirroring how every milestone opens with a pure runtime over the contracts, P8 opens with
that composition.

## Decision

A new pure package `@crossengin/dr-runtime` (the **73rd**), deps `dr` + `residency`. Two
modules:

- **`failover.ts`** — `newFailoverRecord(input)` mints a `queued` failover (the schema
  enforces, e.g., that an outage trigger carries an `incidentTicketId`);
  `transitionFailover(record, to, patch)` applies a **guarded** transition
  (`IllegalFailoverTransitionError`) re-validated through `FailoverRecordSchema` (so
  succeeded⇒completedAt + actualRpo/Rto, reverted⇒revertedAt + ref always hold); named
  helpers `beginFailover` / `completeFailover` (computes `durationSeconds`) / `failFailover`
  / `abortFailover` / `revertFailover` drive the lifecycle. `assessFailover(record, spec)`
  → `{ rpoMet, rtoMet, met }` via the contract's `exceededRpo` / `exceededRto`.
- **`drill.ts`** — `assessDrill(record, spec)` → `{ passing, rpoMet, rtoMet, cadenceMet,
  met }` composing the `dr` drill predicates; `drillReadiness(records, kind, spec, now)`
  summarizes the last successful drill, whether it currently meets its target, and the
  overdue drills (past `nextDrillDueAt`) — the bridge a scheduler/alert pages on.

## Consequences

- **73 packages + 4 apps, 128 meta-schema tables, ~7,477 offline tests.** No new META_
  tables (pure runtime; records persist via existing contracts/tables). New tests: 13 —
  the failover lifecycle (queue → in_progress → succeeded with computed duration, illegal
  transition, outage-requires-ticket, revert) + RPO/RTO assessment (met / RPO-exceeded /
  RTO-exceeded), and drill assessment (passing-within-target met, failed/over-RPO not met)
  + readiness (last successful + currentlyMet + overdue flagging).
- A failover can now be driven + assessed for RPO/RTO compliance, and drill readiness
  computed against the tier cadence — the runtime behind the P8 exit criterion's
  "survives a region-failover drill (RPO/RTO met)". The remaining P8 increments: the
  encryption write-path + key rotation (`reencryptColumnSql`), the SLO loop on
  operate-server's real request stream, scheduled access-review campaigns, and a PG
  persistence sibling for failover/drill records.
