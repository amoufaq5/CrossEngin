import { describe, expect, it } from "vitest";
import { EntityClassificationSchema, fieldClassMap, resolveFieldClass } from "./classification.js";

describe("EntityClassificationSchema", () => {
  it("parses a classification with explicit field overrides", () => {
    const c = EntityClassificationSchema.parse({
      entity: "Patient",
      defaultDataClass: "phi",
      fields: [
        { field: "internal_id", dataClass: "internal" },
        { field: "tax_id", dataClass: "regulated", rationale: "tax authority requirement" },
      ],
    });
    expect(c.fields).toHaveLength(2);
  });

  it("rejects duplicate field entries", () => {
    expect(() =>
      EntityClassificationSchema.parse({
        entity: "Patient",
        defaultDataClass: "phi",
        fields: [
          { field: "ssn", dataClass: "phi" },
          { field: "ssn", dataClass: "pii" },
        ],
      }),
    ).toThrow(/duplicate field/);
  });

  it("rejects non-PascalCase entity names", () => {
    expect(() =>
      EntityClassificationSchema.parse({
        entity: "patient",
        defaultDataClass: "phi",
      }),
    ).toThrow();
  });

  it("rejects unknown data class values", () => {
    expect(() =>
      EntityClassificationSchema.parse({
        entity: "Patient",
        defaultDataClass: "top-secret",
      }),
    ).toThrow();
  });
});

describe("resolveFieldClass", () => {
  const classification = EntityClassificationSchema.parse({
    entity: "Patient",
    defaultDataClass: "phi",
    fields: [{ field: "audit_note", dataClass: "internal" }],
  });

  it("returns the explicit field class when set", () => {
    const r = resolveFieldClass(classification, "audit_note");
    expect(r.dataClass).toBe("internal");
    expect(r.inherited).toBe(false);
  });

  it("falls back to the entity default when no explicit class", () => {
    const r = resolveFieldClass(classification, "diagnosis");
    expect(r.dataClass).toBe("phi");
    expect(r.inherited).toBe(true);
  });
});

describe("fieldClassMap", () => {
  it("returns a record over the requested fields", () => {
    const c = EntityClassificationSchema.parse({
      entity: "Patient",
      defaultDataClass: "phi",
      fields: [{ field: "audit_note", dataClass: "internal" }],
    });
    const map = fieldClassMap(c, ["audit_note", "diagnosis"]);
    expect(map).toEqual({ audit_note: "internal", diagnosis: "phi" });
  });
});
