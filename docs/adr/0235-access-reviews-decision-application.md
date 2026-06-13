# ADR-0235: access-review decision application (Phase 3 P8.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0234 (access-review campaign runtime), ADR-0040 (access reviews + attestations) |

## Context

P8.3 generates review items from live grants + rolls up campaign progress, but the
"attest every grant" half — applying a reviewer's decision to an item with the
strong-attestation gate — was left as a follow-up. The `access-reviews` package ships the
decision contracts (`requiresStrongAttestation`, `isStrongAttestation`, `canTransitionItem`),
but nothing applies a decision to an item under those rules.

## Decision

A `decision.ts` module in `@crossengin/access-reviews-runtime`:

- **`recordItemDecision(item, decision)`** applies a reviewer's `AccessReviewDecision` to its
  `AccessReviewItem`, enforcing three gates and re-validating through the item schema:
  - **identity** — the decision's `itemId` / `campaignId` / `tenantId` must match the item
    (`DecisionItemMismatchError`);
  - **strong attestation** — a decision whose `(kind, reason)` `requiresStrongAttestation` (a
    regulatory `keep`, any `time_bound_extend`, a `security_concern_revoked`) must carry a
    strong attestation (e-signature / qualified e-signature / two-person), else
    `StrongAttestationRequiredError`;
  - **lifecycle** — the item must be able to transition to the decision's resolved status
    (`canTransitionItem`; a `pending` item can't be `decided` without first entering review),
    else `IllegalItemDecisionError`.
  A `defer_to_next_campaign` decision parks the item (`deferred_to_next_campaign`); every other
  kind resolves it as `decided` with the decision linked (`decisionId` + `decidedAt`).

## Consequences

- **75 packages + 4 apps, 128 meta-schema tables, ~7,506 offline tests.** No new META_
  tables (decisions persist via existing access-review tables). New tests: 6 in
  `decision.test.ts` — a keep decision resolves the item; a `time_bound_extend` is blocked
  with a weak attestation then allowed with a strong one; a defer parks the item; deciding a
  still-pending item is rejected; a mismatched decision is rejected.
- The access-review loop is now end-to-end at the runtime level: generate items from live
  grants → review (overdue/escalate signals) → **apply attested decisions** → roll up
  progress → schedule the next campaign. A PG persistence sibling (campaign/item/decision
  stores) is the natural follow-up; the SLO loop on operate-server's real request stream
  (largely landed P2.32/P2.37) is the remaining P8 GA-checklist item.
