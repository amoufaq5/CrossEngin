# ADR-0061: Observability runtime persistence (Phase 2 M8.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0060 (observability-runtime / SLO enforcement), ADR-0047 (kernel-pg), ADR-0050 (api-gateway-runtime), ADR-0049 (workflow-runtime) |

## Context

M8 (ADR-0060) shipped `@crossengin/observability-runtime` — a pure, in-process SLO enforcement loop that ingests `RequestOutcome`s, computes multi-window burn rates, and emits an `EnforcementPlan` (declared incident + page directive + kill switch) on a breach. Like `workflow-runtime` (M3) and `api-gateway-runtime` (M4), the runtime is intentionally table-free: it decides, but it does not persist.

Every other runtime pillar has a Postgres sibling — `workflow-runtime` → `workflow-runtime-pg`, `api-gateway-runtime` → `api-gateway-pg`. M8.5 closes the same gap for observability: a durable audit trail of *what the enforcement loop decided and why*, queryable by incident, surface, and time, surviving process restarts and shared across worker processes.

Two constraints shaped the design:

1. **Reuse the contract records; add only what has no home.** A breach already produces an `IncidentRecord` (→ `META_INCIDENTS`) and a `KillSwitch` (→ feature-flag tables). Those persist through their existing packages. What has *no* table is the enforcement *decision* itself — the link between "this SLO burned" and "so this incident + kill switch were minted" — and the burn-rate *evaluation snapshot*. M8.5 adds exactly two tables for those, no more.

2. **Mirror the existing `-pg` shape exactly.** A `PgConnection` from `@crossengin/kernel-pg`, stores that `INSERT … ON CONFLICT DO NOTHING`, row→record mappers, a one-call persisting wrapper around the runtime engine, and a pure replayer/verifier — the same five-part anatomy as `api-gateway-pg`.

## Decision

Two new META_ tables (kernel meta-schema **119 → 121**) and one new package, `@crossengin/observability-runtime-pg` (depends on `@crossengin/observability-runtime`, `@crossengin/incident-response`, `@crossengin/kernel-pg`, `zod`).

### New tables

- **`meta.slo_evaluations`** — one row per persisted burn-rate verdict: `evaluation_id` (`^sloe_…`), nullable `tenant_id` (platform-or-tenant RLS), `slo_id`, `surface`, `breached`, `worst_severity` (sev1..sev5), `worst_threshold_id`, `target` (`NUMERIC(8,6)`, `0 < target ≤ 1`), `evaluations` JSONB (the per-threshold detail), `evaluated_at`. Indexed by `(tenant_id, evaluated_at)`, `(slo_id, evaluated_at)`, `breached`.
- **`meta.slo_enforcement_actions`** — one row per enforcement decision: `action_id` (`^sloa_…`), nullable `tenant_id`, `slo_id`, `surface`, `decision` (`breach_opened | breach_ongoing | recovered`), nullable `severity`, `incident_id` (`^INC-YYYY-NNNN`), nullable `kill_switch_id` (`^fks_…`), nullable `flag_id` (`^ff_…`), `paged`, `page_channel_count`, `threshold_id`, `occurred_at`. Indexed by `(tenant_id, occurred_at)`, `incident_id`, `decision`, `(slo_id, occurred_at)`.

Both follow the gateway-execution precedent: platform-or-tenant RLS (`tenant_id IS NULL OR tenant_id = current_setting(...)`), UUID PK with `uuid_generate_v7()`, a stable text business id under a unique constraint.

### Package modules

