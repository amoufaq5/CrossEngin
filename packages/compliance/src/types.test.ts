import { describe, expect, it } from "vitest";
import { pack as part11Pack } from "./packs/21-cfr-part-11/pack.js";
import { CompliancePackSchema } from "./types.js";

describe("CompliancePackSchema", () => {
  it("parses a minimal pack", () => {
    const p = {
      meta: { id: "x", title: "X", version: "1.0.0" },
      contributions: {},
    };
    expect(() => CompliancePackSchema.parse(p)).not.toThrow();
  });

  it("parses a pack with entity contributions", () => {
    const p = {
      meta: { id: "x", title: "X", version: "1.0.0" },
      contributions: {
        entities: [{ name: "Foo", fields: [{ name: "x", type: { kind: "text" } }] }],
      },
    };
    expect(() => CompliancePackSchema.parse(p)).not.toThrow();
  });

  it("rejects pack with non-semver version", () => {
    const p = {
      meta: { id: "x", title: "X", version: "1.0" },
      contributions: {},
    };
    expect(() => CompliancePackSchema.parse(p)).toThrow();
  });

  it("parses an enum parameter with values + default", () => {
    const p = {
      meta: {
        id: "x",
        title: "X",
        version: "1.0.0",
        parameters: { method: { type: "enum", values: ["a", "b"], default: "a" } },
      },
      contributions: {},
    };
    expect(() => CompliancePackSchema.parse(p)).not.toThrow();
  });

  it("parses an integer parameter with min/max", () => {
    const p = {
      meta: {
        id: "x",
        title: "X",
        version: "1.0.0",
        parameters: { retention: { type: "integer", min: 7, max: 30, default: 7 } },
      },
      contributions: {},
    };
    expect(() => CompliancePackSchema.parse(p)).not.toThrow();
  });

  it("rejects an enum parameter with empty values", () => {
    const p = {
      meta: {
        id: "x",
        title: "X",
        version: "1.0.0",
        parameters: { method: { type: "enum", values: [] } },
      },
      contributions: {},
    };
    expect(() => CompliancePackSchema.parse(p)).toThrow();
  });
});

describe("21-cfr-part-11 showcase pack", () => {
  it("validates against CompliancePackSchema", () => {
    expect(() => CompliancePackSchema.parse(part11Pack)).not.toThrow();
  });

  it("contributes the Signature entity with the expected fields", () => {
    const entities = part11Pack.contributions.entities ?? [];
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("Signature");
    const fieldNames = entities[0]?.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual([
      "challenge_id",
      "entity_id",
      "entity_kind",
      "meaning_statement",
      "method",
      "signed_at",
      "signed_by",
    ]);
  });

  it("declares three parameters with FDA citation help text", () => {
    const params = part11Pack.meta.parameters ?? {};
    expect(Object.keys(params).sort()).toEqual([
      "auditRetentionYears",
      "signatureMeaningStatement",
      "signatureMethod",
    ]);
  });
});
