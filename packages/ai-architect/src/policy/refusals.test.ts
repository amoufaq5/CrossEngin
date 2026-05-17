import { describe, expect, it } from "vitest";
import {
  evaluateRefusal,
  HARD_REFUSALS,
  HARD_REFUSAL_CITATIONS,
  HardRefusalSchema,
  REFUSAL_AUDIT_RETENTION_YEARS,
  RefusalRequestSchema,
} from "./refusals.js";

const now = "2026-05-13T10:00:00.000Z";

describe("HARD_REFUSALS", () => {
  it("declares the 12 documented refusals", () => {
    expect(HARD_REFUSALS).toHaveLength(12);
    expect(HARD_REFUSALS).toContain("grant_cross_tenant_access");
    expect(HARD_REFUSALS).toContain("ai_architect_self_elevate");
    expect(HARD_REFUSALS).toContain("disable_eval_suite_gate");
  });

  it("HARD_REFUSAL_CITATIONS covers every refusal", () => {
    for (const r of HARD_REFUSALS) {
      expect(HARD_REFUSAL_CITATIONS[r]).toBeTruthy();
    }
  });

  it("HardRefusalSchema rejects unknown values", () => {
    expect(() => HardRefusalSchema.parse("ship_it")).toThrow();
  });
});

describe("RefusalRequestSchema", () => {
  it("parses a CrossEngin-staff-issued attempt", () => {
    expect(() =>
      RefusalRequestSchema.parse({
        refusal: "grant_cross_tenant_access",
        requester: "crossengin_staff",
        tenantId: "t_1",
        attemptedAt: now,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown requester", () => {
    expect(() =>
      RefusalRequestSchema.parse({
        refusal: "grant_cross_tenant_access",
        requester: "marketing",
        tenantId: "t_1",
        attemptedAt: now,
      }),
    ).toThrow();
  });
});

describe("evaluateRefusal", () => {
  it("produces a P0 decision with citation and message", () => {
    const decision = evaluateRefusal({
      refusal: "grant_cross_tenant_access",
      requester: "tenant_admin",
      tenantId: "t_1",
      attemptedAt: now,
    });
    expect(decision.refused).toBe(true);
    expect(decision.auditSeverity).toBe("P0");
    expect(decision.citation).toContain("ADR-0002");
    expect(decision.message).toContain("Granting any form of cross-tenant access");
  });

  it("attaches alternativePath when provided", () => {
    const decision = evaluateRefusal(
      {
        refusal: "reduce_audit_retention_below_pack_minimum",
        requester: "tenant_admin",
        tenantId: "t_1",
        attemptedAt: now,
      },
      { alternative: "Deactivate the 21 CFR Part 11 pack first via its confirmation flow." },
    );
    expect(decision.alternativePath).toContain("Deactivate");
  });

  it("each refusal produces a non-empty subject", () => {
    for (const refusal of HARD_REFUSALS) {
      const decision = evaluateRefusal({
        refusal,
        requester: "ai_architect",
        tenantId: "t_1",
        attemptedAt: now,
      });
      expect(decision.message.length).toBeGreaterThan(10);
    }
  });
});

describe("constants", () => {
  it("REFUSAL_AUDIT_RETENTION_YEARS matches financial audit retention (7y)", () => {
    expect(REFUSAL_AUDIT_RETENTION_YEARS).toBe(7);
  });
});
