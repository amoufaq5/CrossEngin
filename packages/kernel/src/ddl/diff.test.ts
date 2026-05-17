import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";
import { computeEntityDiff, diffAndEmit, emitDiff, type EntityDiff } from "./diff.js";
import { EntityRenameNotSupportedError, UnsupportedDiffChangeError } from "./errors.js";

const schema = "t_acme";

describe("computeEntityDiff — identity", () => {
  it("returns empty diff for identical entities", () => {
    const e: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e, e);
    expect(diff.addedFields).toEqual([]);
    expect(diff.removedFields).toEqual([]);
    expect(diff.modifiedFields).toEqual([]);
    expect(diff.addedIndexes).toEqual([]);
    expect(diff.removedIndexes).toEqual([]);
    expect(diff.destructive).toBe(false);
  });
});

describe("computeEntityDiff — field add / remove", () => {
  it("detects an added field", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" } },
        { name: "b", type: { kind: "integer" } },
      ],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.addedFields).toHaveLength(1);
    expect(diff.addedFields[0]?.name).toBe("b");
    expect(diff.destructive).toBe(false);
  });

  it("detects a removed field as destructive", () => {
    const e1: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" } },
        { name: "b", type: { kind: "integer" } },
      ],
    };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.removedFields).toEqual(["b"]);
    expect(diff.destructive).toBe(true);
  });

  it("uses _id-suffixed column name when removing a reference field", () => {
    const e1: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" } },
        { name: "patient", type: { kind: "reference", target: "Patient" } },
      ],
    };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.removedFields).toEqual(["patient_id"]);
  });
});

describe("computeEntityDiff — field modification", () => {
  it("detects a text maxLength change", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text", maxLength: 50 } }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text", maxLength: 100 } }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields).toHaveLength(1);
    expect(diff.modifiedFields[0]?.typeChange).toEqual({
      from: "VARCHAR(50)",
      to: "VARCHAR(100)",
    });
  });

  it("detects required toggle to NOT NULL", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" }, required: true }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields[0]?.nullabilityChange).toEqual({ from: false, to: true });
  });

  it("detects required toggle to nullable", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" }, required: true }],
    };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields[0]?.nullabilityChange).toEqual({ from: true, to: false });
  });

  it("detects default added", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" }, default: { kind: "literal", value: "x" } },
      ],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields[0]?.defaultChange?.from).toBeUndefined();
    expect(diff.modifiedFields[0]?.defaultChange?.to).toEqual({ kind: "literal", value: "x" });
  });

  it("detects default removed", () => {
    const e1: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" }, default: { kind: "literal", value: "x" } },
      ],
    };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields[0]?.defaultChange?.to).toBeUndefined();
  });

  it("does not emit a modification when only the indexed flag changes (handled via index diff)", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" }, indexed: true }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.modifiedFields).toEqual([]);
    expect(diff.addedIndexes).toHaveLength(1);
  });
});

describe("computeEntityDiff — unsupported changes", () => {
  it("throws on entity rename", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = { name: "Y", fields: [{ name: "a", type: { kind: "text" } }] };
    expect(() => computeEntityDiff(e1, e2)).toThrow(EntityRenameNotSupportedError);
  });

  it("throws on field type kind change", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "integer" } }] };
    expect(() => computeEntityDiff(e1, e2)).toThrow(UnsupportedDiffChangeError);
  });

  it("throws on enum values change", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "enum", values: ["a"] } }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "enum", values: ["a", "b"] } }],
    };
    expect(() => computeEntityDiff(e1, e2)).toThrow(UnsupportedDiffChangeError);
  });

  it("throws on integer range change", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "integer", min: 0 } }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "integer", min: 1 } }],
    };
    expect(() => computeEntityDiff(e1, e2)).toThrow(UnsupportedDiffChangeError);
  });

  it("throws on decimal precision change", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "decimal", precision: 10, scale: 2 } }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "decimal", precision: 12, scale: 2 } }],
    };
    expect(() => computeEntityDiff(e1, e2)).toThrow(UnsupportedDiffChangeError);
  });

  it("throws on unique constraint change", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "email" } }] };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "email" }, unique: true }],
    };
    expect(() => computeEntityDiff(e1, e2)).toThrow(UnsupportedDiffChangeError);
  });
});

describe("computeEntityDiff — traits", () => {
  it("detects added trait fields", () => {
    const e1: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }],
      traits: ["auditable"],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.addedFields.map((f) => f.name)).toEqual([
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]);
    expect(diff.destructive).toBe(false);
  });

  it("detects removed trait fields as destructive", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }],
      traits: ["auditable"],
    };
    const e2: Entity = { name: "X", fields: [{ name: "a", type: { kind: "text" } }] };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.removedFields).toEqual([
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]);
    expect(diff.destructive).toBe(true);
  });

  it("swapping auditable for soft_deletable shows both adds and removes", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }],
      traits: ["auditable"],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }],
      traits: ["soft_deletable"],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.addedFields.map((f) => f.name)).toEqual(["deleted_at", "deleted_by"]);
    expect(diff.removedFields).toEqual([
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]);
  });
});

