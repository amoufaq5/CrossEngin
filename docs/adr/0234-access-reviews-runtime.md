# ADR-0234: access-review campaign runtime (Phase 3 P8.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0085 (dr-runtime), ADR-0040 (access reviews + attestations) |

## Context

P8's GA checklist includes "a quarterly access-review campaign attests every grant". The
`access-reviews` package ships the contracts — the campaign + item + decision lifecycles,
`computeRiskLevel`, `computeCampaignProgress`, `computeNextScheduledStart`, `isItemOverdue`,
`shouldEscalate` — but nothing turns a live authorization snapshot into review items, rolls up
campaign progress, or computes the next scheduled run.

## Decision

A new pure package `@crossengin/access-reviews-runtime` (the **75th**), dep `access-reviews`.
Two modules:

- **`item-generation.ts`** — `generateReviewItem(grant, ctx)` turns a `LiveGrant` (a
  principal's grant pulled from the authorization state) into a `pending`, undecided
  `AccessReviewItem`: it derives the grant's age (`grantedAt`→`now`), scores risk via the
  contract's `computeRiskLevel` (principal type + grant kind + MFA posture + staleness +
  age), and builds the schema-valid item. `generateReviewItems(grants, ctx)` does the whole
  snapshot. This is "the campaign runs against live grants".
- **`review.ts`** — `summarizeItems(items, now)` rolls up resolved / pending / in_review /
  escalated / overdue counts + the completion fraction; `overdueItems` / `itemsToEscalate`
  (the signals a coordinator pages on, via `isItemOverdue` / `shouldEscalate`);
  `allItemsResolved` (the campaign can close); `nextCampaignStart(campaign)` wraps
  `computeNextScheduledStart` (the "on a schedule" part — `null` for non-recurring
  frequencies).

## Consequences

- **75 packages + 4 apps, 128 meta-schema tables, ~7,500 offline tests.** No new META_
  tables (pure runtime; items/decisions persist via existing access-review tables). New
  tests: 10 — item generation (pending/undecided shape, critical vs low risk scoring,
  one-item-per-grant) + the review rollups (progress, overdue filtering, reviewer-timeout
  escalation, all-resolved, recurring vs one-time scheduling).
- A quarterly campaign can now be materialized from live grants, its progress + overdue +
  escalation signals computed, and its next run scheduled. Decision application
  (`recordItemDecision` with the strong-attestation gate) + a PG persistence sibling are the
  follow-ups; the SLO loop on operate-server's real request stream (largely landed
  P2.32/P2.37) is the remaining P8 GA-checklist item.
