# ADR-0273: Telling the tenant their proposal was decided (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0272 (activation diff), ADR-0271 (manifest viewer), ADR-0270 (design-review queue), ADR-0267 (AI onboarding) |

## Context

ADR-0270 put a platform reviewer between a tenant's AI-designed proposal and activation, and
ADRs 0271/0272 gave that reviewer the schema and the diff to judge it by. But the decision only
ever landed in the reviewer's console. A tenant who submitted a system and was told "pending
review" had no way to learn it had been approved short of reloading the proposals table and
noticing a changed status — and a **rejection**, whose whole value is the reviewer's written
reason, was invisible. The loop opened in ADR-0270 stayed open.

## Decision

- **Reuse the notification ledger, do not add a table.** `meta.notification_dispatches` already
  models exactly this record — template, channel, category, priority, audience, status,
  correlation — and already carries a UNIQUE `(tenant_id, idempotency_key)`. A decision is queued
  as a dispatch under `design_review.approved` / `design_review.rejected`, `in_app`,
  `transactional`, `high`. Table count stays at **138**.
- **Idempotency is the schema's, not a check.** The key is `design_review:<proposalId>:<decision>`
  and the insert is `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` returning whether a row
  was written, so re-deciding a proposal the same way collapses onto the one notice already
  queued. No read-then-write race exists to lose.
- **The ledger stores no readable copy.** By its own contract a dispatch persists only
  `variables_sha256`, so the human content — proposal name, the reviewer's notes, when — is
  **joined from the proposal row at read time**. That keeps the message body under the same RLS
  and retention as the record it describes rather than duplicating it into a second table, and a
  proposal that has since been archived degrades to `proposal: null` instead of failing the list.
- **`requested_by` is always null.** It is a RESTRICT foreign key into `meta.users`, and a platform
  reviewer is an operator with no row there — attributing them would fail the insert outright.
  Their identity also stays deliberately out of a ledger the tenant itself can read.
- **A notification failure can never fail a decision.** The decision is already committed when the
  notice is queued, so the notifier is wrapped and any error is routed to `onNotifyError` and
  logged. Both the notifier and the read route are injected and optional, in the established
  pattern — an operate-server without a Postgres store simply has neither.
- **Read side is tenant-scoped twice.** `GET /v1/meta/notifications` runs inside
  `withTenantContext` (binding `app.current_tenant_id` for the transaction, so RLS applies) *and*
  binds `tenant_id` as a WHERE predicate. The projection deliberately omits `audience` and
  `variables_sha256`, so a tenant reading its own inbox cannot read back recipient structure or
  variable digests.
- **UI**: a "Review decisions" section on `/setup` showing the decision chip, proposal name, the
  reviewer's notes verbatim, and — for an approved proposal still awaiting activation — a jump link
  to the row that can activate it. The notification contract carries no per-user read state, so the
  sidebar badge approximates "unacknowledged" by **recency**: decisions under 7 days old.

## Consequences

- **Verified live** against a real Postgres: a tenant designed a system, saw an empty inbox,
  a platform reviewer approved it with notes, and the tenant's `GET /v1/meta/notifications`
  returned the notice with the joined name and notes and `correlationId` equal to the proposal id
  — with `audience`, `variablesSha256` and `requestedBy` all absent from the response. Approving
  again returned 409 and left the count at **1**. A second proposal rejected with a reason produced
  a second, differently-templated notice; `?templateId=` filtered to one and `?limit=1` paginated.
  A second tenant's key saw **zero** rows. The UI rendered both decisions with their notes and the
  activation jump link.
- The onboarding loop is now closed end to end: describe → design → review → **decision the tenant
  is told about** → activate.
- +101 tests (operate-server **50 files / 985**). Full workspace build + typecheck + test green;
  operate-web build green.
- `PostgresTenantManifestStore` now projects the review columns ADR-0270 added, since the joined
  notification content reads them.
- Follow-ups: per-user read state (the contract has none, so "unread" stays recency-based); actually
  *delivering* the queued dispatch over a channel — the row is `queued` and nothing drains it, which
  is correct for `in_app` but not for email; and notifying on the other events a tenant cares about
  (a design job that failed, a proposal auto-archived).
