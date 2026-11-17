import { AsyncLocalStorage } from "node:async_hooks";

import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Which Postgres transaction the current async context is running inside, for a writer that must
 * join it without being handed it.
 *
 * The entity stores open their own transaction (`withTransaction` → `withTenantContext` →
 * `conn.transaction`) and give the handler an `EntityStore` bound to it — deliberately not the
 * `PgConnection`, which `operate-runtime` must not know about. An entity write's audit row has to be
 * written on **that** connection or it cannot share the write's fate: a second transaction commits
 * independently (a write with no record, or a record of a write that rolled back), and it takes a
 * second pooled connection while the first is held, which is ADR-0422's measured pool deadlock.
 *
 * So the pool-level connection is wrapped once, and each transaction it opens runs its callback with
 * the transaction's own connection as the async context's store. The store does not hand out the
 * connection; it only answers "which transaction am I in", and only to code already running inside
 * the callback — exactly the code that could have been passed `tx` explicitly.
 *
 * `transaction` is the only method that changes: a query outside one has no transaction to report,
 * `withAdvisoryLock` holds a session and not a transaction, and the connection a callback receives
 * is node-postgres's own, which refuses a nested `transaction` — so there is no inner level to track.
 */
export class AmbientTransactions {
  private readonly storage = new AsyncLocalStorage<PgConnection>();

  wrap(conn: PgConnection): PgConnection {
    const storage = this.storage;
    return {
      query: (sql, params) => conn.query(sql, params),
      transaction: (fn) => conn.transaction((tx) => storage.run(tx, () => fn(tx))),
      withAdvisoryLock: (key, fn) => conn.withAdvisoryLock(key, fn),
      close: () => conn.close(),
    };
  }

  /** The transaction the caller is running inside, or undefined outside every one. */
  current(): PgConnection | undefined {
    return this.storage.getStore();
  }
}
