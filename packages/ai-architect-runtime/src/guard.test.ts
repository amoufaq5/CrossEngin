import type { RefusalRequest } from "@crossengin/ai-architect";
import type { ProviderPricing } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { ArchitectGuardRuntime } from "./guard.js";

const TENANT = "tenant-1";
const SESSION = "sess-1";

const PRICING: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

function refusalReq(): RefusalRequest {
  return {
    refusal: "grant_cross_tenant_access",
    requester: "tenant_admin",
    tenantId: TENANT,
    attemptedAt: "2026-05-16T12:00:00.000Z",
  };
}

describe("ArchitectGuardRuntime.evaluate", () => {
  it("allows a fresh session under all ceilings", () => {
    const g = new ArchitectGuardRuntime();
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION });
    expect(d.outcome).toBe("allow");
  });

  it("refuses a hard-refusal category (P0, absolute)", () => {
    const g = new ArchitectGuardRuntime();
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION, refusal: refusalReq() });
    expect(d.outcome).toBe("refuse");
    if (d.outcome !== "refuse") return;
    expect(d.refusal.refusal).toBe("grant_cross_tenant_access");
    expect(d.refusal.auditSeverity).toBe("P0");
  });

  it("refusal beats a cost block (checked first)", () => {
    const g = new ArchitectGuardRuntime();
    g.recordTokens(SESSION, 60_000); // over the 50k session ceiling
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION, refusal: refusalReq() });
    expect(d.outcome).toBe("refuse");
  });

  it("warns at the warn-percent of the session token ceiling", () => {
    const g = new ArchitectGuardRuntime();
    g.recordTokens(SESSION, 40_000); // 80% of 50k
    expect(g.evaluate({ tenantId: TENANT, sessionId: SESSION }).outcome).toBe("warn");
  });

  it("blocks when the session token ceiling is reached", () => {
    const g = new ArchitectGuardRuntime();
    g.recordTokens(SESSION, 50_000);
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/session token ceiling/);
  });

  it("blocks when the tenant monthly dollar ceiling is reached", () => {
    const g = new ArchitectGuardRuntime();
    g.recordDollars(TENANT, 200);
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/tenant monthly dollar ceiling/);
  });

  it("blocks when the per-turn tool-call cap is hit", () => {
    const g = new ArchitectGuardRuntime();
    for (let i = 0; i < 12; i += 1) g.recordToolCall(SESSION, `tool-${i.toString()}`);
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/per-turn tool-call cap/);
  });

  it("blocks when a per-tool session cap is hit for the proposed tool", () => {
    const g = new ArchitectGuardRuntime();
    // Spread across turns so the per-turn cap (12) isn't the trigger.
    for (let i = 0; i < 8; i += 1) {
      g.beginTurn(SESSION);
      g.recordToolCall(SESSION, "read_file");
    }
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION, proposedTool: "read_file" });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/per-tool 'read_file'/);
  });

  it("requires confirmation for a bulk operation over threshold", () => {
    const g = new ArchitectGuardRuntime();
    const d = g.evaluate({ tenantId: TENANT, sessionId: SESSION, bulk: { deleteRecords: 101 } });
    expect(d.outcome).toBe("confirm");
    if (d.outcome !== "confirm") return;
    expect(d.scope.deleteRecords).toBe(101);
  });

  it("allows a bulk operation under threshold", () => {
    const g = new ArchitectGuardRuntime();
    expect(g.evaluate({ tenantId: TENANT, sessionId: SESSION, bulk: { deleteRecords: 10 } }).outcome).toBe("allow");
  });

  it("a cost block beats a bulk confirm", () => {
    const g = new ArchitectGuardRuntime();
    g.recordTokens(SESSION, 50_000);
    expect(g.evaluate({ tenantId: TENANT, sessionId: SESSION, bulk: { deleteRecords: 101 } }).outcome).toBe("block");
  });
});

