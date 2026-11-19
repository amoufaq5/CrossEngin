import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  applyBootStatement,
  applyIndexConcurrently,
  renderMillisecondNowDefault,
  renderTenantIsolationQual,
} from "./boot-ddl.js";
import { MILLISECOND_NOW_SQL } from "./entity-ddl.js";

interface Call {
  readonly sql: string;
  readonly inTx: boolean;
}

function fakeConn(answer: (sql: string, attempt: number) => { rows: Record<string, unknown>[] } | Error): {
  conn: PgConnection;
  calls: Call[];
} {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  let inTx = false;
  const run = async (sql: string, params?: readonly unknown[]) => {
    assertBindArity(sql, params ?? []);
    calls.push({ sql, inTx });
    const n = (seen.get(sql) ?? 0) + 1;
    seen.set(sql, n);
    const out = answer(sql, n);
    if (out instanceof Error) throw out;
    return { rows: out.rows, rowCount: out.rows.length };
  };
  const conn = {
    query: run,
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn(conn);
      } finally {
        inTx = false;
      }
    },
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async () => undefined,
  } as unknown as PgConnection;
  return { conn, calls };
}

const lockTimeout = (): Error =>
  Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

describe("applyBootStatement", () => {
  it("runs the statement in a transaction bounded by both timeouts", async () => {
    const { conn, calls } = fakeConn(() => ({ rows: [] }));
    await applyBootStatement(conn, "ALTER TABLE t ENABLE ROW LEVEL SECURITY;", {
      lockTimeoutMs: 1234,
      statementTimeoutMs: 5678,
    });
    expect(calls.map((c) => c.sql)).toEqual([
      "SET LOCAL lock_timeout = '1234ms'",
      "SET LOCAL statement_timeout = '5678ms'",
      "ALTER TABLE t ENABLE ROW LEVEL SECURITY;",
    ]);
    expect(calls.every((c) => c.inTx)).toBe(true);
  });

  it("retries a lock timeout with backoff, and answers the attempt it succeeded on", async () => {
    const slept: number[] = [];
    const { conn } = fakeConn((sql, n) => (sql.startsWith("ALTER") && n < 3 ? lockTimeout() : { rows: [] }));
    const attempts = await applyBootStatement(conn, "ALTER TABLE t ADD COLUMN IF NOT EXISTS x TEXT;", {
      lockRetries: 2,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(attempts).toBe(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it("gives up after the retries, rethrowing the lock timeout", async () => {
    const { conn } = fakeConn((sql) => (sql.startsWith("ALTER") ? lockTimeout() : { rows: [] }));
    await expect(
      applyBootStatement(conn, "ALTER TABLE t ADD COLUMN IF NOT EXISTS x TEXT;", {
        lockRetries: 1,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "55P03" });
  });

  it("does not retry anything but a lock timeout", async () => {
    let alters = 0;
    const { conn } = fakeConn((sql) => {
      if (!sql.startsWith("ALTER")) return { rows: [] };
      alters++;
      return Object.assign(new Error("permission denied"), { code: "42501" });
    });
    await expect(
      applyBootStatement(conn, "ALTER TABLE t ADD COLUMN IF NOT EXISTS x TEXT;", { sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(alters).toBe(1);
  });
});

describe("applyIndexConcurrently", () => {
  const index = {
    qualifiedName: '"public"."t_ix_1"',
    sql: 'CREATE INDEX IF NOT EXISTS "t_ix_1" ON "public"."t" ("tenant_id", "a");',
  };

  it("issues nothing but the probe for an index already valid", async () => {
    const { conn, calls } = fakeConn((sql) => (sql.includes("pg_index") ? { rows: [{ valid: true }] } : { rows: [] }));
    expect(await applyIndexConcurrently(conn, index)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("builds an absent index CONCURRENTLY and outside any transaction", async () => {
    const { conn, calls } = fakeConn(() => ({ rows: [] }));
    expect(await applyIndexConcurrently(conn, index)).toBe(true);
    const build = calls.at(-1)!;
    expect(build.sql).toBe('CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_ix_1" ON "public"."t" ("tenant_id", "a");');
    expect(build.inTx).toBe(false);
  });

  it("drops an invalid leftover first, which IF NOT EXISTS would otherwise accept for ever", async () => {
    const { conn, calls } = fakeConn((sql) => (sql.includes("pg_index") ? { rows: [{ valid: false }] } : { rows: [] }));
    await applyIndexConcurrently(conn, index);
    expect(calls.map((c) => c.sql).slice(1)).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."t_ix_1";',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_ix_1" ON "public"."t" ("tenant_id", "a");',
    ]);
  });

  it("refuses a unique index, whose invalid leftover would still refuse writes", async () => {
    const { conn } = fakeConn(() => ({ rows: [] }));
    await expect(
      applyIndexConcurrently(conn, { ...index, sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "u" ON "public"."t" ("a");' }),
    ).rejects.toThrow(/not a non-unique/);
  });
});

describe("renderTenantIsolationQual", () => {
  it("asks Postgres through a scratch temporary table and answers its deparse", async () => {
    const rendering = "(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)";
    const { conn, calls } = fakeConn((sql) => (sql.includes("pg_get_expr") ? { rows: [{ qual: rendering }] } : { rows: [] }));
    expect(await renderTenantIsolationQual(conn)).toBe(rendering);
    expect(calls[0]!.sql).toContain("CREATE TEMP TABLE");
    expect(calls[0]!.sql).toContain("ON COMMIT DROP");
    expect(calls.every((c) => c.inTx)).toBe(true);
  });

  it("answers null when it cannot ask, so every policy is replaced rather than compared", async () => {
    const { conn } = fakeConn((sql) =>
      sql.includes("TEMP") ? Object.assign(new Error("permission denied to create temporary tables"), { code: "42501" }) : { rows: [] },
    );
    expect(await renderTenantIsolationQual(conn)).toBeNull();
  });
});

describe("renderMillisecondNowDefault", () => {
  it("asks Postgres for the stored form of the very default the emitter writes", async () => {
    const rendering = "date_trunc('milliseconds'::text, now())";
    const { conn, calls } = fakeConn((sql) => (sql.includes("pg_attrdef") ? { rows: [{ expr: rendering }] } : { rows: [] }));
    expect(await renderMillisecondNowDefault(conn)).toBe(rendering);
    expect(calls[0]!.sql).toContain(`DEFAULT ${MILLISECOND_NOW_SQL}`);
    expect(calls[0]!.sql).toContain("ON COMMIT DROP");
    expect(calls.every((c) => c.inTx)).toBe(true);
  });

  it("answers null when it cannot ask, so the SET DEFAULT runs unguarded", async () => {
    const { conn } = fakeConn((sql) =>
      sql.includes("TEMP") ? Object.assign(new Error("permission denied to create temporary tables"), { code: "42501" }) : { rows: [] },
    );
    expect(await renderMillisecondNowDefault(conn)).toBeNull();
  });
});
