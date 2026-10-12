import { beforeEach, describe, expect, it } from "vitest";
import type { PgConnection, ScopedWriteRefusedError } from "@crossengin/kernel-pg";
import {
  InMemoryKeyStore,
  type KeyPurpose,
  type KeyRecord,
} from "@crossengin/crypto";

import { PostgresKeyRegistry } from "./key-registry.js";
import { keyRegistryRecordFrom, type KeyRegistryRecord } from "./records.js";
import { fakeCryptoKeysPg } from "./test-fakes.js";
import {
  SET_PLATFORM_KEY_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./tenant-context.js";

/**
 * A fake that records `{sql, params}` and answers nothing, for asserting the statement order.
 *
 * `rowCount: 1` rather than 0, because a zero-row write is now **diagnosed** rather than swallowed:
 * these tests assert which statements a write issues and in what order, and answering 0 would put
 * every one of them through `classifyScopedWriteRefusal` instead.
 */
function recordingPg(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const client: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(client)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return client;
}

const TENANT = "22222222-2222-4222-8222-222222222222";

let store: InMemoryKeyStore;

beforeEach(() => {
  store = new InMemoryKeyStore({ now: () => new Date("2026-01-02T03:04:05.000Z") });
});

async function record(
  tenantId: string | null,
  algorithm: "ed25519" | "hmac-sha256" = "ed25519",
  purpose: KeyPurpose = "pack_signing",
): Promise<KeyRegistryRecord> {
  const key: KeyRecord = await store.createKey({
    tenantId,
    algorithm,
    purpose: algorithm === "hmac-sha256" ? "webhook_signing" : purpose,
  });
  return keyRegistryRecordFrom(key);
}

describe("PostgresKeyRegistry construction", () => {
  it("rejects a malformed schema identifier", () => {
    expect(() => new PostgresKeyRegistry(fakeCryptoKeysPg(), { schema: "meta; DROP" })).toThrow(
      /invalid schema/,
    );
  });

  it("rejects a malformed tenant id on register", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = { ...(await record(null)), tenantId: "not a uuid;" };
    await expect(registry.register(rec as KeyRegistryRecord)).rejects.toThrow();
  });
});

describe("register + read", () => {
  it("round-trips a platform key by key id", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    const found = await registry.getByKeyId(rec.keyId);
    expect(found).toEqual(rec);
  });

  it("returns null for an unknown key id", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    expect(await registry.getByKeyId("key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123")).toBeNull();
  });

  it("resolves a key by fingerprint", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    expect(rec.fingerprint).not.toBeNull();
    const found = await registry.getByFingerprint(rec.fingerprint as string);
    expect(found?.keyId).toBe(rec.keyId);
  });
});

describe("upsert semantics", () => {
  it("is idempotent — re-registering the same key does not duplicate", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    await registry.register(rec);
    const all = await registry.listKeys();
    expect(all).toHaveLength(1);
  });

  it("upserts the status/version on conflict", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    await registry.register({ ...rec, status: "rotating", keyVersion: 2 });
    const found = await registry.getByKeyId(rec.keyId);
    expect(found?.status).toBe("rotating");
    expect(found?.keyVersion).toBe(2);
  });
});

describe("markStatus", () => {
  it("updates status by key id", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    await registry.markStatus(rec.keyId, "revoked");
    const found = await registry.getByKeyId(rec.keyId);
    expect(found?.status).toBe("revoked");
  });

  it("revoke convenience sets revoked", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(null);
    await registry.register(rec);
    await registry.revoke(rec.keyId);
    expect((await registry.getByKeyId(rec.keyId))?.status).toBe("revoked");
  });

  it("rejects an invalid status", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    await expect(
      registry.markStatus("key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123", "expired" as never),
    ).rejects.toThrow(/invalid key status/);
  });
});

describe("listActive + filters", () => {
  it("excludes non-active keys", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const a = await record(null);
    const b = await record(null);
    await registry.register(a);
    await registry.register({ ...b, status: "revoked" });
    const active = await registry.listActive();
    expect(active.map((r) => r.keyId)).toEqual([a.keyId]);
  });

  it("filters by algorithm", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const ed = await record(null, "ed25519");
    const hmac = await record(null, "hmac-sha256");
    await registry.register(ed);
    await registry.register(hmac);
    const hmacKeys = await registry.listActive({ algorithm: "hmac-sha256" });
    expect(hmacKeys.map((r) => r.keyId)).toEqual([hmac.keyId]);
  });

  it("filters by purpose", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const packKey = await record(null, "ed25519", "pack_signing");
    const sealKey = await record(null, "ed25519", "evidence_sealing");
    await registry.register(packKey);
    await registry.register(sealKey);
    const seals = await registry.listActive({ purpose: "evidence_sealing" });
    expect(seals.map((r) => r.keyId)).toEqual([sealKey.keyId]);
  });
});

