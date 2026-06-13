import { describe, expect, it } from "vitest";

import { evaluateProposalGate } from "./proposal-gate.js";
import { formatProposalGate } from "./summary.js";

describe("formatProposalGate", () => {
  it("renders an allow verdict", () => {
    const out = formatProposalGate(evaluateProposalGate({}));
    expect(out).toContain("allowed");
  });

  it("renders a hard-refusal verdict with its citation", () => {
    const out = formatProposalGate(
      evaluateProposalGate({
        hardRefusal: { request: { refusal: "grant_cross_tenant_access", requester: "ai_architect", tenantId: "t1", attemptedAt: "2026-06-13T00:00:00.000Z" } },
      }),
    );
    expect(out).toContain("REFUSED");
    expect(out).toContain("non-overridable");
    expect(out).toMatch(/see:/);
  });

  it("renders a confirm verdict with reasons", () => {
    const out = formatProposalGate(evaluateProposalGate({ bulkScope: { deleteRecords: 500 } }));
    expect(out).toContain("confirmation");
    expect(out).toMatch(/bulk/);
  });
});
