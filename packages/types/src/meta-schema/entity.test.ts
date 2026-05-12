import { describe, expect, it } from "vitest";
import { EntitySchema } from "./entity.js";

describe("EntitySchema", () => {
  it("parses a minimal entity", () => {
    const input = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text", maxLength: 100 } }],
    };
    expect(EntitySchema.parse(input)).toEqual(input);
  });

  it("parses an entity with traits and indexes", () => {
    const input = {
      name: "Prescription",
      fields: [
        { name: "patient_id", type: { kind: "uuid" }, required: true },
        { name: "status", type: { kind: "enum", values: ["pending", "done"] } },
      ],
      traits: ["auditable", "soft_deletable"],
      indexes: [{ fields: ["status", "patient_id"], kind: "btree" }],
    };
    expect(EntitySchema.parse(input)).toEqual(input);
  });

  it("parses an entity with custom (non-builtin) trait names", () => {
    const input = {
      name: "Address",
      fields: [{ name: "line1", type: { kind: "text" } }],
      traits: ["geocoded"],
    };
    expect(EntitySchema.parse(input)).toEqual(input);
  });

  it("rejects entity with non-PascalCase name", () => {
    expect(() =>
      EntitySchema.parse({
        name: "patient",
        fields: [{ name: "x", type: { kind: "uuid" } }],
      }),
    ).toThrow();
  });

  it("rejects entity name with leading digit", () => {
    expect(() =>
      EntitySchema.parse({
        name: "1Patient",
        fields: [{ name: "x", type: { kind: "uuid" } }],
      }),
    ).toThrow();
  });

  it("rejects entity name with underscore", () => {
    expect(() =>
      EntitySchema.parse({
        name: "Pharma_Patient",
        fields: [{ name: "x", type: { kind: "uuid" } }],
      }),
    ).toThrow();
  });

  it("rejects entity with no fields", () => {
    expect(() => EntitySchema.parse({ name: "Empty", fields: [] })).toThrow();
  });

  it("rejects entity with duplicate field names", () => {
    expect(() =>
      EntitySchema.parse({
        name: "Duplicate",
        fields: [
          { name: "x", type: { kind: "uuid" } },
          { name: "x", type: { kind: "text" } },
        ],
      }),
    ).toThrow();
  });

  it("rejects entity with index referencing non-existent field", () => {
    expect(() =>
      EntitySchema.parse({
        name: "BadIndex",
        fields: [{ name: "x", type: { kind: "uuid" } }],
        indexes: [{ fields: ["y"] }],
      }),
    ).toThrow();
  });

  it("accepts index with valid field reference", () => {
    const input = {
      name: "Indexed",
      fields: [
        { name: "x", type: { kind: "uuid" } },
        { name: "y", type: { kind: "datetime" } },
      ],
      indexes: [{ fields: ["x", "y"] }],
    };
    expect(EntitySchema.parse(input)).toEqual(input);
  });
});