describe("tenant scoping under RLS", () => {
  it("hides a tenant key from a platform (no-context) read", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const rec = await record(TENANT);
    await registry.register(rec);
    expect(await registry.getByKeyId(rec.keyId)).toBeNull();
    const withContext = await registry.getByKeyId(rec.keyId, TENANT);
    expect(withContext?.keyId).toBe(rec.keyId);
  });

  it("scopes a tenant list to that tenant", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const tenantKey = await record(TENANT);
    const platformKey = await record(null);
    await registry.register(tenantKey);
    await registry.register(platformKey);
    const tenantList = await registry.listActive({ tenantId: TENANT });
    expect(tenantList.map((r) => r.keyId)).toEqual([tenantKey.keyId]);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_key_write before a platform-scope registration", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const registry = new PostgresKeyRegistry(recordingPg(capture));
    await registry.register(await record(null));
    expect(capture[0]?.sql).toBe(SET_PLATFORM_KEY_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_key_write");
    expect(capture[1]?.sql).toContain("INSERT INTO meta.crypto_keys");
  });

  it("claims it transaction-locally, never session-wide", () => {
    // `set_config(..., true)` — the third argument is `is_local`. A session-wide `SET` would leave
    // a pooled connection able to register a platform key for the next caller's whole turn.
    expect(SET_PLATFORM_KEY_WRITE_SQL).toContain(", true)");
    expect(SET_PLATFORM_KEY_WRITE_SQL.startsWith("SET ")).toBe(false);
  });

  it("is not the cross-tenant read grant, and not the audit write grant", () => {
    // `meta.crypto_keys` holds the public keys a chain entry's signature resolves against, so a
    // session that could both append to the trail and register a key could re-sign a rewritten
    // chain and have it verify. That is why this is its own grant rather than a share of either.
    expect(SET_PLATFORM_KEY_WRITE_SQL).not.toContain("app.platform_audit");
    expect(SET_PLATFORM_KEY_WRITE_SQL).not.toContain("app.platform_config_write");
    expect(SET_PLATFORM_KEY_WRITE_SQL).not.toContain("app.platform_record_write");
  });

  it("claims nothing on a platform-scope read, because a public key is readable by anyone", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const registry = new PostgresKeyRegistry(recordingPg(capture));
    await registry.getByKeyId("key_ed25519_01arz3ndektsv4rrffq69g5fav");
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("claims the tenant context instead for a tenant-scope registration, never both", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const registry = new PostgresKeyRegistry(recordingPg(capture));
    await registry.register(await record(TENANT));
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims the elevation on markStatus, which is the UPDATE arm", async () => {
    // The fourth policy exists for this: a key is revoked and rotated in place, so an
    // `INSERT`-only platform arm would have made every platform key immutable-by-RLS.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const registry = new PostgresKeyRegistry(recordingPg(capture));
    await registry.revoke("key_ed25519_01arz3ndektsv4rrffq69g5fav");
    expect(capture[0]?.sql).toBe(SET_PLATFORM_KEY_WRITE_SQL);
    expect(capture[1]?.sql).toContain("UPDATE meta.crypto_keys SET status");
  });
});

