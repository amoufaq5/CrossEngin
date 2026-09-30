# ADR-0288: A compromised audit trail declares an incident (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-30 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0287 (integrity-proof scheduler), ADR-0286 (audit-log anchoring), ADR-0060 (SLO enforcement runtime) |

## Context

ADR-0287 made the audit-integrity proof run on a schedule and left its finding going nowhere:
*"a finding logs and nothing more: the `incident-response` package models exactly this
escalation and `observability-runtime` has the planners, but wiring `compromised` → declared
incident is deliberately separate."*

A `compromised` verdict on stderr is a finding nobody is obliged to see. The escalation
machinery already existed and was already wired for a different signal — the SLO enforcement
loop turns an availability breach into a declared incident plus a page using
`planIncidentDeclaration` and `planPageDirective`. There was no reason for audit integrity to
invent its own.

## Decision

- **Reuse the SLO loop's pure planners.** An auto-declared integrity incident is
  indistinguishable in shape from an auto-declared availability one, because it is built by the
  same two functions. `planKillSwitchActivation` is deliberately *not* reused: there is no flag
  to roll back, and rolling one back would not un-alter an audit row.
- **Declare once per episode, not once per pass.** The scheduler runs hourly and a tampered row
  stays tampered, so declaring on every `compromised` verdict would turn one tamper into
  twenty-four incidents a day and train everyone to ignore the alert. This mirrors the SLO
  engine's shape: the first finding for a scope is `opened` (declare, page, audit), subsequent
  findings are `ongoing` and silent, a return to health is `recovered`, and a scope is then
  eligible to declare again with a fresh id.
- **`sev1` by default.** A `compromised` verdict cannot fire on benign state — ADR-0287's
  `unproven` exists precisely to absorb rows that are merely unanchored — so it means the audit
  trail was *provably* altered. Until the blast radius is known no audit record can be trusted,
  and on a platform selling SOC 2 / HIPAA that is an all-hands event with a regulatory clock
  attached. **The low false-positive rate is what earns the severity**; it would be indefensible
  for a signal that fired on absent evidence.
- **Category `security`, not `data_integrity`.** The thing subverted is a security control.
- **The escalation is recorded in `meta.audit_log`**, which the anchoring emitter commits to the
  chain (ADR-0286). So the record that an incident was declared is *itself* tamper-evident, in
  the same structure whose tampering triggered it — suppressing the incident breaks the very
  proof that found the tamper. It is written as `audit.integrity_compromised` (and
  `audit.integrity_recovered` on close), which also means a `compromised` finding now leaves a
  **readable** row, partially answering ADR-0287's "nothing reads verdicts back".
  Writing one per pass would have crowded real audit records out of the 500-row verification
  window; one per *episode* does not, which is what makes this viable here and not for verdicts.
- **An unwritable audit log must not swallow the page.** That condition is one of the things
  being escalated *for*, so a failed audit write is reported as `audited: false` and the page
  still goes out.
- **The scope is marked open before paging.** A failing pager must not cause a re-declare on the
  next pass; a missed page is recoverable, an alert storm is not.
- **Escalation is consulted on every proved pass**, not only on findings — a scope returning to
  health is what closes an open incident, so recovery has to be observed too.
- **A platform-scope escalation pages but cannot be audited.** `audit_log.tenant_id` is NOT NULL,
  so there is no tenant-scoped row to write. Reported as `audited: false` rather than dropped.

## Consequences

- **Verified live** against a real Postgres, as a full episode:
  - healthy tenant → no escalation, no page;
  - tamper → `DECLARED INC-2026-0001 severity=sev1 paged=pagerduty_phone audited=true`, and an
    `audit.integrity_compromised` row;
  - **three further passes → `ongoing`, still one page and one audit row** — the property that
    makes this deployable;
  - the incident's own audit row was **anchored at chain sequence 4 and verified against that
    anchor**;
  - repair → `recovered`, closing the incident with an `audit.integrity_recovered` row;
  - tamper again → a **new** incident `INC-2026-0002`, two pages in total.
- **Verified in the real server** with `--integrity-proof-config` carrying an `escalation` block:
  the pass logged `COMPROMISED`, then `PAGE INC-2026-0001 severity=sev1
  channels=pagerduty_phone`, then `DECLARED … audited=true`.
- `operate-server` gains a dependency on `@crossengin/incident-response`. No new table; no
  meta-schema change.
- The escalation config lives in its own module so the scheduler never imports the escalator
  (which imports the scheduler's report type); the hook is typed against a minimal structural
  `IntegrityEscalationOutcome` rather than a cycle.
- +30 tests (operate-server **66 files / 1684**; workspace **9,411**). Full workspace build +
  typecheck + test green.
- Follow-ups: **nothing persists an `IncidentRecord`.** `incident-response` has no `-pg` sibling
  — the SLO loop has the same gap, recording only an incident *id* in its enforcement-action
  ledger — so the declared record exists in memory, in a log line and in the audit row's summary,
  but the incident's own lifecycle (triage, roles, mitigation, postmortem) has nowhere to live.
  That is the next real increment, and it is shared with SLO enforcement rather than specific to
  audit integrity. **Open-incident state is per-process and in memory**, like the SLO engine's
  incident sequence, so a restart re-declares a still-present tamper; that risks a duplicate
  incident and never a missed one, which is the safe direction. And **paging is a callback** —
  this app has no pager integration, so `channels` is logged rather than dialled.
