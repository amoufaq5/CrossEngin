import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlansForManifest, joinTablePlansForManifest } from "./column-plan.js";
import {
  COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH,
  COLUMN_SCHEMA_SHORTFALL_KINDS,
  ColumnSchemaNotProvisioned,
  columnSchemaGrantSql,
  probeColumnSchemaAuthority,
  verifyColumnSchema,
} from "./column-schema-provisioning.js";
import { ColumnMappedEntityStore } from "./column-store.js";
import { SEARCH_FUNCTION_PRESENT_ROW, SEARCH_FUNCTION_PROBE_MATCH } from "./search-function.js";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "qty", type: { kind: "integer" } },
  ],
};
const MANIFEST = { entities: [WIDGET] } as unknown as Manifest;
const SECRET: Entity = {
  name: "Chart",
  fields: [{ name: "mrn", type: { kind: "text" }, classification: "phi" }],
};
const PHI_MANIFEST = { entities: [SECRET] } as unknown as Manifest;

/** One table as a provisioned catalog holds it: present, every column, RLS on, all four grants. */
interface TableState {
  columns: string[];
  rls: boolean;
  grants: { select: boolean; insert: boolean; update: boolean; delete: boolean };
}

interface CatalogState {
  role: string;
  schemaExists: boolean;
  schemaOwner: string;
  mayApply: boolean;
  tables: Map<string, TableState>;
  searchFunction: boolean;
  pgcrypto: boolean;
  /** Index name → `indisvalid`, for the unique indexes the schema holds. */
  indexes?: Map<string, boolean>;
}

function provisioned(manifest: Manifest, schema: string): CatalogState {
  const tables = new Map<string, TableState>();
  for (const plan of columnPlansForManifest(manifest, { schema }).values()) {
    tables.set(plan.table, {
      columns: ["id", "tenant_id", "created_at", "updated_at", ...plan.columns.map((c) => c.column)],
      rls: true,
      grants: { select: true, insert: true, update: true, delete: true },
    });
  }
  return {
    role: "crossengin_app",
    schemaExists: true,
    schemaOwner: "pg_database_owner",
    mayApply: false,
    tables,
    searchFunction: true,
    pgcrypto: true,
  };
}

/**
 * A fake answering the catalog reads from one declared state, and **throwing** on any statement it
 * does not recognise — so a DDL statement issued on the verifying arm fails the test rather than
 * being answered `{rows: []}` and passing (ADR-0350's fallback rule).
 */
