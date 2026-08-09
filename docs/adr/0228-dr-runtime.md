# ADR-0228: `@crossengin/dr-runtime` — executing failovers + drills (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (P3 plan — P8), `@crossengin/dr` contracts |

## Context

The `@crossengin/dr` package modeled the *shape* of disaster recovery — DR tiers with RPO/RTO specs,
failover records + their state machine, drill records, replication topology, runbooks, backups — but
nothing *ran* them. ADR-0077's P8 milestone calls for "`@crossengin/dr-runtime` executing failover
records + drills against the deployment". This is the pure in-process executor, following the
`observability-runtime` template (no new package infra beyond the contracts it consumes, no META
tables; a Postgres persistence sibling is a later milestone).

## Decision

A new pure runtime package, `@crossengin/dr-runtime`, consuming `@crossengin/dr` (+ `incident-response`,
`residency`). Modules:

- **`clock.ts`** — `Clock` / `SystemClock` / `FixedClock` + `IdGenerator` (`CountingIdGenerator` for
  deterministic tests, `RandomIdGenerator`), mirroring the other runtimes.
- **`failover.ts`** — a `FailoverExecutor` that drives a `FailoverRecord` through its state machine
  (`plan` → `start` → `complete`/`fail`/`abort` → `revert`), each transition guarded by
  `canTransitionFailover` (illegal transitions throw) and re-validated through `FailoverRecordSchema`
  (so the contract's superRefine rules — `succeeded` requires actual RPO/RTO, `reverted` requires the
  revert linkage, outage triggers require an incident ticket — hold). `failoverTierVerdict(record,
  spec)` flags RPO/RTO breaches via `exceededRpo`/`exceededRto`.
- **`drills.ts`** — a `DrillExecutor` (`plan` → `recordResult` with findings), and a
  `drillTierVerdict` using `exceededRpoInDrill` / `exceededRtoInDrill` / `isDrillPassing`.
- **`readiness.ts`** — `assessDrReadiness(input)` aggregates overdue drills (`overdueDrills`), stale
  runbooks (`staleRunbooks`), expired/unverified backups (`expiredBackups`), replication tier
  violations (`violatesTier`), and failover/drill RPO/RTO breaches into a `DrReadinessReport` with an
  overall `ready` flag; `formatDrReadiness` renders a human summary.
- **`engine.ts`** — a `DrRuntime` composing the executors + readiness over one clock + id generator, and
  a `DrReadinessScheduler` (the `PruneScheduler` shape: `unref`'d injectable timer, `onReport`/`onError`
  sinks, `start()`/`stop()`) that periodically re-assesses readiness.

## Consequences

- DR is now executable, not just modeled: a failover can be planned, started, completed with measured
  RPO/RTO, and judged against its tier; a drill can be run and scored; a readiness sweep surfaces every
  overdue/stale/expired/violating artifact against the live records. The DR tier contracts are proven
  under a real executor.
- Every transition re-parses through the contract schema, so the runtime can never emit a
  state-machine-invalid failover/drill record — the same fail-closed posture as the other runtimes.
- Pure + in-process (no sockets/DB): fully offline-tested, and the readiness scheduler's timer is
  `unref`'d so it never holds the process open.
- Follow-ups (open): a `@crossengin/dr-runtime-pg` persistence sibling (failover/drill records +
  readiness snapshots under RLS); wiring the readiness scheduler into `operate-server`'s process
  lifecycle; executing runbook steps rather than only tracking their freshness.
