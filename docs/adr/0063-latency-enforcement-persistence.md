# ADR-0063: Latency enforcement persistence (Phase 2 M8.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0062 (latency-SLO enforcement), ADR-0061 (observability-runtime-pg), ADR-0060 (observability-runtime), ADR-0047 (kernel-pg) |

## Context

M8.6 (ADR-0062) shipped `LatencySloEngine` in `observability-runtime` — a pure engine that declares a `performance` incident, pages, and optionally rolls a flag back when a surface's p95/p99 blows its budget. Like the availability engine before M8.5, its decisions were in-memory only. ADR-0062's open question Q1 named the follow-up: persist latency verdicts and actions, "a projector into `meta.slo_evaluations` (with a `signal` column) or a `meta.slo_latency_evaluations` sibling."

M8.5 (ADR-0061) already built the persistence anatomy for *availability* — `meta.slo_evaluations` + `meta.slo_enforcement_actions`, stores, a persisting engine, a replayer. M8.7 extends that anatomy to latency so the two signals share one audit story.

Two choices shaped the work:

1. **Reuse the enforcement-actions table; add a `signal` discriminator.** Availability and latency both emit the same decision lifecycle (`breach_opened` / `breach_ongoing` / `recovered`) with the same incident / kill-switch / paging shape. Forking a second actions table would duplicate the schema and split "all enforcement for incident X" across two queries. A nullable-free `signal` column (`availability | latency`, default `availability`) keeps one table, one query, backward-compatible inserts.

2. **A separate evaluations table for latency snapshots.** `meta.slo_evaluations` is shaped for availability — `target NUMERIC(8,6) CHECK (target > 0 AND target <= 1)` and a burn-rate `evaluations` JSONB. A latency verdict has no [0,1] target (budgets are milliseconds) and a different breach shape (observed vs budget per percentile). Bending the availability table to hold both would weaken its checks. So latency snapshots get `meta.slo_latency_evaluations`, shaped for percentiles.

## Decision

One altered table + one new table (meta-schema **121 → 122**) and four module changes in `@crossengin/observability-runtime-pg`.

### Schema

- **`meta.slo_enforcement_actions`** gains `signal TEXT NOT NULL DEFAULT 'availability' CHECK (signal IN ('availability','latency'))` + an `idx_slo_enforcement_signal` index. Existing availability inserts are unaffected (the default applies).
- **`meta.slo_latency_evaluations`** (new): `evaluation_id` (`^slle_…`), nullable `tenant_id` (platform-or-tenant RLS), `slo_id`, `surface`, `breached`, `worst_severity` (sev1..sev5), `worst_threshold_id`, `worst_percentile` (`p50|p95|p99`), `sample_count`, `breaches` JSONB (the per-percentile breach detail), `evaluated_at`. Indexed by `(tenant_id, evaluated_at)`, `(slo_id, evaluated_at)`, `breached`.

### Package modules

- **`records.ts`** — `SloEnforcementActionRecordSchema` gains `signal` (`z.enum(SLO_SIGNALS).default("availability")`); `enforcementActionFromDecision` now accepts `EnforcementDecision | LatencyEnforcementDecision` plus an optional `signal`. Both decision unions share the fields the projector reads (`kind`, `plan`, `severity`, `verdict.worstThresholdId`, the recovered `killSwitchId`), so one projector serves both. New `SloLatencyEvaluationRecordSchema` + `latencyEvaluationRecordFromVerdict` + `generateLatencyEvaluationId` (`slle_` prefix).
- **`latency-evaluation-store.ts`** (new) — `PostgresSloLatencyEvaluationStore.record()` (validate → `INSERT … ON CONFLICT (evaluation_id) DO NOTHING`) + `countBreachesSince`.
- **`enforcement-action-store.ts`** — `signal` threaded through the INSERT, both SELECTs, and the row→record mapper.
- **`latency-persisting-engine.ts`** (new) — `buildPersistentLatencySloEngine(conn, options)` wraps a `LatencySloEngine`: every decision writes an enforcement action tagged `signal: "latency"`; every `breach_opened` also writes a latency evaluation snapshot. Mirrors `buildPersistentSloEnforcementEngine`.

