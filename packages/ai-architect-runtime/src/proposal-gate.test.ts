import { DEFAULT_BASE_CEILINGS, type EvalRunResult, type RefusalRequest, type SessionDecisionInput } from "@crossengin/ai-architect";
import { describe, expect, it } from "vitest";

import { evaluateProposalGate } from "./proposal-gate.js";

const ATTEMPTED = "2026-06-13T00:00:00.000Z";

function refusalReq(): RefusalRequest {
  return { refusal: "grant_cross_tenant_access", requester: "ai_architect", tenantId: "t1", attemptedAt: ATTEMPTED };
}

function cost(tokensUsed: number, monthlyDollarsUsed = 0): SessionDecisionInput {
  return {
    ceilings: DEFAULT_BASE_CEILINGS,
    session: { tokensUsed, toolCallsThisTurn: 0, toolCallsBySession: {} },
    tenant: { monthlyDollarsUsed },
  };
}

function evalRun(over: Partial<EvalRunResult>): EvalRunResult {
  return {
    changeKind: "prompt_template",
    changeDescription: "x",
    baselineCommit: "aaa",
    candidateCommit: "bbb",
    overallScore: 1,
    baselineScore: 1,
    safetyCriticalPassed: [],
    safetyCriticalFailed: [],
    meanCostPerSessionDollars: 1,
    baselineMeanCostPerSessionDollars: 1,
    meanLatencyPerTurnMillis: 100,
    baselineMeanLatencyPerTurnMillis: 100,
    runAt: ATTEMPTED,
    ...over,
  } as EvalRunResult;
}

describe("evaluateProposalGate", () => {
  it("allows a clean proposal", () => {
    const d = evaluateProposalGate({ cost: cost(1000), evalResult: { result: evalRun({}) } });
    expect(d.decision).toBe("allow");
    expect(d.reasons).toEqual([]);
  });

  it("refuses a hard refusal (terminal, non-overridable) — and short-circuits cost/eval", () => {
    const d = evaluateProposalGate({
      hardRefusal: { request: refusalReq() },
      cost: cost(999_999), // would block, but the hard refusal wins first
    });
    expect(d.decision).toBe("refuse");
    expect(d.refusal).not.toBeNull();
    expect(d.refusal?.auditSeverity).toBe("P0");
    expect(d.costDecision).toBeNull(); // not evaluated — hard refusal is terminal
  });

  it("refuses on a cost-ceiling block", () => {
    const d = evaluateProposalGate({ cost: cost(DEFAULT_BASE_CEILINGS.perSessionTokens) });
    expect(d.decision).toBe("refuse");
    expect(d.reasons.join(" ")).toMatch(/ceiling/);
  });

  it("warns (non-blocking) when cost is approaching the ceiling", () => {
    const d = evaluateProposalGate({ cost: cost(Math.ceil(DEFAULT_BASE_CEILINGS.perSessionTokens * 0.9)) });
    expect(d.decision).toBe("allow");
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("refuses on an eval safety-critical regression (block)", () => {
    const d = evaluateProposalGate({ evalResult: { result: evalRun({ safetyCriticalFailed: ["refuse_cross_tenant_read"] }) } });
    expect(d.decision).toBe("refuse");
    expect(d.evalOutcome?.decision).toBe("block");
  });

  it("requires confirmation on an overridable eval regression", () => {
    const d = evaluateProposalGate({ evalResult: { result: evalRun({ overallScore: 0.8, baselineScore: 1 }) } }); // 20% regression > 5%
    expect(d.decision).toBe("confirm");
    expect(d.requiresConfirmation).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/regression/);
  });

  it("requires confirmation for a bulk operation over threshold", () => {
    const d = evaluateProposalGate({ bulkScope: { deleteRecords: 500 } });
    expect(d.decision).toBe("confirm");
    expect(d.reasons.join(" ")).toMatch(/bulk/);
  });

  it("refuse wins over confirm (a cost block alongside a bulk confirm)", () => {
    const d = evaluateProposalGate({ cost: cost(DEFAULT_BASE_CEILINGS.perSessionTokens), bulkScope: { deleteRecords: 500 } });
    expect(d.decision).toBe("refuse");
  });
});
