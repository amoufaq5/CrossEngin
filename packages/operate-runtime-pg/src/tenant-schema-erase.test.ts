import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  ERASURE_REFUSAL_REASONS,
  eraseTenantSchema,
  erasureDeletionScope,
  planTenantSchemaErasure,
  probeCascadeCollateral,
  surveyTenantSchema,
  type TenantSchemaErasure,
  type TenantSchemaSurvey,
} from "./tenant-schema-erase.js";
import { TENANT_SCHEMA_LOCK_SQL } from "./tenant-schema-apply.js";
import { tenantSchemaName } from "./tenant-schema.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const OTHER_TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SCHEMA = tenantSchemaName(TENANT);

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const AUTHORITY = { executedBy: ALICE, approvedBy: BOB };

interface FakeOptions {
  /** Whether `pg_namespace` reports the schema present. A list drives successive answers. */
  readonly exists?: boolean | readonly boolean[];
  /** Rows for the `pg_class` table listing: `[name, totalBytes]`. */
  readonly tables?: ReadonlyArray<readonly [string, number]>;
  /** `count(*)` per table name. */
  readonly counts?: Readonly<Record<string, number>>;
  /**
   * The external-relation census the probe diffs: rows before the trial cascade, then rows after.
   * Anything in the first and not the second is collateral.
   */
  readonly censusBefore?: ReadonlyArray<{ oid: string; nspname: string; ident: string; relkind: string }>;
  readonly censusAfter?: ReadonlyArray<{ oid: string }>;
}

interface Fake {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly sql: () => string[];
}

/**
 * A fake `PgConnection` answering the four queries this module sends, matched on a distinctive
 * fragment of each, and recording everything — so a test asserts on the SQL and bound parameters a
 * real erasure would send, per the repo's offline-Postgres convention.
 */
