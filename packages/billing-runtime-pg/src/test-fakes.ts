import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

export interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface FakeConn {
  readonly conn: PgConnection;
  readonly calls: CapturedQuery[];
}

/**
 * A fake `PgConnection` recording every `{sql, params}`; `transaction` runs the
 * callback with the same conn so a `withTenantContext` `set_config` call is
 * observable. `rows` supplies canned SELECT results in order (default empty).
 */
export function fakePg(rows: readonly Record<string, unknown>[][] = []): FakeConn {
  const calls: CapturedQuery[] = [];
  let selectIndex = 0;
  const conn: PgConnection = {
    query: (async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql) && !sql.includes("set_config")) {
        const next = rows[selectIndex] ?? [];
        selectIndex += 1;
        return { rows: next, rowCount: next.length } as PgQueryResult;
      }
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return { conn, calls };
}
