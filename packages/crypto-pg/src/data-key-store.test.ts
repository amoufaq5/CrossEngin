import { describe, expect, it } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  DATA_KEY_BYTES,
  dataKeyWrapAad,
  generateDataKey,
  wrapDataKey,
} from "@crossengin/crypto";

import {
  DATA_KEY_LOCK_SQL,
  DATA_KEY_PROVENANCES,
  DataKeyUnwrapFailed,
  PostgresDataKeyStore,
} from "./data-key-store.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

/** One KEK for both tenants, so only the AAD keeps their rows apart. */
const KEK = new Uint8Array(32).fill(7);
const kekFor = (): Uint8Array => KEK;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
  /** False for a statement issued outside `transaction`, which is the defect ADR-0335 found twice. */
  readonly inTx: boolean;
}

/** Thrown where Postgres raises `new row violates row-level security policy`. */
class FakeRlsViolation extends Error {
  constructor(detail: string) {
    super(
      `new row violates row-level security policy for table "tenant_data_keys": ${detail}`,
    );
    this.name = "FakeRlsViolation";
  }
}

interface FakeDataKeysOptions {
  /**
   * Run as the table's owner: RLS is not applied at all, so the statement's own predicate is the
   * only thing left. Both arms exist because this class of defect is invisible from either vantage
   * alone — a non-owner's unscoped statement is refused by the policy whether the store carries a
   * predicate or not.
   */
  readonly owner?: boolean;
  readonly seedRows?: readonly Record<string, unknown>[];
}

interface FakeDataKeysPg {
  readonly conn: PgConnection;
  readonly captured: readonly Captured[];
  readonly rows: Record<string, unknown>[];
}

/**
 * In-memory `meta.tenant_data_keys` with RLS-like scoping, modelled on this package's
 * `fakeCryptoKeysPg`.
 *
 * Two tripwires carry the weight, and both are the point of having a fake at all rather than a
 * recorder: a **write** with no `tenant_id` — the bound column on an INSERT, the predicate on a
 * DELETE — throws, because as the owner such a statement reaches whichever scope's row it finds;
 * and a non-owner write whose tenant is not the session's scope raises, because this table's
 * isolation policy is its only arm and therefore the only thing carrying a `WITH CHECK`.
 *
 * It diverges from `fakeCryptoKeysPg` in one place: a **read** with no `tenant_id` predicate throws
 * here too. That fake exempts reads on purpose, because `classifyScopedWriteRefusal`'s diagnosing
 * re-read is deliberately unscoped and asks whether the row sits in another scope. This store has no
 * such re-read, so there is nothing to exempt and the stricter rule costs nothing.
 */
function fakeDataKeysPg(options: FakeDataKeysOptions = {}): FakeDataKeysPg {
  const owner = options.owner === true;
  const rows: Record<string, unknown>[] = [...(options.seedRows ?? [])];
  const captured: Captured[] = [];

  function makeClient(inTx: boolean): PgConnection {
    let currentTenant: string | null = null;

    function statementScope(sql: string, p: readonly unknown[], kind: string): string {
      const strict = sql.match(/tenant_id\s*=\s*\$(\d+)/);
      if (strict !== null) return String(p[Number(strict[1]) - 1]);
      throw new Error(
        `this fake refuses a ${kind} that carries no tenant_id predicate: as the table's owner ` +
          "it reaches whichever scope's row it finds",
      );
    }

    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];
      captured.push({ sql, params, inTx });

      if (sql.includes("set_config")) {
        currentTenant = (p[0] as string | null) ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("INSERT INTO")) {
        const columns = sql.match(/\(([^)]*)\)\s*VALUES/);
        if (columns === null || !/\btenant_id\b/.test(columns[1] ?? "")) {
          throw new Error(
            "this fake refuses an INSERT that does not name tenant_id: the column is NOT NULL and " +
              "is the row's whole scope",
          );
        }
        const names = (columns[1] ?? "").split(",").map((c) => c.trim());
        const row: Record<string, unknown> = {};
        names.forEach((name, i) => {
          row[name] = p[i];
        });
        const tenantId = String(row["tenant_id"]);
        if (!owner && tenantId !== currentTenant) {
          throw new FakeRlsViolation(
            `tenant ${tenantId} is not the session's scope (${String(currentTenant)})`,
          );
        }
        const duplicate = rows.some(
          (r) =>
            r["tenant_id"] === row["tenant_id"] && r["generation"] === row["generation"],
        );
        if (duplicate) {
          const err = new Error(
            'duplicate key value violates unique constraint "tenant_data_keys_tenant_generation_key"',
          );
          (err as Error & { code?: string }).code = "23505";
          throw err;
        }
        rows.push(row);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("DELETE FROM")) {
        const scope = statementScope(sql, p, "DELETE");
        const doomed = rows.filter(
          (r) =>
            r["tenant_id"] === scope && (owner || r["tenant_id"] === currentTenant),
        );
        for (const r of doomed) rows.splice(rows.indexOf(r), 1);
        return { rows: [], rowCount: doomed.length };
      }

      if (sql.includes("SELECT")) {
        const scope = statementScope(sql, p, "SELECT");
        let visible = rows.filter(
          (r) => owner || r["tenant_id"] === currentTenant,
        );
        visible = visible.filter((r) => r["tenant_id"] === scope);
        const generation = sql.match(/generation\s*=\s*\$(\d+)/);
        if (generation !== null) {
          const want = p[Number(generation[1]) - 1];
          visible = visible.filter((r) => r["generation"] === want);
        }
        if (sql.includes("ORDER BY generation DESC")) {
          visible = [...visible].sort(
            (a, b) => Number(b["generation"]) - Number(a["generation"]),
          );
        }
        if (/LIMIT 1/.test(sql)) visible = visible.slice(0, 1);
        return { rows: visible, rowCount: visible.length };
      }

      return { rows: [], rowCount: 0 };
    };

    return {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(makeClient(true))) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  return { conn: makeClient(false), captured, rows };
}

