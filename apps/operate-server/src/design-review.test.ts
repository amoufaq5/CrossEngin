import { describe, expect, it } from "vitest";

import { DESIGN_EXAMPLE_MANIFEST } from "./ai-design.js";
import {
  REVIEW_STATUSES,
  RISK_LEVELS,
  assessManifestRisk,
  canTransitionReview,
  type ManifestRiskReport,
  type ReviewStatus,
  type RiskCode,
} from "./design-review.js";

const LEGAL_TRANSITIONS: readonly (readonly [ReviewStatus, ReviewStatus])[] = [
  ["pending", "approved"],
  ["pending", "rejected"],
  ["approved", "rejected"],
  ["rejected", "pending"],
  ["not_required", "pending"],
];

/**
 * A fixture as a manifest that parses, which is what `assessManifestRisk` resolves traits over
 * (ADR-0470). The defensive-input tests below pass unparseable input on purpose and do not use this.
 */
function asManifest(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "test/fixture", version: "0.1.0" },
    ...doc,
  };
}

function codes(report: ManifestRiskReport): readonly RiskCode[] {
  return report.findings.map((f) => f.code);
}

function entity(
  name: string,
  fields: readonly { name: string; classification?: string }[],
  traits: readonly string[] = ["auditable"],
): Record<string, unknown> {
  return {
    name,
    traits,
    fields: fields.map((f) => ({
      name: f.name,
      type: { kind: "text" },
      ...(f.classification === undefined ? {} : { classification: f.classification }),
    })),
  };
}

function roles(...names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = { name, description: name };
  return out;
}

describe("design review constants", () => {
  it("declares the four review states and three risk levels in order", () => {
    expect(REVIEW_STATUSES).toEqual(["not_required", "pending", "approved", "rejected"]);
    expect(RISK_LEVELS).toEqual(["low", "medium", "high"]);
  });
});

describe("canTransitionReview", () => {
  it("allows exactly the five legal transitions", () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransitionReview(from, to)).toBe(true);
    }
  });

  it("rejects every pair outside the legal set across the full 4x4 matrix", () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    let checked = 0;
    for (const from of REVIEW_STATUSES) {
      for (const to of REVIEW_STATUSES) {
        checked += 1;
        expect(canTransitionReview(from, to)).toBe(legal.has(`${from}->${to}`));
      }
    }
    expect(checked).toBe(16);
  });

  it("does not let an approved proposal return to pending", () => {
    expect(canTransitionReview("approved", "pending")).toBe(false);
    expect(canTransitionReview("approved", "not_required")).toBe(false);
  });

  it("does not let not_required skip straight to a verdict", () => {
    expect(canTransitionReview("not_required", "approved")).toBe(false);
    expect(canTransitionReview("not_required", "rejected")).toBe(false);
  });
});

describe("assessManifestRisk — DESIGN_EXAMPLE_MANIFEST", () => {
  it("counts entities, fields, roles, relations and sensitive fields", () => {
    const report = assessManifestRisk(DESIGN_EXAMPLE_MANIFEST);
    // 14 and not 6: both entities carry `auditable`, whose four fields are columns of the served
    // table, and the count is over the fields the table has (ADR-0470). 6 was the own-field count.
    expect(report.counts).toEqual({
      entities: 2,
      fields: 14,
      roles: 2,
      relations: 1,
      sensitiveFields: 2,
    });
  });

  it("flags only the pii field and stays at medium", () => {
    const report = assessManifestRisk(DESIGN_EXAMPLE_MANIFEST);
    expect(codes(report)).toEqual(["pii_data"]);
    expect(report.level).toBe("medium");
    expect(report.findings[0]?.entities).toEqual(["Customer"]);
  });
});

