import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  SCOPED_WRITE_REFUSALS,
  ScopedWriteRefusedError,
  assertScopedWriteLanded,
  classifyScopedWriteRefusal,
  type ScopedWriteDiagnosis,
} from "./scoped-write.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

interface Captured {
  sql: string;
  params: readonly unknown[] | undefined;
}

function conn(
  rows: readonly Record<string, unknown>[],
  capture?: Captured[],
): PgConnection {
  const c: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return { rows, rowCount: rows.length } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(c),
    ) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return c;
}

const d: ScopedWriteDiagnosis = {
  schema: "meta",
  table: "feature_flags",
  idColumn: "flag_id",
  idValue: "ff_checkout1",
  tenantId: null,
  guard: "it was not last updated at the timestamp the caller read",
};

describe("SCOPED_WRITE_REFUSALS", () => {
  it("is the three things a zero-row scoped write can mean, and nothing else", () => {
    expect([...SCOPED_WRITE_REFUSALS]).toEqual([
      "row_absent",
      "wrong_scope",
      "guard_refused",
    ]);
  });
});

describe("classifyScopedWriteRefusal", () => {
  it("asks nothing at all when the write landed", async () => {
    const capture: Captured[] = [];
    expect(await classifyScopedWriteRefusal(conn([], capture), 1, d)).toBeNull();
    expect(capture).toEqual([]);
  });

  it("treats a null or undefined row count as zero, since node-postgres may answer either", async () => {
    expect(await classifyScopedWriteRefusal(conn([]), null, d)).not.toBeNull();
    expect(await classifyScopedWriteRefusal(conn([]), undefined, d)).not.toBeNull();
  });

  it("names `row_absent` when no row carries the id", async () => {
    const report = await classifyScopedWriteRefusal(conn([]), 0, d);
    expect(report?.reason).toBe("row_absent");
    expect(report?.storedTenantId).toBeNull();
    expect(report?.detail).toContain("ff_checkout1");
  });

  it("names `wrong_scope` when a platform write found a tenant's row", async () => {
    const report = await classifyScopedWriteRefusal(conn([{ tenant_id: TENANT }]), 0, d);
    expect(report?.reason).toBe("wrong_scope");
    expect(report?.storedTenantId).toBe(TENANT);
    expect(report?.detail).toContain("the platform scope");
    expect(report?.detail).toContain(TENANT);
  });

  it("names `wrong_scope` when a tenant write found the platform's row", async () => {
    const report = await classifyScopedWriteRefusal(conn([{ tenant_id: null }]), 0, {
      ...d,
      tenantId: TENANT,
    });
    expect(report?.reason).toBe("wrong_scope");
    expect(report?.storedTenantId).toBeNull();
  });

  it("names `wrong_scope` between two tenants", async () => {
    const report = await classifyScopedWriteRefusal(conn([{ tenant_id: OTHER }]), 0, {
      ...d,
      tenantId: TENANT,
    });
    expect(report?.reason).toBe("wrong_scope");
  });

  it("names `guard_refused` when the row is in the scope the write named", async () => {
    const report = await classifyScopedWriteRefusal(conn([{ tenant_id: null }]), 0, d);
    expect(report?.reason).toBe("guard_refused");
    expect(report?.detail).toContain(d.guard);
  });

  it("treats an undefined tenant_id column the way it treats a null one", async () => {
    // A `SELECT tenant_id` on a row where the column is NULL can arrive either way depending on
    // the driver's row shaping, and a platform row must not read as a wrong scope.
    const report = await classifyScopedWriteRefusal(conn([{}]), 0, d);
    expect(report?.reason).toBe("guard_refused");
  });

  /**
   * The read carries **no** scope predicate, deliberately. Its whole question is whether the row
   * sits in another scope, which a scoped read could only ever answer "absent".
   */
  it("diagnoses with an unscoped read, binding only the id", async () => {
    const capture: Captured[] = [];
    await classifyScopedWriteRefusal(conn([], capture), 0, { ...d, tenantId: TENANT });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toBe(
      "SELECT tenant_id FROM meta.feature_flags WHERE flag_id = $1",
    );
    expect(capture[0]?.params).toEqual(["ff_checkout1"]);
  });

  it("refuses an identifier it would have to interpolate and cannot vouch for", async () => {
    for (const bad of [
      { ...d, table: "feature_flags; DROP TABLE meta.audit_log" },
      { ...d, schema: "meta meta" },
      { ...d, idColumn: "flag_id)" },
    ]) {
      await expect(classifyScopedWriteRefusal(conn([]), 0, bad)).rejects.toThrow(
        /not a bare identifier/,
      );
    }
  });

  it("refuses the identifier before issuing anything", async () => {
    const capture: Captured[] = [];
    await classifyScopedWriteRefusal(conn([], capture), 0, { ...d, table: "a-b" }).catch(
      () => undefined,
    );
    expect(capture).toEqual([]);
  });
});

describe("assertScopedWriteLanded", () => {
  it("returns without issuing anything when the write landed", async () => {
    const capture: Captured[] = [];
    await expect(
      assertScopedWriteLanded(conn([], capture), 1, d),
    ).resolves.toBeUndefined();
    expect(capture).toEqual([]);
  });

  it("raises a typed error carrying every field, not only a message", async () => {
    const err = await assertScopedWriteLanded(conn([{ tenant_id: TENANT }]), 0, d).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScopedWriteRefusedError);
    const typed = err as ScopedWriteRefusedError;
    expect(typed.name).toBe("ScopedWriteRefusedError");
    expect(typed.reason).toBe("wrong_scope");
    expect(typed.target).toBe("meta.feature_flags");
    expect(typed.rowId).toBe("ff_checkout1");
    expect(typed.scopeTenantId).toBeNull();
    expect(typed.storedTenantId).toBe(TENANT);
  });

  it("puts the reason in the message, so a log line names it without a catcher", async () => {
    await expect(assertScopedWriteLanded(conn([]), 0, d)).rejects.toThrow(/row_absent/);
    await expect(
      assertScopedWriteLanded(conn([{ tenant_id: null }]), 0, d),
    ).rejects.toThrow(/guard_refused/);
  });

  it("reaches every declared reason", async () => {
    const seen = new Set<string>();
    for (const [rows, scope] of [
      [[], null],
      [[{ tenant_id: TENANT }], null],
      [[{ tenant_id: null }], null],
    ] as const) {
      const err = await assertScopedWriteLanded(conn(rows), 0, {
        ...d,
        tenantId: scope,
      }).then(
        () => null,
        (e: unknown) => (e as ScopedWriteRefusedError).reason,
      );
      if (err !== null) seen.add(err);
    }
    expect([...seen].sort()).toEqual([...SCOPED_WRITE_REFUSALS].sort());
  });
});