function storedRow(
  tenantId: string,
  dek: Uint8Array,
  opts: {
    readonly generation?: number;
    readonly kekGeneration?: number;
    readonly provenance?: string;
    readonly aadTenantId?: string;
  } = {},
): Record<string, unknown> {
  const generation = opts.generation ?? 1;
  return {
    tenant_id: tenantId,
    generation,
    wrapped_key: Buffer.from(
      wrapDataKey(KEK, dek, dataKeyWrapAad(opts.aadTenantId ?? tenantId, generation)),
    ),
    kek_generation: opts.kekGeneration ?? 1,
    provenance: opts.provenance ?? "random",
  };
}

function sqlOf(captured: readonly Captured[]): string[] {
  return captured.map((c) => c.sql);
}

/**
 * A read **of the table**, which is not the same as a statement containing `SELECT`: both
 * `set_config` and `pg_advisory_xact_lock` are issued as `SELECT`s, and matching those as reads is
 * how three of these assertions first passed against the wrong statement.
 */
function isTableRead(sql: string): boolean {
  return /FROM meta\.tenant_data_keys/.test(sql) && sql.startsWith("SELECT ");
}

/** Flips one byte of a stored `wrapped_key`. `readUInt8` rather than an index, for strict mode. */
function corrupt(row: Record<string, unknown>, at: number): Record<string, unknown> {
  const bytes = Buffer.from(row["wrapped_key"] as Uint8Array);
  const offset = at < 0 ? bytes.length + at : at;
  bytes.writeUInt8(bytes.readUInt8(offset) ^ 0xff, offset);
  return { ...row, wrapped_key: bytes };
}

describe("constants", () => {
  it("names exactly the two provenances the column's CHECK permits", () => {
    expect(DATA_KEY_PROVENANCES).toEqual(["random", "seeded_from_derived"]);
  });

  it("takes a transaction-scoped advisory lock, not a session one", () => {
    expect(DATA_KEY_LOCK_SQL).toContain("pg_advisory_xact_lock");
    expect(DATA_KEY_LOCK_SQL).not.toMatch(/pg_advisory_lock\(/);
  });

  it("namespaces the lock key so two per-tenant locks cannot collide", () => {
    expect(DATA_KEY_LOCK_SQL).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('crypto_tenant_data_key'), hashtext($1))",
    );
  });
});

describe("construction", () => {
  it("rejects a malformed schema identifier", () => {
    const { conn } = fakeDataKeysPg();
    expect(() => new PostgresDataKeyStore(conn, kekFor, { schema: "meta; DROP" })).toThrow(
      /invalid schema/,
    );
  });

  it("refuses a kekGeneration the column's CHECK would reject", () => {
    const { conn } = fakeDataKeysPg();
    expect(() => new PostgresDataKeyStore(conn, kekFor, { kekGeneration: 0 })).toThrow(
      /kekGeneration/,
    );
  });

  it("refuses a malformed tenant id before any statement", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await expect(store.ensure("not a uuid;")).rejects.toThrow(/invalid tenantId/);
    expect(fake.captured).toHaveLength(0);
  });
});

