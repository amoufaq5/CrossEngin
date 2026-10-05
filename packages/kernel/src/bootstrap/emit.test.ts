import { describe, expect, it } from "vitest";
import {
  emitAddColumn,
  emitAddForeignKey,
  emitAddTableConstraint,
  emitAddTableConstraintIfEmpty,
  emitAddUniqueConstraint,
  emitAlterColumnTypeIfEmpty,
  emitBootstrapSql,
  emitDropConstraint,
  foreignKeyConstraintName,
  emitColumn,
  emitCreateTable,
  emitDropColumnDefault,
  emitDropColumnNotNull,
  emitIndex,
  emitReplaceIndex,
  emitRenameColumn,
  emitReplaceRlsPolicy,
  emitReplaceTableConstraint,
  emitReplaceTableConstraintIfEmpty,
  emitSetColumnDefault,
  emitRlsEnable,
  emitRlsPolicy,
  emitSchemaCreate,
  emitTable,
  emitTableConstraint,
} from "./emit.js";
import { META_SCHEMA_NAME, META_TABLES } from "./meta-schema.js";
import {
  PUBLIC_ROLE,
  REFERENTIAL_ACTIONS,
  RLS_POLICY_COMMANDS,
  TABLE_CONSTRAINT_KINDS,
  type TableConstraint,
  type TableDefinition,
} from "./types.js";

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

  it("writes neither FOR nor TO when the policy declares neither", () => {
    // The whole reason both fields are optional: `CREATE POLICY` already means `FOR ALL TO PUBLIC`,
    // so every policy in the catalog has to keep emitting the statement it emitted before.
    expect(emitRlsPolicy(minimalTable, { name: "p", using: "true" })).toBe(
      `CREATE POLICY "p" ON "meta"."x" USING (true);`,
    );
  });

  it("emits FOR <command> when a command is declared", () => {
    expect(
      emitRlsPolicy(minimalTable, { name: "p", using: "true", command: "SELECT" }),
    ).toBe(`CREATE POLICY "p" ON "meta"."x" FOR SELECT USING (true);`);
  });

  it("emits every command spelling", () => {
    for (const command of RLS_POLICY_COMMANDS) {
      expect(emitRlsPolicy(minimalTable, { name: "p", using: "true", command })).toBe(
        `CREATE POLICY "p" ON "meta"."x" FOR ${command} USING (true);`,
      );
    }
  });

  it("emits TO with quoted role names", () => {
    expect(
      emitRlsPolicy(minimalTable, { name: "p", using: "true", roles: ["app_reader"] }),
    ).toBe(`CREATE POLICY "p" ON "meta"."x" TO "app_reader" USING (true);`);
  });

  it("emits a multi-role TO list in declaration order", () => {
    expect(
      emitRlsPolicy(minimalTable, {
        name: "p",
        using: "true",
        roles: ["app_reader", "app_writer"],
      }),
    ).toBe(`CREATE POLICY "p" ON "meta"."x" TO "app_reader", "app_writer" USING (true);`);
  });

  it("leaves PUBLIC unquoted, because it is a keyword and not a role", () => {
    // `TO "PUBLIC"` names a role that does not exist, so quoting it would fail at apply time.
    expect(emitRlsPolicy(minimalTable, { name: "p", using: "true", roles: ["PUBLIC"] })).toBe(
      `CREATE POLICY "p" ON "meta"."x" TO PUBLIC USING (true);`,
    );
    expect(emitRlsPolicy(minimalTable, { name: "p", using: "true", roles: ["public"] })).toBe(
      `CREATE POLICY "p" ON "meta"."x" TO PUBLIC USING (true);`,
    );
  });

  it("omits USING entirely for a policy that declares only WITH CHECK", () => {
    // `CREATE POLICY … FOR INSERT USING (…)` is refused by Postgres: an INSERT has no existing rows
    // to filter. Before `using` was optional an INSERT-scoped policy could not be declared at all.
    expect(
      emitRlsPolicy(minimalTable, {
        name: "x_platform_write",
        command: "INSERT",
        check: "tenant_id IS NULL",
      }),
    ).toBe(
      `CREATE POLICY "x_platform_write" ON "meta"."x" FOR INSERT WITH CHECK (tenant_id IS NULL);`,
    );
  });

  it("refuses a policy that declares neither clause rather than emitting allow-everything", () => {
    // Legal SQL, and it permits every row. The one thing a policy must not be able to say by
    // omission is yes.
    expect(() => emitRlsPolicy(minimalTable, { name: "p", command: "INSERT" })).toThrow(
      /neither USING nor WITH CHECK/,
    );
  });

  it("names the offending policy and table in that refusal", () => {
    expect(() => emitRlsPolicy(minimalTable, { name: "wide_open" })).toThrow(/"wide_open"/);
    expect(() => emitRlsPolicy(minimalTable, { name: "wide_open" })).toThrow(/"meta"\."x"/);
  });

  it("orders FOR before TO before USING before WITH CHECK", () => {
    expect(
      emitRlsPolicy(minimalTable, {
        name: "p",
        using: "a",
        check: "b",
        command: "UPDATE",
        roles: ["app_writer"],
      }),
    ).toBe(
      `CREATE POLICY "p" ON "meta"."x" FOR UPDATE TO "app_writer" USING (a) WITH CHECK (b);`,
    );
  });

  it("treats an empty role list as absent rather than as a grant to nobody", () => {
    expect(emitRlsPolicy(minimalTable, { name: "p", using: "true", roles: [] })).toBe(
      `CREATE POLICY "p" ON "meta"."x" USING (true);`,
    );
  });

  it("writes no AS clause when permissiveness is not declared", () => {
    // The rule that lets the field be added at all: `CREATE POLICY` already means `AS PERMISSIVE`.
    expect(emitRlsPolicy(minimalTable, { name: "p", using: "true" })).not.toContain(" AS ");
  });

  it("emits AS RESTRICTIVE for a restrictive policy", () => {
    expect(
      emitRlsPolicy(minimalTable, { name: "p", using: "true", permissive: false }),
    ).toBe(`CREATE POLICY "p" ON "meta"."x" AS RESTRICTIVE USING (true);`);
  });

  it("emits AS PERMISSIVE when the default is spelled out", () => {
    expect(
      emitRlsPolicy(minimalTable, { name: "p", using: "true", permissive: true }),
    ).toBe(`CREATE POLICY "p" ON "meta"."x" AS PERMISSIVE USING (true);`);
  });

  it("orders AS before FOR before TO, which is the order CREATE POLICY accepts", () => {
    expect(
      emitRlsPolicy(minimalTable, {
        name: "p",
        using: "a",
        check: "b",
        permissive: false,
        command: "UPDATE",
        roles: ["app_writer"],
      }),
    ).toBe(
      `CREATE POLICY "p" ON "meta"."x" AS RESTRICTIVE FOR UPDATE TO "app_writer" ` +
        `USING (a) WITH CHECK (b);`,
    );
  });

  it("carries permissiveness through a replacement, so a restrictive policy is replaced as one", () => {
    const sql = emitReplaceRlsPolicy(minimalTable, {
      name: "p",
      using: "true",
      permissive: false,
    });
    expect(sql).toBe(
      `DROP POLICY "p" ON "meta"."x"; CREATE POLICY "p" ON "meta"."x" AS RESTRICTIVE USING (true);`,
    );
  });
});

