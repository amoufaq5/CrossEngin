import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryKeyStore,
  type KeyPurpose,
  type KeyRecord,
} from "@crossengin/crypto";

import { PostgresKeyRegistry } from "./key-registry.js";
import { keyRegistryRecordFrom, type KeyRegistryRecord } from "./records.js";
import { fakeCryptoKeysPg } from "./test-fakes.js";

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
