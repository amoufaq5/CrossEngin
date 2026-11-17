import { describe, expect, it } from "vitest";
import type { Entity, Field, Trait } from "@crossengin/types/meta-schema";
import {
  CLASSIFICATION_MOVES,
  abacObligationChanges,
  classificationMove,
  fieldClassificationChanges,
  fieldDefaultChanges,
  renderFieldDefault,
  roleInheritanceChanges,
} from "./change-detail.js";
import type { Manifest } from "./types.js";

const meta = { name: "T", slug: "t", version: "1.0.0" } as const;

function manifest(parts: Partial<Manifest>): Manifest {
  return { manifestVersion: "1.0", meta, ...parts };
}

function entity(fields: Field[], traits?: string[]): Entity {
  return { name: "Vendor", fields, ...(traits === undefined ? {} : { traits }) };
}

const text = { kind: "text" } as const;

describe("fieldDefaultChanges", () => {
  it("reports a default added, changed and removed, rendered", () => {
    const before = manifest({
      entities: [
        entity([
          { name: "a", type: text },
          { name: "b", type: text, default: { kind: "literal", value: "x" } },
          { name: "c", type: text, default: { kind: "literal", value: "y" } },
          { name: "d", type: text, default: { kind: "literal", value: 1 } },
        ]),
      ],
    });
    const after = manifest({
      entities: [
        entity([
          { name: "a", type: text, default: { kind: "literal", value: "new" } },
          { name: "b", type: text, default: { kind: "literal", value: "z" } },
          { name: "c", type: text },
          { name: "d", type: text, default: { kind: "literal", value: 1 } },
        ]),
      ],
    });
    expect(fieldDefaultChanges(before, after)).toEqual([
      { entity: "Vendor", field: "a", source: "own", from: null, to: 'literal "new"', requiredLosesDefault: false },
      { entity: "Vendor", field: "b", source: "own", from: 'literal "x"', to: 'literal "z"', requiredLosesDefault: false },
      { entity: "Vendor", field: "c", source: "own", from: 'literal "y"', to: null, requiredLosesDefault: false },
    ]);
  });

  it("flags a required field that loses its default, and only that", () => {
    const before = manifest({
      entities: [entity([{ name: "a", type: text, required: true, default: { kind: "literal", value: "x" } }])],
    });
    const after = manifest({ entities: [entity([{ name: "a", type: text, required: true }])] });
    expect(fieldDefaultChanges(before, after)[0]?.requiredLosesDefault).toBe(true);
    expect(fieldDefaultChanges(after, before)[0]?.requiredLosesDefault).toBe(false);
  });

  it("compares canonically, so key order inside a literal is not a change", () => {
    const before = manifest({
      entities: [entity([{ name: "a", type: text, default: { kind: "literal", value: { p: 1, q: 2 } } }])],
    });
    const after = manifest({
      entities: [entity([{ name: "a", type: text, default: { kind: "literal", value: { q: 2, p: 1 } } }])],
    });
    expect(fieldDefaultChanges(before, after)).toEqual([]);
  });

  it("sees a default contributed by a trait, each side against its own traits", () => {
    const traits = (value: string): Trait[] => [
      { name: "stamped", fields: [{ name: "origin", type: text, default: { kind: "literal", value } }] },
    ];
    const before = manifest({ entities: [entity([{ name: "a", type: text }], ["stamped"])], traits: traits("x") });
    const after = manifest({ entities: [entity([{ name: "a", type: text }], ["stamped"])], traits: traits("y") });
    expect(fieldDefaultChanges(before, after)).toEqual([
      { entity: "Vendor", field: "origin", source: "trait", from: 'literal "x"', to: 'literal "y"', requiredLosesDefault: false },
    ]);
  });

  it("ignores a field present on one side only", () => {
    const before = manifest({ entities: [entity([{ name: "a", type: text }])] });
    const after = manifest({
      entities: [entity([{ name: "a", type: text }, { name: "b", type: text, default: { kind: "literal", value: 1 } }])],
    });
    expect(fieldDefaultChanges(before, after)).toEqual([]);
  });
});

