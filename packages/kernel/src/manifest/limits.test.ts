import { describe, expect, it } from "vitest";
import type { Field } from "@crossengin/types/meta-schema";
import {
  foreignKeyBaseName,
  joinTableName,
  toTableName,
  trigramIndexBaseName,
  uniqueIndexBaseName,
} from "../ddl/identifiers.js";
import { ManifestValidationError } from "./errors.js";
import { checkManifestLimits, MANIFEST_LIMITS } from "./limits.js";
import type { Manifest } from "./types.js";
import { validateManifest } from "./validate.js";

const meta = { name: "Test", slug: "test", version: "1.0.0" } as const;

function manifest(partial: Partial<Manifest>): Manifest {
  return { manifestVersion: "1.0", meta, entities: [], ...partial };
}

function entityWith(
  fields: readonly Field[],
  name = "Thing",
  traits?: readonly string[],
): NonNullable<Manifest["entities"]>[number] {
  return { name, fields: [...fields], ...(traits !== undefined ? { traits: [...traits] } : {}) };
}

function refusal(m: Manifest): string {
  try {
    validateManifest(m);
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestValidationError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("MANIFEST_LIMITS", () => {
  it("sits at or above the Postgres ceilings it names, and above every shipped figure", () => {
    expect(MANIFEST_LIMITS.textMaxLength).toBe(10_485_760);
    expect(MANIFEST_LIMITS.decimalPrecision).toBe(1000);
    // The largest shipped pack measured 145,406 bytes, 56 entities, 21 resolved fields, 10 enum values.
    expect(MANIFEST_LIMITS.manifestBytes).toBeGreaterThan(145_406 * 10);
    expect(MANIFEST_LIMITS.entities).toBeGreaterThan(56 * 5);
    expect(MANIFEST_LIMITS.fieldsPerEntity).toBeGreaterThan(21 * 10);
    expect(MANIFEST_LIMITS.fieldsPerEntity).toBeLessThan(1600);
    expect(MANIFEST_LIMITS.enumValues).toBeGreaterThan(10 * 10);
  });
});

describe("checkManifestLimits", () => {
  it("accepts a field at each ceiling", () => {
    const m = manifest({
      entities: [
        entityWith([
          { name: "code", type: { kind: "text", maxLength: MANIFEST_LIMITS.textMaxLength } },
          {
            name: "amount",
            type: { kind: "decimal", precision: MANIFEST_LIMITS.decimalPrecision, scale: 2 },
          },
          {
            name: "pick",
            type: {
              kind: "enum",
              values: Array.from(
                { length: MANIFEST_LIMITS.enumValues },
                (_, i) => `v${i.toString()}`,
              ),
            },
          },
        ]),
      ],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("refuses maxLength past Postgres's VARCHAR ceiling", () => {
    const m = manifest({
      entities: [
        entityWith([
          { name: "code", type: { kind: "text", maxLength: MANIFEST_LIMITS.textMaxLength + 1 } },
        ]),
      ],
    });
    expect(refusal(m)).toMatch(/Thing\.code.*maxLength 10485761.*long_text/);
  });

  it("refuses precision past Postgres's NUMERIC ceiling", () => {
    const m = manifest({
      entities: [
        entityWith([{ name: "amount", type: { kind: "decimal", precision: 5000, scale: 2 } }]),
      ],
    });
    expect(refusal(m)).toMatch(/Thing\.amount.*precision 5000/);
  });

  it("refuses an enum over the ceiling, including inside an array", () => {
    const values = Array.from(
      { length: MANIFEST_LIMITS.enumValues + 1 },
      (_, i) => `v${i.toString()}`,
    );
    const m = manifest({
      entities: [
        entityWith([{ name: "tags", type: { kind: "array", element: { kind: "enum", values } } }]),
      ],
    });
    expect(refusal(m)).toMatch(/Thing\.tags.*1001 enum values/);
  });

  it("checks a trait's fields too", () => {
    const m = manifest({
      traits: [
        {
          name: "coded",
          fields: [{ name: "code", type: { kind: "text", maxLength: 99_999_999 } }],
        },
      ],
    });
    expect(() => checkManifestLimits(m)).toThrow(/coded\.code/);
  });

  it("refuses more entities than the ceiling", () => {
    const entities = Array.from({ length: MANIFEST_LIMITS.entities + 1 }, (_, i) =>
      entityWith([{ name: "label", type: { kind: "text" } }], `Thing${i.toString()}`),
    );
    expect(() => checkManifestLimits(manifest({ entities }))).toThrow(/501 entities/);
  });

  it("refuses a manifest past the byte ceiling before walking it", () => {
    const description = "x".repeat(MANIFEST_LIMITS.manifestBytes);
    const m = manifest({ meta: { ...meta, description } });
    expect(() => checkManifestLimits(m)).toThrow(/bytes of JSON/);
  });

  it("refuses a field whose name Postgres would truncate", () => {
    const m = manifest({
      entities: [entityWith([{ name: `f${"a".repeat(63)}`, type: { kind: "text" } }])],
    });
    expect(refusal(m)).toMatch(/longer than 63 bytes/);
  });
});

describe("validateManifest — fields per entity", () => {
  it("refuses an entity resolving past the ceiling and accepts one at it", () => {
    const fields = (n: number): Field[] =>
      Array.from(
        { length: n },
        (_, i) => ({ name: `f${i.toString()}`, type: { kind: "text" } }) as Field,
      );
    expect(() =>
      validateManifest(
        manifest({ entities: [entityWith(fields(MANIFEST_LIMITS.fieldsPerEntity))] }),
      ),
    ).not.toThrow();
    expect(
      refusal(manifest({ entities: [entityWith(fields(MANIFEST_LIMITS.fieldsPerEntity + 1))] })),
    ).toMatch(/resolves to 401 fields/);
  });
});

describe("validateManifest — physical name collisions", () => {
  it("refuses two entities that map to one table", () => {
    expect(toTableName("ABTest")).toBe(toTableName("AbTest"));
    const m = manifest({
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "ABTest"),
        entityWith([{ name: "label", type: { kind: "text" } }], "AbTest"),
      ],
    });
    expect(refusal(m)).toMatch(/entity 'ABTest' and entity 'AbTest' both map to table 'ab_test'/);
  });

  it("accepts two entities whose tables differ", () => {
    const m = manifest({
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "AbTest"),
        entityWith([{ name: "label", type: { kind: "text" } }], "AbTests"),
      ],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("refuses a reference field and a scalar that share a column", () => {
    const m = manifest({
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "Person"),
        entityWith([
          { name: "owner", type: { kind: "reference", target: "Person" } },
          { name: "owner_id", type: { kind: "text" } },
        ]),
      ],
    });
    expect(refusal(m)).toMatch(
      /Thing\.owner_id' is stored in column 'owner_id', which field 'owner'/,
    );
  });

  it("refuses a reference whose column is the system tenant_id", () => {
    const m = manifest({
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "Org"),
        entityWith([{ name: "tenant", type: { kind: "reference", target: "Org" } }]),
      ],
    });
    expect(refusal(m)).toMatch(/column 'tenant_id', which the system column/);
  });

  it("accepts a reference already named with its _id suffix", () => {
    const m = manifest({
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "Person"),
        entityWith([{ name: "owner_id", type: { kind: "reference", target: "Person" } }]),
      ],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("refuses a join table that is an entity's table", () => {
    expect(joinTableName("Order", "Line")).toBe(toTableName("OrderLine"));
    const label: Field = { name: "label", type: { kind: "text" } };
    const m = manifest({
      entities: [
        entityWith([label], "Order"),
        entityWith([label], "Line"),
        entityWith([label], "OrderLine"),
      ],
      relations: [{ kind: "many_to_many", left: "Order", right: "Line" }],
    });
    expect(refusal(m)).toMatch(
      /Order <-> Line maps to join table 'order_line', which is entity 'OrderLine''s table/,
    );
  });

  it("refuses two different pairs mapping to one join table, and admits one pair declared twice", () => {
    const label: Field = { name: "label", type: { kind: "text" } };
    const ents = [
      entityWith([label], "A"),
      entityWith([label], "BcD"),
      entityWith([label], "ABc"),
      entityWith([label], "D"),
    ];
    expect(joinTableName("A", "BcD")).toBe(joinTableName("ABc", "D"));
    expect(
      refusal(
        manifest({
          entities: ents,
          relations: [
            { kind: "many_to_many", left: "A", right: "BcD" },
            { kind: "many_to_many", left: "ABc", right: "D" },
          ],
        }),
      ),
    ).toMatch(/ABc <-> D and A <-> BcD both map to join table 'a_bc_d'/);
    expect(() =>
      validateManifest(
        manifest({
          entities: ents,
          relations: [
            { kind: "many_to_many", left: "A", right: "BcD" },
            { kind: "many_to_many", left: "A", right: "BcD" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("refuses two tables' columns whose derived index names coincide, naming both", () => {
    // `order_line` + `item` and `order` + `line_item` concatenate to one string, so the column store's
    // `CREATE UNIQUE INDEX IF NOT EXISTS order_line_item_uniq` for the second table was skipped.
    expect(uniqueIndexBaseName(toTableName("OrderLine"), "item")).toBe(
      uniqueIndexBaseName(toTableName("Order"), "line_item"),
    );
    const m = manifest({
      entities: [
        entityWith([{ name: "line_item", type: { kind: "text" }, unique: true }], "Order"),
        entityWith([{ name: "item", type: { kind: "text" }, unique: true }], "OrderLine"),
      ],
    });
    expect(refusal(m)).toMatch(
      /a unique index on 'OrderLine\.item' would be named 'order_line_item_uniq', which a unique index on 'Order\.line_item' already is/,
    );
  });

  it("refuses a derived index name that is a table's name", () => {
    // Indexes and tables share one relation namespace per schema.
    const label: Field = { name: "label", type: { kind: "text" } };
    const m = manifest({
      entities: [entityWith([label], "Order"), entityWith([label], "IdxOrderTenant")],
    });
    expect(refusal(m)).toMatch(
      /would be named 'idx_order_tenant', which entity 'IdxOrderTenant' already is/,
    );
  });

  it("refuses a derived name Postgres would truncate, and accepts one at the limit", () => {
    const table = toTableName("Abcdefghijklmnopqrstuvwxyzabcd");
    const at = "f".repeat(63 - table.length - "__utrgm".length);
    const over = `${at}x`;
    expect(trigramIndexBaseName(table, at)).toHaveLength(63);
    const ok = manifest({
      entities: [
        entityWith([{ name: at, type: { kind: "text" } }], "Abcdefghijklmnopqrstuvwxyzabcd"),
      ],
    });
    expect(() => validateManifest(ok)).not.toThrow();
    const bad = manifest({
      entities: [
        entityWith([{ name: over, type: { kind: "text" } }], "Abcdefghijklmnopqrstuvwxyzabcd"),
      ],
    });
    expect(refusal(bad)).toMatch(/a search index on .* longer than 63 bytes/);
  });

  it("refuses a join table's foreign key name Postgres would truncate", () => {
    // 25 + 1 + 25 = a 51-byte join table, under the table limit; its foreign keys are 3 + 51 + 1 + 28.
    const left = "Abcdefghijklmnopqrstuvwxy";
    const right = "Zyxwvutsrqponmlkjihgfedcba";
    const table = joinTableName(left, right);
    expect(table.length).toBeLessThanOrEqual(63);
    expect(foreignKeyBaseName(table, `${toTableName(left)}_id`).length).toBeGreaterThan(63);
    const label: Field = { name: "label", type: { kind: "text" } };
    const m = manifest({
      entities: [entityWith([label], left), entityWith([label], right)],
      relations: [{ kind: "many_to_many", left, right }],
    });
    expect(refusal(m)).toMatch(/the foreign key of many-to-many .* longer than 63 bytes/);
  });

  it("accepts a join table whose foreign keys fit", () => {
    const label: Field = { name: "label", type: { kind: "text" } };
    const m = manifest({
      entities: [entityWith([label], "Course"), entityWith([label], "Student")],
      relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("refuses an entity whose table name Postgres would truncate", () => {
    const m = manifest({
      entities: [entityWith([{ name: "label", type: { kind: "text" } }], `T${"a".repeat(63)}`)],
    });
    expect(refusal(m)).toMatch(/longer than 63 bytes/);
  });
});

describe("validateManifest — trait field collisions", () => {
  it("refuses an own field a custom trait also supplies", () => {
    const m = manifest({
      traits: [{ name: "coded", fields: [{ name: "code", type: { kind: "text" } }] }],
      entities: [entityWith([{ name: "code", type: { kind: "integer" } }], "Thing", ["coded"])],
    });
    expect(refusal(m)).toMatch(
      /'Thing\.code' is declared on the entity and supplied by its trait 'coded'/,
    );
  });

  it("refuses an own field a built-in trait also supplies", () => {
    const m = manifest({
      entities: [entityWith([{ name: "version", type: { kind: "text" } }], "Thing", ["versioned"])],
    });
    expect(refusal(m)).toMatch(/supplied by its trait 'versioned'/);
  });

  it("refuses two traits supplying one field", () => {
    const m = manifest({
      traits: [
        { name: "coded", fields: [{ name: "code", type: { kind: "text" } }] },
        { name: "keyed", fields: [{ name: "code", type: { kind: "integer" } }] },
      ],
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "Thing", ["coded", "keyed"]),
      ],
    });
    expect(refusal(m)).toMatch(/traits 'coded' and 'keyed' both supply field 'code'/);
  });

  it("accepts a trait whose fields the entity does not redeclare", () => {
    const m = manifest({
      traits: [{ name: "coded", fields: [{ name: "code", type: { kind: "text" } }] }],
      entities: [
        entityWith([{ name: "label", type: { kind: "text" } }], "Thing", ["coded", "auditable"]),
      ],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });
});