describe("ensure provisions when absent", () => {
  it("inserts the full column list with the right bound parameters", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const key = await store.ensure(TENANT_A);

    const insert = fake.captured.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert?.sql).toContain("meta.tenant_data_keys");
    expect(insert?.sql).toContain(
      "(tenant_id, generation, wrapped_key, kek_generation, provenance)",
    );
    expect(insert?.sql).toContain("VALUES ($1, $2, $3, $4, $5)");
    expect(insert?.params?.[0]).toBe(TENANT_A);
    expect(insert?.params?.[1]).toBe(1);
    expect(insert?.params?.[3]).toBe(1);
    expect(insert?.params?.[4]).toBe("random");
    expect(key.tenantId).toBe(TENANT_A);
    expect(key.generation).toBe(1);
    expect(key.dek).toHaveLength(DATA_KEY_BYTES);
  });

  it("binds the wrapped key as a Buffer, which is what node-postgres serialises as BYTEA", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.ensure(TENANT_A);
    const insert = fake.captured.find((c) => c.sql.includes("INSERT INTO"));
    // A forward fence rather than a live one, stated so nobody reads it as more than it is:
    // `wrapDataKey` is declared to return `Uint8Array` and today over-delivers a `Buffer`, because
    // `aeadSeal` ends in `Buffer.concat`. node-postgres serialises a value by asking
    // `Buffer.isBuffer` and renders anything else as text, so the day that return type is honoured
    // literally the store's own `Buffer.from` is the only thing between a wrapped key and a
    // `BYTEA` column holding `"1,2,3,…"`. Removing it is green until then.
    expect(Buffer.isBuffer(insert?.params?.[2])).toBe(true);
  });

  it("records provenance 'random' and a key that is not the seed of anything", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const first = await store.ensure(TENANT_A);
    const other = await new PostgresDataKeyStore(
      fakeDataKeysPg().conn,
      kekFor,
    ).ensure(TENANT_A);
    expect(first.provenance).toBe("random");
    expect(Buffer.from(first.dek).equals(Buffer.from(other.dek))).toBe(false);
  });

  it("records provenance 'seeded_from_derived' and stores the seeded bytes", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const seed = new Uint8Array(DATA_KEY_BYTES).fill(9);

    const key = await store.ensure(TENANT_A, { seed });

    const insert = fake.captured.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert?.params?.[4]).toBe("seeded_from_derived");
    expect(key.provenance).toBe("seeded_from_derived");
    expect(Buffer.from(key.dek).equals(Buffer.from(seed))).toBe(true);

    const reread = await store.load(TENANT_A);
    expect(Buffer.from(reread?.dek ?? new Uint8Array()).equals(Buffer.from(seed))).toBe(
      true,
    );
  });

  it("records the configured kek generation rather than assuming 1", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor, { kekGeneration: 4 });
    const key = await store.ensure(TENANT_A);
    const insert = fake.captured.find((c) => c.sql.includes("INSERT INTO"));
    expect(insert?.params?.[3]).toBe(4);
    expect(key.kekGeneration).toBe(4);
  });

  it("lets wrapDataKey's length refusal propagate, and writes nothing", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    // Not re-checked here: one definition of what a data key is. The consequence worth pinning is
    // that the refusal lands before the INSERT, so the transaction rolls back having written
    // nothing and the advisory lock goes with it.
    await expect(
      store.ensure(TENANT_A, { seed: new Uint8Array(DATA_KEY_BYTES - 1) }),
    ).rejects.toThrow(/32 bytes/);
    expect(sqlOf(fake.captured).some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(fake.rows).toHaveLength(0);
  });
});

