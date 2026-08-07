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

import { SessionCostTracker } from "./state.js";

/**
 * A proposed Architect action to gate. `refusal` is set only when the caller has
 * already classified the action as a hard-refusal category (the classification is
 * the caller's; the runtime formats + enforces it). `proposedTool` / `bulk`
 * feed the cost + bulk-confirmation checks.
 */
export interface GuardRequest {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly proposedTool?: string;
  readonly bulk?: BulkOperationScope;
  readonly refusal?: RefusalRequest;
}

/**
 * The guard's verdict for an action, in strict precedence: a hard `refuse`
 * (P0, absolute) beats a cost `block`, which beats a bulk `confirm` gate, which
 * beats a cost `warn`, else `allow`.
 */
export type GuardDecision =
  | { readonly outcome: "refuse"; readonly refusal: RefusalDecision }
  | { readonly outcome: "block"; readonly reason: string; readonly cost: SessionDecision }
  | { readonly outcome: "confirm"; readonly scope: BulkOperationScope; readonly cost: SessionDecision }
  | { readonly outcome: "warn"; readonly cost: SessionDecision }
  | { readonly outcome: "allow"; readonly cost: SessionDecision };

export interface ArchitectGuardRuntimeOptions {
  readonly ceilings?: CostCeilings;
  readonly tracker?: SessionCostTracker;
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
  readonly tracker: SessionCostTracker;

  constructor(options: ArchitectGuardRuntimeOptions = {}) {
    this.ceilings = options.ceilings ?? DEFAULT_BASE_CEILINGS;
    this.tracker = options.tracker ?? new SessionCostTracker();
  }

  /** Gates a proposed action against refusals → cost ceilings → bulk confirmation. */
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
    if (cost.decision === "block") {
      return { outcome: "block", reason: cost.reason ?? "cost ceiling reached", cost };
    }
    if (request.bulk !== undefined && requiresBulkConfirmation(request.bulk)) {
      return { outcome: "confirm", scope: request.bulk, cost };
    }
    if (cost.decision === "warn") {
      return { outcome: "warn", cost };
    }
    return { outcome: "allow", cost };
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
