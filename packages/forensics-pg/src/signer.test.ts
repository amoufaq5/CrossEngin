import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import { keyStoreChainSigner } from "./signer.js";

async function sealingKey(store: InMemoryKeyStore) {
  return store.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
}

describe("keyStoreChainSigner", () => {
  it("adapts an evidence_sealing key into a signer", async () => {
    const store = new InMemoryKeyStore();
    const record = await sealingKey(store);
    const signer = keyStoreChainSigner(store, record, null);
    expect(signer.fingerprint).toBe(record.fingerprint);
    const sig = await signer.sign(new TextEncoder().encode("hello"));
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("rejects a non-ed25519 key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: null,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    expect(() => keyStoreChainSigner(store, record, null)).toThrow(/ed25519/);
  });

  it("rejects an ed25519 key with the wrong purpose", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    expect(() => keyStoreChainSigner(store, record, null)).toThrow(/evidence_sealing/);
  });
});
