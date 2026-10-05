import { beforeEach, describe, expect, it } from "vitest";
import type { PgConnection } from "@crossengin/kernel-pg";
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

/** A fake that records `{sql, params}` and answers nothing, for asserting the statement order. */
function recordingPg(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const client: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      return { rows: [], rowCount: 0 };
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

  it("lets a tenant read a platform key but not change it", async () => {
    const conn = fakeCryptoKeysPg();
    const registry = new PostgresKeyRegistry(conn);
    const platformKey = await record(null);
    await registry.register(platformKey);
    // Readable from a tenant's context — the platform read arm needs no grant.
    expect((await registry.getByKeyId(platformKey.keyId, TENANT))?.status).toBe("active");
    // And not writable from it: the UPDATE matches zero rows rather than revoking it.
    await registry.revoke(platformKey.keyId, TENANT);
    expect((await registry.getByKeyId(platformKey.keyId))?.status).toBe("active");
  });
});