The M8.5 replayer (`verifyEnforcementActionShape` / `verifyEnforcementHistory` / `summarizeEnforcement`) operates unchanged on the now-signal-bearing actions — its checks are signal-agnostic (open/ongoing/recovered linkage, paged-without-channels, kill-switch-without-flag), so latency actions are verified by the same code.

## Cross-cutting invariants enforced

- **One actions table, two signals.** `SELECT … WHERE incident_id = $1` returns every action for an incident regardless of signal; `WHERE signal = 'latency'` isolates latency enforcement. The default keeps every pre-existing and availability insert valid without naming `signal`.
- **Records valid by construction.** The new store `parse`s before INSERT; the projector `parse`s before returning. `slle_`-prefixed ids, `p50|p95|p99` percentiles, and sev enums are enforced at both the zod and the Postgres-CHECK layer.
- **Append-only + idempotent.** `ON CONFLICT (… _id) DO NOTHING`, same as every other audit store.
- **Sparse snapshots, by design.** A latency snapshot is written on `breach_opened` (verdict in hand), not every tick — matching the availability persisting engine.
- **No regression to availability.** The availability persisting engine, its store, and `observability-runtime-pg`'s existing consumers are untouched except for the additive `signal` field (defaulted), so M8.5 behavior is preserved.

## Alternatives considered

- **Fold latency snapshots into `meta.slo_evaluations` with a `signal` column.**
  - **Considered.** One evaluations table.
  - **Decision.** Rejected. The availability table's `target ∈ (0,1]` check and burn-rate `evaluations` JSONB don't fit latency. A shared table would need both checks relaxed and a mess of mutually-exclusive columns. A purpose-shaped sibling is cleaner and keeps each table's CHECKs meaningful.
- **A second `slo_latency_enforcement_actions` table instead of a `signal` column.**
  - **Decision.** Rejected. The action lifecycle is identical across signals; a `signal` discriminator on one table preserves the "all enforcement for this incident" join and avoids duplicating six columns of constraints.
- **A unified `verdict: BurnRateVerdict | LatencyVerdict` on one persisting engine.**
  - **Considered.** One `buildPersistent…` for both.
  - **Decision.** Two engines (`buildPersistentSloEnforcementEngine` + `buildPersistentLatencySloEngine`), because the runtime ships two engines (`SloEnforcementEngine` + `LatencySloEngine`) for the same verdict-shape reason (ADR-0062). The shared `enforcementActionFromDecision` is the seam they reuse; the evaluation projection differs (burn-rate vs percentile), so the snapshot stores stay separate.

## Consequences

- **53 packages + 1 app, 122 meta-schema tables, 5,943 tests** (was 53 / 121 / 5,930; +1 table, +13 tests, 0 new packages). The latency loop is now as durable and auditable as the availability loop.
- **One enforcement audit, both signals.** `SELECT * FROM meta.slo_enforcement_actions WHERE signal = 'latency' AND occurred_at >= …` lists latency pages; dropping the `signal` filter shows availability + latency together per incident. `meta.slo_latency_evaluations` carries the percentile-vs-budget detail behind each.
- **The M8.5 replayer covers latency for free.** Its drift checks are signal-agnostic, so `SloEnforcementReplayer.verifyRecent()` now sweeps latency actions too.
- **Symmetry restored.** Availability and latency each have: a pure engine (M8 / M8.6), a persisting engine + snapshot table (M8.5 / M8.7), and a shared actions table + replayer. The observability runtime story is complete end-to-end.

## Open questions

- **Q1:** Should a single `buildPersistentObservabilityEngine` wrap both engines over one `RollingWindow` and persist both signals in one `evaluate()`?
  - _Current direction:_ Not yet. The two persisting engines compose (share a `window` + `conn`); a convenience wrapper that fans one `recordOutcome` + one `evaluate` across both is a small additive follow-up if a deployment wants a single entry point.
- **Q2:** Retention for `meta.slo_latency_evaluations` (and its availability + gateway peers).
  - _Current direction:_ Deferred to the audit-retention ADR; the same partition/TTL story applies to all the append-only audit tables.
- **Q3:** Should `worst_percentile` / `breaches` be normalized into a child table for per-percentile querying?
  - _Current direction:_ JSONB for now. If operators need "every p99 breach over 300ms" as a relational query, a `slo_latency_breach_details` child table is a later normalization.