describe("computeEntityDiff — indexes", () => {
  it("detects an added explicit composite index", () => {
    const e1: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" } },
        { name: "b", type: { kind: "text" } },
      ],
    };
    const e2: Entity = {
      name: "X",
      fields: [
        { name: "a", type: { kind: "text" } },
        { name: "b", type: { kind: "text" } },
      ],
      indexes: [{ fields: ["a", "b"] }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.addedIndexes).toHaveLength(1);
    expect(diff.addedIndexes[0]?.columns).toEqual(["a", "b"]);
  });

  it("detects a removed explicit index", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }, { name: "b", type: { kind: "text" } }],
      indexes: [{ fields: ["a", "b"] }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "text" } }, { name: "b", type: { kind: "text" } }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.removedIndexes).toHaveLength(1);
    expect(diff.removedIndexes[0]?.columns).toEqual(["a", "b"]);
  });

  it("detects an index that changed kind (btree -> gin) as drop+add", () => {
    const e1: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "json" }, indexed: true }],
    };
    const e2: Entity = {
      name: "X",
      fields: [{ name: "a", type: { kind: "json" }, indexed: { kind: "gin" } }],
    };
    const diff = computeEntityDiff(e1, e2);
    expect(diff.removedIndexes).toHaveLength(1);
    expect(diff.addedIndexes).toHaveLength(1);
    expect(diff.addedIndexes[0]?.kind).toBe("gin");
  });
});

describe("emitDiff", () => {
  it("emits ADD COLUMN for added fields", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [{ name: "b", type: { kind: "integer" }, required: true }],
      removedFields: [],
      modifiedFields: [],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ADD COLUMN "b" INTEGER NOT NULL;`,
    ]);
  });

  it("emits DROP COLUMN for removed fields", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: ["b"],
      modifiedFields: [],
      addedIndexes: [],
      removedIndexes: [],
      destructive: true,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" DROP COLUMN "b";`,
    ]);
  });

  it("emits ALTER COLUMN TYPE for type changes", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [
        { name: "a", columnName: "a", typeChange: { from: "VARCHAR(50)", to: "VARCHAR(100)" } },
      ],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ALTER COLUMN "a" TYPE VARCHAR(100);`,
    ]);
  });

  it("emits SET NOT NULL", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [
        { name: "a", columnName: "a", nullabilityChange: { from: false, to: true } },
      ],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ALTER COLUMN "a" SET NOT NULL;`,
    ]);
  });

  it("emits DROP NOT NULL", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [
        { name: "a", columnName: "a", nullabilityChange: { from: true, to: false } },
      ],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ALTER COLUMN "a" DROP NOT NULL;`,
    ]);
  });

  it("emits SET DEFAULT for new literal default", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [
        {
          name: "a",
          columnName: "a",
          defaultChange: { from: undefined, to: { kind: "literal", value: "draft" } },
        },
      ],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ALTER COLUMN "a" SET DEFAULT 'draft';`,
    ]);
  });

  it("emits DROP DEFAULT when removing default", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [
        {
          name: "a",
          columnName: "a",
          defaultChange: { from: { kind: "literal", value: "x" }, to: undefined },
        },
      ],
      addedIndexes: [],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `ALTER TABLE "t_acme"."x" ALTER COLUMN "a" DROP DEFAULT;`,
    ]);
  });

  it("emits CREATE INDEX for added indexes", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [],
      addedIndexes: [{ columns: ["a"] }],
      removedIndexes: [],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([
      `CREATE INDEX "idx_x_a" ON "t_acme"."x" ("a");`,
    ]);
  });

  it("emits DROP INDEX for removed indexes", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [],
      removedFields: [],
      modifiedFields: [],
      addedIndexes: [],
      removedIndexes: [{ columns: ["a"] }],
      destructive: false,
    };
    expect(emitDiff(diff, { schema })).toEqual([`DROP INDEX "t_acme"."idx_x_a";`]);
  });

  it("orders: drop indexes -> drop cols -> add cols -> alter cols -> create indexes", () => {
    const diff: EntityDiff = {
      tableName: "x",
      addedFields: [{ name: "new_col", type: { kind: "text" } }],
      removedFields: ["old_col"],
      modifiedFields: [
        {
          name: "mod_col",
          columnName: "mod_col",
          nullabilityChange: { from: false, to: true },
        },
      ],
      addedIndexes: [{ columns: ["new_col"] }],
      removedIndexes: [{ columns: ["old_col"] }],
      destructive: true,
    };
    const statements = emitDiff(diff, { schema });
    expect(statements[0]).toMatch(/^DROP INDEX/);
    expect(statements[1]).toMatch(/DROP COLUMN/);
    expect(statements[2]).toMatch(/ADD COLUMN/);
    expect(statements[3]).toMatch(/ALTER COLUMN/);
    expect(statements[4]).toMatch(/^CREATE INDEX/);
  });
});

describe("diffAndEmit — end-to-end", () => {
  it("adding a column produces a single ALTER statement", () => {
    const e1: Entity = {
      name: "Patient",
      fields: [{ name: "name", type: { kind: "text" } }],
    };
    const e2: Entity = {
      name: "Patient",
      fields: [
        { name: "name", type: { kind: "text" } },
        { name: "email", type: { kind: "email" } },
      ],
    };
    expect(diffAndEmit(e1, e2, { schema })).toEqual([
      `ALTER TABLE "t_acme"."patient" ADD COLUMN "email" VARCHAR(320);`,
    ]);
  });

  it("adding a soft_deletable trait emits 2 ADD COLUMNs + 1 CREATE INDEX", () => {
    const e1: Entity = {
      name: "Patient",
      fields: [{ name: "name", type: { kind: "text" } }],
    };
    const e2: Entity = {
      name: "Patient",
      fields: [{ name: "name", type: { kind: "text" } }],
      traits: ["soft_deletable"],
    };
    const statements = diffAndEmit(e1, e2, { schema });
    expect(statements).toEqual([
      `ALTER TABLE "t_acme"."patient" ADD COLUMN "deleted_at" TIMESTAMPTZ;`,
      `ALTER TABLE "t_acme"."patient" ADD COLUMN "deleted_by" UUID;`,
      `CREATE INDEX "idx_patient_deleted_at" ON "t_acme"."patient" ("deleted_at");`,
    ]);
  });
});