describe("assessManifestRisk — classification", () => {
  it("raises regulated_data to high", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Filing", [{ name: "tax_id", classification: "regulated" }])],
      roles: roles("admin"),
      permissions: { Filing: { read: { roles: ["admin"] } } },
    }));
    expect(codes(report)).toContain("regulated_data");
    expect(report.level).toBe("high");
    expect(report.counts.sensitiveFields).toBe(1);
  });

  it("raises phi_data to high without unaudited_sensitive on an auditable entity", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Chart", [{ name: "diagnosis", classification: "phi" }])],
      roles: roles("clinician"),
      permissions: { Chart: { read: { roles: ["clinician"] } } },
    }));
    expect(codes(report)).toEqual(["phi_data"]);
    expect(report.level).toBe("high");
  });

  it("flags phi on a non-auditable entity as unaudited_sensitive", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Chart", [{ name: "diagnosis", classification: "phi" }], [])],
      roles: roles("clinician"),
      permissions: { Chart: { read: { roles: ["clinician"] } } },
    }));
    expect(codes(report)).toEqual(["phi_data", "unaudited_sensitive"]);
    expect(report.findings.find((f) => f.code === "unaudited_sensitive")?.entities).toEqual([
      "Chart",
    ]);
  });

  it("counts commercial_sensitive toward sensitiveFields without emitting a finding", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Sku", [{ name: "unit_cost", classification: "commercial_sensitive" }])],
      roles: roles("admin"),
      permissions: { Sku: { read: { roles: ["admin"] } } },
    }));
    expect(report.counts.sensitiveFields).toBe(1);
    expect(codes(report)).toEqual([]);
    expect(report.level).toBe("low");
  });
});

describe("assessManifestRisk — governance", () => {
  it("flags an entity with no permissions entry as high", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }]), entity("Ghost", [{ name: "note" }])],
      roles: roles("admin"),
      permissions: { Order: { read: { roles: ["admin"] } } },
    }));
    const finding = report.findings.find((f) => f.code === "no_permissions");
    expect(finding?.level).toBe("high");
    expect(finding?.entities).toEqual(["Ghost"]);
    expect(report.level).toBe("high");
  });

  it("flags every entity when permissions is missing entirely", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("A", [{ name: "x" }]), entity("B", [{ name: "y" }])],
    }));
    expect(report.findings.find((f) => f.code === "no_permissions")?.entities).toEqual(["A", "B"]);
  });

  it("flags a delete grant to three roles", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("a", "b", "c"),
      permissions: { Order: { delete: { roles: ["a", "b", "c"] } } },
    }));
    expect(codes(report)).toEqual(["broad_delete_grant"]);
    expect(report.level).toBe("medium");
  });

  it("does not flag a delete grant to two roles", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("a", "b"),
      permissions: { Order: { delete: { roles: ["a", "b"] } } },
    }));
    expect(codes(report)).toEqual([]);
  });

  it("flags create+update+delete granted to every declared role", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("a", "b"),
      permissions: {
        Order: {
          create: { roles: ["a", "b"] },
          update: { roles: ["a", "b"] },
          delete: { roles: ["a", "b"] },
        },
      },
    }));
    expect(codes(report)).toEqual(["broad_write_grant"]);
    expect(report.findings[0]?.entities).toEqual(["Order"]);
  });

  it("does not flag a write grant that omits one role", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("a", "b"),
      permissions: {
        Order: {
          create: { roles: ["a", "b"] },
          update: { roles: ["a"] },
          delete: { roles: ["a", "b"] },
        },
      },
    }));
    expect(codes(report)).toEqual([]);
  });

  it("flags a declared role that is granted nothing as low", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("admin", "ghost"),
      permissions: { Order: { read: { roles: ["admin"] }, delete: { roles: ["admin"] } } },
    }));
    expect(codes(report)).toEqual(["unreferenced_role"]);
    expect(report.level).toBe("low");
    expect(report.findings[0]?.entities).toEqual([]);
  });

  it("treats a role granted only via a transition as referenced", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("admin", "approver"),
      permissions: {
        Order: { read: { roles: ["admin"] }, transitions: { submit: { roles: ["approver"] } } },
      },
    }));
    expect(codes(report)).toEqual([]);
  });

  it("treats a role granted only via a field permission as referenced", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("admin", "auditor"),
      permissions: {
        Order: { read: { roles: ["admin"] }, fields: { total: { read: { roles: ["auditor"] } } } },
      },
    }));
    expect(codes(report)).toEqual([]);
  });
});

