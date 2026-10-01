import { describe, expect, it } from "vitest";
import {
  TEXT_SEARCHABLE_FIELD_KINDS,
  fieldTypeToPostgresType,
  isTextSearchableFieldKind,
  isTextSearchableFieldType,
} from "./field-type.js";

describe("fieldTypeToPostgresType", () => {
  it("maps text without maxLength to TEXT", () => {
    expect(fieldTypeToPostgresType({ kind: "text" })).toBe("TEXT");
  });

  it("maps text with maxLength to VARCHAR(N)", () => {
    expect(fieldTypeToPostgresType({ kind: "text", maxLength: 255 })).toBe("VARCHAR(255)");
  });

  it("maps long_text to TEXT", () => {
    expect(fieldTypeToPostgresType({ kind: "long_text" })).toBe("TEXT");
  });

  it("maps integer to INTEGER", () => {
    expect(fieldTypeToPostgresType({ kind: "integer" })).toBe("INTEGER");
    expect(fieldTypeToPostgresType({ kind: "integer", min: 0, max: 100 })).toBe("INTEGER");
  });

  it("maps decimal to NUMERIC(p, s)", () => {
    expect(fieldTypeToPostgresType({ kind: "decimal", precision: 10, scale: 2 })).toBe(
      "NUMERIC(10, 2)",
    );
  });

  it("maps boolean to BOOLEAN", () => {
    expect(fieldTypeToPostgresType({ kind: "boolean" })).toBe("BOOLEAN");
  });

  it("maps temporal types", () => {
    expect(fieldTypeToPostgresType({ kind: "date" })).toBe("DATE");
    expect(fieldTypeToPostgresType({ kind: "time" })).toBe("TIME");
    expect(fieldTypeToPostgresType({ kind: "datetime" })).toBe("TIMESTAMPTZ");
    expect(fieldTypeToPostgresType({ kind: "duration" })).toBe("INTERVAL");
  });

  it("maps uuid to UUID", () => {
    expect(fieldTypeToPostgresType({ kind: "uuid" })).toBe("UUID");
  });

  it("maps enum to TEXT (CHECK constraint is emitted separately)", () => {
    expect(fieldTypeToPostgresType({ kind: "enum", values: ["a", "b"] })).toBe("TEXT");
  });

  it("maps reference to UUID (FK constraint is emitted separately)", () => {
    expect(fieldTypeToPostgresType({ kind: "reference", target: "Patient" })).toBe("UUID");
  });

  it("maps array<integer> to INTEGER[]", () => {
    expect(
      fieldTypeToPostgresType({ kind: "array", element: { kind: "integer" } }),
    ).toBe("INTEGER[]");
  });

  it("maps array<text(50)> to VARCHAR(50)[]", () => {
    expect(
      fieldTypeToPostgresType({
        kind: "array",
        element: { kind: "text", maxLength: 50 },
      }),
    ).toBe("VARCHAR(50)[]");
  });

  it("maps json and file to JSONB", () => {
    expect(fieldTypeToPostgresType({ kind: "json" })).toBe("JSONB");
    expect(fieldTypeToPostgresType({ kind: "file" })).toBe("JSONB");
  });

  it("maps domain types", () => {
    expect(fieldTypeToPostgresType({ kind: "email" })).toBe("VARCHAR(320)");
    expect(fieldTypeToPostgresType({ kind: "phone" })).toBe("VARCHAR(32)");
    expect(fieldTypeToPostgresType({ kind: "url" })).toBe("TEXT");
    expect(fieldTypeToPostgresType({ kind: "currency_amount" })).toBe("JSONB");
    expect(fieldTypeToPostgresType({ kind: "country_code" })).toBe("CHAR(2)");
    expect(fieldTypeToPostgresType({ kind: "language_code" })).toBe("VARCHAR(20)");
    expect(fieldTypeToPostgresType({ kind: "timezone" })).toBe("VARCHAR(50)");
  });

  it("maps geo types to PostGIS geography", () => {
    expect(fieldTypeToPostgresType({ kind: "geo_point" })).toBe("geography(POINT)");
    expect(fieldTypeToPostgresType({ kind: "geo_polygon" })).toBe("geography(POLYGON)");
  });
});

describe("TEXT_SEARCHABLE_FIELD_KINDS", () => {
  it("names exactly the six free-text kinds", () => {
    expect([...TEXT_SEARCHABLE_FIELD_KINDS].sort()).toEqual([
      "email",
      "long_text",
      "phone",
      "slug",
      "text",
      "url",
    ]);
  });

  it("excludes enum and reference, which also map to TEXT", () => {
    // Both emit a TEXT column, and neither holds prose: an enum is matched by
    // equality against a closed set and a reference against an id. The two facts
    // are separate on purpose — a trigram index derived from the SQL type alone
    // indexed 149 columns no query could use (ADR-0285).
    expect(fieldTypeToPostgresType({ kind: "enum", values: ["a"] })).toBe("TEXT");
    expect(TEXT_SEARCHABLE_FIELD_KINDS.has("enum")).toBe(false);
    expect(TEXT_SEARCHABLE_FIELD_KINDS.has("reference")).toBe(false);
  });

  it("excludes the fixed-width and structured kinds", () => {
    for (const k of ["country_code", "language_code", "timezone", "json", "uuid", "integer", "datetime"]) {
      expect(TEXT_SEARCHABLE_FIELD_KINDS.has(k)).toBe(false);
    }
  });
});

describe("isTextSearchableFieldKind", () => {
  it("accepts a free-text kind", () => {
    expect(isTextSearchableFieldKind("long_text")).toBe(true);
  });

  it("rejects an unknown kind and undefined, rather than throwing", () => {
    expect(isTextSearchableFieldKind("not_a_kind")).toBe(false);
    expect(isTextSearchableFieldKind(undefined)).toBe(false);
  });
});

describe("isTextSearchableFieldType", () => {
  it("accepts a text field type", () => {
    expect(isTextSearchableFieldType({ kind: "text", maxLength: 80 })).toBe(true);
  });

  it("rejects an array of text: its column is TEXT[], which no text predicate accepts", () => {
    expect(isTextSearchableFieldType({ kind: "array", element: { kind: "text" } })).toBe(false);
    expect(fieldTypeToPostgresType({ kind: "array", element: { kind: "text" } })).toBe("TEXT[]");
  });

  it("rejects enum and reference", () => {
    expect(isTextSearchableFieldType({ kind: "enum", values: ["a", "b"] })).toBe(false);
    expect(isTextSearchableFieldType({ kind: "reference", target: "X" })).toBe(false);
  });
});
