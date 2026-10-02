import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Relation } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  applyTenantManifestSchema,
  resolveTenantSchema,
  TENANT_SCHEMA_LOCK_SQL,
} from "./tenant-schema-apply.js";
import { tenantSchemaName } from "./tenant-schema.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const SCHEMA = tenantSchemaName(TENANT);

const ACCOUNT: Entity = {
  name: "Account",
  fields: [{ name: "name", type: { kind: "text" }, required: true }],
};

const TICKET: Entity = {
  name: "Ticket",
  fields: [
    { name: "subject", type: { kind: "text" }, required: true },
    { name: "account", type: { kind: "reference", target: "Account" } },
    { name: "mrn", type: { kind: "text" }, classification: "phi" },
  ],
};

const RELATION: Relation = {
  kind: "many_to_one",
  from: "Ticket",
  to: "Account",
  field: "account",
  onDelete: "cascade",
};

function manifestOf(entities: readonly Entity[], relations: readonly Relation[] = []): Manifest {
  return { entities, relations } as unknown as Manifest;
}

interface Captured {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly sql: () => string[];
}

/**
 * A fake `PgConnection` that answers the one introspection query from
 * `introspectRows` and records everything else, so the test asserts on the SQL
 * and bound parameters a real apply would send.
 */
function capturePg(introspectRows: readonly Record<string, unknown>[] = []): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("pg_catalog.format_type")) {
        return { rows: introspectRows, rowCount: introspectRows.length };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      calls.push({ sql: "BEGIN", params: [] });
      const out = await fn(conn);
      calls.push({ sql: "COMMIT", params: [] });
      return out;
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, sql: () => calls.map((c) => c.sql) };
}

/** The live shape of a table that already matches what the plan would create. */
function row(table: string, column: string, type: string, notNull = false): Record<string, unknown> {
  return { table_name: table, column_name: column, formatted_type: type, not_null: notNull };
}

const TICKET_LIVE: readonly Record<string, unknown>[] = [
  row("account", "tenant_id", "uuid", true),
  row("account", "id", "text", true),
  row("account", "name", "text", true),
  row("ticket", "tenant_id", "uuid", true),
  row("ticket", "id", "text", true),
  row("ticket", "subject", "text", true),
  row("ticket", "account_id", "text"),
  row("ticket", "mrn", "bytea"),
];

describe("resolveTenantSchema", () => {
  it("derives from the tenant id by default", () => {
    expect(resolveTenantSchema(TENANT)).toBe(SCHEMA);
  });

  it("honours an explicit schema — e.g. the tenant's recorded meta.tenants.schema_name", () => {
    expect(resolveTenantSchema(TENANT, { schema: "t_acme" })).toBe("t_acme");
  });

  it("validates an explicit schema, because it reaches DDL unparameterised", () => {
    expect(() => resolveTenantSchema(TENANT, { schema: 'x"; DROP SCHEMA public; --' })).toThrow(
      /invalid tenant schema name/,
    );
    expect(() => resolveTenantSchema(TENANT, { schema: "a".repeat(64) })).toThrow(
      /invalid tenant schema name/,
    );
  });

  it("still requires a UUID tenant id with an explicit schema — the RLS predicate casts to UUID", () => {
    expect(() => resolveTenantSchema("acme", { schema: "t_acme" })).toThrow(/canonical UUID/);
  });
});