describe("emitTableConstraint", () => {
  it("lists the kinds a table-level constraint can have", () => {
    expect([...TABLE_CONSTRAINT_KINDS]).toEqual(["check", "foreign_key", "unique"]);
  });

  it("lists the referential actions", () => {
    expect([...REFERENTIAL_ACTIONS]).toEqual([
      "NO ACTION",
      "RESTRICT",
      "CASCADE",
      "SET NULL",
      "SET DEFAULT",
    ]);
  });

  it("emits a cross-column CHECK", () => {
    expect(
      emitTableConstraint({
        kind: "check",
        name: "x_bounds_check",
        expression: "bounces_count <= recipient_count",
      }),
    ).toBe(`CONSTRAINT "x_bounds_check" CHECK (bounces_count <= recipient_count)`);
  });

  it("emits a composite UNIQUE", () => {
    expect(
      emitTableConstraint({ kind: "unique", name: "x_pair_key", columns: ["a", "b"] }),
    ).toBe(`CONSTRAINT "x_pair_key" UNIQUE ("a", "b")`);
  });

  it("emits a composite FOREIGN KEY with ON DELETE defaulting to RESTRICT", () => {
    // RESTRICT is what `emitColumn` already writes for an inline reference that omits the action, and
    // what the reconciling side reads an omitted action as.
    expect(
      emitTableConstraint({
        kind: "foreign_key",
        name: "x_parent_fkey",
        columns: ["tenant_id", "parent_id"],
        references: { schema: "meta", table: "parents", columns: ["tenant_id", "id"] },
      }),
    ).toBe(
      `CONSTRAINT "x_parent_fkey" FOREIGN KEY ("tenant_id", "parent_id") ` +
        `REFERENCES "meta"."parents"("tenant_id", "id") ON DELETE RESTRICT`,
    );
  });

  it("emits a declared ON DELETE and ON UPDATE", () => {
    expect(
      emitTableConstraint({
        kind: "foreign_key",
        name: "x_parent_fkey",
        columns: ["parent_id"],
        references: { schema: "meta", table: "parents", columns: ["id"] },
        onDelete: "CASCADE",
        onUpdate: "SET NULL",
      }),
    ).toContain("ON DELETE CASCADE ON UPDATE SET NULL");
  });

  it("writes no ON UPDATE when it is not declared, since omitting it means NO ACTION", () => {
    expect(
      emitTableConstraint({
        kind: "foreign_key",
        name: "x_parent_fkey",
        columns: ["parent_id"],
        references: { table: "parents", columns: ["id"] },
      }),
    ).not.toContain("ON UPDATE");
  });

  it("leaves an unqualified target unqualified, to resolve through the search path", () => {
    expect(
      emitTableConstraint({
        kind: "foreign_key",
        name: "x_parent_fkey",
        columns: ["parent_id"],
        references: { table: "parents", columns: ["id"] },
      }),
    ).toContain(`REFERENCES "parents"("id")`);
  });

  it("refuses an unsafe identifier rather than interpolating it", () => {
    expect(() =>
      emitTableConstraint({ kind: "check", name: 'x"; DROP', expression: "true" }),
    ).toThrow(/unsafe SQL identifier/);
    expect(() =>
      emitTableConstraint({ kind: "unique", name: "ok", columns: ['a"; DROP'] }),
    ).toThrow(/unsafe SQL identifier/);
  });
});

