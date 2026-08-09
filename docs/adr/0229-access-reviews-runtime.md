# ADR-0229: `@crossengin/access-reviews-runtime` — scheduled campaigns against live grants (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (P3 plan — P8), `@crossengin/access-reviews` contracts |

## Context

`@crossengin/access-reviews` modeled attestation campaigns, review items, decisions with four-eyes
attestation, exceptions, and sealed evidence — but nothing *ran* a campaign. ADR-0077's P8 milestone
calls for "`access-reviews` campaigns run on a schedule against live grants". This is the pure
in-process runtime that turns the campaign contracts into a running loop, following the
`observability-runtime` template (no META tables; a Postgres sibling is a later milestone).

## Decision

A new pure runtime package, `@crossengin/access-reviews-runtime`, consuming `@crossengin/access-reviews`.
Modules:

- **`clock.ts`** — `Clock` / `SystemClock` / `FixedClock` + `IdGenerator` (`CountingIdGenerator` /
  `RandomIdGenerator`), mirroring the other runtimes.
- **`scheduling.ts`** — pure campaign scheduling over a clock: `dueCampaigns(campaigns, now)` (scheduled
  and startable), `planNextOccurrence(campaign, now)` (the next recurring instance via
  `computeNextScheduledStart`, `null` for one-time/ad-hoc), and overdue detection via `isPastDeadline` /
  `isPastGracePeriod`.
- **`item-generation.ts`** — `generateItems(campaign, grants, principals, opts)`: for each principal
  matching the campaign scope (`principalMatchesScope`), a pending `AccessReviewItem` per grant, risk via
  `computeRiskLevel`, reviewer via the campaign's assignment policy — every item re-validated by the
  contract schema.
- **`enforcement.ts`** — `planAutoRevocations(items, campaign, now)`: for items left un-attested past the
  deadline, a system `revoke` `AccessReviewDecision` when the campaign's `AutoRevokePolicy` mandates it
  (else none), with the appropriate `DecisionReason`.
- **`engine.ts`** — an `AccessReviewRuntime` composing scheduling + generation + auto-revoke over one
  clock + id generator, and a `CampaignScheduler` (the `PruneScheduler` shape: `unref`'d injectable
  timer, `start()`/`stop()`, `onTick`/`onError` sinks) that each tick starts due campaigns, flags
  overdue items, and plans auto-revocations.

## Consequences

- Access reviews now run themselves: on a timer the runtime starts due campaigns, materializes review
  items from the live grant set (scoped to the campaign), escalates overdue items, and auto-revokes
  lapsed grants under policy — the SOC 2 / HIPAA / PCI attestation loop is executed, not just typed.
- Item generation and auto-revocation re-validate through the contract schemas, so a generated item or a
  planned decision can never be schema-invalid — the same fail-closed posture as the other runtimes.
- Pure + in-process: fully offline-tested; the scheduler timer is `unref`'d so it never holds the
  process open.
- Follow-ups (open): a `@crossengin/access-reviews-runtime-pg` persistence sibling (campaigns/items/
  decisions under RLS); pulling the live grant set from `@crossengin/auth`'s actual RBAC store rather
  than an injected list; sealing per-campaign evidence at close via the existing
  `sealEvidenceWithBundle`.
