import { describe, expect, it } from "vitest";
import {
  emitAddColumn,
  emitAddForeignKey,
  emitAddUniqueConstraint,
  emitAlterColumnTypeIfEmpty,
  emitDropConstraint,
  foreignKeyConstraintName,
  emitColumn,
  emitCreateTable,
  emitDropColumnDefault,
  emitDropColumnNotNull,
  emitIndex,
  emitReplaceIndex,
  emitReplaceRlsPolicy,
  emitSetColumnDefault,
  emitRlsEnable,
  emitRlsPolicy,
  emitSchemaCreate,
  emitTable,
} from "./emit.js";
import { META_TABLES } from "./meta-schema.js";
import { PUBLIC_ROLE, RLS_POLICY_COMMANDS, type TableDefinition } from "./types.js";

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
