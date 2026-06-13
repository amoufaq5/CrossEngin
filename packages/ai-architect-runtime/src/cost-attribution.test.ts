import { DEFAULT_BASE_CEILINGS, type SessionCostState } from "@crossengin/ai-architect";
import { describe, expect, it } from "vitest";

import { buildProposalCostInput, type TenantCostWindowSource } from "./cost-attribution.js";
import { evaluateProposalGate } from "./proposal-gate.js";

const SESSION: SessionCostState = { tokensUsed: 1000, toolCallsThisTurn: 0, toolCallsBySession: {} };

function source(costUsd: number | null): TenantCostWindowSource {
  return { async getWindow() { return costUsd === null ? null : { costUsd }; } };
}

describe("buildProposalCostInput", () => {
  it("maps the tenant's spend window to monthlyDollarsUsed", async () => {
    const input = await buildProposalCostInput({ source: source(42), tenantId: "t1", ceilings: DEFAULT_BASE_CEILINGS, session: SESSION });
    expect(input.tenant.monthlyDollarsUsed).toBe(42);
    expect(input.ceilings).toBe(DEFAULT_BASE_CEILINGS);
    expect(input.session).toBe(SESSION);
  });

  it("treats no recorded window as zero spend", async () => {
    const input = await buildProposalCostInput({ source: source(null), tenantId: "t1", ceilings: DEFAULT_BASE_CEILINGS, session: SESSION });
    expect(input.tenant.monthlyDollarsUsed).toBe(0);
  });

  it("makes the gate's cost facet live — over-ceiling spend blocks the proposal", async () => {
    // DEFAULT_BASE_CEILINGS.perTenantMonthlyDollars is 200; spend 250 → block.
    const cost = await buildProposalCostInput({ source: source(250), tenantId: "t1", ceilings: DEFAULT_BASE_CEILINGS, session: SESSION });
    const decision = evaluateProposalGate({ cost });
    expect(decision.decision).toBe("refuse");
    expect(decision.reasons.join(" ")).toMatch(/ceiling/);
  });

  it("under-ceiling spend allows the proposal", async () => {
    const cost = await buildProposalCostInput({ source: source(10), tenantId: "t1", ceilings: DEFAULT_BASE_CEILINGS, session: SESSION });
    expect(evaluateProposalGate({ cost }).decision).toBe("allow");
  });
});
