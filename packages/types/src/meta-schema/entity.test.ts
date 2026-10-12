import { describe, expect, it } from "vitest";
import { EntitySchema, classifiedFields } from "./entity.js";

describe("classifiedFields", () => {
  it("lists only the classified fields with their data class", () => {
    const entity = EntitySchema.parse({
      name: "Patient",
      fields: [
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
        { name: "given_name", type: { kind: "text", maxLength: 100 }, classification: "pii" },
        { name: "status", type: { kind: "text", maxLength: 20 } },
      ],
    });
    expect(classifiedFields(entity.fields)).toEqual([
      { field: "mrn", classification: "phi" },
      { field: "given_name", classification: "pii" },
    ]);
  });

  it("returns empty when nothing is classified", () => {
    const entity = EntitySchema.parse({
      name: "Widget",
      fields: [{ name: "label", type: { kind: "text", maxLength: 20 } }],
    });
    expect(classifiedFields(entity.fields)).toEqual([]);
  });

  it("preserves the order of the list it was given, not the entity's", () => {
    const entity = EntitySchema.parse({
      name: "Patient",
      fields: [
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
        { name: "sex", type: { kind: "text", maxLength: 10 }, classification: "pii" },
      ],
    });
    expect(classifiedFields([...entity.fields].reverse())).toEqual([
      { field: "sex", classification: "pii" },
      { field: "mrn", classification: "phi" },
    ]);
  });

  it("answers over a field list the entity does not contain, which is the point of the signature", () => {
    // A trait's fields are not `entity.fields`. Before this took a list there was no way to ask
    // this question about them without fabricating an entity, which is why three readers did not.
    const traitField = {
      name: "personal_email",
      type: { kind: "text" as const, maxLength: 200 },
      classification: "pii" as const,
    };
    expect(classifiedFields([traitField])).toEqual([
      { field: "personal_email", classification: "pii" },
    ]);
  });
});

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
