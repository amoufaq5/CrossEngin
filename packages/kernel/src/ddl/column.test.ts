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
  it("renders an admitted expression default from its lookup, not from the input", () => {
    expect(emitDefault({ kind: "expression", expression: "uuid_generate_v7()" })).toBe(
      "uuid_generate_v7()",
    );
  });

  it("refuses an expression default outside the admitted set rather than rendering it", () => {
    expect(() =>
      emitDefault({ kind: "expression", expression: "'a'); CREATE TABLE public.pwned(x int); --" }),
    ).toThrow(/not one of the admitted expressions/);
  });

  it("quotes a string literal", () => {
    expect(emitDefault({ kind: "literal", value: "draft" })).toBe("'draft'");
  });

  it("escapes single quotes in a string literal", () => {
    expect(emitDefault({ kind: "literal", value: "it's fine" })).toBe("'it''s fine'");
  });

  it("renders a value carrying a backslash as an E-string, so `\\'` cannot close it under either setting", () => {
    // The payload that executed on PG 16 with standard_conforming_strings off when the literal was
    // only quote-doubled: `'\''` reads there as a one-quote string followed by SQL.
    const payload = "\\'); CREATE TABLE public.pwned_lit(y int); --";
    expect(emitDefault({ kind: "literal", value: payload })).toBe(
      "E'\\\\''); CREATE TABLE public.pwned_lit(y int); --'",
    );
    expect(emitDefault({ kind: "literal", value: "a\\b" })).toBe("E'a\\\\b'");
    expect(emitDefault({ kind: "literal", value: { p: "C:\\x" } })).toBe(`E'{"p":"C:\\\\\\\\x"}'::jsonb`);
  });

  it("leaves a value with no backslash in the plain form, so existing DDL does not move", () => {
    expect(emitDefault({ kind: "literal", value: "it's fine" })).not.toMatch(/^E'/);
    expect(emitDefault({ kind: "literal", value: { a: "b" } })).toBe(`'{"a":"b"}'::jsonb`);
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
