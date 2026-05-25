import { describe, expect, it } from "vitest";

import { InMemoryKeyStore } from "./key-store.js";
import { verifyEd25519 } from "./signing.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

describe("InMemoryKeyStore — createKey", () => {
  it("creates an ed25519 pack-signing key with public material", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    expect(record.handle.tenantId).toBe(TENANT_A);
    expect(record.handle.algorithm).toBe("ed25519");
    expect(record.handle.purpose).toBe("pack_signing");
    expect(record.handle.version).toBe(1);
    expect(record.status).toBe("active");
    expect(record.publicKeyBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates an HMAC webhook-signing key with no public material", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    expect(record.publicKeyBase64).toBeNull();
    expect(record.fingerprint).toBeNull();
  });

  it("creates platform-wide keys when tenantId is null", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "tombstone_anchoring",
    });
    expect(record.handle.tenantId).toBeNull();
  });

  it("rejects purpose/algorithm mismatches", async () => {
    const store = new InMemoryKeyStore();
    await expect(
      store.createKey({
        tenantId: TENANT_A,
        algorithm: "hmac-sha256",
        purpose: "pack_signing",
      }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      store.createKey({
        tenantId: TENANT_A,
        algorithm: "ed25519",
        purpose: "webhook_signing",
      }),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("InMemoryKeyStore — signing", () => {
  it("signs and verifies with an ed25519 key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    const sig = await store.signWith(record.handle, TENANT_A, "hello");
    expect(await store.verifyWith(record.handle, sig, "hello")).toBe(true);
    expect(verifyEd25519(record.publicKeyBase64!, sig, "hello")).toBe(true);
  });

  it("rejects sign when handle.tenantId mismatches caller-asserted tenant", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(store.signWith(record.handle, TENANT_B, "x")).rejects.toThrow(/tenant/);
  });

  it("allows platform-wide keys to sign for any tenant", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "tombstone_anchoring",
    });
    await expect(store.signWith(record.handle, TENANT_A, "x")).resolves.toBeDefined();
    await expect(store.signWith(record.handle, null, "x")).resolves.toBeDefined();
  });

  it("rejects signWith on hmac key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(store.signWith(record.handle, TENANT_A, "x")).rejects.toThrow(/ed25519/);
  });
});

describe("InMemoryKeyStore — HMAC", () => {
  it("produces deterministic HMAC for the same message", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    const a = await store.hmacWith(record.handle, TENANT_A, "body");
    const b = await store.hmacWith(record.handle, TENANT_A, "body");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects tenant mismatch on hmacWith", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(store.hmacWith(record.handle, TENANT_B, "x")).rejects.toThrow(/tenant/);
  });

  it("rejects hmacWith on ed25519 key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(store.hmacWith(record.handle, TENANT_A, "x")).rejects.toThrow(/hmac/);
  });
});

describe("InMemoryKeyStore — rotation", () => {
  it("issues a new handle and marks the old as rotating", async () => {
    const store = new InMemoryKeyStore();
    const first = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    const next = await store.rotateKey(first.handle);
    expect(next.handle.version).toBe(2);
    expect(next.handle.id).not.toBe(first.handle.id);
    expect(next.rotatedFromKeyId).toBe(first.handle.id);
    expect(next.status).toBe("active");
    const oldRecord = await store.getRecord(first.handle);
    expect(oldRecord.status).toBe("rotating");
  });

  it("preserves the old key's ability to verify previously issued signatures", async () => {
    const store = new InMemoryKeyStore();
    const first = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    const sig = await store.signWith(first.handle, TENANT_A, "hello");
    await store.rotateKey(first.handle);
    expect(await store.verifyWith(first.handle, sig, "hello")).toBe(true);
  });

  it("rejects rotateKey on a revoked key", async () => {
    const store = new InMemoryKeyStore();
    const r = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await store.destroyKey(r.handle);
    await expect(store.rotateKey(r.handle)).rejects.toThrow(/revoked/);
  });
});

describe("InMemoryKeyStore — destroy + revoke semantics", () => {
  it("marks a destroyed key as revoked and blocks signing", async () => {
    const store = new InMemoryKeyStore();
    const r = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await store.destroyKey(r.handle);
    const rec = await store.getRecord(r.handle);
    expect(rec.status).toBe("revoked");
    await expect(store.signWith(r.handle, TENANT_A, "x")).rejects.toThrow(/revoked/);
  });
});

describe("InMemoryKeyStore — listKeys", () => {
  it("filters by tenantId, algorithm, and purpose", async () => {
    const store = new InMemoryKeyStore();
    await store.createKey({ tenantId: TENANT_A, algorithm: "ed25519", purpose: "pack_signing" });
    await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await store.createKey({ tenantId: TENANT_B, algorithm: "ed25519", purpose: "pack_signing" });
    expect(await store.listKeys({ tenantId: TENANT_A })).toHaveLength(2);
    expect(await store.listKeys({ algorithm: "ed25519" })).toHaveLength(2);
    expect(await store.listKeys({ purpose: "webhook_signing" })).toHaveLength(1);
  });

  it("excludes revoked keys by default", async () => {
    const store = new InMemoryKeyStore();
    const r = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await store.destroyKey(r.handle);
    expect(await store.listKeys()).toHaveLength(0);
    expect(await store.listKeys({ includeRevoked: true })).toHaveLength(1);
  });
});

describe("InMemoryKeyStore — public material", () => {
  it("returns ed25519 public key but errors for hmac (no public material)", async () => {
    const store = new InMemoryKeyStore();
    const ed = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    expect(await store.getPublicMaterial(ed.handle)).toBe(ed.publicKeyBase64);
    const hmac = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(store.getPublicMaterial(hmac.handle)).rejects.toThrow(/no public material/);
  });
});

describe("InMemoryKeyStore — uses injected clock", () => {
  it("records createdAt from the supplied now()", async () => {
    const fixed = new Date("2026-01-01T00:00:00Z");
    const store = new InMemoryKeyStore({ now: () => fixed });
    const r = await store.createKey({
      tenantId: TENANT_A,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    expect(r.createdAt).toEqual(fixed);
  });
});
