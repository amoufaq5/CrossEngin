import type { RefusalRequest } from "@crossengin/ai-architect";
import { describe, expect, it } from "vitest";

import { ArchitectGuardRuntime } from "./guard.js";

const TENANT = "tenant-1";
const SESSION = "sess-1";

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