describe("ensure is race-safe and idempotent", () => {
  it("takes the per-tenant advisory lock before reading, inside the transaction", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.ensure(TENANT_A);

    const order = sqlOf(fake.captured);
    const context = order.indexOf(SET_TENANT_CONTEXT_SQL);
    const lock = order.indexOf(DATA_KEY_LOCK_SQL);
    const read = order.findIndex((s) => isTableRead(s));
    const insert = order.findIndex((s) => s.includes("INSERT INTO"));

    expect(context).toBeGreaterThanOrEqual(0);
    expect(context).toBeLessThan(lock);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(insert);
    expect(fake.captured[lock]?.params).toEqual([TENANT_A]);
    expect(fake.captured.every((c) => c.inTx)).toBe(true);
  });

  it("does not insert when a row already exists, and returns it unwrapped", async () => {
    const dek = generateDataKey();
    const fake = fakeDataKeysPg({
      seedRows: [storedRow(TENANT_A, dek, { provenance: "seeded_from_derived" })],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const key = await store.ensure(TENANT_A);

    expect(sqlOf(fake.captured).some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(key.provenance).toBe("seeded_from_derived");
    expect(Buffer.from(key.dek).equals(Buffer.from(dek))).toBe(true);
  });

  it("does not replace an existing key with a caller's seed", async () => {
    const stored = generateDataKey();
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, stored)] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const key = await store.ensure(TENANT_A, {
      seed: new Uint8Array(DATA_KEY_BYTES).fill(3),
    });

    expect(Buffer.from(key.dek).equals(Buffer.from(stored))).toBe(true);
    expect(key.provenance).toBe("random");
  });

  it("returns the highest generation rather than minting a second one", async () => {
    const gen2 = generateDataKey();
    const fake = fakeDataKeysPg({
      seedRows: [
        storedRow(TENANT_A, generateDataKey(), { generation: 1 }),
        storedRow(TENANT_A, gen2, { generation: 2 }),
      ],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const key = await store.ensure(TENANT_A);

    expect(key.generation).toBe(2);
    expect(Buffer.from(key.dek).equals(Buffer.from(gen2))).toBe(true);
  });

  it("propagates a unique violation rather than catching it and re-reading", async () => {
    // What a defeated lock looks like from inside the transaction: the read finds nothing and the
    // INSERT collides with a row another session committed in between. Catching this and
    // re-reading is exactly the `ON CONFLICT DO NOTHING` behaviour this design rejects — the loser
    // that was seeding would discard its seed and return the winner's random key.
    let inserts = 0;
    const racing: PgConnection = {
      query: (async (sql: string) => {
        if (sql.includes("INSERT INTO")) {
          inserts += 1;
          const err = new Error(
            'duplicate key value violates unique constraint "tenant_data_keys_tenant_generation_key"',
          );
          (err as Error & { code?: string }).code = "23505";
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(racing)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    const store = new PostgresDataKeyStore(racing, kekFor);
    const seed = new Uint8Array(DATA_KEY_BYTES).fill(5);

    await expect(store.ensure(TENANT_A, { seed })).rejects.toThrow(/unique constraint/);
    expect(inserts).toBe(1);
  });
});

describe("load", () => {
  it("orders by generation descending and limits 1 when none is named", async () => {
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, generateDataKey())] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.load(TENANT_A);

    const read = fake.captured.find((c) => isTableRead(c.sql));
    expect(read?.sql).toContain("ORDER BY generation DESC");
    expect(read?.sql).toContain("LIMIT 1");
    expect(read?.sql).toContain(
      "SELECT tenant_id, generation, wrapped_key, kek_generation, provenance",
    );
  });

  it("returns the highest generation when none is named", async () => {
    const gen3 = generateDataKey();
    const fake = fakeDataKeysPg({
      seedRows: [
        storedRow(TENANT_A, generateDataKey(), { generation: 1 }),
        storedRow(TENANT_A, gen3, { generation: 3 }),
      ],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const key = await store.load(TENANT_A);
    expect(key?.generation).toBe(3);
    expect(Buffer.from(key?.dek ?? new Uint8Array()).equals(Buffer.from(gen3))).toBe(true);
  });

  it("binds an explicit generation and reads that one", async () => {
    const gen1 = generateDataKey();
    const fake = fakeDataKeysPg({
      seedRows: [
        storedRow(TENANT_A, gen1, { generation: 1 }),
        storedRow(TENANT_A, generateDataKey(), { generation: 3 }),
      ],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const key = await store.load(TENANT_A, 1);

    const read = fake.captured.find((c) => isTableRead(c.sql));
    expect(read?.sql).toContain("generation = $2");
    expect(read?.params).toEqual([TENANT_A, 1]);
    expect(key?.generation).toBe(1);
    expect(Buffer.from(key?.dek ?? new Uint8Array()).equals(Buffer.from(gen1))).toBe(true);
  });

  it("answers null for a tenant with no row", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    expect(await store.load(TENANT_A)).toBeNull();
  });

  it("answers null for a generation that does not exist", async () => {
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, generateDataKey())] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    expect(await store.load(TENANT_A, 9)).toBeNull();
  });

  it("reports provenance and kek generation off the row", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [
        storedRow(TENANT_A, generateDataKey(), {
          kekGeneration: 2,
          provenance: "seeded_from_derived",
        }),
      ],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const key = await store.load(TENANT_A);
    expect(key?.kekGeneration).toBe(2);
    expect(key?.provenance).toBe("seeded_from_derived");
  });
});

describe("scope", () => {
  it("sets tenant context inside the transaction on every path", async () => {
    for (const run of [
      async (s: PostgresDataKeyStore): Promise<unknown> => s.ensure(TENANT_A),
      async (s: PostgresDataKeyStore): Promise<unknown> => s.load(TENANT_A),
      async (s: PostgresDataKeyStore): Promise<unknown> => s.destroy(TENANT_A),
    ]) {
      const fake = fakeDataKeysPg();
      await run(new PostgresDataKeyStore(fake.conn, kekFor));
      const context = fake.captured.find((c) => c.sql === SET_TENANT_CONTEXT_SQL);
      expect(context?.params).toEqual([TENANT_A]);
      expect(context?.inTx).toBe(true);
      expect(fake.captured.every((c) => c.inTx)).toBe(true);
    }
  });

  it("carries the strict scope predicate on every read and delete", async () => {
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, generateDataKey())] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.ensure(TENANT_A);
    await store.load(TENANT_A);
    await store.destroy(TENANT_A);

    const scoped = fake.captured.filter(
      (c) => isTableRead(c.sql) || c.sql.includes("DELETE FROM"),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) {
      expect(c.sql).toContain("tenant_id = $1");
      // Never the inclusive arm: there is no platform data key, so another scope's row is never
      // evidence about this tenant.
      expect(c.sql).not.toContain("tenant_id IS NULL");
    }
  });

  it("is refused by the policy when a write names another tenant (non-owner)", async () => {
    const fake = fakeDataKeysPg();
    // The store always writes the scope it set; this proves the fake's WITH CHECK is live, so the
    // tests above are asserting against a fake that would have caught the absence.
    await expect(
      fake.conn.transaction(async (tx) => {
        await tx.query(SET_TENANT_CONTEXT_SQL, [TENANT_A]);
        return tx.query(
          "INSERT INTO meta.tenant_data_keys (tenant_id, generation, wrapped_key, kek_generation, provenance) VALUES ($1, $2, $3, $4, $5)",
          [TENANT_B, 1, Buffer.alloc(1), 1, "random"],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses an unscoped read, which as the owner would reach every tenant", async () => {
    const fake = fakeDataKeysPg({ owner: true });
    await expect(
      fake.conn.query("SELECT tenant_id FROM meta.tenant_data_keys"),
    ).rejects.toThrow(/no tenant_id predicate/);
  });

  it("refuses an INSERT that does not name tenant_id", async () => {
    const fake = fakeDataKeysPg({ owner: true });
    await expect(
      fake.conn.query(
        "INSERT INTO meta.tenant_data_keys (generation, wrapped_key) VALUES ($1, $2)",
        [1, Buffer.alloc(1)],
      ),
    ).rejects.toThrow(/does not name tenant_id/);
  });

  it("does not read another tenant's row even as the owner", async () => {
    const fake = fakeDataKeysPg({
      owner: true,
      seedRows: [storedRow(TENANT_B, generateDataKey())],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    expect(await store.load(TENANT_A)).toBeNull();
  });
});

describe("a key that will not unwrap is a refusal", () => {
  it("throws DataKeyUnwrapFailed from load on a corrupted wrapped_key", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [corrupt(storedRow(TENANT_A, generateDataKey()), -1)],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    await expect(store.load(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
  });

  it("throws DataKeyUnwrapFailed from ensure rather than provisioning a second key", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [corrupt(storedRow(TENANT_A, generateDataKey()), 0)],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    await expect(store.ensure(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
    expect(sqlOf(fake.captured).some((s) => s.includes("INSERT INTO"))).toBe(false);
  });

  it("names the tenant and generation and leaks no key material", async () => {
    const dek = generateDataKey();
    const row = corrupt(storedRow(TENANT_A, dek, { generation: 2 }), 3);
    const bytes = row["wrapped_key"] as Buffer;
    const fake = fakeDataKeysPg({ seedRows: [row] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const error = await store.load(TENANT_A).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataKeyUnwrapFailed);
    const failure = error as DataKeyUnwrapFailed;
    expect(failure.tenantId).toBe(TENANT_A);
    expect(failure.generation).toBe(2);
    expect(failure.message).toContain(TENANT_A);
    expect(failure.message).toContain("2");
    for (const secret of [
      Buffer.from(dek).toString("hex"),
      Buffer.from(dek).toString("base64"),
      bytes.toString("hex"),
      Buffer.from(KEK).toString("hex"),
    ]) {
      expect(failure.message).not.toContain(secret);
    }
  });

  it("refuses a row wrapped for another tenant under the same KEK (the AAD binding)", async () => {
    // One KEK for both tenants, so the only thing keeping their rows apart is the AAD. The row is
    // filed under TENANT_A and wrapped against TENANT_B's AAD, which is what a row copied between
    // tenants looks like.
    const fake = fakeDataKeysPg({
      seedRows: [storedRow(TENANT_A, generateDataKey(), { aadTenantId: TENANT_B })],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await expect(store.load(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
  });

  it("refuses a row wrapped under a different generation's AAD", async () => {
    const row = storedRow(TENANT_A, generateDataKey(), { generation: 1 });
    const fake = fakeDataKeysPg({ seedRows: [{ ...row, generation: 2 }] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await expect(store.load(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
  });

  it("refuses a row whose wrapped_key came back as text rather than bytes", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [{ ...storedRow(TENANT_A, generateDataKey()), wrapped_key: "\\xdeadbeef" }],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await expect(store.load(TENANT_A)).rejects.toThrow(/BYTEA buffer/);
  });

  it("refuses a provenance the column's CHECK would not permit", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [storedRow(TENANT_A, generateDataKey(), { provenance: "derived" })],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await expect(store.load(TENANT_A)).rejects.toThrow(/unknown data key provenance/);
  });
});

describe("destroy", () => {
  it("deletes every generation for the tenant and returns the count", async () => {
    const fake = fakeDataKeysPg({
      seedRows: [
        storedRow(TENANT_A, generateDataKey(), { generation: 1 }),
        storedRow(TENANT_A, generateDataKey(), { generation: 2 }),
        storedRow(TENANT_B, generateDataKey(), { generation: 1 }),
      ],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    expect(await store.destroy(TENANT_A)).toBe(2);
    expect(fake.rows.map((r) => r["tenant_id"])).toEqual([TENANT_B]);
  });

  it("carries the strict scope predicate and binds the tenant", async () => {
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, generateDataKey())] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.destroy(TENANT_A);

    const del = fake.captured.find((c) => c.sql.includes("DELETE FROM"));
    expect(del?.sql).toBe("DELETE FROM meta.tenant_data_keys WHERE tenant_id = $1");
    expect(del?.params).toEqual([TENANT_A]);
    expect(del?.inTx).toBe(true);
  });

  it("is a hard delete: the row is gone, not flagged", async () => {
    const fake = fakeDataKeysPg({ seedRows: [storedRow(TENANT_A, generateDataKey())] });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    await store.destroy(TENANT_A);
    expect(fake.rows).toHaveLength(0);
    expect(await store.load(TENANT_A)).toBeNull();
  });

  it("answers 0 for a tenant with no key", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    expect(await store.destroy(TENANT_A)).toBe(0);
  });

  it("leaves another tenant's key alone even as the owner", async () => {
    const fake = fakeDataKeysPg({
      owner: true,
      seedRows: [storedRow(TENANT_B, generateDataKey())],
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    expect(await store.destroy(TENANT_A)).toBe(0);
    expect(fake.rows).toHaveLength(1);
  });

  it("makes the key unrecoverable: a later ensure mints a different one", async () => {
    const fake = fakeDataKeysPg();
    const store = new PostgresDataKeyStore(fake.conn, kekFor);
    const before = await store.ensure(TENANT_A);
    await store.destroy(TENANT_A);
    const after = await store.ensure(TENANT_A);
    expect(Buffer.from(before.dek).equals(Buffer.from(after.dek))).toBe(false);
  });
});
