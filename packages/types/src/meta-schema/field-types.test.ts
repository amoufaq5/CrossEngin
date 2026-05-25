import { describe, expect, it } from "vitest";
import { FieldTypeSchema, PrimitiveFieldTypeSchema } from "./field-types.js";

describe("FieldTypeSchema — primitives", () => {
  it("parses a text field with maxLength", () => {
    const input = { kind: "text", maxLength: 255 };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("parses a text field without maxLength", () => {
    const input = { kind: "text" };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects text field with zero maxLength", () => {
    expect(() => FieldTypeSchema.parse({ kind: "text", maxLength: 0 })).toThrow();
  });

  it("rejects text field with negative maxLength", () => {
    expect(() => FieldTypeSchema.parse({ kind: "text", maxLength: -5 })).toThrow();
  });

  it("parses long_text with no options", () => {
    expect(FieldTypeSchema.parse({ kind: "long_text" })).toEqual({ kind: "long_text" });
  });

  it("parses integer field with min and max", () => {
    const input = { kind: "integer", min: 1, max: 100 };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects integer field where min > max", () => {
    expect(() => FieldTypeSchema.parse({ kind: "integer", min: 10, max: 1 })).toThrow();
  });

  it("rejects integer field with non-integer min", () => {
    expect(() => FieldTypeSchema.parse({ kind: "integer", min: 1.5 })).toThrow();
  });

  it("parses decimal field with precision and scale", () => {
    const input = { kind: "decimal", precision: 10, scale: 2 };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects decimal field where scale > precision", () => {
    expect(() => FieldTypeSchema.parse({ kind: "decimal", precision: 5, scale: 10 })).toThrow();
  });

  it("rejects decimal field where min > max", () => {
    expect(() =>
      FieldTypeSchema.parse({ kind: "decimal", precision: 10, scale: 2, min: 100, max: 1 }),
    ).toThrow();
  });

  it.each(["boolean", "date", "time", "datetime", "duration", "uuid"])(
    "parses a %s field",
    (kind) => {
      expect(FieldTypeSchema.parse({ kind })).toEqual({ kind });
    },
  );
});

describe("FieldTypeSchema — structured", () => {
  it("parses enum with values", () => {
    const input = { kind: "enum", values: ["pending", "done"] };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects enum with empty values", () => {
    expect(() => FieldTypeSchema.parse({ kind: "enum", values: [] })).toThrow();
  });

  it("rejects enum with duplicate values", () => {
    expect(() => FieldTypeSchema.parse({ kind: "enum", values: ["a", "a"] })).toThrow();
  });

  it("rejects enum with empty-string values", () => {
    expect(() => FieldTypeSchema.parse({ kind: "enum", values: [""] })).toThrow();
  });

  it("parses reference with target", () => {
    const input = { kind: "reference", target: "Patient" };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects reference with empty target", () => {
    expect(() => FieldTypeSchema.parse({ kind: "reference", target: "" })).toThrow();
  });

  it("parses array of primitives", () => {
    const input = { kind: "array", element: { kind: "text", maxLength: 50 } };
    expect(FieldTypeSchema.parse(input)).toEqual(input);
  });

  it("rejects array of arrays (v1 limitation)", () => {
    expect(() =>
      FieldTypeSchema.parse({
        kind: "array",
        element: { kind: "array", element: { kind: "boolean" } },
      }),
    ).toThrow();
  });

  it("parses json field", () => {
    expect(FieldTypeSchema.parse({ kind: "json" })).toEqual({ kind: "json" });
  });

  it("parses file field", () => {
    expect(FieldTypeSchema.parse({ kind: "file" })).toEqual({ kind: "file" });
  });
});

describe("FieldTypeSchema — domain", () => {
  it.each([
    "email",
    "phone",
    "url",
    "currency_amount",
    "geo_point",
    "geo_polygon",
    "country_code",
    "language_code",
    "timezone",
  ])("parses a %s field", (kind) => {
    expect(FieldTypeSchema.parse({ kind })).toEqual({ kind });
  });
});

describe("FieldTypeSchema — errors", () => {
  it("rejects unknown field kind", () => {
    expect(() => FieldTypeSchema.parse({ kind: "unknown" })).toThrow();
  });

  it("rejects missing kind", () => {
    expect(() => FieldTypeSchema.parse({})).toThrow();
  });

  it("rejects non-object inputs", () => {
    expect(() => FieldTypeSchema.parse("text")).toThrow();
    expect(() => FieldTypeSchema.parse(null)).toThrow();
    expect(() => FieldTypeSchema.parse(undefined)).toThrow();
  });
});

describe("PrimitiveFieldTypeSchema", () => {
  it("rejects array kind (arrays are not primitives)", () => {
    expect(() =>
      PrimitiveFieldTypeSchema.parse({
        kind: "array",
        element: { kind: "boolean" },
      }),
    ).toThrow();
  });
});
