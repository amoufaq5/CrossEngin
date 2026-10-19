import { assertBindArity } from "@crossengin/testing";
import { vi } from "vitest";
import type {
  PgConnection,
  PgQueryResult,
  UnreadableRow,
  UnreadableRowReporter,
} from "@crossengin/kernel-pg";

export interface Captured {
  sql: string;
  params: readonly unknown[] | undefined;
}

/**
 * The one thing a recorder fake *can* check about scope, and the reason it has to.
 *
 * This fake does not model rows, so it cannot tell a scoped store from an unscoped one — which is
 * how the write-side half of ADR-0331's defect survived every offline test in this package: a fake
 * that answers `{rowCount: 1}` is as happy with `ON CONFLICT (execution_id) DO UPDATE` as with one
 * that pins the scope, so a platform-scoped `record()` advancing a *tenant's* failover row looked
 * identical to one that did not.
 *
 * So it refuses a statement that **could not have been scoped**: an `INSERT`/`UPDATE`/`DELETE`
 * against a `tenant_id`-nullable table must mention `tenant_id`, as a supplied column or as a
 * predicate. A tripwire rather than a simulation — it cannot say the predicate is *right* — and it
 * is the half that fails loudly when the next write path forgets.
 *
 * Reads are exempt deliberately: `refuseUnlessWritten`'s diagnosing re-read is unscoped **on
 * purpose**, because its question is whether the row sits in another scope.
 */
const MUTATING_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

export function assertStatementIsScoped(sql: string): void {
  if (!MUTATING_RE.test(sql)) return;
  if (sql.includes("tenant_id")) return;
  throw new Error(
    "this fake refuses an unscoped write: a statement that changes rows in a " +
      "`tenant_id`-nullable table must name tenant_id, as a supplied column or as a predicate — " +
      `got: ${sql.replace(/\s+/g, " ").slice(0, 120)}`,
  );
}

/**
 * The reporter a test passes when it means every row on the page to be readable.
 *
 * It **throws** rather than ignoring, which is this module's own fallback rule one argument over:
 * an answer for a case the test did not mean is how an assertion passes vacuously. Silently
 * dropping a report here would let a fixture drift into a shape the contract refuses and have the
 * test still read green — in a package whose whole subject is that a dropped row goes unnoticed.
 */
export const EXPECT_ALL_READABLE: UnreadableRowReporter = (row) => {
  throw new Error(
    `a row was unexpectedly unreadable (identity ${row.identity ?? "<none>"}): ${row.detail}`,
  );
};

/** A reporter that keeps what it was told, for the tests that mean to produce an unreadable row. */
export function collectUnreadable(): {
  readonly rows: readonly UnreadableRow[];
  readonly report: UnreadableRowReporter;
} {
  const rows: UnreadableRow[] = [];
  return { rows, report: (row) => rows.push(row) };
}

export function mockConnection(
  capture?: Captured[],
  result: PgQueryResult = { rows: [], rowCount: 1 },
  opts: { readonly allowUnscopedWrites?: boolean } = {},
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      if (opts.allowUnscopedWrites !== true) assertStatementIsScoped(sql);
      assertBindArity(sql, params);
      return result;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(mockConnection(capture, result, opts)),
    ) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}
