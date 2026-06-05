# ADR-0132: incident metrics — MTTR + open gauges from the timeline (Phase 3 P2.23)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0131 (incidents CLI), ADR-0130 (incident replayer), ADR-0128 (timeline entries), ADR-0127 (severity escalation), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.23).

## Context

P2.19 (ADR-0128) made every incident carry a self-describing timeline
(declared → severity_changed* → resolved, each entry timestamped), and P2.21–22
(ADR-0130/0131) gave it a read API + operator CLI. But the timeline's richest
payoff — **operational metrics** — was unused: MTTR (mean time to resolve, the
declared→resolved delta), how many incidents are open right now and at what
severity, and how often outages escalated. P2.23 computes those from the stored
timelines and surfaces them as an `incidents metrics` command.

## Decision

- **`incident-metrics.ts` — pure aggregation over `IncidentSummary[]`.**
  - **`incidentResolutionMs(summary)`** — the declared→resolved wall-clock in ms,
    from the `declared` timeline entry (falling back to `declaredAt`) to the last
    `resolved` entry (falling back to `resolvedAt`); `null` when unresolved or the
    timestamps don't yield a non-negative finite duration (clock skew → null).
  - **`incidentEscalationCount(summary)`** — the `severity_changed` entry count.
  - **`computeIncidentMetrics(summaries)`** → `IncidentMetrics`:
    `total`/`open`/`resolved`, `bySeverity` + `openBySeverity` gauges (all
    `SEVERITIES` keys present), `escalations`, and an `MttrStats` (count, mean,
    p50, p95, max ms over the resolvable durations; `null` when none resolved).
    `percentile` is nearest-rank over the ascending-sorted durations.
  - **`formatDurationMs`** (`1h 2m 3s` / `45s` / `120ms`) + `formatIncidentMetrics`
    render the human report.
- **`incidents metrics --from <iso> --to <iso>`** — a fourth `incidents`
  subcommand: `listForPeriod(window)` → `computeIncidentMetrics` → human or
  `--format json` (the raw `IncidentMetrics`). Shares the `--from`/`--to`/
  `--limit`/`--schema`/`--format` flags; `period`/`verify`/`metrics` are the
  window commands. Exit 0.

## Cross-cutting invariants enforced (by tests)

- **`percentile`** — 0 for an empty list, nearest-rank otherwise.
- **`incidentResolutionMs`** — declared→resolved from the timeline; `null` when
  unresolved; falls back to `declaredAt`/`resolvedAt` when entries are absent;
  `null` on a negative (skew) duration.
- **`computeIncidentMetrics`** — counts, per-severity + open-per-severity gauges,
  escalation totals, and MTTR (mean/p50/p95/max) over a mixed list; `null` MTTR
  when nothing resolved; clean handling of the empty list.
- **`formatDurationMs`** — ms / s / m / h compaction.
- **CLI** — `metrics` aggregates the window and exits 0; `--format json` emits
  the `IncidentMetrics` object; `metrics` requires the `--from`/`--to` window.
- **End-to-end (manual smoke).** Against the local DB, `incidents metrics` over a
  wide window reported `total 15  open 9  resolved 6  escalations 3`, the
  per-severity gauges, and MTTR over the 5 resolvable durations (one resolved
  incident had no computable duration — the lenient `null` path).

## Alternatives considered

- **Put the metrics in `observability-runtime` as an SLO surface.**
  - **Decision.** Not yet — the metrics are incident-timeline-specific and the
    consumer is the worker's `incidents` CLI; keeping them beside the replayer
    (same app) is cohesive. Promoting them into an observability report (or an
    `incident-response-pg` package) is the clean follow-up once a second consumer
    appears.
- **Mean-only MTTR.**
  - **Decision.** No — p50/p95/max alongside the mean is the standard incident
    KPI shape and the percentile helper is trivial; a single skewed outage
    shouldn't hide behind the mean.
- **Count an incident's resolution from `acked`/`mitigated` milestones.**
  - **Decision.** No — the stale-worker sink only writes declared/resolved; MTTR
    is declared→resolved. Richer MTTA/MTTM await those milestones being recorded.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,589 offline tests + 26 gated
  real-Postgres integration tests** (15 worker + 11 serving; +15 offline; 0 new
  tables/columns/packages). The incident timeline now yields real ops KPIs:
  `workflow-worker incidents metrics --from … --to … [--format json]` answers
  "what's our MTTR, how many are open, and how often did we escalate?" in one
  query — feeding a dashboard (`--format json`) or an eyeball check.
- **The stale-worker incident loop is now measurable** — declare/escalate/resolve
  (write) → open/period/verify/metrics (read) — all from one binary.
