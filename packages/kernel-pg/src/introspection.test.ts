import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  COLUMN_QUERY,
  INDEX_QUERY,
  POLICY_QUERY,
  TABLE_QUERY,
  introspectSchema,
  parseLiveSchema,
  type ColumnRow,
  type IndexRow,
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
    const tables: TableRow[] = [{ schema: "meta", name: "tenants", rls_enabled: true }];
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
        columns: ["id"],
      },
    ];
    const policies: PolicyRow[] = [
      {
        table_name: "tenants",
        policy_name: "tenant_isolation",
        using_expr: "id = current_setting('app.current_tenant_id', true)::uuid",
        check_expr: null,
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
  });

  it("distributes columns to their owning tables", () => {
    const tables: TableRow[] = [
      { schema: "meta", name: "a", rls_enabled: false },
      { schema: "meta", name: "b", rls_enabled: false },
    ];
    const columns: ColumnRow[] = [
      {
        table_name: "a",
        column_name: "x",
        data_type: "int",
        not_null: true,
        default_expr: null,
        attnum: 1,
      },
      {
        table_name: "b",
        column_name: "y",
        data_type: "int",
        not_null: false,
        default_expr: null,
        attnum: 1,
      },
      {
        table_name: "a",
        column_name: "z",
        data_type: "int",
        not_null: false,
        default_expr: null,
        attnum: 2,
      },
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
      {
        table_name: "ghost",
        column_name: "x",
        data_type: "int",
        not_null: true,
        default_expr: null,
        attnum: 1,
      },
    ];
    const live = parseLiveSchema("meta", tables, columns, [], []);
    expect(live.tables).toHaveLength(0);
  });

  it("treats not_null = false as isNullable = true", () => {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: false }],
      [
        {
          table_name: "t",
          column_name: "x",
          data_type: "int",
          not_null: false,
          default_expr: null,
          attnum: 1,
        },
        {
          table_name: "t",
          column_name: "y",
          data_type: "int",
          not_null: true,
          default_expr: null,
          attnum: 2,
        },
      ],
      [],
      [],
    );
    expect(live.tables[0]?.columns[0]?.isNullable).toBe(true);
    expect(live.tables[0]?.columns[1]?.isNullable).toBe(false);
  });
});

describe("introspectSchema", () => {
  it("issues the four queries in parallel and feeds them into parseLiveSchema", async () => {
    const observedSqls: string[] = [];
    const conn: PgConnection = {
      query: vi.fn(async <T>(sql: string): Promise<PgQueryResult<T>> => {
        observedSqls.push(sql);
        if (sql.includes("relkind = 'r'") && sql.includes("relrowsecurity")) {
          return {
            rows: [{ schema: "meta", name: "x", rls_enabled: false }] as unknown as readonly T[],
            rowCount: 1,
          };
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
    expect(observedSqls).toHaveLength(4);
    expect(live.tables.map((t) => t.name)).toEqual(["x"]);
  });
});
