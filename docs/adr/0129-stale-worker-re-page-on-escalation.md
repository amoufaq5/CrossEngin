# ADR-0129: stale-worker re-page on escalation (Phase 3 P2.20)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0128 (incident timeline entries), ADR-0127 (severity escalation), ADR-0116 (incident bridge), ADR-0060 (SLO enforcement / page planners), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.20).

## Context

P2.13 (ADR-0116) computed page directives at incident **declaration**
(`planStaleWorkerEnforcement` resolves the alert policy at the declared
severity into `plan.pages`), and P2.18 (ADR-0127) let the monitor **escalate**
an open incident's severity when more workers go stale — but escalation only
fired `onEscalate(incidentId, severity)` with **no pages**. The page directives
were frozen at the declaration severity, so a `sev3 → sev2` escalation never
re-paged on-call at the higher urgency. ADR-0127 explicitly flagged re-paging on
escalation as the deferred other half of the follow-up. Separately, the page
directives `plan.pages` produced at declaration were never delivered anywhere —
`node.ts`'s `onIncident` only logged the *count*; there was no paging transport
seam. P2.20 wires both: a `PageDeliverer` transport and re-paging on escalation.

## Decision

- **`staleWorkerPages(policy, severity, incidentId)`** — a pure helper extracted
  from `planStaleWorkerEnforcement` that resolves the alert policy into a
  `PageDirective[]` at a given severity (empty when no policy, or no route for
  the resolved alert severity). The declaration plan and the escalation path now
  share this one resolution, so they page through identical policy logic.
- **`onEscalate` now carries the recomputed pages.** Its payload changed from
  `(incidentId, severity)` to a `StaleWorkerEscalation`
  (`{ incidentId, severity, pages }`), where `pages` is
  `staleWorkerPages(policy, newSeverity, incidentId)` — the directives at the
  **higher** severity. The consumer can re-page on-call at the new urgency.
- **`PageDeliverer` — the paging transport seam** (new `page-sink.ts` in
  `apps/workflow-worker`): `deliver(directive, context)` where `context` is
  `{ incidentId, severity, reason: "declared" | "escalated" }`.
  `LoggingPageDeliverer` (the default a deployment without a wired transport
  gets) writes one `formatPageLine` per directive; a real PagerDuty / Opsgenie /
  Slack transport implements the same interface. `deliverPages(deliverer,
  directives, context)` delivers each directive in order.
- **`node.ts` `run()`** constructs a `LoggingPageDeliverer` and delivers pages on
  **both** lifecycle events: `onIncident` delivers `plan.pages`
  (`reason: "declared"`), and `onEscalate` delivers the escalation's recomputed
  `pages` (`reason: "escalated"`). `plan.pages` is now actually wired through a
  transport, not just counted.

## Cross-cutting invariants enforced (by tests)

- **`staleWorkerPages`** returns `[]` with no policy and `[]` when the policy has
  no route for the resolved alert severity (`sev3 → P2` against a P1-only
  policy); resolves one directive otherwise, carrying the incident id + severity.
- **Re-page on escalation.** Opened at `sev3` (1 stale, `sev3 → P2`), then 3
  stale → `sev2` (`sev2 → P1`): the single escalation carries one page directive
  (the P1 route), and a third check at 3 stale neither re-escalates nor
  re-pages; the incident is never re-declared.
- **Transport seam.** `formatPageLine` renders the incident, `severity/alert
  severity`, reason, and channel kinds (`(no channels)` when empty);
  `LoggingPageDeliverer` writes one line per directive to its injected sink;
  `deliverPages` delivers every directive in order and is a no-op for `[]`.

## Alternatives considered

- **Keep `onEscalate(id, severity)` and recompute pages in the consumer.**
  - **Decision.** No — the monitor owns the policy + the severity transition, so
    it should resolve the directives; making the consumer re-derive them
    duplicates the policy resolution and risks drift from the declaration path.
- **A real PagerDuty/Slack HTTP transport now.**
  - **Decision.** No — consistent with the rest of the platform, this increment
    models the *records* + the *seam* (`PageDeliverer`); the concrete transport
    is a swap-in behind the interface, deferred until the provider contract
    settles (mirrors how `notifications` / integrations model providers).
- **Re-declare a fresh incident at the higher severity to force a new page.**
  - **Decision.** No — that breaks the one-incident-per-period dedup (P2.17);
    escalation updates the open incident (P2.18) and re-pages off the same id.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,538 offline tests + 25 gated
  real-Postgres integration tests** (14 worker + 11 serving; +8 offline — 3
  `staleWorkerPages` + 5 `page-sink`; 0 new tables/columns/packages). A worsening
  stale-worker outage now **re-pages on-call at the higher urgency**, and the
  page directives produced at both declaration and escalation are delivered
  through a real transport seam rather than merely counted.
- **The heartbeat → incident loop is complete, adaptive, auditable, and now
  actionable on-call** — write → detect → plan → **page** → run → persist →
  escalate → **re-page** → resolve.
