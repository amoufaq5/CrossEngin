# ADR-0140: extract `incident-response-pg` package (Phase 3 P2.31)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0130 (incident replayer — flagged this refactor), ADR-0123 (incident persistence sink), ADR-0132/0133/0139 (incident metrics), ADR-0131/0134 (incidents CLI), ADR-0061 (observability-runtime-pg — the sibling persistence package), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.31).

## Context

The incident layer the last eleven increments built (P2.16–P2.30) lived entirely
in `apps/workflow-worker/src` — the sink (write), replayer (read+verify), metrics
(MTTP/MTTA/MTTM/MTTR), and the CLI runner — five substantial modules of domain
logic over `meta.incidents`. ADR-0130 flagged the promotion of sink + replayer to
a shared `incident-response-pg` package as "the clean refactor" once the layer
grew. It has grown; P2.31 extracts it so any `meta.incidents` producer/consumer
(not just the workflow worker) can reuse it, matching the `observability-runtime-pg`
/ `api-gateway-pg` persistence-package pattern.

## Decision

- **New package `@crossengin/incident-response-pg`** (depends only on
  `@crossengin/incident-response` + `@crossengin/kernel-pg`). Four modules:
  - **`sink.ts`** — `PostgresIncidentSink` (record / resolve / escalate /
    acknowledge / mitigate / recordCommsSent), moved verbatim.
  - **`replayer.ts`** — `PostgresIncidentReplayer` + `IncidentSummary` + the pure
    `verifyTimelineShape` / `summarizeIncidentIssues` / `rowToIncidentSummary` +
    `isOpenIncidentStatus` / `INCIDENT_TERMINAL_STATUSES`.
  - **`metrics.ts`** — `computeIncidentMetrics` + the `incident*Ms` helpers +
    `formatIncidentMetrics` + `percentile` / `formatDurationMs`.
  - **`query.ts`** — the framework-neutral CLI runner: `runIncidents` /
    `runIncidentWrite` over the structural `IncidentQuerySource` /
    `IncidentWriteSink`, the `IncidentsCliOptions` shape, `formatIncidentList` /
    `formatVerifyReport`, `DEFAULT_INCIDENT_ACTOR`.
- **`apps/workflow-worker` keeps the app-specific glue** that can't move: the
  `parseIncidentsArgs` CLI parser + help text (tied to the app's `CliUsageError`
  and the `workflow-worker incidents` surface), the `page-sink` transport, the
  `stale-worker-monitor` bridge, and the `node.ts`/`bin` wiring. They now import
  the domain layer from `@crossengin/incident-response-pg`; `incidents-cli.ts`
  re-exports the runner so existing import sites are unchanged.
- **Tests moved with their modules** (sink/replayer/metrics/query tests now live
  in the package, built with literal option objects so the package stays
  dependency-free of the app's parser); the app keeps the `parseIncidentsArgs`
  tests. No behavior change — a pure reorganization.

## Cross-cutting invariants enforced (by tests)

- **Package self-contained.** `@crossengin/incident-response-pg` builds + its 60
  tests pass with only `incident-response` + `kernel-pg` deps (no app import; the
  runner tests build `IncidentsCliOptions` literally).
- **App unchanged behavior.** The worker app's offline + 17 gated integration
  tests pass against the package (CRUD/lifecycle/metrics/verify over real PG via
  the imported sink/replayer/metrics), and the `incidents` CLI + `--monitor`
  paths are byte-for-byte the same — only the import source changed.
- **Whole workspace green.** `pnpm -r build/typecheck/test` clean.

## Alternatives considered

- **Move the parser + help into the package too.**
  - **Decision.** No — the parser throws the app's `CliUsageError` (which the bin
    catches by `instanceof`), so moving it would either fork the error type or
    create an app→package dependency cycle. The parser is CLI-surface-specific;
    the framework-neutral runner is what's reusable.
- **Split pure (verify/metrics) into `@crossengin/incident-response` and only PG
  into `-pg`.**
  - **Decision.** No — the verify/metrics operate on the `IncidentSummary` read
    *projection* (not the full `IncidentRecord` contract), and the replayer
    pattern (gateway / SLO `-pg` packages) already bundles pure verify with the PG
    reads. Keeping them together in `-pg` matches precedent.
- **Move `page-sink` too.**
  - **Decision.** No — it's an HTTP transport seam, not `meta.incidents`
    persistence; it stays in the app (a generic notifications package is a
    separate future home).

## Consequences

- **62 packages + 3 apps** (was 61; `@crossengin/incident-response-pg` is the
  62nd), **124 meta-schema tables, 6,606 offline tests + 28 gated real-Postgres
  integration tests** (17 worker + 11 serving). The −1 offline is a consolidated
  parser test (the `metrics`-requires-window case folded into the shared
  period/verify/metrics assertion); the 60 package tests are the moved
  sink/replayer/metrics/query suites. No new tables/columns; no behavior change.
- **The incident layer is now a reusable package** — `operate-server`, a future
  alerting service, or any `meta.incidents` consumer can `import { … } from
  "@crossengin/incident-response-pg"` without depending on the workflow worker.