describe("applyTenantManifestSchema", () => {
  it("applies into an explicitly supplied schema", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]), {
      schema: "t_acme",
    });
    expect(result.schema).toBe("t_acme");
    expect(result.statements.join("\n")).toContain('CREATE TABLE IF NOT EXISTS "t_acme"."account"');
  });

  it("applies into the tenant's own schema, derived from the tenant id", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    expect(result.schema).toBe(SCHEMA);
    expect(result.applied).toBe(true);
    expect(result.statements.join("\n")).toContain(`CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ticket"`);
    expect(result.statements.join("\n")).not.toContain('"public".');
  });

  it("honours a custom schema prefix", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]), {
      prefix: "tenant_",
    });
    expect(result.schema).toBe(tenantSchemaName(TENANT, "tenant_"));
  });

  it("takes a per-tenant advisory xact lock before touching the schema", async () => {
    const cap = capturePg();
    await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]));
    const lock = cap.calls.findIndex((c) => c.sql === TENANT_SCHEMA_LOCK_SQL);
    const create = cap.calls.findIndex((c) => c.sql.startsWith("CREATE SCHEMA"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(cap.calls[lock]?.params).toEqual([SCHEMA]);
    expect(lock).toBeLessThan(create);
    expect(cap.calls[lock - 1]?.sql).toBe("BEGIN");
  });

  it("runs every DDL statement inside one transaction, so RLS is never briefly unpoliced", async () => {
    const cap = capturePg();
    const sqls = cap.sql();
    await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]));
    const all = cap.sql();
    const begin = all.indexOf("BEGIN");
    const commit = all.indexOf("COMMIT");
    const drop = all.findIndex((s) => s.startsWith("DROP POLICY"));
    const policy = all.findIndex((s) => s.startsWith("CREATE POLICY"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(begin);
    expect(policy).toBeLessThan(commit);
    expect(sqls).not.toBe(all);
  });

  it("provisions the extensions outside the transaction — shared ground, not one tenant's", async () => {
    const cap = capturePg();
    await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([TICKET, ACCOUNT]));
    const all = cap.sql();
    const trgm = all.findIndex((s) => s.includes("pg_trgm"));
    const pgcrypto = all.findIndex((s) => s.includes("pgcrypto"));
    const begin = all.indexOf("BEGIN");
    expect(pgcrypto).toBeGreaterThanOrEqual(0); // Ticket.mrn is phi → ciphertext
    expect(trgm).toBeLessThan(begin);
    expect(pgcrypto).toBeLessThan(begin);
  });

  it("skips pgcrypto when no column is stored as ciphertext", async () => {
    const cap = capturePg();
    await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]));
    expect(cap.sql().some((s) => s.includes("pgcrypto"))).toBe(false);
  });

  it("creates a referenced table before the one referencing it, then adds the tenant-scoped FK", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(
      cap.conn,
      TENANT,
      manifestOf([TICKET, ACCOUNT], [RELATION]),
    );
    const account = result.statements.findIndex((s) => s.includes(`"${SCHEMA}"."account" (`));
    const ticket = result.statements.findIndex((s) => s.includes(`"${SCHEMA}"."ticket" (`));
    const fk = result.statements.findIndex((s) => s.includes('ADD CONSTRAINT "fk_ticket_account_id"'));
    expect(account).toBeLessThan(ticket);
    expect(ticket).toBeLessThan(fk);
    expect(result.statements[fk]).toContain(
      `FOREIGN KEY ("tenant_id", "account_id") REFERENCES "${SCHEMA}"."account" ("tenant_id", "id") ON DELETE CASCADE`,
    );
  });

  it("gives every tenant table tenant_id, the composite key and the standard RLS policy", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([ACCOUNT]));
    const all = result.statements.join("\n");
    expect(all).toContain('"tenant_id" UUID NOT NULL');
    expect(all).toContain('PRIMARY KEY ("tenant_id", "id")');
    expect(all).toContain(`ALTER TABLE "${SCHEMA}"."account" ENABLE ROW LEVEL SECURITY;`);
    expect(all).toContain(
      "USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID)",
    );
  });

  it("is a clean no-op on a second run: the same statements, all idempotent", async () => {
    const first = capturePg();
    const a = await applyTenantManifestSchema(first.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    const second = capturePg(TICKET_LIVE);
    const b = await applyTenantManifestSchema(second.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    expect(b.applied).toBe(true);
    expect(b.changes).toEqual([]);
    expect(b.statements).toEqual(a.statements);
    // Every CREATE is guarded, and the two that are not (`CREATE POLICY`,
    // `ADD CONSTRAINT`) are each preceded by their own `DROP … IF EXISTS`.
    for (const stmt of b.statements) {
      if (/^CREATE (SCHEMA|TABLE|INDEX)\b/.test(stmt) || stmt.includes("ADD COLUMN")) {
        expect(stmt, stmt).toContain("IF NOT EXISTS");
      }
    }
    for (const [i, stmt] of b.statements.entries()) {
      if (/^CREATE POLICY\b/.test(stmt)) expect(b.statements[i - 1]).toMatch(/^DROP POLICY IF EXISTS/);
      if (stmt.includes("ADD CONSTRAINT")) {
        expect(b.statements[i - 1]).toMatch(/DROP CONSTRAINT IF EXISTS/);
      }
    }
  });

  it("adds a field added by a later manifest, additively", async () => {
    const cap = capturePg(TICKET_LIVE);
    const v2: Entity = {
      ...TICKET,
      fields: [...TICKET.fields, { name: "triage_level", type: { kind: "integer" } }],
    };
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([v2, ACCOUNT], [RELATION]));
    expect(result.applied).toBe(true);
    expect(result.statements.join("\n")).toContain(
      `ALTER TABLE "${SCHEMA}"."ticket" ADD COLUMN IF NOT EXISTS "triage_level" INTEGER;`,
    );
  });

  it("refuses the whole application on a changed column type and executes nothing", async () => {
    const drifted = TICKET_LIVE.map((r) =>
      r["column_name"] === "subject" ? { ...r, formatted_type: "integer" } : r,
    );
    const cap = capturePg(drifted);
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    expect(result.applied).toBe(false);
    expect(result.statements).toEqual([]);
    expect(result.changes.map((c) => c.kind)).toContain("column_type_change");
    // Nothing but the lock, the schema guard and the introspection was sent.
    expect(cap.sql().filter((s) => s.startsWith("CREATE TABLE"))).toEqual([]);
    expect(cap.sql().filter((s) => s.startsWith("ALTER TABLE"))).toEqual([]);
  });

  it("refuses when a field's classification moved it between plaintext and ciphertext", async () => {
    const plaintext = TICKET_LIVE.map((r) =>
      r["column_name"] === "mrn" ? { ...r, formatted_type: "text" } : r,
    );
    const cap = capturePg(plaintext);
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    expect(result.applied).toBe(false);
    expect(result.changes.map((c) => c.kind)).toEqual(["column_encryption_change"]);
  });

  it("applies but reports a non-blocking change", async () => {
    const extra = [...TICKET_LIVE, row("ticket", "legacy_code", "text")];
    const cap = capturePg(extra);
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([TICKET, ACCOUNT], [RELATION]));
    expect(result.applied).toBe(true);
    expect(result.statements.length).toBeGreaterThan(0);
    expect(result.changes.map((c) => c.kind)).toEqual(["undeclared_column"]);
  });

  it("emits a tenant-scoped join table for a many_to_many relation", async () => {
    const cap = capturePg();
    const m2m: Relation = { kind: "many_to_many", left: "Ticket", right: "Account" } as Relation;
    const result = await applyTenantManifestSchema(
      cap.conn,
      TENANT,
      manifestOf([TICKET, ACCOUNT], [m2m]),
    );
    const all = result.statements.join("\n");
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ticket_account"`);
    expect(all).toContain(
      `FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "${SCHEMA}"."ticket" ("tenant_id", "id") ON DELETE CASCADE`,
    );
    // Join tables come last: both of their FK targets must already exist.
    const join = result.statements.findIndex((s) => s.includes('"ticket_account"'));
    const ticket = result.statements.findIndex((s) => s.includes(`"${SCHEMA}"."ticket" (`));
    expect(ticket).toBeLessThan(join);
  });

  it("reports the manifest hash it applied, so a caller can memoise on it", async () => {
    const cap = capturePg();
    const manifest = manifestOf([ACCOUNT]);
    const a = await applyTenantManifestSchema(cap.conn, TENANT, manifest);
    const b = await applyTenantManifestSchema(capturePg().conn, TENANT, manifest);
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.manifestHash.length).toBeGreaterThan(0);
  });

  it("refuses a non-uuid tenant id before issuing any SQL", async () => {
    const cap = capturePg();
    await expect(applyTenantManifestSchema(cap.conn, "acme", manifestOf([ACCOUNT]))).rejects.toThrow(
      /canonical UUID/,
    );
    expect(cap.calls).toEqual([]);
  });

  it("creates the schema even for a manifest with no entities", async () => {
    const cap = capturePg();
    const result = await applyTenantManifestSchema(cap.conn, TENANT, manifestOf([]));
    expect(result.applied).toBe(true);
    expect(cap.sql()).toContain(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";`);
  });
});
