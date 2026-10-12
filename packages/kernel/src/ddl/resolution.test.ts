import type { Entity, Trait } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import { resolvedClassifiedFields, resolvedFieldNames, resolvedFields } from "./resolution.js";

const entity = (over: Partial<Entity> = {}): Entity => ({
  name: "Prescription",
  fields: [
    { name: "qty", type: { kind: "integer" } },
    { name: "status", type: { kind: "text" } },
  ],
  ...over,
});

describe("resolvedFieldNames", () => {
  it("includes the implicit id primary key, which every entity table carries", () => {
    expect(resolvedFieldNames(entity(), []).has("id")).toBe(true);
  });

  it("includes the entity's own fields", () => {
    const names = resolvedFieldNames(entity(), []);
    expect(names.has("qty")).toBe(true);
    expect(names.has("status")).toBe(true);
  });

  it("excludes a field the entity does not declare", () => {
    expect(resolvedFieldNames(entity(), []).has("dosage")).toBe(false);
  });

  it("includes fields contributed by a built-in trait", () => {
    const names = resolvedFieldNames(entity({ traits: ["auditable"] }), []);
    expect([...names].sort()).toEqual([
      "created_at",
      "created_by",
      "id",
      "qty",
      "status",
      "updated_at",
      "updated_by",
    ]);
  });

  it("includes fields from several traits at once", () => {
    const names = resolvedFieldNames(entity({ traits: ["versioned", "soft_deletable"] }), []);
    expect(names.has("version")).toBe(true);
    expect(names.has("deleted_at")).toBe(true);
    expect(names.has("deleted_by")).toBe(true);
  });

  it("includes fields from a manifest-declared custom trait", () => {
    const traits: Trait[] = [
      { name: "geocoded", fields: [{ name: "lat", type: { kind: "decimal", precision: 9, scale: 6 } }] },
    ];
    const names = resolvedFieldNames(entity({ traits: ["geocoded"] }), traits);
    expect(names.has("lat")).toBe(true);
  });

  it("ignores a trait it cannot resolve rather than throwing", () => {
    // Trait existence is checked earlier in validateManifest; this is an existence question
    // about fields, and it must not raise a second, less useful error here.
    expect(() => resolvedFieldNames(entity({ traits: ["nonexistent"] }), [])).not.toThrow();
    expect(resolvedFieldNames(entity({ traits: ["nonexistent"] }), []).has("qty")).toBe(true);
  });

  it("tolerates the same name arriving from two traits", () => {
    // A collision is checkEntityFieldNames's error to raise; for existence, the field exists.
    const traits: Trait[] = [
      { name: "a", fields: [{ name: "note", type: { kind: "text" } }] },
      { name: "b", fields: [{ name: "note", type: { kind: "text" } }] },
    ];
    const names = resolvedFieldNames(entity({ traits: ["a", "b"] }), traits);
    expect(names.has("note")).toBe(true);
  });

  it("returns id plus nothing else for a fieldless, traitless entity", () => {
    expect([...resolvedFieldNames(entity({ fields: [] }), [])]).toEqual(["id"]);
  });
});

describe("resolvedFields", () => {
  it("returns the entity's own fields first, then the trait's", () => {
    const fields = resolvedFields(entity({ traits: ["versioned"] }), []);
    expect(fields.map((f) => f.name)).toEqual(["qty", "status", "version"]);
  });

  it("omits the implicit id, which is a system column each emitter types for itself", () => {
    expect(resolvedFields(entity(), []).map((f) => f.name)).not.toContain("id");
    expect(resolvedFieldNames(entity(), []).has("id")).toBe(true);
  });

  it("carries the trait field's type and default, which the serving store needs", () => {
    const created = resolvedFields(entity({ traits: ["auditable"] }), []).find(
      (f) => f.name === "created_at",
    );
    expect(created?.type).toEqual({ kind: "datetime" });
    expect(created?.required).toBe(true);
    expect(created?.default).toEqual({ kind: "expression", expression: "now()" });
  });

  it("lets the entity's own field win over a trait supplying the same name", () => {
    const shadowed = entity({
      traits: ["versioned"],
      fields: [{ name: "version", type: { kind: "text" } }],
    });
    const fields = resolvedFields(shadowed, []);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.type).toEqual({ kind: "text" });
  });

  it("agrees with resolvedFieldNames, which is defined over it", () => {
    const e = entity({ traits: ["auditable", "soft_deletable"] });
    const names = new Set(["id", ...resolvedFields(e, []).map((f) => f.name)]);
    expect([...resolvedFieldNames(e, [])].sort()).toEqual([...names].sort());
  });
});

