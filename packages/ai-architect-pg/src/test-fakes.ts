import { assertBindArity } from "@crossengin/testing";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
  /** The `app.current_tenant_id` in force when it ran; `null` outside a scoped transaction. */
  readonly tenant: string | null;
}

export type StatementHandler = (
  sql: string,
  params: readonly unknown[] | undefined,
) => PgQueryResult<Record<string, unknown>>;

/**
 * A connection whose `transaction` runs its callback and remembers the tenant context the
 * callback set, so a test can ask under which tenant each statement ran.
 *
 * The fakes this replaces declared `transaction: vi.fn()`, which discards the callback (ADR-0389):
 * a store that moved its statement inside `withTenantContext` would have issued nothing at all
 * and every assertion about the statement would have been unreachable. The context statement is
 * answered here and never handed to the test's handler, which asserts on the statement it is for.
 */
export function tenantScopedConnection(handler: StatementHandler): PgConnection & {
  readonly statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    tenant: string | null,
  ): Promise<PgQueryResult<Record<string, unknown>>> => {
    assertBindArity(sql, params ?? []);
    statements.push({ sql, params, tenant });
    return handler(sql, params);
  };
  const conn = {
    statements,
    query: (async (sql: string, params?: readonly unknown[]) => run(sql, params, null)) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      let tenant: string | null = null;
      const tx: PgConnection = {
        ...conn,
        query: (async (sql: string, params?: readonly unknown[]) => {
          if (sql === SET_TENANT_CONTEXT_SQL) {
            assertBindArity(sql, params ?? []);
            tenant = typeof params?.[0] === "string" ? params[0] : null;
            return { rows: [], rowCount: 1 };
          }
          return run(sql, params, tenant);
        }) as PgConnection["query"],
      };
      return fn(tx);
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async () => {
      throw new Error("this fake models no advisory lock");
    }) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}