describe("emitCreateTable — table-level constraints", () => {
  const base: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "tenant_id", type: "UUID", notNull: true },
      { name: "recipient_count", type: "INTEGER", notNull: true },
      { name: "bounces_count", type: "INTEGER", notNull: true },
    ],
    primaryKey: ["id"],
  };

  it("emits nothing extra when no constraints are declared", () => {
    // The byte-identity rule: a table that declares none emits exactly what it emitted before the
    // field existed.
    expect(emitCreateTable(base)).toBe(
      `CREATE TABLE "meta"."comms" (\n` +
        `  "id" UUID NOT NULL,\n` +
        `  "tenant_id" UUID NOT NULL,\n` +
        `  "recipient_count" INTEGER NOT NULL,\n` +
        `  "bounces_count" INTEGER NOT NULL,\n` +
        `  PRIMARY KEY ("id")\n` +
        `);`,
    );
    expect(emitCreateTable({ ...base, constraints: [] })).toBe(emitCreateTable(base));
  });

  it("emits a cross-column CHECK as a table-level line, not an ALTER afterwards", () => {
    const sql = emitCreateTable({
      ...base,
      constraints: [
        {
          kind: "check",
          name: "comms_bounces_check",
          expression: "bounces_count <= recipient_count",
        },
      ],
    });
    expect(sql).toContain(
      `  CONSTRAINT "comms_bounces_check" CHECK (bounces_count <= recipient_count)`,
    );
    expect(sql).not.toContain("ALTER TABLE");
    expect(sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);
  });

  it("emits a composite foreign key inside the CREATE TABLE", () => {
    const sql = emitCreateTable({
      ...base,
      constraints: [
        {
          kind: "foreign_key",
          name: "comms_incident_fkey",
          columns: ["tenant_id", "id"],
          references: { schema: "meta", table: "incidents", columns: ["tenant_id", "id"] },
          onDelete: "CASCADE",
        },
      ],
    });
    expect(sql).toContain(
      `  CONSTRAINT "comms_incident_fkey" FOREIGN KEY ("tenant_id", "id") ` +
        `REFERENCES "meta"."incidents"("tenant_id", "id") ON DELETE CASCADE`,
    );
  });

  it("puts the new constraints after the pre-existing table-level lines", () => {
    const sql = emitCreateTable({
      ...base,
      uniqueConstraints: [{ name: "comms_tenant_id_key", columns: ["tenant_id", "id"] }],
      constraints: [{ kind: "check", name: "comms_positive_check", expression: "recipient_count > 0" }],
    });
    const lines = sql.split("\n");
    expect(lines.findIndex((l) => l.includes("PRIMARY KEY"))).toBeLessThan(
      lines.findIndex((l) => l.includes("comms_tenant_id_key")),
    );
    expect(lines.findIndex((l) => l.includes("comms_tenant_id_key"))).toBeLessThan(
      lines.findIndex((l) => l.includes("comms_positive_check")),
    );
  });

  it("emits several constraints in declaration order", () => {
    const constraints: readonly TableConstraint[] = [
      { kind: "check", name: "c1", expression: "a" },
      { kind: "unique", name: "c2", columns: ["id"] },
      {
        kind: "foreign_key",
        name: "c3",
        columns: ["tenant_id"],
        references: { table: "tenants", columns: ["id"] },
      },
    ];
    const sql = emitCreateTable({ ...base, constraints });
    const order = ["c1", "c2", "c3"].map((n) => sql.indexOf(`"${n}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });
});

describe("guarded table-constraint emitters", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [{ name: "id", type: "UUID", notNull: true }],
    primaryKey: ["id"],
  };
  const check: TableConstraint = {
    kind: "check",
    name: "comms_window_check",
    expression: "published_at <= deadline_at",
  };

  it("re-checks emptiness in the statement, not only when the plan was built", () => {
    const sql = emitAddTableConstraintIfEmpty(table, check);
    expect(sql).toContain("SELECT count(*) INTO existing FROM \"meta\".\"comms\"");
    expect(sql).toContain("IF existing > 0 THEN");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("refusing to add constraint comms_window_check to meta.comms");
  });

  it("adds the constraint once the guard passes", () => {
    expect(emitAddTableConstraintIfEmpty(table, check)).toContain(
      `ALTER TABLE "meta"."comms" ADD CONSTRAINT "comms_window_check" ` +
        `CHECK (published_at <= deadline_at);`,
    );
  });

  it("never uses NOT VALID, which would record a rule the data may violate", () => {
    expect(emitAddTableConstraintIfEmpty(table, check)).not.toContain("NOT VALID");
    expect(emitReplaceTableConstraintIfEmpty(table, check)).not.toContain("NOT VALID");
  });

  it("drops before adding, inside the same guarded block, when it replaces one", () => {
    const sql = emitReplaceTableConstraintIfEmpty(table, check);
    const drop = sql.indexOf("DROP CONSTRAINT");
    const add = sql.indexOf("ADD CONSTRAINT");
    expect(drop).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(drop);
    expect(sql.indexOf("IF existing > 0")).toBeLessThan(drop);
    expect(sql.startsWith("DO $$")).toBe(true);
    expect(sql.endsWith("END $$;")).toBe(true);
  });

  it("tolerates the constraint already being gone on a replacement", () => {
    expect(emitReplaceTableConstraintIfEmpty(table, check)).toContain(
      "DROP CONSTRAINT IF EXISTS",
    );
  });

  it("drops the name the database holds, not the declared one, when told they differ", () => {
    expect(emitReplaceTableConstraintIfEmpty(table, check, "comms_legacy_check")).toContain(
      `DROP CONSTRAINT IF EXISTS "comms_legacy_check";`,
    );
  });

  it("drops the declared name when no live name is given", () => {
    expect(emitReplaceTableConstraintIfEmpty(table, check)).toContain(
      `DROP CONSTRAINT IF EXISTS "comms_window_check";`,
    );
  });
});

describe("unguarded table-constraint emitters", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [
      { name: "tenant_id", type: "UUID", notNull: true },
      { name: "id", type: "UUID", notNull: true },
    ],
    primaryKey: ["id"],
  };
  const fk: TableConstraint = {
    kind: "foreign_key",
    name: "comms_incident_fkey",
    columns: ["tenant_id", "id"],
    references: { schema: "meta", table: "incidents", columns: ["tenant_id", "id"] },
    onDelete: "CASCADE",
  };

  it("adds a composite foreign key in one plain statement", () => {
    expect(emitAddTableConstraint(table, fk)).toBe(
      `ALTER TABLE "meta"."comms" ADD CONSTRAINT "comms_incident_fkey" ` +
        `FOREIGN KEY ("tenant_id", "id") REFERENCES "meta"."incidents"("tenant_id", "id") ` +
        `ON DELETE CASCADE;`,
    );
  });

  it("does not guard on emptiness, by the same rule as emitAddForeignKey", () => {
    expect(emitAddTableConstraint(table, fk)).not.toContain("count(*)");
    expect(emitAddTableConstraint(table, fk)).not.toContain("DO $$");
  });

  it("replaces in one statement, so the table is never committed without the key", () => {
    const sql = emitReplaceTableConstraint(table, fk);
    const drop = sql.indexOf("DROP CONSTRAINT");
    const add = sql.indexOf("ADD CONSTRAINT");
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(drop);
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "comms_incident_fkey";`);
  });

  it("replaces under the live name when the database holds another", () => {
    expect(emitReplaceTableConstraint(table, fk, "comms_tenant_id_id_fkey")).toContain(
      `DROP CONSTRAINT IF EXISTS "comms_tenant_id_id_fkey";`,
    );
  });
});

