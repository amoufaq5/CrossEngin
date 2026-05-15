# ADR-0037: Incident response

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0009, ADR-0017, ADR-0020, ADR-0025, ADR-0031, ADR-0035, ADR-0036 |

## Context

Production incidents happen. The question is whether the response is structured (named roles, clocked SLAs, documented runbooks, blameless postmortems) or improvised (one engineer panicking, no comms, no learnings). Mature operations need structure.

Five layers of structure:

1. **Severity model.** SEV-1 (production down, security breach, data loss) through SEV-5 (informational). Each level has explicit ack / mitigate / resolve targets in minutes, page-on-call policy, status-page requirement, postmortem requirement.
2. **Roles.** Incident Commander (IC), Scribe, Comms Lead are required for any active incident. Technical Lead, SME, Executive Sponsor add for SEV-1. Handoffs (shift changes) are recorded with witness and reason.
3. **State machine.** declared → triaged → mitigating → mitigated → resolved → postmortem_pending → closed (with cancelled escape hatch). Timestamps strictly ordered (ack ≤ mitigate ≤ resolve).
4. **Runbook execution.** When an incident invokes a runbook (from `@crossengin/dr`, ADR-0031), the execution is recorded — steps, outcomes, manual overrides, IC approval.
5. **Postmortems.** Blameless culture is non-negotiable. Schema enforces the attestation. ≥2 peer reviewers, author ≠ reviewer. SEV-1 postmortems require action items.

A sixth concern is **customer communications**. Status page updates, affected-tenant emails, regulator notifications. GDPR Article 33 requires breach notification within **72 hours**. The schema enforces published-by-deadline; missing it is a contract violation.

## Decision

Incident response contract has **six modules** in `@crossengin/incident-response`:

1. **`severities.ts`.** Five SEV levels with explicit profiles:
   - sev1: ack 5min, mitigate 1h, resolve 4h, pages on-call, status page, exec brief, postmortem required
   - sev2: ack 15min, mitigate 4h, resolve 24h, pages on-call, status page, postmortem required
   - sev3: ack 1h, mitigate 24h, resolve 72h, no page
   - sev4: ack 4h, mitigate 1 week, resolve 30 days
   - sev5: ack 24h, mitigate 30 days, resolve 90 days
   `SeverityProfileSchema` enforces sev1 must page on-call and must require postmortem.

2. **`roles.ts`.** Seven roles (incident_commander, scribe, comms_lead, technical_lead, subject_matter_expert, executive_sponsor, customer_liaison). `REQUIRED_ROLES` = IC + scribe + comms_lead. `SEV1_REQUIRED_ROLES` adds technical_lead + executive_sponsor. `RoleAssignment` enforces handoff needs recipient + reason, can't hand off to self, handoff is after assignment. `RoleAssignmentSet` enforces at most one active assignment per role.

3. **`incidents.ts`.** Eight-state lifecycle × 9 categories (availability, performance, data_integrity, security, compliance, billing, dependency_failure, human_error, scheduled_change_impact). `INC-YYYY-NNNN` id pattern. `IncidentRecord` enforces strict timeline (ack ≤ mitigate ≤ resolve, all ≥ declared), active statuses require role coverage, sev1 needs SEV1_REQUIRED_ROLES, securityIncident ↔ category=security, closed needs rootCause, sev1/sev2 closed needs postmortemId. SLA helpers compute timeToAck/Mitigate/Resolve and metAck/MitigateSla.

4. **`executions.ts`.** Six-status runbook execution (queued → running → paused → succeeded/failed/aborted). References dr package RB-NNNN ids. Succeeded execution requires step records, no failed steps. Manual override outcome requires notes. Step outcome ↔ completedAt pairing.

5. **`postmortems.ts`.** Four-state lifecycle (drafting → review → published → amended). `PM-YYYY-NNNN` id pattern. Four ActionItem priorities × 5 statuses. `Postmortem` enforces blameless attestation, ≥2 peer reviewers, author ≠ reviewer, sev1 requires ≥1 action item, critical-priority items require preventsRecurrence=true. Helpers: `openActionItems`, `overdueActionItems`, `preventsRecurrenceItems`.

