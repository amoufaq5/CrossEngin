import type { CostCeilings, SessionCostState, SessionDecisionInput } from "@crossengin/ai-architect";

/**
 * The per-tenant AI-spend window the gate's cost facet reads — satisfied structurally
 * by `@crossengin/ai-router`'s `CostTracker` (`getWindow(tenantId)` returns a
 * `{ costUsd }` window), so the bridge needs no `ai-router` dep. `null` ⇒ no spend
 * recorded for the tenant yet.
 */
export interface TenantCostWindowSource {
  getWindow(tenantId: string): Promise<{ readonly costUsd: number } | null>;
}

export interface ProposalCostInputOptions {
  readonly source: TenantCostWindowSource;
  readonly tenantId: string;
  readonly ceilings: CostCeilings;
  readonly session: SessionCostState;
  readonly proposedTool?: string;
}

/**
 * Builds the proposal gate's `cost` input from the router's per-tenant cost
 * attribution: it reads the tenant's accumulated spend window (`costUsd`) and maps it
 * to the gate's `tenant.monthlyDollarsUsed`, alongside the live session token/tool
 * state. Feeding the result into `evaluateProposalGate({ cost })` makes the cost
 * facet **live** — a tenant whose router-tracked AI spend has hit its monthly ceiling
 * gets its next proposal blocked (and a warning as it approaches). (The deployment
 * configures the tracker's window to match the ceiling's period.)
 */
export async function buildProposalCostInput(opts: ProposalCostInputOptions): Promise<SessionDecisionInput> {
  const window = await opts.source.getWindow(opts.tenantId);
  return {
    ceilings: opts.ceilings,
    session: opts.session,
    tenant: { monthlyDollarsUsed: window?.costUsd ?? 0 },
    ...(opts.proposedTool !== undefined ? { proposedTool: opts.proposedTool } : {}),
  };
}
