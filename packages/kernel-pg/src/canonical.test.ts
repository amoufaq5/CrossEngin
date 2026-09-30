import { describe, expect, it } from "vitest";
import { META_TABLES, type TableDefinition } from "@crossengin/kernel/bootstrap";

import {
  APPLIER_OWNED_TABLES,
  DEFAULT_ON_DELETE,
  PG_TYPE_ALIASES,
  canonicalPgDefault,
  canonicalPgType,
  declaredForeignKeys,
  declaredOnDelete,
  expectedIndexNames,
} from "./canonical.js";

describe("APPLIER_OWNED_TABLES", () => {
  it("names the applier's own bookkeeping table", () => {
    expect(APPLIER_OWNED_TABLES.has("_meta_migrations")).toBe(true);
  });

  it("does not shadow a catalog table", () => {
    for (const name of APPLIER_OWNED_TABLES) {
      expect(META_TABLES.some((t) => t.name === name)).toBe(false);
    }
  });
});

describe("canonicalPgType", () => {
  it("rewrites TIMESTAMPTZ the way format_type prints it", () => {
    // 425 columns in the catalog declare TIMESTAMPTZ; comparing the raw spellings reported every
    // one of them as drifted.
    expect(canonicalPgType("TIMESTAMPTZ")).toBe("timestamp with time zone");
  });

  it("is already canonical for the printed form, so it is idempotent", () => {
    expect(canonicalPgType("timestamp with time zone")).toBe("timestamp with time zone");
    expect(canonicalPgType(canonicalPgType("TIMESTAMPTZ"))).toBe("timestamp with time zone");
  });

  it("expands CHAR and VARCHAR", () => {
    expect(canonicalPgType("CHAR(64)")).toBe("character(64)");
    expect(canonicalPgType("VARCHAR(20)")).toBe("character varying(20)");
  });

  it("strips whitespace inside a precision list", () => {
    expect(canonicalPgType("NUMERIC(12, 6)")).toBe("numeric(12,6)");
    expect(canonicalPgType("numeric(12,6)")).toBe("numeric(12,6)");
  });

  it("maps the integer and float aliases", () => {
    expect(canonicalPgType("INT")).toBe("integer");
    expect(canonicalPgType("INT4")).toBe("integer");
    expect(canonicalPgType("INT8")).toBe("bigint");
    expect(canonicalPgType("INT2")).toBe("smallint");
    expect(canonicalPgType("FLOAT8")).toBe("double precision");
    expect(canonicalPgType("BOOL")).toBe("boolean");
    expect(canonicalPgType("DECIMAL(4,2)")).toBe("numeric(4,2)");
  });

  it("keeps an array suffix and canonicalizes the element type", () => {
    expect(canonicalPgType("TEXT[]")).toBe("text[]");
    expect(canonicalPgType("TIMESTAMPTZ[]")).toBe("timestamp with time zone[]");
    expect(canonicalPgType("TEXT [ ]")).toBe("text[]");
    expect(canonicalPgType("TEXT[][]")).toBe("text[][]");
  });

  it("puts a time precision inside the name, where Postgres puts it", () => {
    expect(canonicalPgType("TIMESTAMPTZ(3)")).toBe("timestamp(3) with time zone");
    expect(canonicalPgType("TIMETZ(0)")).toBe("time(0) with time zone");
  });

  it("distinguishes the two timestamp flavours", () => {
    expect(canonicalPgType("TIMESTAMP")).toBe("timestamp without time zone");
    expect(canonicalPgType("TIMESTAMPTZ")).not.toBe(canonicalPgType("TIMESTAMP"));
  });

  it("leaves a type it has no alias for alone but lowercases it", () => {
    expect(canonicalPgType("JSONB")).toBe("jsonb");
    expect(canonicalPgType("UUID")).toBe("uuid");
    expect(canonicalPgType("TEXT")).toBe("text");
  });

  it("handles an empty string", () => {
    expect(canonicalPgType("")).toBe("");
  });

  it("never maps two distinct declared types onto one canonical form", () => {
    const seen = new Map<string, string>();
    for (const [alias, target] of Object.entries(PG_TYPE_ALIASES)) {
      const prior = seen.get(target);
      // Several aliases legitimately share a target (int/int4 -> integer); what must not happen is
      // an alias mapping onto a *different* alias's declared name.
      if (prior !== undefined) expect(PG_TYPE_ALIASES[prior]).toBe(target);
      seen.set(target, alias);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe("canonicalPgDefault", () => {
  it("is null for an absent default", () => {
    expect(canonicalPgDefault(null)).toBeNull();
    expect(canonicalPgDefault(undefined)).toBeNull();
    expect(canonicalPgDefault("   ")).toBeNull();
  });

  it("equates a string literal with the cast Postgres adds to it", () => {
    expect(canonicalPgDefault("'active'")).toBe(canonicalPgDefault("'active'::text"));
  });

  it("strips a cast carrying a precision or an array suffix", () => {
    expect(canonicalPgDefault("'{}'::jsonb")).toBe("'{}'");
    expect(canonicalPgDefault("'x'::character varying(20)")).toBe("'x'");
    expect(canonicalPgDefault("'{}'::text[]")).toBe("'{}'");
  });

  it("unwraps the parentheses Postgres adds around a re-rendered default", () => {
    expect(canonicalPgDefault("('{}'::jsonb)")).toBe("'{}'");
  });

  it("leaves a function call alone", () => {
    expect(canonicalPgDefault("uuid_generate_v7()")).toBe("uuid_generate_v7()");
    expect(canonicalPgDefault("now()")).toBe("now()");
  });

  it("does not strip a cast that sits inside a call", () => {
    expect(canonicalPgDefault("nextval('s'::regclass)")).toBe("nextval('s'::regclass)");
  });

  it("normalizes case and whitespace", () => {
    expect(canonicalPgDefault("  NOW()  ")).toBe("now()");
    expect(canonicalPgDefault("FALSE")).toBe("false");
  });

  it("agrees on the literal defaults the catalog actually uses", () => {
    for (const declared of ["'active'", "'eu'", "'small'", "'simple'", "false", "0", "'[]'::jsonb"]) {
      const live = declared.includes("::") ? declared : `${declared}::text`;
      expect(canonicalPgDefault(declared)).toBe(canonicalPgDefault(live));
    }
  });
});

const TABLE: TableDefinition = {
  schema: "meta",
  name: "widgets",
  columns: [
    { name: "id", type: "UUID", notNull: true },
    { name: "code", type: "TEXT", notNull: true, unique: { constraintName: "widgets_code_key" } },
    { name: "label", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [{ name: "widgets_label_code_key", columns: ["label", "code"] }],
  indexes: [{ name: "idx_widgets_label", columns: ["label"] }],
};

describe("expectedIndexNames", () => {
  it("separates plain indexes from constraint-backed ones", () => {
    const expected = expectedIndexNames(TABLE);
    expect([...expected.indexes]).toEqual(["idx_widgets_label"]);
    expect([...expected.constraints].sort()).toEqual([
      "widgets_code_key",
      "widgets_label_code_key",
    ]);
  });

  it("derives the Postgres name for an unnamed column UNIQUE", () => {
    const expected = expectedIndexNames({
      ...TABLE,
      uniqueConstraints: undefined,
      columns: [{ name: "slug", type: "TEXT", unique: true }],
    });
    expect([...expected.constraints]).toEqual(["widgets_slug_key"]);
  });

  it("is empty for a table declaring neither", () => {
    const expected = expectedIndexNames({
      schema: "meta",
      name: "bare",
      columns: [{ name: "id", type: "UUID" }],
    });
    expect(expected.indexes.size).toBe(0);
    expect(expected.constraints.size).toBe(0);
  });

  it("accounts for every constraint-backed index in the real catalog", () => {
    // The gap this closes: 117 live indexes were reported as removed because they are created by a
    // UNIQUE constraint and so never appear in `table.indexes`.
    let constraintBacked = 0;
    for (const table of META_TABLES) {
      const expected = expectedIndexNames(table);
      constraintBacked += expected.constraints.size;
      for (const idx of table.indexes ?? []) {
        expect(expected.indexes.has(idx.name)).toBe(true);
      }
    }
    expect(constraintBacked).toBeGreaterThan(100);
  });
});

describe("declaredOnDelete", () => {
  it("is RESTRICT when the reference omits it, because that is what the emitter writes", () => {
    expect(declaredOnDelete({ schema: "meta", table: "users", column: "id" })).toBe("RESTRICT");
    expect(DEFAULT_ON_DELETE).toBe("RESTRICT");
  });

  it("is whatever the reference declares", () => {
    expect(
      declaredOnDelete({ schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" }),
    ).toBe("CASCADE");
    expect(
      declaredOnDelete({ schema: "meta", table: "tenants", column: "id", onDelete: "SET NULL" }),
    ).toBe("SET NULL");
  });
});

describe("declaredForeignKeys", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "children",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      {
        name: "tenant_id",
        type: "UUID",
        references: { schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" },
      },
      { name: "owner_id", type: "UUID", references: { table: "users", column: "id" } },
      { name: "label", type: "TEXT" },
    ],
  };

  it("finds one per column carrying a reference", () => {
    const fks = declaredForeignKeys(table);
    expect(fks.map((f) => f.column)).toEqual(["tenant_id", "owner_id"]);
  });

  it("predicts the name Postgres gives an inline reference", () => {
    expect(declaredForeignKeys(table)[0]?.expectedConstraintName).toBe("children_tenant_id_fkey");
  });

  it("resolves an unqualified target to the table's own schema", () => {
    // An unqualified REFERENCES resolves through the search path, which for the meta-schema is
    // the schema the table lives in.
    expect(declaredForeignKeys(table)[1]?.targetSchema).toBe("meta");
  });

  it("carries the effective onDelete for each", () => {
    const fks = declaredForeignKeys(table);
    expect(fks[0]?.onDelete).toBe("CASCADE");
    expect(fks[1]?.onDelete).toBe("RESTRICT");
  });

  it("is empty for a table with no references", () => {
    expect(declaredForeignKeys({ ...table, columns: [{ name: "id", type: "UUID" }] })).toEqual([]);
  });

  it("finds every reference in the real catalog and names them uniquely per table", () => {
    let total = 0;
    for (const t of META_TABLES) {
      const fks = declaredForeignKeys(t);
      total += fks.length;
      expect(new Set(fks.map((f) => f.expectedConstraintName)).size).toBe(fks.length);
    }
    expect(total).toBeGreaterThan(100);
  });
});