describe("the platform write arm, against the policy-shaped fake", () => {
  it("refuses a platform-scope row when the elevation is withheld", async () => {
    // The defect this closes: under the single `ALL`-scope policy `tenant_id IS NULL` satisfied the
    // `WITH CHECK` unconditionally, so this insert succeeded from any session at all.
    const conn = fakeCryptoKeysPg();
    const rec = await record(null);
    await expect(
      conn.transaction((tx) =>
        tx.query("INSERT INTO meta.crypto_keys (a) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          rec.keyId,
          null,
          rec.algorithm,
          rec.purpose,
          rec.publicKeyBase64,
          rec.fingerprint,
          rec.keyVersion,
          rec.status,
          rec.createdAt,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a tenant row to a session holding only the platform elevation", async () => {
    // The other direction, and the one that matters as much: the elevation buys no access to any
    // tenant's keys.
    const conn = fakeCryptoKeysPg();
    const rec = await record(TENANT);
    await expect(
      conn.transaction(async (tx) => {
        await tx.query(SET_PLATFORM_KEY_WRITE_SQL);
        return tx.query(
          "INSERT INTO meta.crypto_keys (a) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            rec.keyId,
            TENANT,
            rec.algorithm,
            rec.purpose,
            rec.publicKeyBase64,
            rec.fingerprint,
            rec.keyVersion,
            rec.status,
            rec.createdAt,
          ],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets the store itself write both scopes, because it claims the right one each time", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg());
    const platformKey = await record(null);
    const tenantKey = await record(TENANT);
    await registry.register(platformKey);
    await registry.register(tenantKey);
    expect((await registry.getByKeyId(platformKey.keyId))?.keyId).toBe(platformKey.keyId);
    expect((await registry.getByKeyId(tenantKey.keyId, TENANT))?.keyId).toBe(tenantKey.keyId);
  });

  it("lets a tenant read a platform key but not change it, and says so", async () => {
    const conn = fakeCryptoKeysPg();
    const registry = new PostgresKeyRegistry(conn);
    const platformKey = await record(null);
    await registry.register(platformKey);
    // Readable from a tenant's context — the platform read arm needs no grant.
    expect((await registry.getByKeyId(platformKey.keyId, TENANT))?.status).toBe("active");
    // And not writable from it. It used to match zero rows and **report success**, which is the
    // half of this defect both roles got wrong: an operator revoking a key under the wrong scope
    // was told it worked. It now names which rule refused.
    const err = await registry
      .revoke(platformKey.keyId, TENANT)
      .then(() => null, (e: unknown) => e);
    expect((err as ScopedWriteRefusedError).reason).toBe("wrong_scope");
    expect((err as ScopedWriteRefusedError).scopeTenantId).toBe(TENANT);
    expect((err as ScopedWriteRefusedError).storedTenantId).toBeNull();
    expect((await registry.getByKeyId(platformKey.keyId))?.status).toBe("active");
  });
});

/**
 * The write-side half of ADR-0331's defect, which ADR-0333 left open and named. Every case here is
 * run against the fake in **owner** mode, because as a non-owner RLS refuses the cross-scope write
 * whether the store carries a predicate or not — the defect is invisible from either vantage alone.
 *
 * Measured live on a fresh cluster as the owner before these predicates existed: a platform-scope
 * `register` **replaced a tenant's public key** and reported success, and `revoke(<a tenant's key
 * id>, null)` revoked a tenant's key. `meta.crypto_keys` is the table whose write elevation is its
 * own grant precisely because it holds the public keys a chain entry's signature resolves against.
 */
describe("a scoped write stays in its scope, as the owner", () => {
  it("refuses a platform register that would replace a tenant's public key", async () => {
    const conn = fakeCryptoKeysPg({ owner: true });
    const registry = new PostgresKeyRegistry(conn);
    const tenantKey = await record(TENANT);
    await registry.register(tenantKey);

    const err = await registry
      .register({ ...tenantKey, tenantId: null, publicKeyBase64: "c3RvbGVu", keyVersion: 2 })
      .then(() => null, (e: unknown) => e);
    expect((err as ScopedWriteRefusedError).reason).toBe("wrong_scope");
    expect((err as ScopedWriteRefusedError).storedTenantId).toBe(TENANT);

    // The tenant's key is untouched: this is the assertion the live run made before and after.
    const stored = await registry.getByKeyId(tenantKey.keyId, TENANT);
    expect(stored?.publicKeyBase64).toBe(tenantKey.publicKeyBase64);
    expect(stored?.keyVersion).toBe(tenantKey.keyVersion);
  });

  it("still lets a scope re-register its own key, which registerAuditChainKey does every boot", async () => {
    const conn = fakeCryptoKeysPg({ owner: true });
    const registry = new PostgresKeyRegistry(conn);
    const platformKey = await record(null);
    await registry.register(platformKey);
    await expect(
      registry.register({ ...platformKey, keyVersion: 2 }),
    ).resolves.toBeUndefined();
    expect((await registry.getByKeyId(platformKey.keyId))?.keyVersion).toBe(2);
  });

  it("refuses a platform revoke of a tenant's key", async () => {
    const conn = fakeCryptoKeysPg({ owner: true });
    const registry = new PostgresKeyRegistry(conn);
    const tenantKey = await record(TENANT);
    await registry.register(tenantKey);
    const err = await registry
      .revoke(tenantKey.keyId, null)
      .then(() => null, (e: unknown) => e);
    expect((err as ScopedWriteRefusedError).reason).toBe("wrong_scope");
    expect((await registry.getByKeyId(tenantKey.keyId, TENANT))?.status).toBe("active");
  });

  it("names `row_absent` for a key id that exists nowhere, instead of reporting success", async () => {
    // The mode both roles got wrong: a zero-row UPDATE was silently accepted, so revoking a
    // compromised key under a mistyped id was indistinguishable from revoking it.
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg({ owner: true }));
    const err = await registry
      .revoke("key_ed25519_01BX5ZZKBKACTAV9WEVGEMMVRY", null)
      .then(() => null, (e: unknown) => e);
    expect((err as ScopedWriteRefusedError).reason).toBe("row_absent");
    expect((err as Error).message).toContain("key_ed25519_01BX5ZZKBKACTAV9WEVGEMMVRY");
  });

  it("revokes a key in its own scope, both arms", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysPg({ owner: true }));
    const tenantKey = await record(TENANT);
    const platformKey = await record(null);
    await registry.register(tenantKey);
    await registry.register(platformKey);
    await expect(registry.revoke(tenantKey.keyId, TENANT)).resolves.toBeUndefined();
    await expect(registry.revoke(platformKey.keyId, null)).resolves.toBeUndefined();
    expect((await registry.getByKeyId(tenantKey.keyId, TENANT))?.status).toBe("revoked");
    expect((await registry.getByKeyId(platformKey.keyId))?.status).toBe("revoked");
  });

  it("carries the strict predicate on markStatus, and binds the tenant after the key id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresKeyRegistry(recordingPg(capture)).revoke(
      "key_ed25519_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TENANT,
    );
    const write = capture.find((c) => c.sql.includes("UPDATE meta.crypto_keys"));
    expect(write?.sql).toContain("WHERE key_id = $2 AND tenant_id = $3");
    // The inclusive arm is right for `getByKeyId` and would be a defect here.
    expect(write?.sql).not.toContain("OR tenant_id IS NULL");
    expect(write?.params).toEqual(["revoked", "key_ed25519_01ARZ3NDEKTSV4RRFFQ69G5FAV", TENANT]);
  });

  it("pins the scope inside the upsert's DO UPDATE, where the single NULL-matching operator is right", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresKeyRegistry(recordingPg(capture)).register(await record(null));
    const write = capture.find((c) => c.sql.includes("INSERT INTO meta.crypto_keys"));
    // Both operands come from one already-located row, so no index is consulted and `=` would be
    // never-true for a platform registration — which would make the platform unable to
    // re-register its own key on every boot.
    expect(write?.sql).toContain(
      "WHERE crypto_keys.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id",
    );
  });

  it("issues the diagnosing read only when the write failed, and unscoped when it does", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    await new PostgresKeyRegistry(recordingPg(capture)).revoke(
      "key_ed25519_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TENANT,
    );
    expect(capture.filter((c) => c.sql.includes("SELECT tenant_id FROM"))).toHaveLength(0);

    const failing: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = fakeCryptoKeysPg({ owner: true });
    const wrapped: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        failing.push({ sql, params });
        return conn.query(sql, params);
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(wrapped)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    await new PostgresKeyRegistry(wrapped)
      .revoke("key_ed25519_01BX5ZZKBKACTAV9WEVGEMMVRY", TENANT)
      .catch(() => undefined);
    const diag = failing.find((c) => c.sql.includes("SELECT tenant_id FROM"));
    // No scope predicate, deliberately: the question is which scope holds the row.
    expect(diag?.sql).toBe("SELECT tenant_id FROM meta.crypto_keys WHERE key_id = $1");
    expect(diag?.params).toEqual(["key_ed25519_01BX5ZZKBKACTAV9WEVGEMMVRY"]);
  });

  it("refuses, in the fake, a write that carries no scope predicate at all", async () => {
    // The pre-fix statement. A fake that answered it is how this class survived: the boundary is
    // drawn at the SQL string, so a scoped store and an unscoped one look identical.
    const conn = fakeCryptoKeysPg({ owner: true });
    const tenantKey = await record(TENANT);
    await new PostgresKeyRegistry(conn).register(tenantKey);
    await expect(
      conn.transaction((tx) =>
        tx.query("UPDATE meta.crypto_keys SET status = $1 WHERE key_id = $2", [
          "revoked",
          tenantKey.keyId,
        ]),
      ),
    ).rejects.toThrow(/carries no tenant_id predicate/);
  });

  it("refuses, in the fake, the inclusive arm on a write", async () => {
    const conn = fakeCryptoKeysPg({ owner: true });
    const tenantKey = await record(TENANT);
    await new PostgresKeyRegistry(conn).register(tenantKey);
    await expect(
      conn.transaction((tx) =>
        tx.query(
          "UPDATE meta.crypto_keys SET status = $1 WHERE key_id = $2 AND (tenant_id = $3 OR tenant_id IS NULL)",
          ["revoked", tenantKey.keyId, TENANT],
        ),
      ),
    ).rejects.toThrow(/refuses the inclusive scope arm on a write/);
  });

  it("refuses, in the fake, an upsert whose DO UPDATE does not pin the scope", async () => {
    const conn = fakeCryptoKeysPg({ owner: true });
    const tenantKey = await record(TENANT);
    await new PostgresKeyRegistry(conn).register(tenantKey);
    await expect(
      conn.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO meta.crypto_keys (key_id, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (key_id) DO UPDATE SET status = EXCLUDED.status",
          [tenantKey.keyId, null, "ed25519", "pack_signing", "x", "a".repeat(64), 2, "active", "2026-01-01T00:00:00.000Z"],
        );
      }),
    ).rejects.toThrow(/does not pin the scope/);
  });
});