describe("renderFieldDefault", () => {
  it("renders each kind and truncates a long literal", () => {
    expect(renderFieldDefault(undefined)).toBeNull();
    expect(renderFieldDefault({ kind: "expression", expression: "now()" })).toBe("expression now()");
    expect(renderFieldDefault({ kind: "sequence", sequence: "inv", format: "INV-{n}" })).toBe(
      "sequence inv (INV-{n})",
    );
    const long = renderFieldDefault({ kind: "literal", value: "x".repeat(500) }) ?? "";
    expect(long.length).toBeLessThanOrEqual("literal ".length + 80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("classificationMove", () => {
  it("answers each of the four moves", () => {
    expect(classificationMove(null, "pii")).toBe("raised");
    expect(classificationMove("internal", "phi")).toBe("raised");
    expect(classificationMove("pii", "public")).toBe("lowered");
    expect(classificationMove("pii", "phi")).toBe("between_sensitive");
    expect(classificationMove("public", "internal")).toBe("between_insensitive");
    expect(new Set(CLASSIFICATION_MOVES).size).toBe(4);
  });
});

describe("fieldClassificationChanges", () => {
  it("reports a move between two sensitive classes, with the encryption change", () => {
    const before = manifest({ entities: [entity([{ name: "email", type: text, classification: "pii" }])] });
    const after = manifest({ entities: [entity([{ name: "email", type: text, classification: "phi" }])] });
    expect(fieldClassificationChanges(before, after)).toEqual([
      { entity: "Vendor", field: "email", source: "own", from: "pii", to: "phi", move: "between_sensitive", encryptionChanged: true },
    ]);
  });

  it("does not claim an encryption change between two non-encrypted sensitive classes", () => {
    const before = manifest({ entities: [entity([{ name: "email", type: text, classification: "pii" }])] });
    const after = manifest({
      entities: [entity([{ name: "email", type: text, classification: "commercial_sensitive" }])],
    });
    expect(fieldClassificationChanges(before, after)[0]?.encryptionChanged).toBe(false);
  });

  it("reports a trait-contributed field's classification, which an entity.fields reader misses", () => {
    const traits = (classification: Field["classification"]): Trait[] => [
      { name: "contactable", fields: [{ name: "mail", type: text, ...(classification ? { classification } : {}) }] },
    ];
    const before = manifest({ entities: [entity([], ["contactable"])], traits: traits("pii") });
    const after = manifest({ entities: [entity([], ["contactable"])], traits: traits(undefined) });
    expect(fieldClassificationChanges(before, after)).toEqual([
      { entity: "Vendor", field: "mail", source: "trait", from: "pii", to: null, move: "lowered", encryptionChanged: false },
    ]);
  });

  it("is empty for an unchanged manifest", () => {
    const m = manifest({ entities: [entity([{ name: "email", type: text, classification: "pii" }])] });
    expect(fieldClassificationChanges(m, m)).toEqual([]);
  });
});

describe("roleInheritanceChanges", () => {
  it("names what a role gained and lost, and skips added or removed roles", () => {
    const before = manifest({
      roles: { viewer: { name: "viewer", inherits: ["reader"] }, gone: { name: "gone" } },
    });
    const after = manifest({
      roles: { viewer: { name: "viewer", inherits: ["admin"] }, fresh: { name: "fresh", inherits: ["admin"] } },
    });
    expect(roleInheritanceChanges(before, after)).toEqual([
      { role: "viewer", gained: ["admin"], lost: ["reader"] },
    ]);
  });

  it("is empty when inherits is unchanged, an absent list reading as none", () => {
    const before = manifest({ roles: { viewer: { name: "viewer" } } });
    const after = manifest({ roles: { viewer: { name: "viewer", inherits: [] } } });
    expect(roleInheritanceChanges(before, after)).toEqual([]);
  });
});

describe("abacObligationChanges", () => {
  it("reports an obligation added, removed and re-keyed, at every grant position", () => {
    const before = manifest({
      permissions: {
        Vendor: {
          list: { roles: ["a"] },
          read: { roles: ["a"], abac: "own_rows" },
          update: { roles: ["a"], abac: "k1" },
          transitions: { approve: { roles: ["a"] } },
          fields: {
            tax_id: { create: { roles: ["a"] } },
            iban: { read: { roles: ["a"], abac: "finance" }, update: { roles: ["a"] } },
          },
        },
      },
    });
    const after = manifest({
      permissions: {
        Vendor: {
          list: { roles: ["a"], abac: "own_rows" },
          read: { roles: ["a"] },
          update: { roles: ["a"], abac: "k2" },
          transitions: { approve: { roles: ["a"], abac: "dept" } },
          fields: {
            tax_id: { create: { roles: ["a"], abac: "dept" } },
            iban: { read: { roles: ["a"] }, update: { roles: ["a"], abac: "finance" } },
          },
        },
      },
    });
    expect(abacObligationChanges(before, after)).toEqual([
      { entity: "Vendor", operation: "list", from: null, to: "own_rows" },
      { entity: "Vendor", operation: "read", from: "own_rows", to: null },
      { entity: "Vendor", operation: "update", from: "k1", to: "k2" },
      { entity: "Vendor", operation: "transitions.approve", from: null, to: "dept" },
      { entity: "Vendor", operation: "fields.tax_id.create", from: null, to: "dept" },
      { entity: "Vendor", operation: "fields.iban.read", from: "finance", to: null },
      { entity: "Vendor", operation: "fields.iban.update", from: null, to: "finance" },
    ]);
  });

  it("does not report a grant that appears with no obligation — that is a role change", () => {
    const before = manifest({ permissions: { Vendor: {} } });
    const after = manifest({ permissions: { Vendor: { list: { roles: ["a"] } } } });
    expect(abacObligationChanges(before, after)).toEqual([]);
  });
});

describe("fieldDefaultChanges — array order", () => {
  it("reports a reordered array literal, which stores a different value, though the hash ignores it", () => {
    const value = (names: string[]): Field["default"] => ({
      kind: "literal",
      value: names.map((name) => ({ name })),
    });
    const before = manifest({ entities: [entity([{ name: "a", type: { kind: "json" }, default: value(["x", "y"]) }])] });
    const after = manifest({ entities: [entity([{ name: "a", type: { kind: "json" }, default: value(["y", "x"]) }])] });
    expect(fieldDefaultChanges(before, after)).toHaveLength(1);
  });
});