describe("emitRenameColumn", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "feature_flags",
    columns: [{ name: "default_json", type: "JSONB", renamedFrom: "default_value" }],
  };
  const sql = emitRenameColumn(table, "default_value", "default_json");

  it("renames the column", () => {
    expect(sql).toContain(
      `ALTER TABLE "meta"."feature_flags" RENAME COLUMN "default_value" TO "default_json";`,
    );
  });

  it("re-checks both names in its own transaction", () => {
    expect(sql.startsWith("DO $$")).toBe(true);
    expect(sql.endsWith("END $$;")).toBe(true);
    expect(sql).toContain(`attname = 'default_value'`);
    expect(sql).toContain(`attname = 'default_json'`);
    expect(sql).toContain("NOT attisdropped");
  });

  it("refuses when both columns exist, rather than picking one", () => {
    expect(sql).toContain("IF has_old AND has_new THEN");
    expect(sql).toContain("both columns exist");
  });

  it("is a no-op when only the new name exists, so a retry does not fail", () => {
    // `ELSIF NOT has_new` is the whole rule: old gone and new present means the rename already
    // happened, which an applier re-running a statement has to tolerate.
    expect(sql).toContain("ELSIF NOT has_new THEN");
    expect(sql).toContain("neither column exists");
  });

  it("never reads or writes a row, so it is safe on a populated table", () => {
    expect(sql).not.toContain("count(*)");
  });

  it("leaves emission alone — renamedFrom is history, not DDL", () => {
    expect(emitCreateTable(table)).toBe(
      `CREATE TABLE "meta"."feature_flags" (\n  "default_json" JSONB\n);`,
    );
  });
});