function fakePg(opts: FakeOptions = {}): Fake {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const existsAnswers = Array.isArray(opts.exists)
    ? [...(opts.exists as readonly boolean[])]
    : [opts.exists ?? true];
  let existsIndex = 0;
  let censusCalls = 0;
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("FROM pg_namespace WHERE nspname")) {
        const answer = existsAnswers[Math.min(existsIndex, existsAnswers.length - 1)] ?? true;
        existsIndex += 1;
        return { rows: [{ exists: answer }], rowCount: 1 };
      }
      if (sql.includes("pg_total_relation_size")) {
        const rows = (opts.tables ?? []).map(([table_name, total_bytes]) => ({ table_name, total_bytes }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("count(*) AS n")) {
        const match = /FROM "[^"]+"\."([^"]+)"/.exec(sql);
        const table = match?.[1] ?? "";
        return { rows: [{ n: opts.counts?.[table] ?? 0 }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_class c")) {
        // The census runs twice: before the trial cascade and after it.
        censusCalls += 1;
        const rows = censusCalls === 1 ? (opts.censusBefore ?? []) : (opts.censusAfter ?? opts.censusBefore ?? []);
        return { rows, rowCount: rows.length };
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

function surveyOf(over: Partial<TenantSchemaSurvey> = {}): TenantSchemaSurvey {
  return {
    tenantId: TENANT,
    schema: SCHEMA,
    exists: true,
    relations: [{ table: "invoice", rowCount: 12, storageBytes: 8192 }],
    rowCount: 12,
    storageBytes: 8192,
    ...over,
  };
}

describe("surveyTenantSchema", () => {
  it("reports an absent schema as nothing to erase, without probing further", async () => {
    const { conn, sql } = fakePg({ exists: false });
    const survey = await surveyTenantSchema(conn, TENANT);
    expect(survey).toEqual({
      tenantId: TENANT,
      schema: SCHEMA,
      exists: false,
      relations: [],
      rowCount: 0,
      storageBytes: 0,
    });
    // No table listing and no counts: there is nothing to measure.
    expect(sql().some((s) => s.includes("pg_total_relation_size"))).toBe(false);
  });

  it("counts rows exactly rather than reading an estimate", async () => {
    const { conn, sql } = fakePg({
      tables: [["invoice", 8192], ["line", 4096]],
      counts: { invoice: 12, line: 40 },
    });
    const survey = await surveyTenantSchema(conn, TENANT);
    expect(survey.relations).toEqual([
      { table: "invoice", rowCount: 12, storageBytes: 8192 },
      { table: "line", rowCount: 40, storageBytes: 4096 },
    ]);
    expect(survey.rowCount).toBe(52);
    expect(survey.storageBytes).toBe(12288);
    // `reltuples` is an estimate, and the tombstone's hash commits to this number.
    expect(sql().some((s) => s.includes("reltuples"))).toBe(false);
    expect(sql().filter((s) => s.includes("count(*) AS n"))).toHaveLength(2);
  });

  it("quotes the schema and table in each count, and binds the schema elsewhere", async () => {
    const { conn, calls } = fakePg({ tables: [["invoice", 1]], counts: { invoice: 1 } });
    await surveyTenantSchema(conn, TENANT);
    const count = calls.find((c) => c.sql.includes("count(*) AS n"));
    expect(count?.sql).toContain(`FROM "${SCHEMA}"."invoice"`);
    const listing = calls.find((c) => c.sql.includes("pg_total_relation_size"));
    expect(listing?.params).toEqual([SCHEMA]);
  });

  it("measures only; it does not probe, drop, lock or open a transaction", async () => {
    const { conn, sql } = fakePg({ tables: [["invoice", 1]], counts: { invoice: 1 } });
    await surveyTenantSchema(conn, TENANT);
    // Whether the cascade is safe is `probeCascadeCollateral`'s answer, and it needs a transaction a
    // survey shown to an operator should not require.
    expect(sql().some((s) => s.includes("DROP"))).toBe(false);
    expect(sql().some((s) => s === TENANT_SCHEMA_LOCK_SQL)).toBe(false);
    expect(sql().some((s) => s === "BEGIN")).toBe(false);
    expect(sql().some((s) => s.includes("SAVEPOINT"))).toBe(false);
  });
});

describe("probeCascadeCollateral", () => {
  it("names what the trial cascade destroyed outside the schema, by relkind", async () => {
    const { conn } = fakePg({
      censusBefore: [
        { oid: "1", nspname: "public", ident: "public.leaky", relkind: "v" },
        { oid: "2", nspname: "public", ident: "public.kept", relkind: "r" },
        { oid: "3", nspname: "reporting", ident: "reporting.snap", relkind: "m" },
      ],
      censusAfter: [{ oid: "2" }],
    });
    expect(await probeCascadeCollateral(conn, SCHEMA)).toEqual([
      { description: "view public.leaky", schema: "public" },
      { description: "materialized view reporting.snap", schema: "reporting" },
    ]);
  });

  it("reports nothing when every external relation survives the trial", async () => {
    const { conn } = fakePg({
      censusBefore: [{ oid: "1", nspname: "public", ident: "public.kept", relkind: "r" }],
      censusAfter: [{ oid: "1" }],
    });
    expect(await probeCascadeCollateral(conn, SCHEMA)).toEqual([]);
  });

  it("asks Postgres rather than inferring from pg_depend", async () => {
    const { conn, sql } = fakePg({ censusBefore: [] });
    await probeCascadeCollateral(conn, SCHEMA);
    // Two real failures came from reasoning over pg_depend: `objid` is an oid in the catalog
    // `classid` names (so a constraint never joined to pg_class, and every primary key read as
    // external), and `pg_identify_object(…).schema` is NULL for a rule — which is how a view in
    // another schema depends on a table, so the one case the check exists for slipped through.
    expect(sql().some((s) => s.includes("pg_depend"))).toBe(false);
    expect(sql().some((s) => s.includes("pg_identify_object"))).toBe(false);
    expect(sql().filter((s) => s.includes("FROM pg_class c"))).toHaveLength(2);
  });

  it("rolls the trial cascade back and releases the savepoint, in order", async () => {
    const { conn, sql } = fakePg({ censusBefore: [] });
    await probeCascadeCollateral(conn, SCHEMA);
    const order = sql();
    const save = order.findIndex((s) => s.startsWith("SAVEPOINT"));
    const drop = order.findIndex((s) => s.startsWith("DROP SCHEMA"));
    const back = order.findIndex((s) => s.startsWith("ROLLBACK TO SAVEPOINT"));
    const release = order.findIndex((s) => s.startsWith("RELEASE SAVEPOINT"));
    expect(save).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(save);
    expect(back).toBeGreaterThan(drop);
    expect(release).toBeGreaterThan(back);
  });

  it("rolls back even when the trial cascade throws", async () => {
    const calls: string[] = [];
    const conn: PgConnection = {
      query: (async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith("DROP SCHEMA")) throw new Error("dependent objects still exist");
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    await expect(probeCascadeCollateral(conn, SCHEMA)).rejects.toThrow(/dependent objects/);
    // The trial cascade must never outlive the probe, including on a throw.
    expect(calls.some((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
  });
});

describe("planTenantSchemaErasure", () => {
  it("plans one cascading drop for a tenant's own populated schema", () => {
    const plan = planTenantSchemaErasure(surveyOf(), [], AUTHORITY);
    expect(plan.erasable).toBe(true);
    expect(plan.refusals).toEqual([]);
    expect(plan.statements).toEqual([`DROP SCHEMA "${SCHEMA}" CASCADE;`]);
  });

  it("refuses a schema that is not a tenant schema at all", () => {
    for (const schema of ["meta", "public", "t_notahex", "operate"]) {
      const plan = planTenantSchemaErasure(surveyOf({ schema }), [], AUTHORITY);
      expect(plan.erasable, schema).toBe(false);
      expect(plan.refusals.map((r) => r.reason), schema).toContain("not_a_tenant_schema");
      expect(plan.statements, schema).toEqual([]);
    }
  });

  it("refuses a tenant schema belonging to a different tenant", () => {
    const plan = planTenantSchemaErasure(
      surveyOf({ schema: tenantSchemaName(OTHER_TENANT) }),
      [],
      AUTHORITY,
    );
    expect(plan.erasable).toBe(false);
    expect(plan.refusals.map((r) => r.reason)).toContain("schema_not_this_tenant");
    expect(plan.refusals[0]?.detail).toContain(tenantSchemaName(TENANT));
  });

  it("refuses when the executor is also the approver", () => {
    const plan = planTenantSchemaErasure(surveyOf(), [], { executedBy: ALICE, approvedBy: ALICE });
    expect(plan.erasable).toBe(false);
    expect(plan.refusals.map((r) => r.reason)).toContain("four_eyes_violated");
  });

  it("refuses when a cascade would reach outside the schema, naming what it would hit", () => {
    const plan = planTenantSchemaErasure(
      surveyOf(),
      [
        { description: "view public.tenant_overview", schema: "public" },
        { description: "materialized view reporting.snapshot", schema: "reporting" },
      ],
      AUTHORITY,
    );
    expect(plan.erasable).toBe(false);
    const refusal = plan.refusals.find((r) => r.reason === "external_dependents");
    expect(refusal?.detail).toContain("2 object(s)");
    expect(refusal?.detail).toContain("public.tenant_overview");
    expect(refusal?.detail).toContain("reporting.snapshot");
  });

  it("treats an absent schema as nothing to do, not as a refusal", () => {
    const plan = planTenantSchemaErasure(
      surveyOf({ exists: false, relations: [], rowCount: 0, storageBytes: 0 }),
      [],
      AUTHORITY,
    );
    expect(plan.erasable).toBe(false);
    // The distinction a caller needs: no refusals means there was nothing wrong.
    expect(plan.refusals).toEqual([]);
    expect(plan.statements).toEqual([]);
  });

  it("reports every applicable refusal rather than stopping at the first", () => {
    const plan = planTenantSchemaErasure(
      surveyOf({ schema: "public" }),
      [{ description: "view y.x", schema: "y" }],
      { executedBy: ALICE, approvedBy: ALICE },
    );
    expect(plan.refusals.map((r) => r.reason).sort()).toEqual([
      "external_dependents",
      "four_eyes_violated",
      "not_a_tenant_schema",
    ]);
  });

  it("checks the tenant match against the configured prefix", () => {
    const plan = planTenantSchemaErasure(
      surveyOf({ schema: tenantSchemaName(TENANT, "ten_") }),
      [],
      { ...AUTHORITY, prefix: "ten_" },
    );
    expect(plan.erasable).toBe(true);
  });

  it("declares every refusal reason it can produce", () => {
    expect([...ERASURE_REFUSAL_REASONS].sort()).toEqual([
      "external_dependents",
      "four_eyes_violated",
      "not_a_tenant_schema",
      "schema_not_this_tenant",
    ]);
  });
});

describe("eraseTenantSchema", () => {
  it("takes the per-tenant lock before it surveys or drops", async () => {
    const { conn, sql } = fakePg({
      exists: [true, false],
      tables: [["invoice", 8192]],
      counts: { invoice: 12 },
    });
    await eraseTenantSchema(conn, TENANT, AUTHORITY);
    const order = sql();
    const lock = order.indexOf(TENANT_SCHEMA_LOCK_SQL);
    const drop = order.findIndex((s) => s.startsWith("DROP SCHEMA"));
    expect(lock).toBeGreaterThan(order.indexOf("BEGIN"));
    expect(lock).toBeLessThan(drop);
    // The same lock the apply path takes, so an activation cannot re-create the schema mid-drop.
    expect(sql().filter((s) => s === TENANT_SCHEMA_LOCK_SQL)).toHaveLength(1);
  });

  it("binds the lock to the schema name", async () => {
    const { conn, calls } = fakePg({ exists: [true, false], tables: [] });
    await eraseTenantSchema(conn, TENANT, AUTHORITY);
    const lock = calls.find((c) => c.sql === TENANT_SCHEMA_LOCK_SQL);
    expect(lock?.params).toEqual([SCHEMA]);
  });

  it("drops and confirms absence, reporting what it destroyed", async () => {
    const { conn, sql } = fakePg({
      exists: [true, false],
      tables: [["invoice", 8192], ["line", 4096]],
      counts: { invoice: 12, line: 40 },
    });
    const result = await eraseTenantSchema(conn, TENANT, AUTHORITY);
    expect(result.erased).toBe(true);
    expect(result.alreadyAbsent).toBe(false);
    expect(result.rowCount).toBe(52);
    expect(result.storageBytes).toBe(12288);
    expect(result.erasedRelations.map((r) => r.table)).toEqual(["invoice", "line"]);
    expect(result.statements).toEqual([`DROP SCHEMA "${SCHEMA}" CASCADE;`]);
    // Two existence probes: the survey's, and the confirmation after the drop.
    expect(sql().filter((s) => s.includes("FROM pg_namespace WHERE nspname"))).toHaveLength(2);
    expect(sql()).toContain("COMMIT");
  });

  it("confirms absence AFTER the drop, not before", async () => {
    const { conn, sql } = fakePg({ exists: [true, false], tables: [] });
    await eraseTenantSchema(conn, TENANT, AUTHORITY);
    const order = sql();
    const drop = order.findIndex((s) => s.startsWith("DROP SCHEMA"));
    const probes = order.reduce<number[]>((acc, s, i) => {
      if (s.includes("FROM pg_namespace WHERE nspname")) acc.push(i);
      return acc;
    }, []);
    expect(probes.some((i) => i > drop)).toBe(true);
  });

  it("throws rather than reporting success when the schema is still there afterwards", async () => {
    // The whole point: a DROP that reported success over live data would produce a signed tombstone
    // for data that still exists.
    const { conn } = fakePg({ exists: [true, true], tables: [["invoice", 1]], counts: { invoice: 1 } });
    await expect(eraseTenantSchema(conn, TENANT, AUTHORITY)).rejects.toThrow(
      /did not remove the schema; rolling back/,
    );
  });

  it("drops nothing when the plan refuses, and reports the refusal", async () => {
    const { conn, sql } = fakePg({
      tables: [["invoice", 1]],
      counts: { invoice: 1 },
      censusBefore: [{ oid: "9", nspname: "public", ident: "public.x", relkind: "v" }],
      censusAfter: [],
    });
    const result = await eraseTenantSchema(conn, TENANT, AUTHORITY);
    expect(result.erased).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toEqual(["external_dependents"]);
    // The only `DROP SCHEMA` issued is the probe's trial, and it is rolled back.
    expect(sql().filter((s) => s.startsWith("DROP SCHEMA"))).toHaveLength(1);
    expect(sql().filter((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toHaveLength(1);
  });

  it("refuses four-eyes before dropping, so the receipt is not the first check", async () => {
    const { conn, sql } = fakePg({ exists: [true, false], tables: [] });
    const result = await eraseTenantSchema(conn, TENANT, { executedBy: ALICE, approvedBy: ALICE });
    expect(result.erased).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toEqual(["four_eyes_violated"]);
    // Not even the probe's trial cascade: a caller who may not erase this schema does not get it
    // trial-dropped on their behalf, rolled back or not.
    expect(sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
    expect(sql().some((s) => s.startsWith("SAVEPOINT"))).toBe(false);
  });

  it("re-surveys under the lock rather than trusting an earlier survey", async () => {
    // The survey an operator approved was taken before they read it; a dependent added since must
    // still refuse. This fake reports one only on the in-transaction probe.
    const { conn, sql } = fakePg({
      tables: [],
      censusBefore: [{ oid: "9", nspname: "public", ident: "public.added_since", relkind: "v" }],
      censusAfter: [],
    });
    const result = await eraseTenantSchema(conn, TENANT, AUTHORITY);
    expect(result.refusals.map((r) => r.reason)).toEqual(["external_dependents"]);
    // Probed under the lock, exactly once: a view created against a tenant table between an
    // operator's survey and their approval must still refuse.
    expect(sql().filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(1);
    const order = sql();
    expect(order.indexOf(TENANT_SCHEMA_LOCK_SQL)).toBeLessThan(
      order.findIndex((s) => s.startsWith("SAVEPOINT")),
    );
  });

  it("reports an already-absent schema as done, distinctly from a refusal", async () => {
    const { conn, sql } = fakePg({ exists: false });
    const result = await eraseTenantSchema(conn, TENANT, AUTHORITY);
    expect(result.alreadyAbsent).toBe(true);
    expect(result.erased).toBe(false);
    expect(result.refusals).toEqual([]);
    expect(sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
  });

  it("throws on a non-UUID tenant id before touching the database", async () => {
    const { conn, sql } = fakePg();
    await expect(eraseTenantSchema(conn, "not-a-uuid", AUTHORITY)).rejects.toThrow(/canonical UUID/);
    expect(sql()).toEqual([]);
  });
});

describe("erasureDeletionScope", () => {
  function erasureOf(over: Partial<TenantSchemaErasure> = {}): TenantSchemaErasure {
    return {
      tenantId: TENANT,
      schema: SCHEMA,
      erased: true,
      alreadyAbsent: false,
      statements: [`DROP SCHEMA "${SCHEMA}" CASCADE;`],
      refusals: [],
      erasedRelations: [
        { table: "invoice", rowCount: 12, storageBytes: 8192 },
        { table: "line", rowCount: 40, storageBytes: 4096 },
      ],
      rowCount: 52,
      storageBytes: 12288,
      erasedAt: "2026-10-03T00:00:00.000Z",
      ...over,
    };
  }

  it("schema-qualifies each table, since DeletionScope.tables is a flat list", () => {
    const scope = erasureDeletionScope(erasureOf());
    expect(scope.schemas).toEqual([SCHEMA]);
    expect(scope.tables).toEqual([`${SCHEMA}.invoice`, `${SCHEMA}.line`]);
    expect(scope.rowCount).toBe(52);
    expect(scope.storageBytes).toBe(12288);
  });

  it("claims nothing when nothing was erased", () => {
    for (const erasure of [erasureOf({ erased: false }), erasureOf({ erased: false, alreadyAbsent: true })]) {
      expect(erasureDeletionScope(erasure)).toEqual({
        schemas: [],
        tables: [],
        rowCount: 0,
        storageBytes: 0,
      });
    }
  });

  it("omits the fields other subsystems own, so a zero never reads as 'none'", () => {
    const scope = erasureDeletionScope(erasureOf());
    // Object storage, backups, search indexes and cache keys are not this module's to report.
    expect(Object.keys(scope).sort()).toEqual(["rowCount", "schemas", "storageBytes", "tables"]);
  });
});