function catalogPg(state: CatalogState): { conn: PgConnection; issued: string[] } {
  const issued: string[] = [];
  const query = (async (sql: string, params?: readonly unknown[]) => {
    issued.push(sql);
    if (sql.includes(COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH)) {
      return {
        rows: [
          {
            role: state.role,
            schema_exists: state.schemaExists,
            schema_owner: state.schemaExists ? state.schemaOwner : null,
            may_apply: state.mayApply,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pg_namespace WHERE nspname")) {
      return { rows: [{ present: state.schemaExists }], rowCount: 1 };
    }
    if (sql.includes("has_table_privilege")) {
      const wanted = (params?.[1] as string[]) ?? [];
      const rows = wanted.flatMap((t) => {
        const tbl = state.tables.get(t);
        if (tbl === undefined) return [];
        return [
          {
            table_name: t,
            rls: tbl.rls,
            can_select: tbl.grants.select,
            can_insert: tbl.grants.insert,
            can_update: tbl.grants.update,
            can_delete: tbl.grants.delete,
          },
        ];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM pg_attribute")) {
      const wanted = (params?.[1] as string[]) ?? [];
      const rows = wanted.flatMap((t) =>
        (state.tables.get(t)?.columns ?? []).map((c) => ({ table_name: t, column_name: c })),
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.includes(SEARCH_FUNCTION_PROBE_MATCH)) {
      return state.searchFunction
        ? { rows: [SEARCH_FUNCTION_PRESENT_ROW], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM pg_index x")) {
      const wanted = (params?.[1] as string[]) ?? [];
      const rows = wanted.flatMap((name) => {
        const valid = state.indexes?.get(name);
        return valid === undefined ? [] : [{ index_name: name, valid }];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("pg_extension WHERE extname = 'pgcrypto'")) {
      return { rows: [{ present: state.pgcrypto }], rowCount: 1 };
    }
    throw new Error(`unexpected statement on the verifying path: ${sql.slice(0, 80)}`);
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, issued };
}

const plansOf = (m: Manifest, schema = "public") => ({
  plans: columnPlansForManifest(m, { schema }),
  joins: joinTablePlansForManifest(m, { schema }),
});

describe("probeColumnSchemaAuthority", () => {
  it("answers verifies for a role that may not apply DDL to an existing schema", async () => {
    const state = provisioned(MANIFEST, "public");
    const { conn } = catalogPg(state);
    await expect(probeColumnSchemaAuthority(conn, "public")).resolves.toEqual({
      authority: "verifies",
      role: "crossengin_app",
      schemaExists: true,
      schemaOwner: "pg_database_owner",
    });
  });

  it("answers applies for a member of the schema's owner", async () => {
    const state = { ...provisioned(MANIFEST, "public"), mayApply: true, role: "crossengin" };
    const { conn } = catalogPg(state);
    expect((await probeColumnSchemaAuthority(conn, "public")).authority).toBe("applies");
  });

  it("reports an absent schema with no owner, and reads it as verifies unless CREATE is held", async () => {
    const state = { ...provisioned(MANIFEST, "public"), schemaExists: false };
    const { conn } = catalogPg(state);
    const probe = await probeColumnSchemaAuthority(conn, "public");
    expect(probe).toMatchObject({ authority: "verifies", schemaExists: false, schemaOwner: null });
  });

  it("refuses to guess when the probe returns no row", async () => {
    const conn = {
      query: (async () => ({ rows: [], rowCount: 0 })) as PgConnection["query"],
    } as unknown as PgConnection;
    await expect(probeColumnSchemaAuthority(conn, "public")).rejects.toThrow(/could not read/);
  });
});

describe("verifyColumnSchema", () => {
  it("passes a schema an owner provisioned from the same manifest", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const { conn } = catalogPg(provisioned(MANIFEST, "public"));
    await expect(verifyColumnSchema(conn, plans, joins)).resolves.toEqual([]);
  });

  it("reports an absent schema once, and reads nothing else", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const { conn, issued } = catalogPg({ ...provisioned(MANIFEST, "public"), schemaExists: false });
    await expect(verifyColumnSchema(conn, plans, joins)).resolves.toEqual([
      { kind: "schema_absent", object: "public" },
    ]);
    expect(issued).toHaveLength(1);
  });

  it("reports a planned table that is not there", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const state = provisioned(MANIFEST, "public");
    state.tables.clear();
    const { conn } = catalogPg(state);
    expect(await verifyColumnSchema(conn, plans, joins)).toEqual([
      { kind: "table_absent", object: "public.widget" },
    ]);
  });

  it("reports a planned column the table lacks, which is what a manifest the owner never applied looks like", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const state = provisioned(MANIFEST, "public");
    state.tables.get("widget")!.columns = ["id", "tenant_id", "sku"];
    const { conn } = catalogPg(state);
    expect(await verifyColumnSchema(conn, plans, joins)).toEqual([
      { kind: "column_absent", object: "public.widget.qty" },
    ]);
  });

  it("reports row-level security off, because a table without it serves every tenant's rows", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const state = provisioned(MANIFEST, "public");
    state.tables.get("widget")!.rls = false;
    const { conn } = catalogPg(state);
    expect(await verifyColumnSchema(conn, plans, joins)).toEqual([
      { kind: "row_security_off", object: "public.widget" },
    ]);
  });

  it("names each missing DML privilege rather than one of them", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const state = provisioned(MANIFEST, "public");
    state.tables.get("widget")!.grants = { select: true, insert: false, update: true, delete: false };
    const { conn } = catalogPg(state);
    expect(await verifyColumnSchema(conn, plans, joins)).toEqual([
      { kind: "privilege_absent", object: "public.widget (INSERT, DELETE)" },
    ]);
  });

  it("reports the search wrapper the list predicate names when it is absent", async () => {
    const { plans, joins } = plansOf(MANIFEST);
    const { conn } = catalogPg({ ...provisioned(MANIFEST, "public"), searchFunction: false });
    expect(await verifyColumnSchema(conn, plans, joins)).toEqual([
      { kind: "search_function_absent", object: "public.ce_unaccent(text) (absent)" },
    ]);
  });

  it("asks for pgcrypto only when a column is stored as ciphertext", async () => {
    const noPhi = plansOf(MANIFEST);
    const a = catalogPg({ ...provisioned(MANIFEST, "public"), pgcrypto: false });
    expect(await verifyColumnSchema(a.conn, noPhi.plans, noPhi.joins)).toEqual([]);
    const phi = plansOf(PHI_MANIFEST);
    const b = catalogPg({ ...provisioned(PHI_MANIFEST, "public"), pgcrypto: false });
    expect(await verifyColumnSchema(b.conn, phi.plans, phi.joins)).toEqual([
      { kind: "extension_absent", object: "pgcrypto" },
    ]);
  });

  it("covers every shortfall kind it declares", () => {
    expect([...COLUMN_SCHEMA_SHORTFALL_KINDS].sort()).toEqual(
      [
        "column_absent",
        "extension_absent",
        "privilege_absent",
        "row_security_off",
        "schema_absent",
        "search_function_absent",
        "table_absent",
      ].sort(),
    );
  });
});

describe("ColumnMappedEntityStore.ensureSchema as a role that cannot apply DDL", () => {
  it("verifies a provisioned schema and issues no DDL at all", async () => {
    const { conn, issued } = catalogPg(provisioned(MANIFEST, "public"));
    await expect(new ColumnMappedEntityStore(conn, MANIFEST).ensureSchema()).resolves.toEqual({
      mode: "verified",
      role: "crossengin_app",
      schema: "public",
      uniqueIndexes: [],
    });
    expect(issued.some((s) => /\b(CREATE|ALTER|GRANT)\b/.test(s) && !s.includes("SELECT"))).toBe(false);
  });

  it("reports a declared unique index the verified schema lacks or holds invalid, without refusing", async () => {
    // On this arm nothing runs the CREATE UNIQUE INDEX, so nothing else would see the owner's
    // one-shot refused it (existing duplicates) — and the boot line would count it enforced.
    const ITEM: Entity = {
      name: "Item",
      fields: [
        { name: "code", type: { kind: "text" }, unique: true },
        { name: "ean", type: { kind: "text" }, unique: true },
        { name: "sku", type: { kind: "text" }, unique: true },
      ],
    };
    const manifest = { entities: [ITEM] } as unknown as Manifest;
    const state = provisioned(manifest, "public");
    state.indexes = new Map([
      ["item_code_uniq", true],
      ["item_ean_uniq", false],
    ]);
    const { conn } = catalogPg(state);
    const ensured = await new ColumnMappedEntityStore(conn, manifest).ensureSchema();
    expect(ensured.mode).toBe("verified");
    expect(ensured.uniqueIndexes).toEqual([
      { entity: "Item", field: "ean", index: "item_ean_uniq", state: "invalid" },
      { entity: "Item", field: "sku", index: "item_sku_uniq", state: "absent" },
    ]);
    state.indexes.set("item_ean_uniq", true);
    state.indexes.set("item_sku_uniq", true);
    expect((await new ColumnMappedEntityStore(conn, manifest).ensureSchema()).uniqueIndexes).toEqual([]);
  });

  it("refuses an unprovisioned schema by name, with the remedy, before issuing any DDL", async () => {
    const state = provisioned(MANIFEST, "public");
    state.tables.clear();
    const { conn, issued } = catalogPg(state);
    const err = await new ColumnMappedEntityStore(conn, MANIFEST).ensureSchema().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColumnSchemaNotProvisioned);
    const message = (err as Error).message;
    expect(message).toContain("role 'crossengin_app'");
    expect(message).toContain("table_absent public.widget");
    expect(message).toContain("operate-server column-schema");
    expect(message).toContain("--grant-to crossengin_app");
    expect(issued.some((s) => s.includes("CREATE SCHEMA"))).toBe(false);
  });
});

describe("columnSchemaGrantSql", () => {
  it("grants schema usage and the four DML privileges per table, and nothing that confers ownership", () => {
    const { plans, joins } = plansOf(MANIFEST, "public");
    expect(columnSchemaGrantSql(plans, joins, "crossengin_app")).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "crossengin_app";',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."widget" TO "crossengin_app";',
    ]);
  });

  it("answers no statements for a manifest with no table", () => {
    const empty = { entities: [] } as unknown as Manifest;
    const { plans, joins } = plansOf(empty);
    expect(columnSchemaGrantSql(plans, joins, "r")).toEqual([]);
  });
});