describe("the catalog's own emission is unchanged", () => {
  /**
   * The rule that let `constraints` and `permissive` be added at all. Nothing in the catalog declares
   * either yet, so nothing in the emitted SQL may mention them — written against live `META_TABLES`
   * so a table added later cannot quietly change what the other hundred-odd emit.
   */
  const statements = emitBootstrapSql(META_SCHEMA_NAME, META_TABLES);

  it("writes no AS PERMISSIVE or AS RESTRICTIVE anywhere", () => {
    expect(statements.filter((s) => / AS (PERMISSIVE|RESTRICTIVE)/.test(s))).toEqual([]);
  });

  it("writes a table-level CHECK line only for the table that declares one", () => {
    // A column's own CHECK and inline REFERENCES are written on the column, so a `CONSTRAINT … `
    // line appears only where `constraints` is used — the tables with a genuinely cross-column rule.
    // Named rather than counted, so a table gaining one by accident still fails here.
    const withCheckLine = statements
      .filter((sql) => /CONSTRAINT "[^"]+" CHECK \(/.test(sql))
      .map((sql) => /CREATE TABLE "meta"\."([^"]+)"/.exec(sql)?.[1] ?? "?")
      .sort();
    expect(withCheckLine).toEqual([
      "incident_communications",
      "notification_read_watermarks",
      "notification_user_quiet_hours",
      "tenant_tombstones",
      "workflow_definitions",
    ]);
    for (const sql of statements) {
      expect(sql).not.toMatch(/CONSTRAINT "[^"]+" FOREIGN KEY \(/);
    }
  });

  it("declares a table-level constraint only where intended, and no permissiveness anywhere", () => {
    const declaring = META_TABLES.filter((t) => t.constraints !== undefined)
      .map((t) => t.name)
      .sort();
    expect(declaring).toEqual([
      "incident_communications",
      "notification_read_watermarks",
      "notification_user_quiet_hours",
      "tenant_tombstones",
      "workflow_definitions",
    ]);
    for (const table of META_TABLES) {
      for (const policy of table.rls?.policies ?? []) {
        // Nothing declares permissiveness yet; a restrictive policy added by hand would still be
        // detected, which is the point of ADR-0298 — but the catalog itself must stay silent, or
        // every existing policy's emitted SQL would change.
        expect(policy.permissive, `${table.name}.${policy.name}`).toBeUndefined();
      }
    }
  });
});

