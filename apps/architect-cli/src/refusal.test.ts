import { describe, expect, it } from "vitest";

import { ManifestSchema, type Manifest } from "@crossengin/kernel/manifest";

import { classifyManifestEditRefusal, manifestEditRefusalResult } from "./refusal.js";

interface FieldSpec {
  readonly name: string;
  readonly classification?: string;
}

interface EntitySpec {
  readonly name: string;
  readonly auditable?: boolean;
  readonly fields?: readonly FieldSpec[];
}

function manifest(opts: {
  readonly slug?: string;
  readonly compliancePacks?: readonly string[];
  readonly extendsPacks?: readonly string[];
  readonly entities?: readonly EntitySpec[];
}): Manifest {
  return ManifestSchema.parse({
    manifestVersion: "1.0",
    meta: {
      name: "Fixture",
      slug: opts.slug ?? "fixture-pack",
      version: "1.0.0",
      ...(opts.compliancePacks !== undefined ? { compliancePacks: opts.compliancePacks } : {}),
      ...(opts.extendsPacks !== undefined ? { extends: opts.extendsPacks } : {}),
    },
    entities: (opts.entities ?? []).map((e) => ({
      name: e.name,
      ...(e.auditable === true ? { traits: ["auditable"] } : {}),
      fields: (e.fields ?? [{ name: "label" }]).map((f) => ({
        name: f.name,
        type: { kind: "text", maxLength: 64 },
        ...(f.classification !== undefined ? { classification: f.classification } : {}),
      })),
    })),
  });
}

describe("classifyManifestEditRefusal — audit disable", () => {
  it("refuses removing the auditable trait from a pack-bound entity", () => {
    const before = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: true }],
    });
    const after = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: false }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBe("disable_audit_on_pack_bound_entity");
  });

  it("fires when the manifest is pack-bound via meta.extends", () => {
    const before = manifest({
      extendsPacks: ["operate-erp/core"],
      entities: [{ name: "Patient", auditable: true }],
    });
    const after = manifest({
      extendsPacks: ["operate-erp/core"],
      entities: [{ name: "Patient", auditable: false }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBe("disable_audit_on_pack_bound_entity");
  });

  it("allows removing auditable when the manifest is not pack-bound", () => {
    const before = manifest({ entities: [{ name: "Note", auditable: true }] });
    const after = manifest({ entities: [{ name: "Note", auditable: false }] });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });

  it("does not fire when the entity is removed entirely (not an audit downgrade)", () => {
    const before = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: true }],
    });
    const after = manifest({ compliancePacks: ["hipaa"], entities: [] });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });

  it("allows keeping auditable in place", () => {
    const before = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: true }],
    });
    const after = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: true, fields: [{ name: "extra" }, { name: "label" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });
});

describe("classifyManifestEditRefusal — encryption weakening", () => {
  it("refuses downgrading a phi field to a lower classification", () => {
    const before = manifest({
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "phi" }] }],
    });
    const after = manifest({
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "pii" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBe("weaken_encryption_below_pack_minimum");
  });

  it("refuses dropping the classification off a regulated field", () => {
    const before = manifest({
      entities: [{ name: "Ledger", fields: [{ name: "ssn", classification: "regulated" }] }],
    });
    const after = manifest({
      entities: [{ name: "Ledger", fields: [{ name: "ssn" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBe("weaken_encryption_below_pack_minimum");
  });

  it("allows keeping phi classification", () => {
    const before = manifest({
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "phi" }] }],
    });
    const after = manifest({
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "regulated" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });

  it("does not fire when a phi field is removed entirely", () => {
    const before = manifest({
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "phi" }, { name: "label" }] }],
    });
    const after = manifest({
      entities: [{ name: "Patient", fields: [{ name: "label" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });

  it("allows raising a non-sensitive field to phi", () => {
    const before = manifest({
      entities: [{ name: "Patient", fields: [{ name: "note" }] }],
    });
    const after = manifest({
      entities: [{ name: "Patient", fields: [{ name: "note", classification: "phi" }] }],
    });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });
});

describe("classifyManifestEditRefusal — new manifests + benign edits", () => {
  it("returns null when there is no current manifest (nothing to remove)", () => {
    const after = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", fields: [{ name: "mrn", classification: "phi" }] }],
    });
    expect(classifyManifestEditRefusal(null, after)).toBeNull();
  });

  it("returns null for an unrelated additive edit", () => {
    const before = manifest({
      compliancePacks: ["hipaa"],
      entities: [{ name: "Patient", auditable: true, fields: [{ name: "mrn", classification: "phi" }] }],
    });
    const after = manifest({
      compliancePacks: ["hipaa"],
      entities: [
        { name: "Patient", auditable: true, fields: [{ name: "mrn", classification: "phi" }] },
        { name: "Encounter", auditable: true },
      ],
    });
    expect(classifyManifestEditRefusal(before, after)).toBeNull();
  });
});

describe("manifestEditRefusalResult", () => {
  it("builds a P0 refusal envelope with the canonical citation", () => {
    const result = manifestEditRefusalResult("disable_audit_on_pack_bound_entity");
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("refused");
    expect(result.refusal).toBe("disable_audit_on_pack_bound_entity");
    expect(result.auditSeverity).toBe("P0");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.citation).toContain("21-cfr-part-11");
  });
});
