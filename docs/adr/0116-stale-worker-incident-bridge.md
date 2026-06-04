# ADR-0116: stale-worker → incident bridge (Phase 3 P2.13)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0114 (stale-worker detection), ADR-0110 (heartbeats), ADR-0060 (observability-runtime enforcement), ADR-0106 (apps/workflow-worker), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.13).

## Context

ADR-0114 produced the *detection* (`StaleWorkerAlert[]` /
`WorkerHealthReport`) but deliberately kept `@crossengin/workflow-worker` off the
incident/SLO packages, leaving the routing to a consumer. P2.13 is that
consumer: it turns a stale-worker report into a declared incident + page
directives using the existing `observability-runtime` enforcement planners — so
a dead worker actually pages, not just shows up in a query.

## Decision

- **`apps/workflow-worker` — `stale-worker-monitor.ts`** (the app is the
  deployable that composes concerns; it gains `@crossengin/observability-runtime`
  + `@crossengin/observability` + `@crossengin/incident-response` deps).
  - **`staleWorkerSeverity(staleCount)`** (pure) — `null` at 0, `sev3` at 1–2,
    `sev2` at 3+ (a meaningful chunk of the pool gone).
  - **`planStaleWorkerEnforcement({report, now, incidentId, declaredBy, surface?,
    policy?})`** (pure) — `null` when no workers are stale; else
    `planIncidentDeclaration(...)` (severity scaled, detail = `formatWorkerHealth`)
    + `planPageDirective(policy, severity, incidentId)` for each resolvable route.
    Reuses the ADR-0060 planners verbatim.
  - **`StaleWorkerMonitor`** — polls a `HeartbeatSource` (`listAll()`, satisfied
    by `PostgresWorkerHeartbeatStore`), summarizes health, and on any stale
    worker mints an incident id (`nextIncidentId` injectable), plans the
    enforcement, and hands it to an `onIncident` sink. Injectable scheduler +
    clock; `onError`-routed; never throws from the loop. Page *delivery* is the
    sink's job — this produces the records.

The bridge lives in the app, not the library, preserving the ADR-0114
separation: detection is reusable + dependency-light; routing to incidents is a
deployment concern that composes detection with the incident packages.

## Cross-cutting invariants enforced (by tests)

- **Severity scales.** `staleWorkerSeverity`: 0 → null, 1–2 → sev3, 3+ → sev2.
- **Plan shape.** A healthy report → `null`; one stale worker → a `declared`
  SEV3 `IncidentRecord` (title "1 workflow worker(s) stale", timeline message =
  the health summary), no pages without a policy; 3+ stale → SEV2; with a policy
  whose routes cover the alert severity, a page resolves with the incident id.
- **Monitor.** `checkOnce` emits exactly one incident when a worker is stale and
  nothing when all are healthy; the poll loop runs per tick, routes errors, and
  stops cleanly.

## Alternatives considered

- **Put the bridge in `observability-runtime` or `workflow-worker`.**
  - **Decision.** No — `observability-runtime` shouldn't import the worker's
    `HeartbeatSnapshot`, and `workflow-worker` must stay off the incident packages
    (ADR-0114). The app is the correct composition point; the pure
    `planStaleWorkerEnforcement` is still independently testable.
- **Declare a kill-switch / auto-remediate (restart the worker).**
  - **Decision.** No — a stale worker is an availability signal to *page*, not a
    flag to roll back. Auto-remediation (respawn) is an orchestration concern
    outside this codebase's contracts.
- **Open one incident per stale worker.**
  - **Decision.** No — one incident per *check* (titled with the count) avoids an
    incident storm when a whole host's workers die together; the detail lists
    each stale worker.
- **A fixed severity.**
  - **Decision.** No — scaling sev3→sev2 by count distinguishes "one worker
    flaked" from "the pool is collapsing", which routes to different on-call
    urgency.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,514 offline tests + 9 gated
  real-Postgres integration tests** (+8 offline; 0 new tables/columns/packages —
  the app gained 3 contract deps). The heartbeat loop is now **closed
  end-to-end**: write (P2.7) → detect (P2.11) → **page (P2.13)**. A dead worker
  becomes a SEV2/SEV3 incident + page directives an on-call system delivers.
- **The enforcement planners proved reusable** beyond SLO burn — the same
  `planIncidentDeclaration` / `planPageDirective` now serve worker liveness,
  validating the ADR-0060 abstraction.
- **Delivery + a real `AlertPolicy` source** (per-tenant routing, paging
  transport) remain the operator-side follow-up; the monitor produces the plan,
  the deployment wires the sink.
