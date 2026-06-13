# ADR-0236: access-review persistence (Phase 3 P8.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0234 (access-review campaign runtime), ADR-0235 (decision application), ADR-0040 (access reviews + attestations) |

## Context

P8.3/P8.4 made the access-review loop run at the runtime level (generate items from live
grants → review → apply attested decisions → roll up progress), but nothing persisted the
items or decisions — the natural follow-up the P8.4 ADR named. The `meta.access_review_items`
+ `meta.access_review_decisions` tables already exist (tenant-scoped, RLS), so this is a
persistence sibling over pre-existing tables, like `dr-runtime-pg` / `marketplace-pg`.

The wrinkle: both tables key rows on a UUID `id` (the FKs point at it) while the contract
objects are keyed on the `ari_…` / `ard_…` / `arc_…` business ids. `access_review_items.
campaign_id` is a UUID FK; `access_review_decisions.item_id` + `campaign_id` are UUID FKs.

## Decision

A new `@crossengin/access-reviews-pg` package (the **76th**, deps `access-reviews` +
`kernel-pg`), no new META tables. 3 modules:

- **`records.ts`** — `rowToReviewItem` / `rowToDecision` reconstruct the contract objects
  through their schemas. The item's flattened reviewer columns
  (`current_reviewer_user_id` / `…_kind` / `reviewer_assigned_at` / `reminder_count` /
  `last_reminder_at` / `escalation_level`) collapse back into the nullable `currentReviewer`
  (a null user id ⇒ no reviewer). The decision's attestation flattening stores neither
  `attestedAt` nor `attestedByUserId` — both are derived (`decided_at` /
  `decided_by_user_id`, which the contract pins equal); an optional `attestationPhrase` is
  not persisted.
- **`item-store.ts`** — `PostgresAccessReviewItemStore` (`record` upserts on `item_id` and
  resolves the campaign UUID inline via `(SELECT id FROM …_campaigns WHERE campaign_id = $N)`;
  `get` / `listForCampaign` join the campaign back so the `arc_…` business id is read back).
- **`decision-store.ts`** — `PostgresAccessReviewDecisionStore` (`record` upserts on
  `decision_id` resolving the item + campaign UUIDs by subquery; `get` / `listForItem` join
  both back). Every op runs inside a tenant context
  (`set_config('app.current_tenant_id', …)`) so RLS — not just `WHERE tenant_id` — confines
  reads + writes; the tenant id is a bound parameter, never interpolated, UUID-guarded.

## Consequences

- **76 packages + 4 apps, 128 meta-schema tables, ~7,515 offline tests** (+9 in
  `store.test.ts`) + a gated `integration.test.ts` (2 cases — seed a tenant/user/campaign,
  persist an in-review item + read it back RLS-scoped, persist + read a keep decision through
  the FK joins — green on live Postgres 16). No new META_ tables.
- The access-review loop is now durable end-to-end. A campaign store (the heavier
  scope/reviewer-assignment JSONB mapping) + an `access-reviews` read/verify CLI stay the
  follow-ups; the SLO loop on operate-server's real request stream (largely landed
  P2.32/P2.37) is the remaining P8 GA-checklist item.
