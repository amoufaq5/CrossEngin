import { describe, expect, it } from "vitest";
import { InMemoryKeyStore, type KeyRecord } from "@crossengin/crypto";

import {
  KEY_STATUSES,
  KeyRegistryRecordSchema,
  keyRegistryRecordFrom,
  rowToKeyRegistryRecord,
} from "./records.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

async function ed25519Record(tenantId: string | null): Promise<KeyRecord> {
  const store = new InMemoryKeyStore({ now: () => new Date("2026-01-02T03:04:05.000Z") });
  return store.createKey({ tenantId, algorithm: "ed25519", purpose: "pack_signing" });
}

async function hmacRecord(tenantId: string | null): Promise<KeyRecord> {
  const store = new InMemoryKeyStore({ now: () => new Date("2026-01-02T03:04:05.000Z") });
  return store.createKey({ tenantId, algorithm: "hmac-sha256", purpose: "webhook_signing" });
}

describe("keyRegistryRecordFrom", () => {
  it("projects an ed25519 KeyRecord to its public/lifecycle view", async () => {
    const rec = await ed25519Record(TENANT);
    const projected = keyRegistryRecordFrom(rec);
    expect(projected.keyId).toBe(rec.handle.id);
    expect(projected.tenantId).toBe(TENANT);
    expect(projected.algorithm).toBe("ed25519");
    expect(projected.purpose).toBe("pack_signing");
    expect(projected.publicKeyBase64).toBe(rec.publicKeyBase64);
    expect(projected.fingerprint).toBe(rec.fingerprint);
    expect(projected.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(projected.keyVersion).toBe(1);
    expect(projected.status).toBe("active");
    expect(projected.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("projects an hmac KeyRecord with null public material + fingerprint", async () => {
    const rec = await hmacRecord(null);
    const projected = keyRegistryRecordFrom(rec);
    expect(projected.algorithm).toBe("hmac-sha256");
    expect(projected.purpose).toBe("webhook_signing");
    expect(projected.tenantId).toBeNull();
    expect(projected.publicKeyBase64).toBeNull();
    expect(projected.fingerprint).toBeNull();
  });

  it("carries the rotated key's incremented version + active status", async () => {
    const store = new InMemoryKeyStore();
    const created = await store.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const rotated = await store.rotateKey(created.handle);
    const projected = keyRegistryRecordFrom(rotated);
    expect(projected.keyVersion).toBe(2);
    expect(projected.status).toBe("active");
  });
});

describe("KeyRegistryRecordSchema", () => {
  it("rejects a malformed key id", () => {
    expect(() =>
      KeyRegistryRecordSchema.parse({
        keyId: "not-a-key",
        tenantId: null,
        algorithm: "ed25519",
        purpose: "pack_signing",
        publicKeyBase64: "AAAA",
        fingerprint: null,
        keyVersion: 1,
        status: "active",
        createdAt: "2026-01-02T03:04:05.000Z",
      }),
    ).toThrow();
  });

  it("rejects a non-uuid tenant id", () => {
    expect(() =>
      KeyRegistryRecordSchema.parse({
        keyId: "key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123",
        tenantId: "tenant-1",
        algorithm: "ed25519",
        purpose: "pack_signing",
        publicKeyBase64: "AAAA",
        fingerprint: null,
        keyVersion: 1,
        status: "active",
        createdAt: "2026-01-02T03:04:05.000Z",
      }),
    ).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      KeyRegistryRecordSchema.parse({
        keyId: "key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123",
        tenantId: null,
        algorithm: "ed25519",
        purpose: "pack_signing",
        publicKeyBase64: "AAAA",
        fingerprint: null,
        keyVersion: 1,
        status: "expired",
        createdAt: "2026-01-02T03:04:05.000Z",
      }),
    ).toThrow();
  });

  it("exposes the three lifecycle statuses", () => {
    expect(KEY_STATUSES).toEqual(["active", "rotating", "revoked"]);
  });
});

describe("rowToKeyRegistryRecord", () => {
  it("parses a full row, coercing a Date + trimming a padded fingerprint", () => {
    const rec = rowToKeyRegistryRecord({
      key_id: "key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123",
      tenant_id: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
      public_key_base64: "AAAA",
      fingerprint_sha256: `${"a".repeat(64)}   `,
      key_version: 3,
      status: "rotating",
      created_at: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(rec.tenantId).toBe(TENANT);
    expect(rec.fingerprint).toBe("a".repeat(64));
    expect(rec.keyVersion).toBe(3);
    expect(rec.status).toBe("rotating");
    expect(rec.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("maps null public material + fingerprint to null", () => {
    const rec = rowToKeyRegistryRecord({
      key_id: "key_hmac-sha256_ABCDEFGHJKMNPQRSTVWXYZ0123",
      tenant_id: null,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
      public_key_base64: null,
      fingerprint_sha256: null,
      key_version: 1,
      status: "active",
      created_at: "2026-01-02T03:04:05.000Z",
    });
    expect(rec.tenantId).toBeNull();
    expect(rec.publicKeyBase64).toBeNull();
    expect(rec.fingerprint).toBeNull();
  });
});
