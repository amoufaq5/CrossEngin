import { describe, expect, it } from "vitest";
import {
  AI_INCIDENT_CLASSES,
  AiIncidentSchema,
  recommendedResponse,
  requiresPublicDisclosure,
  severityFor,
} from "./incidents.js";

const now = "2026-05-13T10:00:00.000Z";

describe("AI_INCIDENT_CLASSES", () => {
  it("declares the six documented classes", () => {
    expect(AI_INCIDENT_CLASSES).toHaveLength(6);
    expect(AI_INCIDENT_CLASSES).toContain("cross_tenant_retrieval_leak");
    expect(AI_INCIDENT_CLASSES).toContain("prompt_injection_bypass");
  });
});

describe("severityFor", () => {
  it("cross_tenant_retrieval_leak is P0", () => {
    expect(severityFor("cross_tenant_retrieval_leak")).toBe("P0");
  });

  it("prompt_injection_bypass + production_eval_regression are P1", () => {
    expect(severityFor("prompt_injection_bypass")).toBe("P1");
    expect(severityFor("production_eval_regression")).toBe("P1");
  });

  it("cost_runaway + refused_op_ui_bypass_attempt are P2", () => {
    expect(severityFor("cost_runaway")).toBe("P2");
    expect(severityFor("refused_op_ui_bypass_attempt")).toBe("P2");
  });

  it("refusal_copy_regression is P3", () => {
    expect(severityFor("refusal_copy_regression")).toBe("P3");
  });
});

describe("recommendedResponse", () => {
  it("each class has a non-empty response", () => {
    for (const c of AI_INCIDENT_CLASSES) {
      expect(recommendedResponse(c).length).toBeGreaterThan(10);
    }
  });
});

describe("requiresPublicDisclosure", () => {
  it("returns true for P0 and P1", () => {
    expect(requiresPublicDisclosure("P0")).toBe(true);
    expect(requiresPublicDisclosure("P1")).toBe(true);
  });

  it("returns false for P2 and P3", () => {
    expect(requiresPublicDisclosure("P2")).toBe(false);
    expect(requiresPublicDisclosure("P3")).toBe(false);
  });
});

describe("AiIncidentSchema", () => {
  it("parses a tenant-leak incident", () => {
    expect(() =>
      AiIncidentSchema.parse({
        id: "ai-i-1",
        class: "cross_tenant_retrieval_leak",
        severity: "P0",
        detectedAt: now,
        containedAt: now,
        resolvedAt: null,
        affectedTenantIds: ["t_1", "t_2"],
        triggeringConversationId: "c_42",
        triggeringEvalCaseId: null,
        notificationStatus: "in_progress",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown class", () => {
    expect(() =>
      AiIncidentSchema.parse({
        id: "ai-i-2",
        class: "made_up_class",
        severity: "P1",
        detectedAt: now,
      }),
    ).toThrow();
  });
});
