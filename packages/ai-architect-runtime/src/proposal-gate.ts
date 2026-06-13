import {
  decideSessionAction,
  evaluateGate,
  evaluateRefusal,
  requiresBulkConfirmation,
  type BulkOperationScope,
  type EvalGateConfig,
  type EvalGateOutcome,
  type EvalRunResult,
  type RefusalDecision,
  type RefusalRequest,
  type SessionDecision,
  type SessionDecisionInput,
} from "@crossengin/ai-architect";

export const PROPOSAL_GATE_DECISIONS = ["allow", "confirm", "refuse"] as const;
export type ProposalGateDecisionKind = (typeof PROPOSAL_GATE_DECISIONS)[number];

/**
 * The context for gating one AI-Architect proposal (e.g. an approved
 * `propose_manifest_edit` before it publishes/installs). Each clause is optional —
 * the runtime only evaluates the policy facets the caller supplies.
 */
export interface ProposalGateInput {
  /** A hard refusal the proposed edit matches (caller-detected from the diff); terminal + non-overridable. */
  readonly hardRefusal?: { readonly request: RefusalRequest; readonly alternative?: string };
  /** Per-session / per-tenant cost ceiling pre-check. */
  readonly cost?: SessionDecisionInput;
  /** The eval-suite run result + optional gate config. */
  readonly evalResult?: { readonly result: EvalRunResult; readonly config?: EvalGateConfig };
  /** A bulk-operation scope (large delete/update/cancel) requiring explicit confirmation. */
  readonly bulkScope?: BulkOperationScope;
}

/**
 * The aggregate gate verdict: `allow` (proceed), `confirm` (a human must
 * acknowledge/override before proceeding), or `refuse` (blocked). `reasons` are the
 * blocking/confirm-driving reasons; `warnings` are non-blocking notes (e.g. cost
 * approaching its ceiling). The per-facet decisions are surfaced for the UI.
 */
export interface ProposalGateDecision {
  readonly decision: ProposalGateDecisionKind;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly refusal: RefusalDecision | null;
  readonly costDecision: SessionDecision | null;
  readonly evalOutcome: EvalGateOutcome | null;
}

/**
 * Composes the `@crossengin/ai-architect` safety-policy deciders into one verdict
 * for a proposal, by precedence: a **hard refusal** (P0, non-overridable) wins and
 * is terminal; otherwise a cost-ceiling **block** or an eval-gate **block** refuses;
 * otherwise an eval gate that's `fail_with_override_possible`, or a bulk operation
 * over threshold, requires **confirm** (a human override); a cost **warn** is a
 * non-blocking warning; else **allow**. Pure — the loop supplies the facts, this
 * decides.
 */
export function evaluateProposalGate(input: ProposalGateInput): ProposalGateDecision {
  // 1. Hard refusal — terminal, non-overridable (P0).
  if (input.hardRefusal !== undefined) {
    const refusal = evaluateRefusal(
      input.hardRefusal.request,
      input.hardRefusal.alternative !== undefined ? { alternative: input.hardRefusal.alternative } : undefined,
    );
    return {
      decision: "refuse",
      reasons: [refusal.message],
      warnings: [],
      requiresConfirmation: false,
      refusal,
      costDecision: null,
      evalOutcome: null,
    };
  }

  const refuseReasons: string[] = [];
  const confirmReasons: string[] = [];
  const warnings: string[] = [];

  // 2. Cost ceilings.
  let costDecision: SessionDecision | null = null;
  if (input.cost !== undefined) {
    costDecision = decideSessionAction(input.cost);
    if (costDecision.decision === "block") {
      refuseReasons.push(costDecision.reason ?? "cost ceiling exceeded");
    } else if (costDecision.decision === "warn") {
      warnings.push(costDecision.reason ?? "cost approaching ceiling");
    }
  }

  // 3. Eval gate.
  let evalOutcome: EvalGateOutcome | null = null;
  if (input.evalResult !== undefined) {
    evalOutcome = evaluateGate(input.evalResult.result, input.evalResult.config);
    if (evalOutcome.decision === "block") {
      refuseReasons.push(...evalOutcome.reasons);
    } else if (evalOutcome.decision === "fail_with_override_possible") {
      confirmReasons.push(...evalOutcome.reasons);
    }
  }

  // 4. Bulk-operation confirmation.
  if (input.bulkScope !== undefined && requiresBulkConfirmation(input.bulkScope)) {
    confirmReasons.push("bulk operation exceeds a safe threshold and requires explicit confirmation");
  }

  const decision: ProposalGateDecisionKind =
    refuseReasons.length > 0 ? "refuse" : confirmReasons.length > 0 ? "confirm" : "allow";

  return {
    decision,
    reasons: decision === "refuse" ? refuseReasons : decision === "confirm" ? confirmReasons : [],
    warnings,
    requiresConfirmation: decision === "confirm",
    refusal: null,
    costDecision,
    evalOutcome,
  };
}
