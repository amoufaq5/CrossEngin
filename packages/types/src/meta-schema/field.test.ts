import { describe, expect, it } from "vitest";
import {
  DATA_CLASSIFICATIONS,
  FieldSchema,
  fieldClassification,
  isFieldSensitive,
  isSensitiveDataClass,
  requiresAuditTrail,
} from "./field.js";

describe("field data classification", () => {
  it("accepts every declared classification on a field", () => {
    for (const c of DATA_CLASSIFICATIONS) {
      const parsed = FieldSchema.parse({
        name: "x",
        type: { kind: "text", maxLength: 10 },
        classification: c,
      });
      expect(parsed.classification).toBe(c);
    }
  });

  it("rejects an unknown classification", () => {
    const res = FieldSchema.safeParse({
      name: "x",
      type: { kind: "text", maxLength: 10 },
      classification: "top_secret",
    });
    expect(res.success).toBe(false);
  });

  it("treats pii/phi/regulated/commercial_sensitive as sensitive", () => {
    expect(isSensitiveDataClass("phi")).toBe(true);
    expect(isSensitiveDataClass("pii")).toBe(true);
    expect(isSensitiveDataClass("regulated")).toBe(true);
    expect(isSensitiveDataClass("commercial_sensitive")).toBe(true);
    expect(isSensitiveDataClass("internal")).toBe(false);
    expect(isSensitiveDataClass("public")).toBe(false);
  });

  it("requires an audit trail only for phi + regulated", () => {
    expect(requiresAuditTrail("phi")).toBe(true);
    expect(requiresAuditTrail("regulated")).toBe(true);
    expect(requiresAuditTrail("pii")).toBe(false);
    expect(requiresAuditTrail("commercial_sensitive")).toBe(false);
  });

  it("exposes per-field helpers", () => {
    const phi = FieldSchema.parse({ name: "v", type: { kind: "long_text" }, classification: "phi" });
    const plain = FieldSchema.parse({ name: "v", type: { kind: "long_text" } });
    expect(fieldClassification(phi)).toBe("phi");
    expect(fieldClassification(plain)).toBeUndefined();
    expect(isFieldSensitive(phi)).toBe(true);
    expect(isFieldSensitive(plain)).toBe(false);
  });
});

describe("FieldSchema", () => {
  it("parses a minimal field", () => {
    const input = {
      name: "first_name",
      type: { kind: "text", maxLength: 255 },
    };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("parses a field with every option populated", () => {
    const input = {
      name: "patient_id",
      type: { kind: "reference", target: "Patient" },
      required: true,
      default: { kind: "expression", expression: "uuid_generate_v7()" },
      indexed: { kind: "btree" },
      unique: { scope: ["pharmacy_id"] },
      validations: [{ kind: "regex", pattern: "^pat_", message: "must start with pat_" }],
    };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("parses indexed as a bare boolean", () => {
    const input = { name: "name", type: { kind: "text" }, indexed: true };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("parses unique as a bare boolean", () => {
    const input = { name: "email", type: { kind: "email" }, unique: true };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("parses a literal default value", () => {
    const input = {
      name: "status",
      type: { kind: "enum", values: ["draft", "active"] },
      default: { kind: "literal", value: "draft" },
    };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("rejects field with PascalCase name", () => {
    expect(() =>
      FieldSchema.parse({ name: "PatientId", type: { kind: "uuid" } }),
    ).toThrow();
  });

  it("rejects field with camelCase name", () => {
    expect(() =>
      FieldSchema.parse({ name: "patientId", type: { kind: "uuid" } }),
    ).toThrow();
  });

  it("rejects field with leading underscore", () => {
    expect(() =>
      FieldSchema.parse({ name: "_id", type: { kind: "uuid" } }),
    ).toThrow();
  });

  it("rejects field with leading digit", () => {
    expect(() =>
      FieldSchema.parse({ name: "1st_place", type: { kind: "integer" } }),
    ).toThrow();
  });

  it("rejects field with hyphen", () => {
    expect(() =>
      FieldSchema.parse({ name: "first-name", type: { kind: "text" } }),
    ).toThrow();
  });

  it("rejects field with empty name", () => {
    expect(() =>
      FieldSchema.parse({ name: "", type: { kind: "uuid" } }),
    ).toThrow();
  });

  it("rejects unique with empty scope array", () => {
    expect(() =>
      FieldSchema.parse({
        name: "email",
        type: { kind: "email" },
        unique: { scope: [] },
      }),
    ).toThrow();
  });

  it("rejects regex validation with empty pattern", () => {
    expect(() =>
      FieldSchema.parse({
        name: "x",
        type: { kind: "text" },
        validations: [{ kind: "regex", pattern: "" }],
      }),
    ).toThrow();
  });
});
