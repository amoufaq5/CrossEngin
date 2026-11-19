import { dataKeyToColumnKey } from "@crossengin/crypto";
import {
  DATA_KEY_SHARED_LOCK_SQL,
  type PostgresDataKeyStore,
  type StoredDataKey,
} from "@crossengin/crypto-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { COLUMN_ENCRYPTION_KEY_SETTING } from "@crossengin/operate-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  ColumnKeyRetired,
  fenceColumnKeyGeneration,
  type ColumnKeyFenceOutcome,
} from "./column-key-fence.js";
import { ColumnKeyLedger } from "./data-key-envelope.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SET_KEY = "SELECT set_config($1, $2, true)";
const OLD_DEK = new Uint8Array(32).fill(1);
const NEW_DEK = new Uint8Array(32).fill(2);
const OLD_KEY = dataKeyToColumnKey(OLD_DEK);
const NEW_KEY = dataKeyToColumnKey(NEW_DEK);

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function fakeConn(captured: Captured[]): PgConnection {
  const tx: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (inner: PgConnection) => Promise<T>) => fn(tx)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return tx;
}

function fakeStore(current: number | null, fresh: StoredDataKey | null): PostgresDataKeyStore {
  return {
    currentGenerationWithin: async () => current,
    loadWithin: async () => fresh,
  } as unknown as PostgresDataKeyStore;
}

async function setKeyThrough(
  conn: PgConnection,
  key: string,
): Promise<void> {
  await conn.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
    await tx.query(SET_KEY, [COLUMN_ENCRYPTION_KEY_SETTING, key]);
    await tx.query("INSERT INTO public.patient (mrn) VALUES (pgp_sym_encrypt($1, current_setting('app.column_encryption_key')))", ["x"]);
  });
}

describe("fenceColumnKeyGeneration", () => {
  it("takes the shared lock, re-reads the generation, then sets the cached key when it is current", async () => {
    const captured: Captured[] = [];
    const ledger = new ColumnKeyLedger();
    ledger.record(TENANT, OLD_KEY, 3);
    const outcomes: ColumnKeyFenceOutcome[] = [];
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), {
      store: fakeStore(3, null),
      ledger,
      onFence: (_t, o) => outcomes.push(o),
    });
    await setKeyThrough(fenced, OLD_KEY);
    const sqls = captured.map((c) => c.sql);
    const lock = sqls.indexOf(DATA_KEY_SHARED_LOCK_SQL);
    const set = sqls.indexOf(SET_KEY);
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(set);
    expect(captured[lock]?.params).toEqual([TENANT]);
    expect(captured[set]?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, OLD_KEY]);
    expect(outcomes).toEqual(["current"]);
  });

  it("heals a superseded key inside the transaction and evicts the cached entry", async () => {
    const captured: Captured[] = [];
    const ledger = new ColumnKeyLedger();
    ledger.record(TENANT, OLD_KEY, 3);
    const evicted: string[] = [];
    ledger.onSupersede((t) => evicted.push(t));
    const fresh: StoredDataKey = {
      tenantId: TENANT,
      generation: 4,
      kekGeneration: 1,
      provenance: "random",
      dek: NEW_DEK,
    };
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), {
      store: fakeStore(4, fresh),
      ledger,
    });
    await setKeyThrough(fenced, OLD_KEY);
    const set = captured.find((c) => c.sql === SET_KEY);
    // The write that follows is under the current generation's key, never the destroyed one.
    expect(set?.params).toEqual([COLUMN_ENCRYPTION_KEY_SETTING, NEW_KEY]);
    expect(captured.some((c) => c.params?.[1] === OLD_KEY)).toBe(false);
    expect(evicted).toEqual([TENANT]);
    expect(ledger.originOf(NEW_KEY)).toEqual({ tenantId: TENANT, generation: 4 });
    // Kept, not evicted: another request may still hold the old key (see the next test).
    expect(ledger.originOf(OLD_KEY)).toEqual({ tenantId: TENANT, generation: 3 });
  });

  it("still fences a superseded key a concurrent request read from the cache before the heal", async () => {
    // Request A heals (recording generation 4's key); request B had already taken generation 3's
    // key from the cache and only now sets it. B's key must still be recognised and moved to the
    // current generation, not passed through as a key this process never handed out.
    const ledger = new ColumnKeyLedger();
    ledger.record(TENANT, OLD_KEY, 3);
    ledger.record(TENANT, NEW_KEY, 4);
    const fresh: StoredDataKey = {
      tenantId: TENANT,
      generation: 4,
      kekGeneration: 1,
      provenance: "random",
      dek: NEW_DEK,
    };
    const captured: Captured[] = [];
    const outcomes: ColumnKeyFenceOutcome[] = [];
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), {
      store: fakeStore(4, fresh),
      ledger,
      onFence: (_t, o) => outcomes.push(o),
    });
    await setKeyThrough(fenced, OLD_KEY);
    expect(captured.map((c) => c.sql)).toContain(DATA_KEY_SHARED_LOCK_SQL);
    expect(captured.find((c) => c.sql === SET_KEY)?.params).toEqual([
      COLUMN_ENCRYPTION_KEY_SETTING,
      NEW_KEY,
    ]);
    expect(captured.some((c) => c.params?.[1] === OLD_KEY)).toBe(false);
    expect(outcomes).toEqual(["healed"]);
  });

  it("refuses by name when the tenant's data key row is gone", async () => {
    const ledger = new ColumnKeyLedger();
    ledger.record(TENANT, OLD_KEY, 3);
    const captured: Captured[] = [];
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), {
      store: fakeStore(null, null),
      ledger,
    });
    await expect(setKeyThrough(fenced, OLD_KEY)).rejects.toBeInstanceOf(ColumnKeyRetired);
    expect(captured.some((c) => c.sql === SET_KEY)).toBe(false);
  });

  it("passes a key it did not hand out through untouched, and adds no statement", async () => {
    const captured: Captured[] = [];
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), {
      store: fakeStore(9, null),
      ledger: new ColumnKeyLedger(),
    });
    await setKeyThrough(fenced, "a-derived-mode-key");
    expect(captured.map((c) => c.sql)).not.toContain(DATA_KEY_SHARED_LOCK_SQL);
    expect(captured).toHaveLength(3);
  });

  it("leaves a statement that does not set the column key alone", async () => {
    const captured: Captured[] = [];
    const ledger = new ColumnKeyLedger();
    ledger.record(TENANT, OLD_KEY, 3);
    const fenced = fenceColumnKeyGeneration(fakeConn(captured), { store: fakeStore(3, null), ledger });
    await fenced.transaction(async (tx) => {
      await tx.query("SELECT set_config($1, $2, true)", ["app.something_else", OLD_KEY]);
    });
    expect(captured).toHaveLength(1);
  });
});
