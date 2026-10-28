import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { SET_TENANT_CONTEXT_SQL } from "@crossengin/workflow-runtime-pg";
import { describe, expect, it } from "vitest";

import { PostgresJobInvoker, buildActionRoleMap, mergeActionRoleMaps } from "./job-invoke.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

/** The two statement kinds this producer emits, selected by predicate rather than by index. */
const inserts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes("INSERT INTO meta.job_runs"));
const contexts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes(SET_TENANT_CONTEXT_SQL));

/**
 * `transaction` must RUN its callback, handing it this same recording connection.
 * `enqueueUserInvokedJob` wraps its batch in `withTenantContext`, so a `transaction` that discarded
 * its callback recorded no statement *and* resolved `undefined` — which here surfaced as
 * `Cannot read properties of undefined (reading 'map')` from the producer's own return mapping, a
 * failure that names nothing about the fake (CLAUDE.md's `Tests` convention, seventh member).
 *
 * The `set_config` branch is first: its statement begins with `SELECT`, so any later branch keying
 * on that word would hand it another statement's rows (ADR-0363).
 */
function mockConn(calls: Call[]): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      if (sql.includes(SET_TENANT_CONTEXT_SQL)) return { rows: [], rowCount: 1 };
      return { rows: [{ run_id: params?.[3] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

const reindexJob: JobDeclaration = JobDeclarationSchema.parse({
  id: "reindex-catalog",
  name: "reindex-catalog",
  trigger: { kind: "userInvoked", action: "reindex-catalog" },
  onFailure: { strategy: "dead-letter" },
});

describe("PostgresJobInvoker", () => {
  it("enqueues a userInvoked run for a matching action and maps the result", async () => {
    const calls: Call[] = [];
    const invoker = new PostgresJobInvoker(mockConn(calls), [reindexJob], { now: NOW });
    const runs = await invoker.invoke({ tenantId: TENANT, action: "reindex-catalog", data: { scope: "all" }, idempotencyKey: "inv-1" });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ jobId: "reindex-catalog", inserted: true });
    const ins = inserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params?.[0]).toBe(TENANT);
    expect(ins[0]!.params?.[2]).toBe("userInvoked");
    // Nothing but that insert and its tenant context is issued.
    expect(calls).toHaveLength(ins.length + contexts(calls).length);
  });

  it("returns an empty list when no userInvoked job matches the action", async () => {
    const calls: Call[] = [];
    const invoker = new PostgresJobInvoker(mockConn(calls), [reindexJob], { now: NOW });
    const runs = await invoker.invoke({ tenantId: TENANT, action: "unknown", data: {} });
    expect(runs).toEqual([]);
    // Not one statement, so no transaction is opened and no context is set when nothing is planned.
    expect(calls).toHaveLength(0);
  });

  it("establishes the tenant RLS context, with the tenant bound rather than interpolated", async () => {
    const calls: Call[] = [];
    const invoker = new PostgresJobInvoker(mockConn(calls), [reindexJob], { now: NOW });
    await invoker.invoke({ tenantId: TENANT, action: "reindex-catalog", data: {}, idempotencyKey: "inv-2" });

    // `meta.job_runs` carries exactly one ALL-scope isolation policy with a NULL WITH CHECK, so its
    // USING doubles as the write check: with no context the predicate is `tenant_id = NULL`, never
    // true, and the INSERT is refused 42501 as any role but the table's owner (ADR-0389).
    const ctx = contexts(calls);
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.sql).toBe(SET_TENANT_CONTEXT_SQL);
    // Bound as `$1`, never interpolated — a tenant id must not reach SQL text.
    expect(ctx[0]!.params).toEqual([TENANT]);
    expect(ctx[0]!.sql).not.toContain(TENANT);
    expect(ctx[0]!.sql).toContain("$1");
    // And it precedes the insert it exists to admit.
    expect(calls.indexOf(ctx[0]!)).toBeLessThan(calls.indexOf(inserts(calls)[0]!));
  });
});

describe("buildActionRoleMap", () => {
  it("parses action:role specs, accumulating roles per action", () => {
    const map = buildActionRoleMap([
      "reindex-catalog:catalog_admin",
      "reindex-catalog:ops_admin",
      "export-report:analyst",
    ]);
    expect([...map.get("reindex-catalog")!].sort()).toEqual(["catalog_admin", "ops_admin"]);
    expect([...map.get("export-report")!]).toEqual(["analyst"]);
    expect(map.has("other")).toBe(false);
  });

  it("throws on a malformed spec (no colon / empty side)", () => {
    expect(() => buildActionRoleMap(["noColon"])).toThrow(/expected action:role/);
    expect(() => buildActionRoleMap([":role"])).toThrow(/expected action:role/);
    expect(() => buildActionRoleMap(["action:"])).toThrow(/expected action:role/);
  });
});

describe("mergeActionRoleMaps", () => {
  it("overrides base per action, carrying through un-overridden actions", () => {
    const base = new Map<string, ReadonlySet<string>>([
      ["reindex-catalog", new Set(["catalog_admin"])],
      ["export-report", new Set(["analyst"])],
    ]);
    const override = new Map<string, ReadonlySet<string>>([["reindex-catalog", new Set(["ops_admin"])]]);
    const merged = mergeActionRoleMaps(base, override);
    expect([...merged.get("reindex-catalog")!]).toEqual(["ops_admin"]); // override wins entirely
    expect([...merged.get("export-report")!]).toEqual(["analyst"]); // base carries through
  });

  it("returns a fresh map (does not mutate base)", () => {
    const base = new Map<string, ReadonlySet<string>>([["a", new Set(["r"])]]);
    mergeActionRoleMaps(base, new Map([["b", new Set(["s"])]]));
    expect(base.has("b")).toBe(false);
  });
});
