import { describe, expect, it } from "vitest";
import { columnNameForField, emitColumn } from "./column.js";

const schema = "t_acme";

describe("columnNameForField", () => {
  it("uses the field name for non-references", () => {
    expect(columnNameForField({ name: "first_name", type: { kind: "text" } })).toBe("first_name");
  });

  it("appends _id for references", () => {
    expect(
      columnNameForField({ name: "patient", type: { kind: "reference", target: "Patient" } }),
    ).toBe("patient_id");
  });

  it("does not double-append _id for reference fields already ending in _id", () => {
    expect(
      columnNameForField({ name: "patient_id", type: { kind: "reference", target: "Patient" } }),
    ).toBe("patient_id");
  });
});

describe("emitColumn — basics", () => {
  it("emits a minimal text column", () => {
    expect(emitColumn({ name: "name", type: { kind: "text" } }, { schema })).toBe(`"name" TEXT`);
  });

  it("emits VARCHAR(N) for text with maxLength", () => {
    expect(emitColumn({ name: "name", type: { kind: "text", maxLength: 100 } }, { schema })).toBe(
      `"name" VARCHAR(100)`,
    );
  });

  it("adds NOT NULL when required", () => {
    expect(emitColumn({ name: "name", type: { kind: "text" }, required: true }, { schema })).toBe(
      `"name" TEXT NOT NULL`,
    );
  });

  it("adds UNIQUE when unique=true", () => {
    expect(emitColumn({ name: "email", type: { kind: "email" }, unique: true }, { schema })).toBe(
      `"email" VARCHAR(320) UNIQUE`,
    );
  });

  it("does NOT add UNIQUE for unique={scope: [...]} (composite handled at table level)", () => {
    expect(
      emitColumn(
        { name: "email", type: { kind: "email" }, unique: { scope: ["org_id"] } },
        { schema },
      ),
    ).toBe(`"email" VARCHAR(320)`);
  });
});

describe("emitColumn — defaults", () => {
  it("emits an expression default verbatim", () => {
    expect(
      emitColumn(
        {
          name: "id",
          type: { kind: "uuid" },
          default: { kind: "expression", expression: "uuid_generate_v7()" },
        },
        { schema },
      ),
    ).toBe(`"id" UUID DEFAULT uuid_generate_v7()`);
  });

  it("emits a string literal default escaped", () => {
    expect(
      emitColumn(
        {
          name: "status",
          type: { kind: "text" },
          default: { kind: "literal", value: "draft" },
        },
        { schema },
      ),
    ).toBe(`"status" TEXT DEFAULT 'draft'`);
  });

  it("escapes single quotes in string literals", () => {
    expect(
      emitColumn(
        {
          name: "note",
          type: { kind: "text" },
          default: { kind: "literal", value: "it's fine" },
        },
        { schema },
      ),
    ).toBe(`"note" TEXT DEFAULT 'it''s fine'`);
  });

  it("emits boolean defaults as TRUE / FALSE", () => {
    expect(
      emitColumn(
        {
          name: "active",
          type: { kind: "boolean" },
          default: { kind: "literal", value: true },
        },
        { schema },
      ),
    ).toBe(`"active" BOOLEAN DEFAULT TRUE`);
    expect(
      emitColumn(
        {
          name: "active",
          type: { kind: "boolean" },
          default: { kind: "literal", value: false },
        },
        { schema },
      ),
    ).toBe(`"active" BOOLEAN DEFAULT FALSE`);
  });

  it("emits numeric defaults", () => {
    expect(
      emitColumn(
        {
          name: "version",
          type: { kind: "integer" },
          default: { kind: "literal", value: 1 },
        },
        { schema },
      ),
    ).toBe(`"version" INTEGER DEFAULT 1`);
  });

  it("emits NULL for null literal defaults", () => {
    expect(
      emitColumn(
        {
          name: "x",
          type: { kind: "text" },
          default: { kind: "literal", value: null },
        },
        { schema },
      ),
    ).toBe(`"x" TEXT DEFAULT NULL`);
  });
});

describe("emitColumn — enum CHECK", () => {
  it("emits a CHECK constraint on enum values", () => {
    expect(
      emitColumn(
        {
          name: "status",
          type: { kind: "enum", values: ["pending", "done"] },
          required: true,
        },
        { schema },
      ),
    ).toBe(`"status" TEXT NOT NULL CHECK ("status" IN ('pending', 'done'))`);
  });

  it("escapes single quotes inside enum values", () => {
    expect(
      emitColumn(
        {
          name: "kind",
          type: { kind: "enum", values: ["it's"] },
        },
        { schema },
      ),
    ).toBe(`"kind" TEXT CHECK ("kind" IN ('it''s'))`);
  });
});

describe("emitColumn — integer range CHECK", () => {
  it("emits BETWEEN for both bounds", () => {
    expect(
      emitColumn({ name: "qty", type: { kind: "integer", min: 1, max: 100 } }, { schema }),
    ).toBe(`"qty" INTEGER CHECK ("qty" BETWEEN 1 AND 100)`);
  });

  it("emits >= for min only", () => {
    expect(emitColumn({ name: "qty", type: { kind: "integer", min: 0 } }, { schema })).toBe(
      `"qty" INTEGER CHECK ("qty" >= 0)`,
    );
  });

  it("emits <= for max only", () => {
    expect(emitColumn({ name: "qty", type: { kind: "integer", max: 100 } }, { schema })).toBe(
      `"qty" INTEGER CHECK ("qty" <= 100)`,
    );
  });

  it("emits no CHECK when no bounds", () => {
    expect(emitColumn({ name: "qty", type: { kind: "integer" } }, { schema })).toBe(
      `"qty" INTEGER`,
    );
  });
});

describe("emitColumn — decimal range CHECK", () => {
  it("emits BETWEEN for both bounds on decimal", () => {
    expect(
      emitColumn(
        {
          name: "price",
          type: { kind: "decimal", precision: 10, scale: 2, min: 0, max: 9999 },
        },
        { schema },
      ),
    ).toBe(`"price" NUMERIC(10, 2) CHECK ("price" BETWEEN 0 AND 9999)`);
  });
});

describe("emitColumn — references", () => {
  it("emits a FK constraint with default ON DELETE RESTRICT", () => {
    expect(
      emitColumn(
        {
          name: "patient",
          type: { kind: "reference", target: "Patient" },
          required: true,
        },
        { schema },
      ),
    ).toBe(`"patient_id" UUID NOT NULL REFERENCES "t_acme"."patient"("id") ON DELETE RESTRICT`);
  });

  it("converts target PascalCase to snake_case in the FK reference", () => {
    expect(
      emitColumn(
        { name: "batch", type: { kind: "reference", target: "BatchRelease" } },
        { schema },
      ),
    ).toBe(`"batch_id" UUID REFERENCES "t_acme"."batch_release"("id") ON DELETE RESTRICT`);
  });
});
