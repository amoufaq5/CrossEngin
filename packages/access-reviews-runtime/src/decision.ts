import {
  AccessReviewItemSchema,
  canTransitionItem,
  isStrongAttestation,
  requiresStrongAttestation,
  type AccessReviewDecision,
  type AccessReviewItem,
} from "@crossengin/access-reviews";

/** Thrown when a decision's strong-attestation requirement isn't met. */
export class StrongAttestationRequiredError extends Error {}
/** Thrown when a decision doesn't belong to the item it's applied to. */
export class DecisionItemMismatchError extends Error {}
/** Thrown when the item can't transition to the decision's resolved status. */
export class IllegalItemDecisionError extends Error {}

/** A `defer_to_next_campaign` decision parks the item; every other kind resolves it as `decided`. */
function targetStatusFor(decision: AccessReviewDecision): AccessReviewItem["status"] {
  return decision.kind === "defer_to_next_campaign" ? "deferred_to_next_campaign" : "decided";
}

/**
 * Applies a reviewer's decision to its item — the "attest a grant" step. It enforces:
 *
 * - **identity** — the decision's `itemId` / `campaignId` / `tenantId` must match the item
 *   (`DecisionItemMismatchError`);
 * - **strong attestation** — a decision whose `(kind, reason)` `requiresStrongAttestation`
 *   (a regulatory keep, any time-bound extension, a security-concern revoke) must carry a
 *   strong attestation (e-signature / qualified e-signature / two-person), else
 *   `StrongAttestationRequiredError`;
 * - **lifecycle** — the item must be able to transition to the decision's resolved status
 *   (`canTransitionItem`; e.g. a `pending` item can't be `decided` without first entering
 *   review), else `IllegalItemDecisionError`.
 *
 * On success it returns the item re-validated through the schema with the decision linked
 * (`decisionId` + `decidedAt`) and the resolved status set.
 */
export function recordItemDecision(item: AccessReviewItem, decision: AccessReviewDecision): AccessReviewItem {
  if (decision.itemId !== item.id || decision.campaignId !== item.campaignId || decision.tenantId !== item.tenantId) {
    throw new DecisionItemMismatchError(`decision ${decision.id} does not belong to item ${item.id}`);
  }
  if (requiresStrongAttestation(decision.kind, decision.reason) && !isStrongAttestation(decision.attestation)) {
    throw new StrongAttestationRequiredError(
      `a '${decision.kind}' decision with reason '${decision.reason}' requires a strong attestation (got '${decision.attestation.kind}')`,
    );
  }
  const target = targetStatusFor(decision);
  if (!canTransitionItem(item.status, target)) {
    throw new IllegalItemDecisionError(`cannot apply a '${decision.kind}' decision to an item in '${item.status}'`);
  }
  return AccessReviewItemSchema.parse({
    ...item,
    status: target,
    decidedAt: decision.decidedAt,
    decisionId: decision.id,
  });
}
