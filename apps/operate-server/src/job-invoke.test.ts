import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresJobInvoker, buildActionRoleMap, mergeActionRoleMaps } from "./job-invoke.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function mockConn(calls: Call[]): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      return { rows: [{ run_id: params?.[3] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
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
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO meta.job_runs");
    expect(calls[0]!.params?.[0]).toBe(TENANT);
    expect(calls[0]!.params?.[2]).toBe("userInvoked");
  });

  it("returns an empty list when no userInvoked job matches the action", async () => {
    const calls: Call[] = [];
    const invoker = new PostgresJobInvoker(mockConn(calls), [reindexJob], { now: NOW });
    const runs = await invoker.invoke({ tenantId: TENANT, action: "unknown", data: {} });
    expect(runs).toEqual([]);
    expect(calls).toHaveLength(0);
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
