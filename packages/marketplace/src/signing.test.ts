import { InMemoryKeyStore, generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { PackManifestSchema, type PackManifest } from "./packs.js";
import { PackSignatureSchema } from "./registry.js";
import {
  canonicalManifestBytes,
  signPackManifest,
  signPackManifestWithStore,
  verifyPackSignature,
} from "./signing.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fixtureManifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return PackManifestSchema.parse({
    id: "com.crossengin.example",
    name: "Example Pack",
    description: "A test pack",
    kind: "vertical_template",
    author: {
      kind: "crossengin_official",
      name: "CrossEngin Test",
      contactEmail: "test@example.com",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    },
    license: "MIT",
    minPlatformVersion: "1.0.0",
    ...overrides,
  });
}

describe("canonicalManifestBytes", () => {
  it("produces stable bytes regardless of key insertion order", () => {
    const manifest = fixtureManifest();
    const a = canonicalManifestBytes(manifest);
    const b = canonicalManifestBytes({
      ...manifest,
      keywords: manifest.keywords,
      requiredScopes: manifest.requiredScopes,
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("prefixes a domain tag so signatures don't collide with other JSON", () => {
    const bytes = canonicalManifestBytes(fixtureManifest());
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded.startsWith("crossengin.pack.v1\n")).toBe(true);
  });

  it("produces different bytes for different manifests", () => {
    const a = canonicalManifestBytes(fixtureManifest({ name: "A" }));
    const b = canonicalManifestBytes(fixtureManifest({ name: "B" }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("signPackManifest", () => {
  it("produces a schema-valid PackSignature", () => {
    const kp = generateEd25519Keypair();
    const sig = signPackManifest({
      manifest: fixtureManifest(),
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(PackSignatureSchema.parse(sig)).toEqual(sig);
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.publicKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("round-trips through verifyPackSignature", () => {
    const kp = generateEd25519Keypair();
    const manifest = fixtureManifest();
    const sig = signPackManifest({
      manifest,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyPackSignature({
        manifest,
        signature: sig,
        publicKeyBase64: kp.publicKeyBase64,
      }),
    ).toBe(true);
  });
});

describe("verifyPackSignature", () => {
  it("rejects a tampered manifest", () => {
    const kp = generateEd25519Keypair();
    const sig = signPackManifest({
      manifest: fixtureManifest({ name: "Original" }),
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyPackSignature({
        manifest: fixtureManifest({ name: "Tampered" }),
        signature: sig,
        publicKeyBase64: kp.publicKeyBase64,
      }),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const manifest = fixtureManifest();
    const sig = signPackManifest({
      manifest,
      privateKeyBase64: kp1.privateKeyBase64,
      publicKeyBase64: kp1.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyPackSignature({
        manifest,
        signature: sig,
        publicKeyBase64: kp2.publicKeyBase64,
      }),
    ).toBe(false);
  });

  it("rejects when the fingerprint in the signature does not match the supplied public key", () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const manifest = fixtureManifest();
    const sig = signPackManifest({
      manifest,
      privateKeyBase64: kp1.privateKeyBase64,
      publicKeyBase64: kp1.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyPackSignature({
        manifest,
        signature: { ...sig, publicKeyFingerprint: "0".repeat(64) },
        publicKeyBase64: kp1.publicKeyBase64,
      }),
    ).toBe(false);
    expect(
      verifyPackSignature({
        manifest,
        signature: sig,
        publicKeyBase64: kp2.publicKeyBase64,
      }),
    ).toBe(false);
  });
});

describe("signPackManifestWithStore", () => {
  it("signs and verifies via KeyStore round-trip", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    const manifest = fixtureManifest();
    const sig = await signPackManifestWithStore({
      manifest,
      store,
      handle: record.handle,
      tenantId: TENANT,
      signedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyPackSignature({
        manifest,
        signature: sig,
        publicKeyBase64: record.publicKeyBase64!,
      }),
    ).toBe(true);
  });

  it("rejects a wrong-purpose key (webhook_signing)", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(
      signPackManifestWithStore({
        manifest: fixtureManifest(),
        store,
        handle: record.handle,
        tenantId: TENANT,
        signedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/pack_signing|ed25519/);
  });

  it("rejects cross-tenant signing", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(
      signPackManifestWithStore({
        manifest: fixtureManifest(),
        store,
        handle: record.handle,
        tenantId: "00000000-0000-4000-8000-000000000002",
        signedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/tenant/);
  });
});
