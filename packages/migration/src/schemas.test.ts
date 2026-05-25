import { describe, expect, it } from "vitest";
import {
  INFERRED_TYPES,
  InferredColumnSchema,
  InferredSchemaSchema,
  SEMANTIC_HINTS,
  columnConfidence,
  consolidateTypes,
  inferTypeFromSample,
  type InferredColumn,
  type InferredSchema,
} from "./schemas.js";

describe("constants", () => {
  it("INFERRED_TYPES has 13 entries", () => {
    expect(INFERRED_TYPES).toContain("uuid");
    expect(INFERRED_TYPES).toContain("phone");
    expect(INFERRED_TYPES).toContain("unknown");
  });

  it("SEMANTIC_HINTS covers PK + PII + PHI", () => {
    expect(SEMANTIC_HINTS).toContain("primary_key_candidate");
    expect(SEMANTIC_HINTS).toContain("pii_email");
    expect(SEMANTIC_HINTS).toContain("phi");
  });
});

describe("inferTypeFromSample", () => {
  it("infers boolean from true/false", () => {
    expect(inferTypeFromSample(true)).toBe("boolean");
    expect(inferTypeFromSample("true")).toBe("boolean");
  });

  it("infers integer", () => {
    expect(inferTypeFromSample(42)).toBe("integer");
    expect(inferTypeFromSample("42")).toBe("integer");
  });

  it("infers decimal", () => {
    expect(inferTypeFromSample(3.14)).toBe("decimal");
    expect(inferTypeFromSample("3.14")).toBe("decimal");
  });

  it("infers uuid", () => {
    expect(inferTypeFromSample("550e8400-e29b-41d4-a716-446655440000")).toBe("uuid");
  });

  it("infers email", () => {
    expect(inferTypeFromSample("alice@example.com")).toBe("email");
  });

  it("infers url", () => {
    expect(inferTypeFromSample("https://example.com")).toBe("url");
  });

  it("infers date and datetime", () => {
    expect(inferTypeFromSample("2026-05-14")).toBe("date");
    expect(inferTypeFromSample("2026-05-14T10:00:00Z")).toBe("datetime");
  });

  it("infers phone", () => {
    expect(inferTypeFromSample("+1 415 555 1234")).toBe("phone");
  });

  it("infers string for arbitrary text", () => {
    expect(inferTypeFromSample("hello world")).toBe("string");
  });

  it("infers unknown for null / empty string", () => {
    expect(inferTypeFromSample(null)).toBe("unknown");
    expect(inferTypeFromSample("")).toBe("unknown");
  });
});

describe("consolidateTypes", () => {
  it("returns single type when uniform", () => {
    expect(consolidateTypes(["integer", "integer", "integer"])).toBe("integer");
  });

  it("widens integer + decimal to decimal", () => {
    expect(consolidateTypes(["integer", "decimal", "integer"])).toBe("decimal");
  });

  it("widens date + datetime to datetime", () => {
    expect(consolidateTypes(["date", "datetime"])).toBe("datetime");
  });

  it("falls back to string for mixed unrelated types", () => {
    expect(consolidateTypes(["integer", "email"])).toBe("string");
  });

  it("ignores unknown in counts", () => {
    expect(consolidateTypes(["unknown", "integer", "integer"])).toBe("integer");
  });

  it("returns unknown when all samples are unknown", () => {
    expect(consolidateTypes(["unknown", "unknown"])).toBe("unknown");
  });
});

describe("columnConfidence", () => {
  it("returns 1 when all samples match", () => {
    expect(columnConfidence("integer", ["integer", "integer", "integer"])).toBe(1);
  });

  it("returns 0 for empty samples", () => {
    expect(columnConfidence("integer", [])).toBe(0);
  });

  it("treats integer as compatible with decimal", () => {
    expect(columnConfidence("decimal", ["decimal", "integer", "integer"])).toBe(1);
  });

  it("returns 0 for unknown consolidated type", () => {
    expect(columnConfidence("unknown", ["integer"])).toBe(0);
  });
});

describe("InferredColumnSchema", () => {
  const base: InferredColumn = {
    name: "email",
    sourceName: "Email Address",
    type: "email",
    nullable: false,
    nonNullSamples: 100,
    nullSamples: 0,
    distinctSamples: 100,
    confidence: 0.95,
    semanticHints: ["pii_email"],
    examples: ["a@example.com"],
  };

  it("accepts a valid column", () => {
    expect(() => InferredColumnSchema.parse(base)).not.toThrow();
  });

  it("rejects malformed column name", () => {
    expect(() => InferredColumnSchema.parse({ ...base, name: "1invalid" })).toThrow();
  });

  it("rejects distinctSamples > total samples", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        distinctSamples: 200,
      }),
    ).toThrow(/cannot exceed total samples/);
  });

  it("rejects minLength > maxLength", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        minLength: 10,
        maxLength: 5,
      }),
    ).toThrow(/minLength cannot exceed maxLength/);
  });

  it("rejects type='unknown' with high confidence", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        type: "unknown",
        confidence: 0.9,
      }),
    ).toThrow(/confidence <= 0\.5/);
  });

  it("rejects primary_key_candidate with null samples", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        semanticHints: ["primary_key_candidate"],
        nullSamples: 5,
      }),
    ).toThrow(/nullSamples=0/);
  });

  it("rejects primary_key_candidate with duplicates", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        semanticHints: ["primary_key_candidate"],
        distinctSamples: 90,
      }),
    ).toThrow(/no duplicates/);
  });

  it("rejects duplicate semantic hints", () => {
    expect(() =>
      InferredColumnSchema.parse({
        ...base,
        semanticHints: ["pii_email", "pii_email"],
      }),
    ).toThrow(/duplicate hint/);
  });
});

describe("InferredSchemaSchema", () => {
  const col = (name: string): InferredColumn => ({
    name,
    sourceName: name,
    type: "integer",
    nullable: false,
    nonNullSamples: 10,
    nullSamples: 0,
    distinctSamples: 10,
    confidence: 0.9,
    semanticHints: [],
    examples: [],
  });

  const base: InferredSchema = {
    entityName: "patients",
    sourceEntityLabel: "Patient",
    columns: [col("id"), col("dob_year")],
    rowSampleCount: 10,
    primaryKeyCandidates: ["id"],
    overallConfidence: 0.85,
  };

  it("accepts a valid schema", () => {
    expect(() => InferredSchemaSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate column names", () => {
    expect(() =>
      InferredSchemaSchema.parse({
        ...base,
        columns: [col("id"), col("id")],
      }),
    ).toThrow(/duplicate column name/);
  });

  it("rejects PK candidate not in columns", () => {
    expect(() =>
      InferredSchemaSchema.parse({
        ...base,
        primaryKeyCandidates: ["nonexistent"],
      }),
    ).toThrow(/not a declared column/);
  });

  it("rejects duplicate PK candidates", () => {
    expect(() =>
      InferredSchemaSchema.parse({
        ...base,
        primaryKeyCandidates: ["id", "id"],
      }),
    ).toThrow(/duplicate primary key candidate/);
  });
});