- **`records.ts`** — `SloEvaluationRecordSchema` + `SloEnforcementActionRecordSchema` (the row shapes), Crockford-base32 id generators (`generateEvaluationId` / `generateEnforcementActionId`), and pure projectors `evaluationRecordFromVerdict(verdict, …)` + `enforcementActionFromDecision(decision, …)`. The projector reads each `EnforcementDecision` variant: `breach_opened` carries severity + incident + kill switch + page channel count; `breach_ongoing` / `recovered` carry only the incident (and, for recovered, the kill-switch id).
- **`evaluation-store.ts`** — `PostgresSloEvaluationStore.record()` (validates then inserts) + `countBreachesSince(sloId, since)`.
- **`enforcement-action-store.ts`** — `PostgresSloEnforcementActionStore.record()` + `listForIncident()` + `listRecent(limit)` + `countSince()`, with a row→record mapper that normalizes a `Date` `occurred_at` back to ISO.
- **`persisting-engine.ts`** — `buildPersistentSloEnforcementEngine(conn, options)` constructs a `SloEnforcementEngine`, then wraps `evaluate()`: every decision writes an enforcement action; every `breach_opened` additionally writes an evaluation snapshot (it carries the full `BurnRateVerdict` + the engine knows the SLO's availability target). Tenant id resolves from the registration, else an optional `resolveTenantId(surface)`, else the kill switch's tenant. Mirrors `buildPersistentEngine` from `workflow-runtime-pg`.
- **`replayer.ts`** — pure `verifyEnforcementActionShape` (paged-without-channels, channels-without-paged, breach-opened-missing-severity, kill-switch-without-flag) + `verifyEnforcementHistory` (ongoing/recovered-without-open, duplicate-open, with correct re-open-after-recovery handling) + `summarizeEnforcement`, plus a `SloEnforcementReplayer` that runs them over store queries. Mirrors `GatewayReplayer`.

## Cross-cutting invariants enforced

- **Records are valid by construction.** Both stores `Schema.parse` before the `INSERT`; the projectors `parse` before returning. An invalid row never reaches Postgres.
- **Append-only, idempotent.** `INSERT … ON CONFLICT (… _id) DO NOTHING` — re-running an evaluation loop after a crash never duplicates a row.
- **One incident per ongoing breach holds at the storage layer too.** The replayer's `duplicate_open` check flags any second `breach_opened` for an incident that wasn't first recovered — the persisted mirror of the runtime's in-memory dedup.
- **Evaluation snapshots are sparse by design.** They are written on `breach_opened` (where the verdict is in hand), not on every healthy tick. Full per-tick history would need the runtime to expose healthy verdicts; see open questions.
- **Platform-or-tenant scoping.** Both tables carry a nullable `tenant_id` with the gateway-style RLS policy, so platform-wide surfaces (`POST /v1/orders`) and tenant-scoped SLOs coexist under the same row-level guard. The meta-schema test's "every `tenant_id` table has RLS" invariant covers them.

## Alternatives considered

- **Persist into `META_INCIDENTS` / feature-flag tables only; add no new tables.**
  - **Considered.** The incident and kill switch already have homes.
  - **Decision.** Those capture the *artifacts* but not the *decision linkage* (which burn opened which incident, whether it paged, when it recovered). The two new tables are the audit spine that joins them. Without them, "show me every SLO breach last week and what it did" is unanswerable.
- **One combined `slo_enforcement_events` table instead of two.**
  - **Decision.** Split. Evaluations are high-cardinality numeric snapshots (trend/analytics); enforcement actions are low-cardinality lifecycle rows (audit). Different access patterns, different indexes, different retention. Folding them would bloat one table with mostly-null columns.
- **Project on every tick (persist all verdicts, not just breaches).**
  - **Considered.** Richer trend data.
  - **Decision.** Deferred. The engine's `evaluate()` returns only *decisions*, not healthy verdicts. Exposing a `lastVerdicts()` accessor on the runtime (a small M8 change) would enable full-history projection; deferred to M8.6 to keep this milestone additive and the runtime untouched.
- **Make the persisting engine wrap the event log (like `ProjectingEventLog`).**
  - **Considered.** The workflow analogue projects on every append.
  - **Decision.** The SLO loop has no event log — it's a periodic `evaluate()`, not an append stream. Wrapping `evaluate()` is the right seam; the projection happens once per evaluation cadence, not per outcome.
- **Percentile-based latency-target enforcement in this milestone (per ADR-0060's M8.5 note).**
  - **Decision.** Re-scoped. Latency enforcement is *pure compute* and belongs in `observability-runtime` (next to availability burn), not in a persistence package. Pulling it into `-pg` would mislayer it. M8.5 is persistence; latency enforcement moves to **M8.6** (a pure addition to `observability-runtime`). ADR-0060's consequence line is hereby narrowed.

## Consequences

- **53 packages + 1 app, 121 meta-schema tables, 5,897 tests** (was 52 / 119 / 5,859; +1 package, +2 tables, +38 tests). Every `*-runtime` pillar now has its `*-runtime-pg` sibling.
- **The enforcement loop is auditable.** `SELECT * FROM meta.slo_enforcement_actions WHERE decision = 'breach_opened' AND occurred_at >= now() - interval '7 days'` lists every auto-paged breach; joining `incident_id` to `meta.incidents` reconstructs the full incident, and `kill_switch_id` to the feature-flag tables shows what was rolled back. `meta.slo_evaluations` gives the burn-rate trend behind each.
- **Drift detection for the SLO loop.** `SloEnforcementReplayer.verifyRecent()` powers a periodic CI/observability sweep — the same role `GatewayReplayer` plays for the gateway and `WorkflowReplayer` for workflows.
- **The stale `architect-cli` count moved with reality.** `apply.test.ts` now asserts `tableCount === 121` (was 119, corrected from 115 in M8).
- **No adoption coupling.** No package depends on `observability-runtime-pg` yet; a deployment wires `buildPersistentSloEnforcementEngine(conn, …)` into its evaluation cadence whenever it wants the audit trail. The pure runtime keeps working table-free for tests and short-lived loops.

## Open questions

- **Q1:** Should evaluation snapshots be written on every tick, not just breaches?
  - _Current direction:_ Breaches only, until the runtime exposes healthy verdicts (M8.6). A deployment that wants full-resolution trend data can call the burn-rate evaluator directly and feed `PostgresSloEvaluationStore.record()` itself today.
- **Q2:** Where does incident *closure* / kill-switch *release* get persisted on `recovered`?
  - _Current direction:_ M8.5 records the `recovered` decision; the actual incident close + switch release (which need a root cause + four-eyes) remain the consumer's job. A `planIncidentResolution` / `planKillSwitchRelease` pair plus their projections is M8.6.
- **Q3:** Should there be a `crossengin-obs` CLI (like `crossengin-pg`) to query/replay enforcement history?
  - _Current direction:_ Out of scope. The stores + replayer are the library surface; a CLI can layer on in M8.7 if operators want one.
- **Q4:** Retention — these tables grow unbounded.
  - _Current direction:_ Deferred to a partition/retention policy (the same open question `META_GATEWAY_PIPELINE_EXECUTIONS` and `META_RATE_LIMIT_DECISIONS` carry). A periodic `DELETE … WHERE occurred_at < cutoff` or native partitioning lands when the audit-retention ADR is written.