6. **`comms.ts`.** Seven audiences (status_page_public, affected_tenants, all_customers, internal_eng, internal_exec, regulators, law_enforcement) × 7 kinds × 5 status-page levels. `IncidentCommunication` enforces status_page audience needs statusPageLevel, breach_notification audience must be affected_tenants or regulators, breach_notification requires legal review + deadline + published-before-deadline (GDPR 72h), regulators/law_enforcement require legal review.

Four meta-schema tables: `META_INCIDENTS`, `META_INCIDENT_RUNBOOK_EXECUTIONS`, `META_INCIDENT_POSTMORTEMS`, `META_INCIDENT_COMMUNICATIONS` (all platform-wide; incidents are not tenant-scoped because they typically span multiple tenants).

## Alternatives considered

- **Option A:** Use a vendor incident management tool (Incident.io, PagerDuty Incident Response, FireHydrant).
  - **Pros:** Mature features.
  - **Cons:** Vendor-specific data model; doesn't integrate with our compliance / billing breach notifications.
  - **Why not:** We need the contract types in-platform for cross-package invariants (incident references in tenant_lifecycle, in forensics, in security packages).

- **Option B:** Free-form incidents — no schema, just notes.
  - **Pros:** Fast.
  - **Cons:** Can't measure MTTR, can't audit role coverage, can't enforce breach-notification deadlines.
  - **Why not:** Defensibility and operations metrics require structure.

- **Option C:** Skip blameless attestation — assume team culture.
  - **Pros:** Less ceremony.
  - **Cons:** Postmortems regress toward blame without explicit attestation. Schema is the cheapest reinforcement.
  - **Why not:** Cultural defaults erode; schema is durable.

- **Option D:** Combine SEV-1/2 into single "critical" tier.
  - **Pros:** Simpler.
  - **Cons:** Different operational responses (exec brief at sev1 not sev2; page-on-call same).
  - **Why not:** Granularity helps capacity planning and on-call experience.

## Consequences

- **Positive.** Incidents are clocked. MTTR is measurable. Postmortems are blameless by contract. Communications gate on legal review for high-stakes audiences. GDPR 72h deadline enforced.
- **Negative.** Ceremony around handoffs, four-eyes, peer review. Non-trivial to operate for small teams; appropriate for the platform's scale and regulatory context.
- **Neutral.** Severity bands are starting points; we can tune ack/mitigate/resolve targets per learning.
- **Reversibility.** Schema additions are easy. Historical records once accumulated need version-2 migration for breaking changes.

## Implementation notes

- **Timeline strictness.** `mitigatedAt requires ackedAt`, `resolvedAt requires mitigatedAt`. You can't claim mitigation without first acknowledging.
- **Public visibility gating.** sev1 and sev2 (status page required severities) require `publiclyVisible=true` once triaged. Declared and cancelled states allow `publiclyVisible=false` to handle the brief investigation window before public disclosure.
- **Postmortem reviewers.** Author cannot be a reviewer of their own postmortem (peer review). Reviewers must be ≥2 for publication. This is enforced at the schema level.
- **Breach notification timing.** `breachNotificationDeadlineAt` is set at incident declaration based on regulatory context (GDPR 72h, HIPAA 60 days, sector-specific). `isBreachNotificationTimely()` checks publishedAt ≤ deadlineAt.
- **Runbook execution.** References `dr` package's `RB-NNNN` runbook ids. Execution records live in incident-response; runbook specs live in dr. Separation of "what the runbook says" from "how it executed".

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Auto-page integration — PagerDuty webhook spec | _pending_ | Phase 2 |
| Customer-facing status page generator (open-source or build) | _pending_ | Phase 2 |
| Cross-region incident coordination (region-specific incident vs global) | _pending_ | Phase 3 |
| Postmortem template variations by category | _pending_ | Phase 3 |

## References

- GDPR Article 33 (breach notification — 72 hours).
- HIPAA 45 CFR 164.408 (breach notification timing).
- Google SRE Book — postmortem culture, severity definitions.
- ADR-0009 (security model) — incident classification.
- ADR-0017 (observability and SLOs) — error budget interaction with incidents.
- ADR-0031 (disaster recovery) — runbook specs referenced by incident-response executions.
- ADR-0035 (audit and forensics) — incident records may seed evidence collection.
- `packages/incident-response/src/` for the zod schemas and helpers.