describe("ArchitectGuardRuntime per-request ceiling", () => {
  it("ignores a priced request when no per-request ceiling is configured", () => {
    const g = new ArchitectGuardRuntime();
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 1_000_000, maxOutputTokens: 200_000 },
    });
    expect(d.outcome).toBe("allow");
    if (d.outcome !== "allow") return;
    expect(d.estimate).toBeUndefined();
  });

  it("allows a request under the ceiling and reports its estimate", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 1 } });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 1000 },
    });
    expect(d.outcome).toBe("allow");
    if (d.outcome !== "allow" || d.estimate === undefined) throw new Error("estimate expected");
    expect(d.estimate.kind).toBe("bounded");
  });

  it("blocks a single request estimated over the per-request ceiling", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.01 } });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 200_000 },
    });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/per-request ceiling/);
    expect(d.estimate?.kind).toBe("bounded");
  });

  it("blocks a request that declares no output ceiling (fail closed)", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 1000 } });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 10 },
    });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/no maxTokens/);
  });

  it("an exhausted monthly ceiling is reported ahead of an oversized request", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.0001 } });
    g.recordDollars(TENANT, 200);
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 200_000 },
    });
    expect(d.outcome).toBe("block");
    if (d.outcome !== "block") return;
    expect(d.reason).toMatch(/tenant monthly dollar ceiling/);
  });

  it("a refusal still beats a per-request block", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.0001 } });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      refusal: refusalReq(),
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 200_000 },
    });
    expect(d.outcome).toBe("refuse");
  });

  it("a per-request block beats a bulk confirm", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.0001 } });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      bulk: { deleteRecords: 101 },
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 200_000 },
    });
    expect(d.outcome).toBe("block");
  });
});

describe("ArchitectGuardRuntime.recordActualCost", () => {
  it("charges the tenant the full actual cost, never the estimate", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 10 } });
    g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.1,
      actualDollars: 0.4,
    });
    expect(g.tracker.tenant(TENANT).monthlyDollarsUsed).toBeCloseTo(0.4, 10);
  });

  it("still charges the tenant when no per-request ceiling is configured", () => {
    const g = new ArchitectGuardRuntime();
    const v = g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.1,
      actualDollars: 2,
    });
    expect(v.kind).toBe("within_estimate");
    expect(g.tracker.tenant(TENANT).monthlyDollarsUsed).toBe(2);
  });

  it("an over-estimate inflates the session's next estimate without sealing it", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 10 } });
    const v = g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.1,
      actualDollars: 0.3,
    });
    expect(v.kind).toBe("over_estimate");
    expect(g.tracker.estimateInflation(SESSION)).toBeCloseTo(3, 10);
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: SESSION,
      request: { pricing: PRICING, promptChars: 3500, maxOutputTokens: 1000 },
    });
    expect(d.outcome).toBe("allow");
    if (d.outcome !== "allow" || d.estimate === undefined || d.estimate.kind !== "bounded") {
      throw new Error("bounded estimate expected");
    }
    expect(d.estimate.inflation).toBeCloseTo(3, 10);
    expect(d.estimate.dollars).toBeCloseTo(0.018 * 3, 10);
  });

  it("keeps the worst observed ratio, not the latest", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 10 } });
    g.recordActualCost({ tenantId: TENANT, sessionId: SESSION, estimatedDollars: 1, actualDollars: 4 });
    g.recordActualCost({ tenantId: TENANT, sessionId: SESSION, estimatedDollars: 1, actualDollars: 2 });
    expect(g.tracker.estimateInflation(SESSION)).toBeCloseTo(4, 10);
  });

  it("seals the session when the actual cost broke the per-request ceiling", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.5 } });
    const v = g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.4,
      actualDollars: 0.9,
    });
    expect(v.kind).toBe("over_ceiling");
    const blocked = g.evaluate({ tenantId: TENANT, sessionId: SESSION });
    expect(blocked.outcome).toBe("block");
    if (blocked.outcome !== "block") return;
    expect(blocked.reason).toMatch(/actually cost/);
  });

  it("a sealed session blocks even a request that would otherwise be allowed", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.5 } });
    g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.4,
      actualDollars: 0.9,
    });
    const d = g.evaluate({
      tenantId: TENANT,
      sessionId: "other-session",
      request: { pricing: PRICING, promptChars: 350, maxOutputTokens: 10 },
    });
    expect(d.outcome).toBe("allow");
    expect(
      g.evaluate({
        tenantId: TENANT,
        sessionId: SESSION,
        request: { pricing: PRICING, promptChars: 350, maxOutputTokens: 10 },
      }).outcome,
    ).toBe("block");
  });

  it("a refusal is still reported ahead of a sealed session", () => {
    const g = new ArchitectGuardRuntime({ perRequestCeiling: { maxDollars: 0.5 } });
    g.recordActualCost({
      tenantId: TENANT,
      sessionId: SESSION,
      estimatedDollars: 0.4,
      actualDollars: 0.9,
    });
    expect(
      g.evaluate({ tenantId: TENANT, sessionId: SESSION, refusal: refusalReq() }).outcome,
    ).toBe("refuse");
  });
});