describe("resolvedClassifiedFields", () => {
  const classifiedTrait: Trait = {
    name: "contact_bearing",
    fields: [
      { name: "personal_email", type: { kind: "text", maxLength: 200 }, classification: "pii" },
      { name: "nickname", type: { kind: "text", maxLength: 40 } },
    ],
  };

  it("finds a classified field the entity declares itself", () => {
    const e = entity({
      fields: [{ name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" }],
    });
    expect(resolvedClassifiedFields(e, [])).toEqual([{ field: "mrn", classification: "phi" }]);
  });

  // The whole reason this function exists. A reader that asks `entity.fields` answers `[]` here,
  // and two readers did: the gateway's redaction registry and the write mask, both failing open.
  it("finds a classified field a CUSTOM TRAIT contributes, which the entity's own fields do not", () => {
    const e = entity({ traits: ["contact_bearing"], fields: [{ name: "qty", type: { kind: "integer" } }] });
    expect(resolvedClassifiedFields(e, [classifiedTrait])).toEqual([
      { field: "personal_email", classification: "pii" },
    ]);
  });

  it("orders the entity's own classified fields before a trait's", () => {
    const e = entity({
      traits: ["contact_bearing"],
      fields: [{ name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" }],
    });
    expect(resolvedClassifiedFields(e, [classifiedTrait])).toEqual([
      { field: "mrn", classification: "phi" },
      { field: "personal_email", classification: "pii" },
    ]);
  });

  it("omits a trait's unclassified field", () => {
    const e = entity({ traits: ["contact_bearing"], fields: [{ name: "qty", type: { kind: "integer" } }] });
    const names = resolvedClassifiedFields(e, [classifiedTrait]).map((c) => c.field);
    expect(names).not.toContain("nickname");
  });

  // No built-in trait field carries a classification today, and this pins that it is a fact about
  // the table rather than something this function assumes: if one gained a class, it would appear
  // here and in every reader, which is the behaviour the function exists to guarantee.
  it("answers empty for built-in traits, none of whose fields are classified today", () => {
    expect(resolvedClassifiedFields(entity({ traits: ["auditable", "soft_deletable", "versioned"], fields: [{ name: "qty", type: { kind: "integer" } }] }), [])).toEqual([]);
  });

  it("lets the entity's own classification win over a trait supplying the same field name", () => {
    const shadowed = entity({
      traits: ["contact_bearing"],
      fields: [
        { name: "personal_email", type: { kind: "text", maxLength: 200 }, classification: "regulated" },
      ],
    });
    expect(resolvedClassifiedFields(shadowed, [classifiedTrait])).toEqual([
      { field: "personal_email", classification: "regulated" },
    ]);
  });

  it("is exactly the classified subset of resolvedFields, so the two cannot disagree", () => {
    const e = entity({
      traits: ["contact_bearing", "auditable"],
      fields: [{ name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" }],
    });
    const expected = resolvedFields(e, [classifiedTrait])
      .filter((f) => f.classification !== undefined)
      .map((f) => ({ field: f.name, classification: f.classification }));
    expect(resolvedClassifiedFields(e, [classifiedTrait])).toEqual(expected);
    expect(expected.length).toBeGreaterThan(1);
  });

  it("ignores a trait the entity does not name", () => {
    const e = entity({ fields: [{ name: "qty", type: { kind: "integer" } }] });
    expect(resolvedClassifiedFields(e, [classifiedTrait])).toEqual([]);
  });
});
