import type { Entity, Trait } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import { resolvedFieldNames, resolvedFields } from "./resolution.js";

const entity = (over: Partial<Entity> = {}): Entity => ({
  name: "Prescription",
  fields: [
    { name: "qty", type: { kind: "integer" } },
    { name: "status", type: { kind: "text" } },
  ],
  ...over,
});

describe("resolvedFieldNames", () => {
  it("includes the implicit id primary key, which emitCreateTable always adds", () => {
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
    // A collision is emitCreateTable's error to raise; for existence, the field still exists.
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
