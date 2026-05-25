import { describe, expect, it } from "vitest";
import { fieldTypeToPostgresType } from "./field-type.js";

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
    expect(fieldTypeToPostgresType({ kind: "array", element: { kind: "integer" } })).toBe(
      "INTEGER[]",
    );
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
