import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  CHECK_CONSTRAINT_QUERY,
  COLUMN_QUERY,
  CONFUPDTYPE_TO_ACTION,
  FOREIGN_KEY_QUERY,
  INDEX_QUERY,
  POLICY_QUERY,
  TABLE_QUERY,
  introspectSchema,
  parseLiveSchema,
  type CheckConstraintRow,
  type ColumnRow,
  type ForeignKeyRow,
  type IndexRow,
  type LiveForeignKey,
  type LivePolicy,
  type PolicyRow,
  type TableRow,
} from "./introspection.js";

describe("query constants", () => {
  it("declare a parameterized schema filter", () => {
    expect(TABLE_QUERY).toContain("nspname = $1");
    expect(COLUMN_QUERY).toContain("nspname = $1");
    expect(INDEX_QUERY).toContain("nspname = $1");
    expect(POLICY_QUERY).toContain("nspname = $1");
  });

  it("use pg_catalog views without database name interpolation", () => {
    for (const q of [TABLE_QUERY, COLUMN_QUERY, INDEX_QUERY, POLICY_QUERY]) {
      expect(q).not.toMatch(/postgres|crossengin|tenant/i);
    }
  });
});

describe("parseLiveSchema", () => {
  it("returns an empty schema when no tables exist", () => {
    const live = parseLiveSchema("meta", [], [], [], []);
    expect(live.schema).toBe("meta");
    expect(live.tables).toEqual([]);
  });

  it("assembles a table with its columns, indexes, and policies", () => {
    const tables: TableRow[] = [
      { schema: "meta", name: "tenants", rls_enabled: true },
    ];
    const columns: ColumnRow[] = [
      {
        table_name: "tenants",
        column_name: "id",
        data_type: "uuid",
        not_null: true,
        default_expr: "uuid_generate_v7()",
        attnum: 1,
      },
      {
        table_name: "tenants",
        column_name: "name",
        data_type: "text",
        not_null: true,
        default_expr: null,
        attnum: 2,
      },
    ];
    const indexes: IndexRow[] = [
      {
        table_name: "tenants",
        index_name: "tenants_pkey",
        is_unique: true,
        is_primary: true,
        constraint_backed: true,
        method: "btree",
        predicate: null,
        columns: ["id"],
      },
    ];
    const policies: PolicyRow[] = [
      {
        table_name: "tenants",
        policy_name: "tenant_isolation",
        using_expr: "id = current_setting('app.current_tenant_id', true)::uuid",
        check_expr: null,
        command: "*",
        roles: ["PUBLIC"],
        role_count: 1,
      },
    ];
    const live = parseLiveSchema("meta", tables, columns, indexes, policies);
    expect(live.tables).toHaveLength(1);
    const table = live.tables[0]!;
    expect(table.name).toBe("tenants");
    expect(table.rlsEnabled).toBe(true);
    expect(table.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(table.columns[0]?.defaultExpr).toBe("uuid_generate_v7()");
    expect(table.columns[1]?.defaultExpr).toBeNull();
    expect(table.indexes[0]?.primary).toBe(true);
    expect(table.policies[0]?.name).toBe("tenant_isolation");
    expect(table.policies[0]?.command).toBe("ALL");
    expect(table.policies[0]?.roles).toEqual(["PUBLIC"]);
  });

  it("distributes columns to their owning tables", () => {
    const tables: TableRow[] = [
      { schema: "meta", name: "a", rls_enabled: false },
      { schema: "meta", name: "b", rls_enabled: false },
    ];
    const columns: ColumnRow[] = [
      { table_name: "a", column_name: "x", data_type: "int", not_null: true, default_expr: null, attnum: 1 },
      { table_name: "b", column_name: "y", data_type: "int", not_null: false, default_expr: null, attnum: 1 },
      { table_name: "a", column_name: "z", data_type: "int", not_null: false, default_expr: null, attnum: 2 },
    ];
    const live = parseLiveSchema("meta", tables, columns, [], []);
    const a = live.tables.find((t) => t.name === "a");
    const b = live.tables.find((t) => t.name === "b");
    expect(a?.columns.map((c) => c.name)).toEqual(["x", "z"]);
    expect(b?.columns.map((c) => c.name)).toEqual(["y"]);
  });

  it("orphans rows whose table is not in the table list", () => {
    const tables: TableRow[] = [];
    const columns: ColumnRow[] = [
      { table_name: "ghost", column_name: "x", data_type: "int", not_null: true, default_expr: null, attnum: 1 },
    ];
    const live = parseLiveSchema("meta", tables, columns, [], []);
    expect(live.tables).toHaveLength(0);
  });

  it("treats not_null = false as isNullable = true", () => {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: false }],
      [
        { table_name: "t", column_name: "x", data_type: "int", not_null: false, default_expr: null, attnum: 1 },
        { table_name: "t", column_name: "y", data_type: "int", not_null: true, default_expr: null, attnum: 2 },
      ],
      [],
      [],
    );
    expect(live.tables[0]?.columns[0]?.isNullable).toBe(true);
    expect(live.tables[0]?.columns[1]?.isNullable).toBe(false);
  });
});