describe("RLS_POLICY_COMMANDS", () => {
  it("lists the commands a policy can be scoped to", () => {
    expect([...RLS_POLICY_COMMANDS]).toEqual(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("spells PUBLIC the way CREATE POLICY does", () => {
    expect(PUBLIC_ROLE).toBe("PUBLIC");
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

describe("foreign-key and type-change emitters", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "children",
    columns: [{ name: "id", type: "UUID", notNull: true }],
    primaryKey: ["id"],
  };

  it("foreignKeyConstraintName matches what Postgres names an inline reference", () => {
    expect(foreignKeyConstraintName("children", "tenant_id")).toBe("children_tenant_id_fkey");
  });

  it("emitAddForeignKey names the constraint so a later introspection matches it", () => {
    const sql = emitAddForeignKey(
      table,
      "tenant_id",
      { schema: "meta", table: "tenants", column: "id" },
      "CASCADE",
    );
    expect(sql).toContain('ALTER TABLE "meta"."children"');
    expect(sql).toContain('ADD CONSTRAINT "children_tenant_id_fkey"');
    expect(sql).toContain('FOREIGN KEY ("tenant_id") REFERENCES "meta"."tenants"("id")');
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("emitAddForeignKey leaves an unqualified target unqualified", () => {
    const sql = emitAddForeignKey(table, "owner_id", { table: "users", column: "id" }, "RESTRICT");
    expect(sql).toContain('REFERENCES "users"("id")');
  });

  it("emitDropConstraint tolerates the constraint already being gone", () => {
    expect(emitDropConstraint(table, "children_tenant_id_fkey")).toBe(
      'ALTER TABLE "meta"."children" DROP CONSTRAINT IF EXISTS "children_tenant_id_fkey";',
    );
  });

  it("emitAlterColumnTypeIfEmpty re-checks emptiness in the same transaction", () => {
    // The plan's row count was taken earlier; this is what stops a row inserted since then from
    // being silently rewritten.
    const sql = emitAlterColumnTypeIfEmpty(table, "owner_id", "text");
    expect(sql).toContain("SELECT count(*) INTO existing FROM \"meta\".\"children\"");
    expect(sql).toContain("IF existing > 0 THEN");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain('ALTER COLUMN "owner_id" TYPE text USING "owner_id"::text');
  });

  it("emitAlterColumnTypeIfEmpty names the column in its refusal", () => {
    expect(emitAlterColumnTypeIfEmpty(table, "owner_id", "text")).toContain(
      "meta.children.owner_id",
    );
  });

  it("refuses unsafe identifiers in every new emitter", () => {
    expect(() => emitDropConstraint(table, "od'd")).toThrow(/unsafe SQL identifier/);
    expect(() => emitAlterColumnTypeIfEmpty(table, "od'd", "text")).toThrow(
      /unsafe SQL identifier/,
    );
    expect(() =>
      emitAddForeignKey(table, "od'd", { table: "users", column: "id" }, "RESTRICT"),
    ).toThrow(/unsafe SQL identifier/);
  });
});

describe("atomic replacement emitters", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "widgets",
    columns: [{ name: "id", type: "UUID", notNull: true }, { name: "status", type: "TEXT" }],
    primaryKey: ["id"],
  };

  it("emitReplaceIndex drops and creates in one statement", () => {
    // The applier wraps each statement in its own transaction, so two statements would leave a
    // window with the index gone.
    const sql = emitReplaceIndex(table, {
      name: "idx_widgets_status",
      columns: ["status"],
      where: "status = 'open'",
    });
    expect(sql).toContain('DROP INDEX "meta"."idx_widgets_status";');
    expect(sql).toContain('CREATE INDEX "idx_widgets_status"');
    expect(sql).toContain("WHERE status = 'open'");
  });

  it("emitReplaceIndex preserves uniqueness and the access method", () => {
    const sql = emitReplaceIndex(table, {
      name: "idx_widgets_status",
      columns: ["status"],
      unique: true,
      kind: "gin",
    });
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("USING GIN");
  });

  it("emitReplaceRlsPolicy drops and creates in one statement", () => {
    // RLS on with no policy denies every row, so a window here is an outage, not a leak — and one
    // statement means there is no window.
    const sql = emitReplaceRlsPolicy(table, {
      name: "widgets_isolation",
      using: "tenant_id IS NOT NULL",
    });
    expect(sql).toContain('DROP POLICY "widgets_isolation" ON "meta"."widgets";');
    expect(sql).toContain('CREATE POLICY "widgets_isolation"');
    expect(sql).toContain("USING (tenant_id IS NOT NULL)");
  });

  it("emitReplaceRlsPolicy carries a WITH CHECK clause through", () => {
    const sql = emitReplaceRlsPolicy(table, {
      name: "widgets_isolation",
      using: "a",
      check: "b",
    });
    expect(sql).toContain("WITH CHECK (b)");
  });

  it("emitReplaceRlsPolicy carries the command and the roles through", () => {
    // A command or role list that changed is repaired by the same replacement, so the re-created
    // policy has to carry them or the repair would silently widen the grant to FOR ALL TO PUBLIC.
    const sql = emitReplaceRlsPolicy(table, {
      name: "widgets_isolation",
      using: "a",
      command: "SELECT",
      roles: ["app_reader"],
    });
    expect(sql).toBe(
      `DROP POLICY "widgets_isolation" ON "meta"."widgets"; ` +
        `CREATE POLICY "widgets_isolation" ON "meta"."widgets" FOR SELECT TO "app_reader" USING (a);`,
    );
  });

  it("both refuse an unsafe identifier", () => {
    expect(() =>
      emitReplaceIndex(table, { name: "od'd", columns: ["status"] }),
    ).toThrow(/unsafe SQL identifier/);
    expect(() =>
      emitReplaceRlsPolicy(table, { name: "od'd", using: "a" }),
    ).toThrow(/unsafe SQL identifier/);
    expect(() =>
      emitRlsPolicy(table, { name: "p", using: "a", roles: ["od'd"] }),
    ).toThrow(/unsafe SQL identifier/);
  });
});

describe("the catalog's own policies", () => {
  /**
   * The rule that let `command` and `roles` be added at all: a policy declaring neither emits the
   * statement it emitted before they existed. Written against the live catalog rather than a fixture,
   * so a policy added later cannot quietly change what the other hundred emit.
   */
  it("emit exactly the pre-scoping statement when they declare neither command nor roles", () => {
    let checked = 0;
    for (const table of META_TABLES) {
      for (const policy of table.rls?.policies ?? []) {
        if (policy.command !== undefined || policy.roles !== undefined) continue;
        const check = policy.check !== undefined ? ` WITH CHECK (${policy.check})` : "";
        expect(emitRlsPolicy(table, policy)).toBe(
          `CREATE POLICY "${policy.name}" ON "${table.schema}"."${table.name}" ` +
            `USING (${policy.using})${check};`,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
