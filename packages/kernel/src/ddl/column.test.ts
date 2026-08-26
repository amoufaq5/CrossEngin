import { describe, expect, it } from "vitest";
import { columnNameForField, emitDefault } from "./column.js";


describe("columnNameForField", () => {
  it("uses the field name for non-references", () => {
    expect(columnNameForField({ name: "first_name", type: { kind: "text" } })).toBe("first_name");
  });

  it("appends _id for references", () => {
    expect(
      columnNameForField({ name: "patient", type: { kind: "reference", target: "Patient" } }),
    ).toBe("patient_id");
  });

  it("does not double-append _id for reference fields already ending in _id", () => {
    expect(
      columnNameForField({ name: "patient_id", type: { kind: "reference", target: "Patient" } }),
    ).toBe("patient_id");
  });
});

describe("emitDefault", () => {
  it("returns an expression default verbatim", () => {
    expect(emitDefault({ kind: "expression", expression: "uuid_generate_v7()" })).toBe(
      "uuid_generate_v7()",
    );
  });

  it("quotes a string literal", () => {
    expect(emitDefault({ kind: "literal", value: "draft" })).toBe("'draft'");
  });

  it("escapes single quotes in a string literal", () => {
    expect(emitDefault({ kind: "literal", value: "it's fine" })).toBe("'it''s fine'");
  });

  it("renders booleans as TRUE / FALSE", () => {
    expect(emitDefault({ kind: "literal", value: true })).toBe("TRUE");
    expect(emitDefault({ kind: "literal", value: false })).toBe("FALSE");
  });

  it("renders a number bare", () => {
    expect(emitDefault({ kind: "literal", value: 1 })).toBe("1");
    expect(emitDefault({ kind: "literal", value: -2.5 })).toBe("-2.5");
  });

  it("renders a null literal as NULL", () => {
    expect(emitDefault({ kind: "literal", value: null })).toBe("NULL");
  });

  it("renders an object literal as escaped jsonb", () => {
    expect(emitDefault({ kind: "literal", value: { a: 1 } })).toBe(`'{"a":1}'::jsonb`);
  });

  it("returns null for a sequence default, which the serving runtime allocates", () => {
    expect(emitDefault({ kind: "sequence", sequence: "inv" })).toBeNull();
  });

  it("rejects a non-finite number rather than emitting invalid SQL", () => {
    expect(() => emitDefault({ kind: "literal", value: Number.NaN })).toThrow(
      /unsupported numeric literal/,
    );
  });
});