describe("the scope predicate every read carries beside RLS", () => {
  type Captured = { sql: string; params: readonly unknown[] | undefined };

  function read(capture: readonly Captured[]): Captured {
    const found = capture.find((c) => c.sql.includes("FROM meta.crypto_keys"));
    if (found === undefined) throw new Error("no read was issued");
    return found;
  }

  function where(captured: Captured): string {
    const at = captured.sql.indexOf("WHERE");
    if (at < 0) throw new Error(`read carried no WHERE clause: ${captured.sql}`);
    return captured.sql.slice(at);
  }

  it("asks for the platform scope by name on a fingerprint lookup", async () => {
    // The read `apps/operate-server`'s `chain-verify.ts` makes with no tenant id, to resolve the
    // public key a platform chain entry's signature verifies under. Unscoped, it answered with a
    // *tenant's* key as the owner — which hands back the forgery route `app.platform_key_write`
    // exists to close.
    const capture: Captured[] = [];
    await new PostgresKeyRegistry(recordingPg(capture)).getByFingerprint("a".repeat(64));
    expect(where(read(capture))).toContain("tenant_id IS NULL");
    expect(where(read(capture))).not.toContain("tenant_id = $");
  });

  it("keeps the platform's keys in a tenant's point lookup, which is the point of a public key", async () => {
    const capture: Captured[] = [];
    await new PostgresKeyRegistry(recordingPg(capture)).getByKeyId("key_ed25519_X", TENANT);
    expect(where(read(capture))).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
    expect(read(capture).params).toEqual(["key_ed25519_X", TENANT]);
  });

  it("keeps listKeys strict, because a filter by tenant means that tenant's keys", async () => {
    // The two spellings in one store, and the distinction is the repo's own: a lookup by identity
    // may answer with a platform key, a list filtered by tenant may not. `listActive({tenantId})`
    // has a test pinning that, and its tenant arm was already strict — only the platform arm was
    // missing.
    const capture: Captured[] = [];
    await new PostgresKeyRegistry(recordingPg(capture)).listActive({ tenantId: TENANT });
    expect(where(read(capture))).toContain("tenant_id = $1");
    expect(where(read(capture))).not.toContain("OR tenant_id IS NULL");

    const platform: Captured[] = [];
    await new PostgresKeyRegistry(recordingPg(platform)).listActive({});
    expect(where(read(platform))).toContain("tenant_id IS NULL");
  });

  it("sets the tenant's RLS context beside the predicate, and claims no write elevation", async () => {
    const capture: Captured[] = [];
    await new PostgresKeyRegistry(recordingPg(capture)).getByKeyId("key_ed25519_X", TENANT);
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[0]?.params).toEqual([TENANT]);
    expect(capture.some((c) => c.sql === SET_PLATFORM_KEY_WRITE_SQL)).toBe(false);
  });

  it("never spells a scope as IS NOT DISTINCT FROM, which is unindexable", async () => {
    const capture: Captured[] = [];
    const registry = new PostgresKeyRegistry(recordingPg(capture));
    await registry.getByKeyId("key_ed25519_X", TENANT);
    await registry.getByFingerprint("b".repeat(64), TENANT);
    await registry.listKeys({ tenantId: TENANT });
    const reads = capture.filter((c) => c.sql.includes("FROM meta.crypto_keys"));
    expect(reads).toHaveLength(3);
    for (const r of reads) {
      expect(r.sql).not.toContain("IS NOT DISTINCT FROM");
      expect(where(r)).toContain("tenant_id = $");
    }
  });

  it("refuses an implausible tenantId before issuing anything", async () => {
    const capture: Captured[] = [];
    await expect(
      new PostgresKeyRegistry(recordingPg(capture)).getByKeyId(
        "key_ed25519_X",
        "'; DROP TABLE meta.tenants --",
      ),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });
});