describe("parseLiveSchema — a policy's command and roles", () => {
  function onePolicy(over: Partial<PolicyRow>): LivePolicy {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: true }],
      [],
      [],
      [
        {
          table_name: "t",
          policy_name: "p",
          using_expr: "(true)",
          check_expr: null,
          command: "*",
          roles: ["PUBLIC"],
          role_count: 1,
          permissive: true,
          ...over,
        },
      ],
    );
    return live.tables[0]?.policies[0] as LivePolicy;
  }

  it("reads polpermissive as given", () => {
    expect(onePolicy({ permissive: true }).permissive).toBe(true);
    expect(onePolicy({ permissive: false }).permissive).toBe(false);
  });

  it("reports an absent polpermissive as undetermined rather than as permissive", () => {
    // Reading an absent value as the default is exactly how a restrictive policy came to look
    // permissive and get silently replaced.
    expect(onePolicy({ permissive: undefined }).permissive).toBeNull();
  });

  it("canonicalizes each polcmd character", () => {
    expect(onePolicy({ command: "*" }).command).toBe("ALL");
    expect(onePolicy({ command: "r" }).command).toBe("SELECT");
    expect(onePolicy({ command: "a" }).command).toBe("INSERT");
    expect(onePolicy({ command: "w" }).command).toBe("UPDATE");
    expect(onePolicy({ command: "d" }).command).toBe("DELETE");
  });

  it("reports an unknown polcmd as undetermined rather than as ALL", () => {
    expect(onePolicy({ command: "z" }).command).toBeNull();
  });

  it("reports a resolved role list as given", () => {
    expect(onePolicy({ roles: ["app_reader", "app_writer"], role_count: 2 }).roles).toEqual([
      "app_reader",
      "app_writer",
    ]);
  });

  it("reports roles as undetermined when an oid resolved to nothing", () => {
    // The resolved list is then a strict subset of the real grant, and comparing a subset would
    // report a narrowing nobody declared.
    expect(onePolicy({ roles: ["app_reader"], role_count: 2 }).roles).toBeNull();
  });

  it("reports both as undetermined when the row does not carry them at all", () => {
    const policy = onePolicy({ command: undefined, roles: undefined, role_count: undefined });
    expect(policy.command).toBeNull();
    expect(policy.roles).toBeNull();
  });

  it("accepts a role list without a count, since there is nothing to contradict it", () => {
    expect(onePolicy({ roles: ["app_reader"], role_count: undefined }).roles).toEqual([
      "app_reader",
    ]);
  });
});

describe("POLICY_QUERY", () => {
  it("casts polcmd and rolname to text, because node-postgres parses neither", () => {
    // ADR-0291 broke on exactly this: a `name[]` arrives as the raw literal `{tenant_id}`.
    expect(POLICY_QUERY).toContain("p.polcmd::text");
    expect(POLICY_QUERY).toContain("r.rolname::text");
  });

  it("maps oid 0 to PUBLIC, which has no pg_roles row to join against", () => {
    expect(POLICY_QUERY).toContain("t.rid = 0 THEN 'PUBLIC'");
    expect(POLICY_QUERY).toContain("LEFT JOIN pg_roles");
  });

  it("asks for the unresolved count alongside the resolved list", () => {
    expect(POLICY_QUERY).toContain("cardinality(p.polroles) AS role_count");
  });

  it("orders the role list, so oid order cannot read as a difference", () => {
    expect(POLICY_QUERY).toContain("ORDER BY 1");
  });
});

