import { describe, expect, it } from "vitest";

import { evaluateProposalGate } from "./proposal-gate.js";
import { detectHardRefusals, scanProposalRefusalRequest, type ScanManifest } from "./refusal-scan.js";

const CTX = { requester: "ai_architect" as const, tenantId: "t1", attemptedAt: "2026-06-13T00:00:00.000Z" };

// A patient entity carrying a phi field, auditable.
function patient(opts: { auditable: boolean; mrnClass: string | undefined }): ScanManifest {
  return {
    entities: [
      {
        name: "Patient",
        traits: opts.auditable ? [{ name: "auditable" }] : [],
        fields: [
          { name: "name", classification: "pii" },
          ...(opts.mrnClass !== undefined ? [{ name: "mrn", classification: opts.mrnClass as never }] : [{ name: "mrn" }]),
        ],
      },
    ],
  };
}

describe("detectHardRefusals", () => {
  it("finds no refusal for an unchanged manifest", () => {
    const m = patient({ auditable: true, mrnClass: "phi" });
    expect(detectHardRefusals(m, m)).toEqual([]);
  });

  it("detects removing the auditable trait from a pack-bound (phi-carrying) entity", () => {
    const before = patient({ auditable: true, mrnClass: "phi" });
    const after = patient({ auditable: false, mrnClass: "phi" });
    const found = detectHardRefusals(before, after);
    expect(found.map((d) => d.refusal)).toContain("disable_audit_on_pack_bound_entity");
  });

  it("does NOT flag audit removal on an entity with no audit-required field", () => {
    const before: ScanManifest = { entities: [{ name: "Note", traits: [{ name: "auditable" }], fields: [{ name: "body", classification: "internal" }] }] };
    const after: ScanManifest = { entities: [{ name: "Note", traits: [], fields: [{ name: "body", classification: "internal" }] }] };
    expect(detectHardRefusals(before, after)).toEqual([]);
  });

  it("detects downgrading a phi field's encryption below the minimum", () => {
    const before = patient({ auditable: true, mrnClass: "phi" });
    const after = patient({ auditable: true, mrnClass: "pii" }); // pii doesn't require at-rest encryption
    const found = detectHardRefusals(before, after);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ refusal: "weaken_encryption_below_pack_minimum", entity: "Patient", field: "mrn" });
  });

  it("detects dropping a phi field's classification entirely", () => {
    const before = patient({ auditable: true, mrnClass: "regulated" });
    const after = patient({ auditable: true, mrnClass: undefined });
    expect(detectHardRefusals(before, after).map((d) => d.refusal)).toContain("weaken_encryption_below_pack_minimum");
  });

  it("supports string-form traits", () => {
    const before: ScanManifest = { entities: [{ name: "Patient", traits: ["auditable"], fields: [{ name: "mrn", classification: "phi" }] }] };
    const after: ScanManifest = { entities: [{ name: "Patient", traits: [], fields: [{ name: "mrn", classification: "phi" }] }] };
    expect(detectHardRefusals(before, after).map((d) => d.refusal)).toContain("disable_audit_on_pack_bound_entity");
  });
});

describe("scanProposalRefusalRequest + gate", () => {
  it("builds a RefusalRequest the gate refuses (terminal P0)", () => {
    const before = patient({ auditable: true, mrnClass: "phi" });
    const after = patient({ auditable: true, mrnClass: "public" });
    const request = scanProposalRefusalRequest(before, after, CTX);
    expect(request).not.toBeNull();
    expect(request).toMatchObject({ refusal: "weaken_encryption_below_pack_minimum", tenantId: "t1", proposedScope: "Patient.mrn" });

    const decision = evaluateProposalGate({ hardRefusal: { request: request! } });
    expect(decision.decision).toBe("refuse");
    expect(decision.refusal?.auditSeverity).toBe("P0");
  });

  it("returns null when the edit trips no entity/field hard refusal", () => {
    const m = patient({ auditable: true, mrnClass: "phi" });
    expect(scanProposalRefusalRequest(m, m, CTX)).toBeNull();
  });
});