describe("assessManifestRisk — surface size", () => {
  function surface(entityCount: number, fieldsPer: number): Record<string, unknown> {
    const entities: Record<string, unknown>[] = [];
    const permissions: Record<string, unknown> = {};
    for (let i = 0; i < entityCount; i++) {
      const name = `E${i.toString()}`;
      entities.push(
        entity(
          name,
          Array.from({ length: fieldsPer }, (_, j) => ({ name: `f${j.toString()}` })),
        ),
      );
      permissions[name] = {};
    }
    return asManifest({ entities, permissions });
  }

  it("flags more than 25 entities", () => {
    const report = assessManifestRisk(surface(26, 1));
    expect(codes(report)).toEqual(["large_surface"]);
    expect(report.level).toBe("medium");
    expect(report.counts.entities).toBe(26);
  });

  it("does not flag exactly 25 entities", () => {
    const report = assessManifestRisk(surface(25, 1));
    expect(codes(report)).toEqual([]);
  });

  it("flags more than 300 total fields", () => {
    const report = assessManifestRisk(surface(2, 151));
    expect(codes(report)).toEqual(["large_surface"]);
    // 302 own fields plus two `auditable` entities' four trait fields each (ADR-0470).
    expect(report.counts.fields).toBe(310);
    expect(report.findings[0]?.entities).toEqual([]);
  });
});

describe("assessManifestRisk — ordering and level", () => {
  const mixed: Record<string, unknown> = asManifest({
    entities: [
      entity("Patient", [
        { name: "mrn", classification: "phi" },
        { name: "email", classification: "pii" },
      ]),
    ],
    roles: roles("clinician", "ghost"),
    permissions: { Patient: { read: { roles: ["clinician"] } } },
  });

  it("orders findings high then medium then low", () => {
    expect(codes(assessManifestRisk(mixed))).toEqual(["phi_data", "pii_data", "unreferenced_role"]);
  });

  it("reports the worst finding level", () => {
    expect(assessManifestRisk(mixed).level).toBe("high");
  });

  it("keeps emission order stable within a level", () => {
    const report = assessManifestRisk(asManifest({
      entities: [
        entity("Filing", [{ name: "tax_id", classification: "regulated" }]),
        entity("Chart", [{ name: "diagnosis", classification: "phi" }]),
        entity("Ghost", [{ name: "note" }]),
      ],
      roles: roles("admin"),
      permissions: {
        Filing: { read: { roles: ["admin"] } },
        Chart: { read: { roles: ["admin"] } },
      },
    }));
    expect(codes(report)).toEqual(["regulated_data", "phi_data", "no_permissions"]);
    expect(report.findings.every((f) => f.level === "high")).toBe(true);
  });

  it("reports low with no findings for a clean manifest", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: roles("admin"),
      permissions: { Order: { read: { roles: ["admin"] } } },
    }));
    expect(report.findings).toEqual([]);
    expect(report.level).toBe("low");
  });

  it("gives every finding a non-empty actionable message", () => {
    for (const finding of assessManifestRisk(mixed).findings) {
      expect(finding.message.length).toBeGreaterThan(20);
      expect(finding.message.endsWith(".")).toBe(true);
    }
  });
});

describe("assessManifestRisk — defensive input", () => {
  it("treats an empty object as an empty manifest with zero counts", () => {
    const report = assessManifestRisk({});
    // Unparseable input says so, and at high, so it never reads low (ADR-0470).
    expect(codes(report)).toEqual(["classification_unresolved", "empty_manifest"]);
    expect(report.level).toBe("high");
    expect(report.counts).toEqual({
      entities: 0,
      fields: 0,
      roles: 0,
      relations: 0,
      sensitiveFields: 0,
    });
  });

  it("does not throw on a non-object entities value", () => {
    const report = assessManifestRisk({ entities: "nonsense" });
    expect(codes(report)).toEqual(["classification_unresolved", "empty_manifest"]);
    expect(report.counts.entities).toBe(0);
  });

  it("does not throw on null-ish or wrongly typed members", () => {
    const report = assessManifestRisk({
      entities: [null, 7, { name: "Ok", fields: null, traits: "auditable" }],
      roles: null,
      relations: 42,
      permissions: [],
    } as unknown as Record<string, unknown>);
    expect(report.counts.entities).toBe(3);
    expect(report.counts.fields).toBe(0);
    expect(report.counts.roles).toBe(0);
    expect(report.counts.relations).toBe(0);
    expect(codes(report)).toEqual(["classification_unresolved", "no_permissions"]);
  });

  it("does not throw when the whole manifest is null-ish", () => {
    const report = assessManifestRisk(null as unknown as Record<string, unknown>);
    expect(codes(report)).toEqual(["classification_unresolved", "empty_manifest"]);
  });
});

