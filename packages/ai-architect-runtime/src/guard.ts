import {
  DEFAULT_BASE_CEILINGS,
  decideSessionAction,
  evaluateRefusal,
  requiresBulkConfirmation,
  type BulkOperationScope,
  type CostCeilings,
  type RefusalDecision,
  type RefusalRequest,
  type SessionDecision,
} from "@crossengin/ai-architect";

import {
  admitRequestCost,
  reconcileRequestCost,
  type CostOverrunVerdict,
  type PerRequestCostCeiling,
  type RequestCostEstimate,
  type RequestCostEstimateInput,
} from "./request-cost.js";
import { SessionCostTracker } from "./state.js";

/**
 * A proposed Architect action to gate. `refusal` is set only when the caller has
 * already classified the action as a hard-refusal category (the classification is
 * the caller's; the runtime formats + enforces it). `proposedTool` / `bulk`
 * feed the cost + bulk-confirmation checks, and `request` — everything needed to
 * price one completion before it is sent — feeds the per-request ceiling.
 */
export interface GuardRequest {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly proposedTool?: string;
  readonly bulk?: BulkOperationScope;
  readonly refusal?: RefusalRequest;
  readonly request?: Omit<RequestCostEstimateInput, "inflation">;
}

/**
 * The guard's verdict for an action, in strict precedence: a hard `refuse`
 * (P0, absolute) beats a cost `block`, which beats a bulk `confirm` gate, which
 * beats a cost `warn`, else `allow`. A `block` carries `estimate` when the per-request
 * ceiling is what stopped it.
 */
export type GuardDecision =
  | { readonly outcome: "refuse"; readonly refusal: RefusalDecision }
  | {
      readonly outcome: "block";
      readonly reason: string;
      readonly cost: SessionDecision;
      readonly estimate?: RequestCostEstimate;
    }
  | { readonly outcome: "confirm"; readonly scope: BulkOperationScope; readonly cost: SessionDecision }
  | { readonly outcome: "warn"; readonly cost: SessionDecision; readonly estimate?: RequestCostEstimate }
  | { readonly outcome: "allow"; readonly cost: SessionDecision; readonly estimate?: RequestCostEstimate };

export interface ArchitectGuardRuntimeOptions {
  readonly ceilings?: CostCeilings;
  /**
   * The per-request ceiling. Absent means no request is priced before it is sent, which
   * is the pre-ADR-0267 behaviour: a single pathological completion can spend a month's
   * budget, because the monthly ceiling is only ever read *between* requests.
   */
  readonly perRequestCeiling?: PerRequestCostCeiling;
  readonly tracker?: SessionCostTracker;
}

export interface RecordActualCostInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly estimatedDollars: number;
  readonly actualDollars: number;
}

/**
 * The production Architect safety runtime: wraps the pure policy checks
 * (`evaluateRefusal` / `decideSessionAction` / `requiresBulkConfirmation`) around
 * live per-session + per-tenant cost state, so a serving Architect gates every
 * turn/tool against refusals, cost ceilings, and bulk-confirmation. Stateless
 * decisions, stateful accounting; the caller records usage after each turn.
 */
export class ArchitectGuardRuntime {
  private readonly ceilings: CostCeilings;
  private readonly perRequestCeiling?: PerRequestCostCeiling;
  readonly tracker: SessionCostTracker;

  constructor(options: ArchitectGuardRuntimeOptions = {}) {
    this.ceilings = options.ceilings ?? DEFAULT_BASE_CEILINGS;
    this.perRequestCeiling = options.perRequestCeiling;
    this.tracker = options.tracker ?? new SessionCostTracker();
  }

  /**
   * Gates a proposed action: refusals → a sealed session → session/tenant cost ceilings
   * → the per-request ceiling → bulk confirmation. The per-request check comes after the
   * accumulated ones because "there is no budget left at all" is the more useful answer
   * than "this one request is too big" when both are true.
   */
  evaluate(request: GuardRequest): GuardDecision {
    // Hard refusals are absolute and checked first — no cost/gating can override them.
    if (request.refusal !== undefined) {
      return { outcome: "refuse", refusal: evaluateRefusal(request.refusal) };
    }
    const cost = decideSessionAction({
      ceilings: this.ceilings,
      session: this.tracker.session(request.sessionId),
      tenant: this.tracker.tenant(request.tenantId),
      ...(request.proposedTool !== undefined ? { proposedTool: request.proposedTool } : {}),
    });
    const sealed = this.tracker.sealedReason(request.sessionId);
    if (sealed !== null) {
      return { outcome: "block", reason: sealed, cost };
    }
    if (cost.decision === "block") {
      return { outcome: "block", reason: cost.reason ?? "cost ceiling reached", cost };
    }
    let estimate: RequestCostEstimate | undefined;
    if (this.perRequestCeiling !== undefined && request.request !== undefined) {
      const admission = admitRequestCost(this.perRequestCeiling, {
        ...request.request,
        inflation: this.tracker.estimateInflation(request.sessionId),
      });
      estimate = admission.estimate;
      if (admission.outcome === "refuse") {
        return { outcome: "block", reason: admission.reason, cost, estimate };
      }
    }
    if (request.bulk !== undefined && requiresBulkConfirmation(request.bulk)) {
      return { outcome: "confirm", scope: request.bulk, cost };
    }
    if (cost.decision === "warn") {
      return { outcome: "warn", cost, ...(estimate !== undefined ? { estimate } : {}) };
    }
    return { outcome: "allow", cost, ...(estimate !== undefined ? { estimate } : {}) };
  }

  /**
   * Settles one request against the estimate that admitted it. The actual cost is always
   * charged in full — an estimate is not a cap on what the tenant owes — and an overrun
   * additionally raises the session's estimate inflation. A cost over the per-request
   * ceiling seals the session: the estimator was wrong about a hard limit, so continuing
   * to admit requests on its word would be guessing twice.
   */
  recordActualCost(input: RecordActualCostInput): CostOverrunVerdict {
    this.tracker.recordDollars(input.tenantId, input.actualDollars);
    const ceiling = this.perRequestCeiling;
    if (ceiling === undefined) {
      return { kind: "within_estimate", actualDollars: input.actualDollars };
    }
    const verdict = reconcileRequestCost({
      ceiling,
      estimatedDollars: input.estimatedDollars,
      actualDollars: input.actualDollars,
    });
    if (verdict.kind !== "within_estimate" && verdict.ratio !== undefined) {
      this.tracker.observeEstimateRatio(input.sessionId, verdict.ratio);
    }
    if (verdict.kind === "over_ceiling") {
      this.tracker.seal(
        input.sessionId,
        `request actually cost $${verdict.actualDollars.toFixed(4)}, over the per-request ceiling of $${ceiling.maxDollars.toFixed(4)}`,
      );
    }
    return verdict;
  }

  /** Resets the per-turn tool counter for a session (call at the start of a turn). */
  beginTurn(sessionId: string): void {
    this.tracker.beginTurn(sessionId);
  }

  /** Records a session's token spend after a turn. */
  recordTokens(sessionId: string, tokens: number): void {
    this.tracker.recordTokens(sessionId, tokens);
  }

  /** Records a tool call (per-turn + per-tool session tallies). */
  recordToolCall(sessionId: string, tool: string): void {
    this.tracker.recordToolCall(sessionId, tool);
  }

  /** Records a tenant's dollar spend against its monthly total. */
  recordDollars(tenantId: string, dollars: number): void {
    this.tracker.recordDollars(tenantId, dollars);
  }
}
