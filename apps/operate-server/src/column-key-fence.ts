/**
 * The write-time data-key generation fence (M-25).
 *
 * A serving process caches each tenant's column key for `--column-key-ttl-ms`, and a rekey changes
 * that key out of process. Until the entry lapses, the process **writes** new ciphertext under the
 * destroyed generation's key, splitting the tenant's columns across two keys with nothing on any row
 * recording which — and the rekey's own lock did not help, because no writer took it.
 *
 * This decorator makes every transaction that sets `app.column_encryption_key` take the **shared**
 * form of the rekey's per-tenant lock and then re-read the tenant's current generation, both as their
 * own statements and both before the key is set:
 *
 * - a rekey in flight holds the exclusive form, so the writer waits for it to commit or roll back;
 * - a writer already holding the shared form makes a starting rekey wait for it to finish, so a
 *   rekey's re-encryption pass can never miss a row a writer is about to commit under the old key;
 * - the generation read runs **after** the lock is granted, in a statement of its own, so under READ
 *   COMMITTED its snapshot sees whatever the rekey committed. Folded into the lock statement it would
 *   read the world as it was before the wait.
 *
 * If the generation moved, the transaction heals instead of failing: it loads the current key inside
 * the same transaction, sets that one, records it and evicts the stale cache entry. If the row is
 * gone the tenant's key was destroyed, and the write is refused by name — there is no key to write
 * under, and deriving one would be the silent split this exists to prevent.
 *
 * A key the ledger does not know — `--column-key-mode derived`, where keys never change — passes
 * through untouched, so a deployment that does not rekey pays nothing.
 */
import { DATA_KEY_SHARED_LOCK_SQL, type PostgresDataKeyStore } from "@crossengin/crypto-pg";
import { dataKeyToColumnKey } from "@crossengin/crypto";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { COLUMN_ENCRYPTION_KEY_SETTING } from "@crossengin/operate-runtime-pg";

import type { ColumnKeyLedger } from "./data-key-envelope.js";

/** The tenant's data key row is gone: destroyed under Article 17 or by hand. */
export class ColumnKeyRetired extends Error {
  constructor(readonly tenantId: string, readonly cachedGeneration: number) {
    super(
      `tenant ${tenantId} has no data key row any more (this process held generation ` +
        `${cachedGeneration.toString()}): its column key was destroyed, so nothing can be written ` +
        "or read under it",
    );
    this.name = "ColumnKeyRetired";
  }
}

/** What the fence did for one key-setting statement, for tests and a counter. */
export type ColumnKeyFenceOutcome = "current" | "healed" | "unknown_key";

export interface ColumnKeyFenceOptions {
  readonly store: PostgresDataKeyStore;
  readonly ledger: ColumnKeyLedger;
  readonly onFence?: (tenantId: string | null, outcome: ColumnKeyFenceOutcome) => void;
}

function isKeySetting(sql: string, params: readonly unknown[] | undefined): boolean {
  return (
    params !== undefined &&
    params[0] === COLUMN_ENCRYPTION_KEY_SETTING &&
    typeof params[1] === "string" &&
    /set_config\(\s*\$1\s*,\s*\$2/.test(sql)
  );
}

function fenceTransaction(tx: PgConnection, options: ColumnKeyFenceOptions): PgConnection {
  const { store, ledger, onFence } = options;
  const query = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
    if (!isKeySetting(sql, params)) return tx.query(sql, params);
    const key = params?.[1] as string;
    const origin = ledger.originOf(key);
    if (origin === undefined) {
      onFence?.(null, "unknown_key");
      return tx.query(sql, params);
    }
    await tx.query(DATA_KEY_SHARED_LOCK_SQL, [origin.tenantId]);
    const current = await store.currentGenerationWithin(tx, origin.tenantId);
    if (current === origin.generation) {
      onFence?.(origin.tenantId, "current");
      return tx.query(sql, params);
    }
    if (current === null) throw new ColumnKeyRetired(origin.tenantId, origin.generation);
    const fresh = await store.loadWithin(tx, origin.tenantId);
    if (fresh === null) throw new ColumnKeyRetired(origin.tenantId, origin.generation);
    const healed = dataKeyToColumnKey(fresh.dek);
    ledger.record(origin.tenantId, healed, fresh.generation);
    ledger.supersede(origin.tenantId);
    onFence?.(origin.tenantId, "healed");
    return tx.query(sql, [params?.[0], healed, ...(params?.slice(2) ?? [])]);
  };
  return {
    query: query as PgConnection["query"],
    transaction: ((fn: (inner: PgConnection) => Promise<unknown>) =>
      tx.transaction((inner) => fn(fenceTransaction(inner, options)))) as PgConnection["transaction"],
    withAdvisoryLock: tx.withAdvisoryLock.bind(tx) as PgConnection["withAdvisoryLock"],
    close: tx.close.bind(tx) as PgConnection["close"],
  };
}

/**
 * Wraps the connection the column store writes through. Only statements inside a transaction are
 * fenced, because `withTenantContext` is the only route a key reaches the database by and it always
 * opens one; a bare `query` passes through.
 */
export function fenceColumnKeyGeneration(
  conn: PgConnection,
  options: ColumnKeyFenceOptions,
): PgConnection {
  return {
    query: conn.query.bind(conn) as PgConnection["query"],
    transaction: ((fn: (tx: PgConnection) => Promise<unknown>) =>
      conn.transaction((tx) => fn(fenceTransaction(tx, options)))) as PgConnection["transaction"],
    withAdvisoryLock: conn.withAdvisoryLock.bind(conn) as PgConnection["withAdvisoryLock"],
    close: conn.close.bind(conn) as PgConnection["close"],
  };
}