describe("introspectSchema", () => {
  it("issues the six catalog queries in parallel and feeds them into parseLiveSchema", async () => {
    const observedSqls: string[] = [];
    const conn: PgConnection = {
      query: vi.fn(async <T,>(sql: string): Promise<PgQueryResult<T>> => {
        observedSqls.push(sql);
        if (sql.includes("relkind = 'r'") && sql.includes("relrowsecurity")) {
          return { rows: [{ schema: "meta", name: "x", rls_enabled: false }] as unknown as readonly T[], rowCount: 1 };
        }
        // Matched before the pg_attribute branch: the foreign-key query joins pg_attribute too.
        if (sql.includes("pg_constraint")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_attribute")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_index")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_policy")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        throw new Error("unexpected SQL: " + sql);
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const live = await introspectSchema(conn, "meta");
    expect(observedSqls).toHaveLength(6);
    expect(observedSqls.some((s) => s.includes("contype = 'f'"))).toBe(true);
    expect(observedSqls.some((s) => s.includes("contype = 'c'"))).toBe(true);
    expect(live.tables.map((t) => t.name)).toEqual(["x"]);
    expect(live.tables[0]?.foreignKeys).toEqual([]);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });
});

describe("POLICY_QUERY — permissiveness", () => {
  it("asks for polpermissive", () => {
    expect(POLICY_QUERY).toContain("p.polpermissive AS permissive");
  });
});

describe("parseLiveSchema — a foreign key's ON UPDATE", () => {
  function oneFk(over: Partial<ForeignKeyRow>): LiveForeignKey {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: false }],
      [],
      [],
      [],
      [
        {
          table_name: "t",
          constraint_name: "t_parent_fkey",
          columns: ["tenant_id", "parent_id"],
          target_schema: "meta",
          target_table: "parents",
          target_columns: ["tenant_id", "id"],
          on_delete: "c",
          on_update: "a",
          ...over,
        },
      ],
    );
    return live.tables[0]?.foreignKeys[0] as LiveForeignKey;
  }

  it("keeps a composite key's columns in key order on both sides", () => {
    const fk = oneFk({});
    expect([...fk.columns]).toEqual(["tenant_id", "parent_id"]);
    expect([...fk.targetColumns]).toEqual(["tenant_id", "id"]);
  });

  it("canonicalizes confupdtype with the same codes as confdeltype", () => {
    expect(oneFk({ on_update: "a" }).onUpdate).toBe("NO ACTION");
    expect(oneFk({ on_update: "r" }).onUpdate).toBe("RESTRICT");
    expect(oneFk({ on_update: "c" }).onUpdate).toBe("CASCADE");
    expect(oneFk({ on_update: "n" }).onUpdate).toBe("SET NULL");
    expect(oneFk({ on_update: "d" }).onUpdate).toBe("SET DEFAULT");
    expect(CONFUPDTYPE_TO_ACTION["c"]).toBe("CASCADE");
  });

  it("reads an absent or unknown code as NO ACTION, which under-reports rather than invents", () => {
    expect(oneFk({ on_update: undefined }).onUpdate).toBe("NO ACTION");
    expect(oneFk({ on_update: "z" }).onUpdate).toBe("NO ACTION");
  });

  it("still reads ON DELETE independently", () => {
    expect(oneFk({ on_delete: "n", on_update: "c" }).onDelete).toBe("SET NULL");
    expect(oneFk({ on_delete: "n", on_update: "c" }).onUpdate).toBe("CASCADE");
  });
});

describe("FOREIGN_KEY_QUERY — ON UPDATE", () => {
  it("asks for confupdtype alongside confdeltype", () => {
    expect(FOREIGN_KEY_QUERY).toContain("con.confdeltype AS on_delete");
    expect(FOREIGN_KEY_QUERY).toContain("con.confupdtype AS on_update");
  });
});

describe("CHECK_CONSTRAINT_QUERY", () => {
  it("selects only CHECK constraints in the requested schema", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("con.contype = 'c'");
    expect(CHECK_CONSTRAINT_QUERY).toContain("nspname = $1");
  });

  it("deparses the expression through pg_get_expr, as the index and policy queries do", () => {
    // That rendering is character-identical to what the ADR-0292 probe produces for the declared
    // side, which is the whole reason the comparison can be an exact string match.
    expect(CHECK_CONSTRAINT_QUERY).toContain("pg_get_expr(con.conbin, con.conrelid)");
  });

  it("casts attname to text, because node-postgres has no name[] parser", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("a.attname::text");
  });

  it("keeps conkey in order, so a two-column rule reports both columns as declared", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("WITH ORDINALITY");
  });

  it("interpolates no database name", () => {
    expect(CHECK_CONSTRAINT_QUERY).not.toMatch(/postgres|crossengin|tenant/i);
  });
});

describe("parseLiveSchema — check constraints", () => {
  const tables: TableRow[] = [
    { schema: "meta", name: "comms", rls_enabled: false },
    { schema: "meta", name: "other", rls_enabled: false },
  ];

  it("attaches each check to its own table", () => {
    const checks: CheckConstraintRow[] = [
      {
        table_name: "comms",
        constraint_name: "comms_bounces_check",
        expression: "(bounces_count <= recipient_count)",
        columns: ["recipient_count", "bounces_count"],
      },
      {
        table_name: "other",
        constraint_name: "other_status_check",
        expression: "(status = ANY (ARRAY['a'::text]))",
        columns: ["status"],
      },
    ];
    const live = parseLiveSchema("meta", tables, [], [], [], [], checks);
    const comms = live.tables.find((t) => t.name === "comms");
    const other = live.tables.find((t) => t.name === "other");
    expect(comms?.checkConstraints.map((c) => c.name)).toEqual(["comms_bounces_check"]);
    expect([...(comms?.checkConstraints[0]?.columns ?? [])]).toEqual([
      "recipient_count",
      "bounces_count",
    ]);
    expect(other?.checkConstraints[0]?.expression).toBe("(status = ANY (ARRAY['a'::text]))");
  });

  it("defaults to an empty list for a table with none", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], []);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });

  it("carries a null expression through as undetermined rather than as absent", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "c", expression: null, columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints[0]?.expression).toBeNull();
  });

  it("accepts a check that references no column at all", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "c", expression: "(true)", columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints[0]?.columns).toEqual([]);
  });

  it("groups several checks on one table in the order they arrive", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "a", expression: "(1)", columns: [] },
      { table_name: "comms", constraint_name: "b", expression: "(2)", columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("defaults to no checks when the caller does not pass them, so older callers still parse", () => {
    const live = parseLiveSchema("meta", tables, [], [], []);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });
});
