import { describe, expect, it } from "vitest";

import { PostgresDrDrillStore } from "./drill-store.js";
import { PostgresDrFailoverStore } from "./failover-store.js";
import { PostgresDrReadinessStore } from "./readiness-store.js";
import { DrReplayer } from "./replayer.js";
import { assertTenantId, scopeFilter } from "./tenant-context.js";

const TENANT = "11111111-1111-7111-8111-111111111111";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

/** Records every statement and answers empty, so a read's *shape* is the whole observation. */
function capturingConn(into: Captured[]): never extends never
  ? ConstructorParameters<typeof PostgresDrFailoverStore>[0]
  : never {
  const conn = {
    query: async (sql: string, params?: readonly unknown[]) => {
      into.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(conn),
    close: async (): Promise<void> => undefined,
  };
  return conn as never;
}

describe("scopeFilter", () => {
  it("asks for the platform scope as IS NULL, because `= NULL` is never true", () => {
    expect(scopeFilter(null)).toEqual({ sql: "tenant_id IS NULL", params: [] });
  });

  it("binds a tenant rather than interpolating it", () => {
    expect(scopeFilter(TENANT, 3)).toEqual({
      sql: "tenant_id = $3",
      params: [TENANT],
    });
  });

  it("refuses a tenant id that is not one", () => {
    expect(() => scopeFilter("'; DROP TABLE meta.dr_drills; --")).toThrow(/invalid tenantId/);
    expect(() => assertTenantId("not-a-uuid")).toThrow(/invalid tenantId/);
  });

  it("never emits IS NOT DISTINCT FROM, which is the one operator that is not indexable", () => {
    // ADR-0331 measured the unindexable form at 16 ms against a 0.09 ms index scan on 45k rows.
    // Lane E measured the sharper fact: with a *literal* NULL Postgres constant-folds it and the
    // index is used, but with a *bound parameter* — which is how a store issues it — it is a
    // sequential scan. 10.67 ms against 0.73 ms. So the penalty is invisible in psql and real in
    // production, which is exactly how a one-code-path refactor would get merged.
    for (const scope of [null, TENANT]) {
      expect(scopeFilter(scope).sql).not.toContain("IS NOT DISTINCT FROM");
    }
  });
});

describe("every DR read carries a scope predicate", () => {
  // The defect these pin: all three stores' reads took no scope argument at all, so there was
  // nothing to carry. As the table's owner — who bypasses RLS — `listRecent` returned every
  // tenant's rows and `latest()` answered with whichever tenant's snapshot was newest. The cost
  // was not a long list: `assessDrReadiness` scores drill recency and failover breaches from
  // these, so a deployment was scored READY on another tenant's disaster recovery.
  const cases: readonly {
    readonly name: string;
    readonly run: (c: Captured[], scope: string | null) => Promise<unknown>;
  }[] = [
    {
      name: "failover listRecent",
      run: (c, s) => new PostgresDrFailoverStore(capturingConn(c)).listRecent(s, 10),
    },
    {
      name: "failover countSince",
      run: (c, s) => new PostgresDrFailoverStore(capturingConn(c)).countSince(s, new Date(0)),
    },
    {
      name: "drill listRecent",
      run: (c, s) => new PostgresDrDrillStore(capturingConn(c)).listRecent(s, 10),
    },
    {
      name: "drill countSince",
      run: (c, s) => new PostgresDrDrillStore(capturingConn(c)).countSince(s, new Date(0)),
    },
    {
      name: "readiness listRecent",
      run: (c, s) => new PostgresDrReadinessStore(capturingConn(c)).listRecent(s, 10),
    },
    {
      name: "readiness latest",
      run: (c, s) => new PostgresDrReadinessStore(capturingConn(c)).latest(s),
    },
  ];

  for (const { name, run } of cases) {
    it(`${name} filters to the platform scope`, async () => {
      const captured: Captured[] = [];
      await run(captured, null);
      const read = captured.at(-1);
      expect(read?.sql).toContain("tenant_id IS NULL");
      expect(read?.params ?? []).not.toContain(TENANT);
    });

    it(`${name} binds a tenant and branches rather than matching NULL to NULL`, async () => {
      const captured: Captured[] = [];
      await run(captured, TENANT);
      const read = captured.at(-1);
      expect(read?.sql).toMatch(/tenant_id = \$\d/);
      expect(read?.sql).not.toContain("IS NOT DISTINCT FROM");
      expect(read?.params).toContain(TENANT);
    });
  }

  it("keeps the limit's placeholder after the scope's, so the two cannot collide", async () => {
    const captured: Captured[] = [];
    await new PostgresDrFailoverStore(capturingConn(captured)).listRecent(TENANT, 7);
    const read = captured.at(-1);
    // $1 is the tenant, $2 the limit — the numbering is derived from the filter's own parameter
    // count rather than hardcoded, so the platform arm (which binds nothing) shifts the limit to $1.
    expect(read?.sql).toContain("tenant_id = $1");
    expect(read?.sql).toContain("LIMIT $2");
    expect(read?.params).toEqual([TENANT, 7]);

    const platform: Captured[] = [];
    await new PostgresDrFailoverStore(capturingConn(platform)).listRecent(null, 7);
    expect(platform.at(-1)?.sql).toContain("LIMIT $1");
    expect(platform.at(-1)?.params).toEqual([7]);
  });
});

describe("the replayer takes a scope too", () => {
  it("passes it through to both stores rather than summarising every tenant into one figure", async () => {
    const captured: Captured[] = [];
    const conn = capturingConn(captured);
    const replayer = new DrReplayer(
      new PostgresDrFailoverStore(conn),
      new PostgresDrDrillStore(conn),
    );
    await replayer.summarize(TENANT, 5);
    expect(captured).toHaveLength(2);
    for (const stmt of captured) {
      expect(stmt.sql).toContain("tenant_id = $1");
      expect(stmt.params).toContain(TENANT);
    }
  });
});
