import { describe, expect, it } from "vitest";
import {
  indexName,
  qualifyTable,
  quoteIdent,
  referenceColumnName,
  toTableName,
} from "./identifiers.js";

describe("quoteIdent", () => {
  it("wraps simple identifiers in double quotes", () => {
    expect(quoteIdent("patient")).toBe(`"patient"`);
  });

  it("preserves snake_case", () => {
    expect(quoteIdent("first_name")).toBe(`"first_name"`);
  });

  it("preserves leading underscore", () => {
    expect(quoteIdent("_internal")).toBe(`"_internal"`);
  });

  it("preserves digits within identifier", () => {
    expect(quoteIdent("col_2026")).toBe(`"col_2026"`);
  });

  it("rejects identifiers starting with a digit", () => {
    expect(() => quoteIdent("1col")).toThrow();
  });

  it("rejects identifiers with hyphens", () => {
    expect(() => quoteIdent("first-name")).toThrow();
  });

  it("rejects identifiers with embedded quotes", () => {
    expect(() => quoteIdent(`a"b`)).toThrow();
  });

  it("rejects identifiers with semicolons", () => {
    expect(() => quoteIdent("a; DROP TABLE x")).toThrow();
  });

  it("rejects identifiers with whitespace", () => {
    expect(() => quoteIdent("two words")).toThrow();
  });

  it("rejects the empty string", () => {
    expect(() => quoteIdent("")).toThrow();
  });
});

describe("toTableName", () => {
  it("lowercases a single-word PascalCase name", () => {
    expect(toTableName("Patient")).toBe("patient");
  });

  it("splits PascalCase into snake_case", () => {
    expect(toTableName("BatchRelease")).toBe("batch_release");
    expect(toTableName("PrescriptionLineItem")).toBe("prescription_line_item");
  });

  it("preserves digits within names", () => {
    expect(toTableName("Patient2026")).toBe("patient2026");
  });

  it("handles acronyms followed by PascalCase", () => {
    expect(toTableName("OOSReport")).toBe("oos_report");
    expect(toTableName("APIToken")).toBe("api_token");
  });

  it("returns lowercase for an all-lowercase input", () => {
    expect(toTableName("patient")).toBe("patient");
  });
});

describe("qualifyTable", () => {
  it("joins schema and table with a dot, both quoted", () => {
    expect(qualifyTable("t_acme", "patient")).toBe(`"t_acme"."patient"`);
  });
});

describe("referenceColumnName", () => {
  it("appends _id to a base name", () => {
    expect(referenceColumnName("patient")).toBe("patient_id");
  });

  it("does not double-append when name already ends in _id", () => {
    expect(referenceColumnName("patient_id")).toBe("patient_id");
  });

  it("appends to single-character names", () => {
    expect(referenceColumnName("a")).toBe("a_id");
  });
});

describe("indexName", () => {
  it("builds a single-column index name", () => {
    expect(indexName("patient", ["email"])).toBe("idx_patient_email");
  });

  it("builds a multi-column index name", () => {
    expect(indexName("prescription", ["status", "written_at"])).toBe(
      "idx_prescription_status_written_at",
    );
  });
});