describe("assessManifestRisk — record-keyed shapes", () => {
  // A record-keyed `entities` is not a manifest — the schema is array-shaped — so it is assessed over
  // its own fields with the unresolved finding, where the parsing array form is assessed over the
  // served table's fields (ADR-0470). They used to be asserted identical, which they no longer are.
  it("assesses record-keyed entities over their own fields, flagged as unresolved", () => {
    const arrayShaped = assessManifestRisk(asManifest({
      entities: [
        entity("Customer", [
          { name: "display_name" },
          { name: "contact_email", classification: "pii" },
        ]),
      ],
      roles: roles("admin"),
      permissions: { Customer: { read: { roles: ["admin"] } } },
    }));
    const recordShaped = assessManifestRisk(asManifest({
      entities: {
        Customer: {
          traits: ["auditable"],
          fields: {
            display_name: { type: { kind: "text" } },
            contact_email: { type: { kind: "email" }, classification: "pii" },
          },
        },
      },
      roles: roles("admin"),
      permissions: { Customer: { read: { roles: ["admin"] } } },
    }));
    expect(recordShaped.counts.fields).toBe(2);
    expect(arrayShaped.counts.fields).toBe(6);
    expect(codes(arrayShaped)).toEqual(["pii_data"]);
    expect(codes(recordShaped)).toEqual(["classification_unresolved", "pii_data"]);
    expect(recordShaped.level).toBe("high");
    expect(recordShaped.counts.sensitiveFields).toBe(arrayShaped.counts.sensitiveFields);
  });

  it("counts array-shaped roles and relations", () => {
    const report = assessManifestRisk(asManifest({
      entities: [entity("Order", [{ name: "total" }])],
      roles: [{ name: "admin" }, { name: "ghost" }],
      relations: [{ kind: "many_to_one", from: "Order", to: "Order" }],
      permissions: { Order: { read: { roles: ["admin"] } } },
    }));
    expect(report.counts.roles).toBe(2);
    expect(report.counts.relations).toBe(1);
    // Array-shaped roles are not a manifest either, so this is the raw path.
    expect(codes(report)).toEqual(["classification_unresolved", "unreferenced_role"]);
  });
});

describe("assessManifestRisk — trait-carried classification (ADR-0470)", () => {
  // A trait field reaches the served table as a column exactly as an own field does, so a PHI field
  // declared on a custom trait is PHI. Counted over `entity.fields`, this manifest read `low` with
  // zero sensitive fields while its entity spelling read `high` (ADR-0361's reviewer-gate member).
  function withTraitPhi(): Record<string, unknown> {
    return asManifest({
      traits: [
        {
          name: "clinical",
          fields: [{ name: "diagnosis", type: { kind: "text" }, classification: "phi" }],
        },
      ],
      entities: [{ ...entity("Visit", [{ name: "notes" }]), traits: ["auditable", "clinical"] }],
      roles: roles("clinician"),
      permissions: { Visit: { read: { roles: ["clinician"] } } },
    });
  }

  it("raises trait-carried phi to high and counts it as sensitive", () => {
    const report = assessManifestRisk(withTraitPhi());
    expect(codes(report)).toContain("phi_data");
    expect(report.level).toBe("high");
    expect(report.counts.sensitiveFields).toBe(1);
    expect(codes(report)).not.toContain("classification_unresolved");
  });

  it("leaves the entity-declared control unchanged", () => {
    const report = assessManifestRisk(
      asManifest({
        entities: [entity("Visit", [{ name: "notes" }, { name: "diagnosis", classification: "phi" }])],
        roles: roles("clinician"),
        permissions: { Visit: { read: { roles: ["clinician"] } } },
      }),
    );
    expect(codes(report)).toContain("phi_data");
    expect(report.level).toBe("high");
    expect(report.counts.sensitiveFields).toBe(1);
  });
});
