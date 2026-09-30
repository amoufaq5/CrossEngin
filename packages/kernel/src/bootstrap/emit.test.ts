import { describe, expect, it } from "vitest";
import {
  emitAddColumn,
  emitAddUniqueConstraint,
  emitColumn,
  emitCreateTable,
  emitDropColumnDefault,
  emitDropColumnNotNull,
  emitIndex,
  emitSetColumnDefault,
  emitRlsEnable,
  emitRlsPolicy,
  emitSchemaCreate,
  emitTable,
} from "./emit.js";
import type { TableDefinition } from "./types.js";

describe("emitSchemaCreate", () => {
  it("emits CREATE SCHEMA IF NOT EXISTS", () => {
    expect(emitSchemaCreate("meta")).toBe(`CREATE SCHEMA IF NOT EXISTS "meta";`);
  });
});

describe("emitColumn", () => {
  it("emits a minimal column", () => {
    expect(emitColumn({ name: "name", type: "TEXT" })).toBe(`"name" TEXT`);
  });

  it("adds NOT NULL", () => {
    expect(emitColumn({ name: "x", type: "INTEGER", notNull: true })).toBe(
      `"x" INTEGER NOT NULL`,
    );
  });

  it("adds DEFAULT verbatim (raw SQL expression)", () => {
    expect(emitColumn({ name: "ts", type: "TIMESTAMPTZ", default: "now()" })).toBe(
      `"ts" TIMESTAMPTZ DEFAULT now()`,
    );
  });

  it("adds inline UNIQUE for boolean unique", () => {
    expect(emitColumn({ name: "slug", type: "TEXT", unique: true })).toBe(
      `"slug" TEXT UNIQUE`,
    );
  });

  it("does NOT add inline UNIQUE for object unique (named constraint emits separately)", () => {
    expect(
      emitColumn({
        name: "slug",
        type: "TEXT",
        unique: { constraintName: "x_slug_key" },
      }),
    ).toBe(`"slug" TEXT`);
  });

  it("adds CHECK", () => {
    expect(
      emitColumn({
        name: "status",
        type: "TEXT",
        check: "status IN ('a', 'b')",
      }),
    ).toBe(`"status" TEXT CHECK (status IN ('a', 'b'))`);
  });

  it("emits FK references with default RESTRICT", () => {
    expect(
      emitColumn({
        name: "user_id",
        type: "UUID",
        notNull: true,
        references: { schema: "meta", table: "users", column: "id" },
      }),
    ).toBe(`"user_id" UUID NOT NULL REFERENCES "meta"."users"("id") ON DELETE RESTRICT`);
  });

  it("emits FK references with CASCADE", () => {
    expect(
      emitColumn({
        name: "tenant_id",
        type: "UUID",
        references: { schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" },
      }),
    ).toBe(`"tenant_id" UUID REFERENCES "meta"."tenants"("id") ON DELETE CASCADE`);
  });
});

const minimalTable: TableDefinition = {
  schema: "meta",
  name: "x",
  columns: [
    { name: "id", type: "UUID", notNull: true },
    { name: "name", type: "TEXT", notNull: true },
  ],
  primaryKey: ["id"],
};

describe("emitCreateTable", () => {
  it("emits a basic CREATE TABLE with PRIMARY KEY", () => {
    expect(emitCreateTable(minimalTable)).toBe(
      `CREATE TABLE "meta"."x" (\n` +
        `  "id" UUID NOT NULL,\n` +
        `  "name" TEXT NOT NULL,\n` +
        `  PRIMARY KEY ("id")\n` +
        `);`,
    );
  });

  it("emits composite UNIQUE constraints at the table level", () => {
    const def: TableDefinition = {
      schema: "meta",
      name: "membership",
      columns: [
        { name: "id", type: "UUID", notNull: true },
        { name: "user_id", type: "UUID", notNull: true },
        { name: "tenant_id", type: "UUID", notNull: true },
      ],
      primaryKey: ["id"],
      uniqueConstraints: [
        { name: "membership_user_tenant_key", columns: ["user_id", "tenant_id"] },
      ],
    };
    const sql = emitCreateTable(def);
    expect(sql).toContain(
      `  CONSTRAINT "membership_user_tenant_key" UNIQUE ("user_id", "tenant_id")`,
    );
  });

  it("emits named UNIQUE constraints from column-level object form", () => {
    const def: TableDefinition = {
      schema: "meta",
      name: "users",
      columns: [
        { name: "id", type: "UUID", notNull: true },
        {
          name: "email",
          type: "TEXT",
          notNull: true,
          unique: { constraintName: "users_email_key" },
        },
      ],
      primaryKey: ["id"],
    };
    const sql = emitCreateTable(def);
    expect(sql).toContain(`  CONSTRAINT "users_email_key" UNIQUE ("email")`);
  });
});

describe("emitIndex", () => {
  it("emits a basic btree index", () => {
    expect(
      emitIndex(minimalTable, { name: "idx_x_name", columns: ["name"] }),
    ).toBe(`CREATE INDEX "idx_x_name" ON "meta"."x" ("name");`);
  });

  it("emits a unique index", () => {
    expect(
      emitIndex(minimalTable, {
        name: "idx_x_name_unique",
        columns: ["name"],
        unique: true,
      }),
    ).toBe(`CREATE UNIQUE INDEX "idx_x_name_unique" ON "meta"."x" ("name");`);
  });

  it("emits a GIN index", () => {
    expect(
      emitIndex(minimalTable, {
        name: "idx_x_jsonb",
        columns: ["name"],
        kind: "gin",
      }),
    ).toBe(`CREATE INDEX "idx_x_jsonb" ON "meta"."x" USING GIN ("name");`);
  });

  it("emits a multi-column index", () => {
    expect(
      emitIndex(minimalTable, {
        name: "idx_x_a_b",
        columns: ["id", "name"],
      }),
    ).toBe(`CREATE INDEX "idx_x_a_b" ON "meta"."x" ("id", "name");`);
  });

  it("omits WHERE entirely when the index is not partial", () => {
    expect(
      emitIndex(minimalTable, { name: "idx_x_name", columns: ["name"], where: undefined }),
    ).toBe(`CREATE INDEX "idx_x_name" ON "meta"."x" ("name");`);
  });

  it("emits a partial index with a WHERE predicate", () => {
    expect(
      emitIndex(minimalTable, {
        name: "idx_x_name_active",
        columns: ["name"],
        where: "status = 'active'",
      }),
    ).toBe(`CREATE INDEX "idx_x_name_active" ON "meta"."x" ("name") WHERE status = 'active';`);
  });

  it("emits a partial UNIQUE index (at-most-one-active invariant)", () => {
    expect(
      emitIndex(minimalTable, {
        name: "uq_x_active",
        columns: ["id"],
        unique: true,
        where: "status = 'active'",
      }),
    ).toBe(`CREATE UNIQUE INDEX "uq_x_active" ON "meta"."x" ("id") WHERE status = 'active';`);
  });

  it("emits a partial index alongside USING and multiple columns", () => {
    expect(
      emitIndex(minimalTable, {
        name: "idx_x_gin_partial",
        columns: ["id", "name"],
        kind: "gin",
        where: "name IS NOT NULL",
      }),
    ).toBe(
      `CREATE INDEX "idx_x_gin_partial" ON "meta"."x" USING GIN ("id", "name") WHERE name IS NOT NULL;`,
    );
  });
});

describe("emitRlsEnable", () => {
  it("emits ENABLE ROW LEVEL SECURITY", () => {
    expect(emitRlsEnable(minimalTable)).toBe(
      `ALTER TABLE "meta"."x" ENABLE ROW LEVEL SECURITY;`,
    );
  });
});

describe("emitRlsPolicy", () => {
  it("emits a CREATE POLICY with USING", () => {
    expect(
      emitRlsPolicy(minimalTable, {
        name: "x_isolation",
        using: "tenant_id = current_setting('app.current_tenant_id')::UUID",
      }),
    ).toBe(
      `CREATE POLICY "x_isolation" ON "meta"."x" USING (tenant_id = current_setting('app.current_tenant_id')::UUID);`,
    );
  });

  it("emits a CREATE POLICY with WITH CHECK", () => {
    expect(
      emitRlsPolicy(minimalTable, {
        name: "x_isolation",
        using: "x = y",
        check: "x = y",
      }),
    ).toBe(`CREATE POLICY "x_isolation" ON "meta"."x" USING (x = y) WITH CHECK (x = y);`);
  });
});

describe("emitTable", () => {
  it("emits CREATE TABLE + indexes + RLS in order", () => {
    const def: TableDefinition = {
      schema: "meta",
      name: "x",
      columns: [
        { name: "id", type: "UUID", notNull: true },
        { name: "tenant_id", type: "UUID", notNull: true },
      ],
      primaryKey: ["id"],
      indexes: [{ name: "idx_x_tenant", columns: ["tenant_id"] }],
      rls: {
        enabled: true,
        policies: [
          { name: "x_isolation", using: "tenant_id = current_setting('a')::UUID" },
        ],
      },
    };
    const statements = emitTable(def);
    expect(statements[0]).toMatch(/^CREATE TABLE/);
    expect(statements[1]).toMatch(/^CREATE INDEX/);
    expect(statements[2]).toMatch(/^ALTER TABLE.*ENABLE ROW LEVEL SECURITY/);
    expect(statements[3]).toMatch(/^CREATE POLICY/);
    expect(statements).toHaveLength(4);
  });
});

describe("migration emitters", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "kind", type: "TEXT", notNull: true, default: "'basic'", check: "kind <> ''" },
      { name: "owner", type: "UUID", references: { schema: "meta", table: "users", column: "id" } },
    ],
    primaryKey: ["id"],
  };

  it("emitAddColumn tolerates the column having appeared already", () => {
    // A plan is computed from a live schema and applied a moment later.
    const sql = emitAddColumn(table, table.columns[1] as never);
    expect(sql).toContain('ALTER TABLE "meta"."widgets" ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('"kind" TEXT NOT NULL DEFAULT \'basic\'');
  });

  it("emitAddColumn carries the column's check and reference", () => {
    expect(emitAddColumn(table, table.columns[1] as never)).toContain("CHECK (kind <> '')");
    expect(emitAddColumn(table, table.columns[2] as never)).toContain('REFERENCES "meta"."users"');
  });

  it("emitAddUniqueConstraint guards on pg_constraint, since Postgres has no IF NOT EXISTS", () => {
    const sql = emitAddUniqueConstraint(table, "widgets_kind_key", ["kind", "id"]);
    expect(sql).toContain("SELECT 1 FROM pg_constraint");
    expect(sql).toContain("conname = 'widgets_kind_key'");
    expect(sql).toContain("'meta.widgets'::regclass");
    expect(sql).toContain('ADD CONSTRAINT "widgets_kind_key" UNIQUE ("kind", "id")');
  });

  it("emitAddUniqueConstraint refuses an unsafe constraint name outright", () => {
    // The name is interpolated into both an identifier and a string literal, so it is rejected by
    // `quoteIdent` before it can reach either — failing closed rather than escaping and hoping.
    expect(() => emitAddUniqueConstraint(table, "od'd", ["id"])).toThrow(/unsafe SQL identifier/);
    expect(() => emitAddUniqueConstraint(table, "ok_name", ["od'd"])).toThrow(
      /unsafe SQL identifier/,
    );
  });

  it("emitSetColumnDefault and emitDropColumnDefault touch only the default", () => {
    expect(emitSetColumnDefault(table, "kind", "'basic'")).toBe(
      'ALTER TABLE "meta"."widgets" ALTER COLUMN "kind" SET DEFAULT \'basic\';',
    );
    expect(emitDropColumnDefault(table, "kind")).toBe(
      'ALTER TABLE "meta"."widgets" ALTER COLUMN "kind" DROP DEFAULT;',
    );
  });

  it("emitDropColumnNotNull relaxes nullability", () => {
    expect(emitDropColumnNotNull(table, "kind")).toBe(
      'ALTER TABLE "meta"."widgets" ALTER COLUMN "kind" DROP NOT NULL;',
    );
  });

  it("emits no statement that drops a column, table or policy", () => {
    const all = [
      emitAddColumn(table, table.columns[1] as never),
      emitAddUniqueConstraint(table, "k", ["id"]),
      emitSetColumnDefault(table, "kind", "'b'"),
      emitDropColumnDefault(table, "kind"),
      emitDropColumnNotNull(table, "kind"),
    ].join("\n");
    expect(all).not.toMatch(/DROP (TABLE|COLUMN|POLICY|INDEX)/);
  });
});
