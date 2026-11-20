import { InMemoryKeyStore, generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { PackManifestSchema, type PackManifest } from "./packs.js";
import { PACK_RELEASE_FORM, PackSignatureSchema, type PackSignature } from "./registry.js";
import {
  canonicalManifestBytes,
  canonicalReleaseBytes,
  packManifestDigest,
  packReleaseClaimFor,
  signPackRelease,
  signPackReleaseWithStore,
  verifyPackReleaseSignature,
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

  it("keeps the manifest tag, which is now the digest preimage and never a signed message", () => {
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

const BUNDLE = "a".repeat(64);
const OTHER_BUNDLE = "b".repeat(64);
const SIGNED_AT = "2026-05-16T12:00:00.000Z";

function sign(manifest = fixtureManifest(), kp = generateEd25519Keypair(), version = "1.0.0", bundleSha256 = BUNDLE) {
  return {
    kp,
    sig: signPackRelease({
      manifest,
      version,
      bundleSha256,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      signedAt: SIGNED_AT,
    }),
  };
}

describe("packReleaseClaimFor", () => {
  it("derives the pack id and the manifest digest from the manifest", () => {
    const manifest = fixtureManifest();
    const claim = packReleaseClaimFor({ manifest, version: "1.2.3", bundleSha256: BUNDLE });
    expect(claim).toEqual({
      form: PACK_RELEASE_FORM,
      packId: manifest.id,
      version: "1.2.3",
      manifestSha256: packManifestDigest(manifest),
      bundleSha256: BUNDLE,
    });
  });

  it("refuses a version that is not semver and a bundle digest that is not sha256 hex", () => {
    expect(() => packReleaseClaimFor({ manifest: fixtureManifest(), version: "v1", bundleSha256: BUNDLE })).toThrow();
    expect(() => packReleaseClaimFor({ manifest: fixtureManifest(), version: "1.0.0", bundleSha256: "XYZ" })).toThrow();
  });
});

describe("canonicalReleaseBytes", () => {
  const signer = { publicKeyFingerprint: "f".repeat(64), signedAt: SIGNED_AT };

  it("opens with the release form as the domain tag, distinct from the manifest tag", () => {
    const claim = packReleaseClaimFor({ manifest: fixtureManifest(), version: "1.0.0", bundleSha256: BUNDLE });
    const decoded = new TextDecoder().decode(canonicalReleaseBytes(claim, signer));
    expect(decoded.startsWith(`${PACK_RELEASE_FORM}\n`)).toBe(true);
    expect(decoded.startsWith("crossengin.pack.v1\n")).toBe(false);
  });

  it("is canonical JSON of one object over the claim, the fingerprint and signedAt, keys sorted", () => {
    const claim = packReleaseClaimFor({ manifest: fixtureManifest(), version: "1.0.0", bundleSha256: BUNDLE });
    const decoded = new TextDecoder().decode(canonicalReleaseBytes(claim, signer));
    const body = JSON.parse(decoded.slice(PACK_RELEASE_FORM.length + 1)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "bundleSha256",
      "form",
      "manifestSha256",
      "packId",
      "publicKeyFingerprint",
      "signedAt",
      "version",
    ]);
    expect(body).toMatchObject({ ...claim, ...signer });
  });

  it("changes when any bound fact changes", () => {
    const claim = packReleaseClaimFor({ manifest: fixtureManifest(), version: "1.0.0", bundleSha256: BUNDLE });
    const base = Buffer.from(canonicalReleaseBytes(claim, signer));
    const variants = [
      canonicalReleaseBytes({ ...claim, version: "1.0.1" }, signer),
      canonicalReleaseBytes({ ...claim, bundleSha256: OTHER_BUNDLE }, signer),
      canonicalReleaseBytes({ ...claim, manifestSha256: "c".repeat(64) }, signer),
      canonicalReleaseBytes({ ...claim, packId: "com.crossengin.other" }, signer),
      canonicalReleaseBytes(claim, { ...signer, publicKeyFingerprint: "e".repeat(64) }),
      canonicalReleaseBytes(claim, { ...signer, signedAt: "2026-05-17T12:00:00.000Z" }),
    ];
    for (const v of variants) expect(base.equals(Buffer.from(v))).toBe(false);
  });
});

describe("signPackRelease", () => {
  it("produces a schema-valid signature carrying the release it is over", () => {
    const { sig } = sign();
    expect(PackSignatureSchema.parse(sig)).toEqual(sig);
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.release).toMatchObject({ form: PACK_RELEASE_FORM, version: "1.0.0", bundleSha256: BUNDLE });
  });

  it("round-trips through verifyPackReleaseSignature", () => {
    const { kp, sig } = sign();
    expect(verifyPackReleaseSignature({ signature: sig, publicKeyBase64: kp.publicKeyBase64 })).toBe(true);
  });
});

describe("verifyPackReleaseSignature", () => {
  // A captured signature with one carried fact edited: what a replay onto another release looks like
  // when the attacker also rewrites the claim to match the new submission.
  it.each<[string, (s: PackSignature) => PackSignature]>([
    ["a different version", (s) => ({ ...s, release: { ...s.release!, version: "9.9.9" } })],
    ["a different bundle", (s) => ({ ...s, release: { ...s.release!, bundleSha256: OTHER_BUNDLE } })],
    ["a different manifest digest", (s) => ({ ...s, release: { ...s.release!, manifestSha256: "c".repeat(64) } })],
    ["a different pack id", (s) => ({ ...s, release: { ...s.release!, packId: "com.crossengin.other" } })],
    ["a different signedAt", (s) => ({ ...s, signedAt: "2026-05-17T12:00:00.000Z" })],
  ])("refuses a claim rewritten to name %s", (_label, rewrite) => {
    const { kp, sig } = sign();
    expect(verifyPackReleaseSignature({ signature: rewrite(sig), publicKeyBase64: kp.publicKeyBase64 })).toBe(false);
  });

  it("refuses a manifest-only signature, which carries no release", () => {
    const { kp, sig } = sign();
    const { release: _release, ...legacy } = sig;
    expect(verifyPackReleaseSignature({ signature: legacy, publicKeyBase64: kp.publicKeyBase64 })).toBe(false);
  });

  it("refuses a legacy signature made over the manifest bytes, even with a release attached", () => {
    // The pre-ADR-0454 form signed `crossengin.pack.v1\n{manifest}`. Grafting a release claim onto
    // such a signature must not make it verify. This test does not isolate the tag: the two bodies
    // differ too, so it would pass with equal tags. The tag's distinctness is fenced by the prefix
    // test above (mutation-checked), and the body-shape leg by the test below.
    const kp = generateEd25519Keypair();
    const manifest = fixtureManifest();
    const legacyBytes = canonicalManifestBytes(manifest);
    const { sig } = sign(manifest, kp);
    const legacySig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, legacyBytes);
    expect(verifyPackReleaseSignature({ signature: { ...sig, signature: legacySig }, publicKeyBase64: kp.publicKeyBase64 })).toBe(false);
  });

  it("cannot read an envelope body as a manifest, so the two messages differ in shape as well as tag", () => {
    // The second, independent leg of the separation: even under one tag, a manifest-only signature
    // could verify as a release only if some valid manifest canonicalised to the envelope's body.
    const claim = packReleaseClaimFor({ manifest: fixtureManifest(), version: "1.0.0", bundleSha256: BUNDLE });
    const body = JSON.parse(
      new TextDecoder()
        .decode(canonicalReleaseBytes(claim, { publicKeyFingerprint: "f".repeat(64), signedAt: SIGNED_AT }))
        .slice(PACK_RELEASE_FORM.length + 1),
    ) as unknown;
    expect(PackManifestSchema.safeParse(body).success).toBe(false);
  });

  it("refuses a signature from a different key, and a fingerprint that does not match the key", () => {
    const { sig } = sign();
    const other = generateEd25519Keypair();
    expect(verifyPackReleaseSignature({ signature: sig, publicKeyBase64: other.publicKeyBase64 })).toBe(false);
    const { kp, sig: sig2 } = sign();
    expect(
      verifyPackReleaseSignature({ signature: { ...sig2, publicKeyFingerprint: "0".repeat(64) }, publicKeyBase64: kp.publicKeyBase64 }),
    ).toBe(false);
  });
});

describe("signPackReleaseWithStore", () => {
  it("signs and verifies via KeyStore round-trip", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({ tenantId: TENANT, algorithm: "ed25519", purpose: "pack_signing" });
    const sig = await signPackReleaseWithStore({
      manifest: fixtureManifest(),
      version: "1.0.0",
      bundleSha256: BUNDLE,
      store,
      handle: record.handle,
      tenantId: TENANT,
      signedAt: SIGNED_AT,
    });
    expect(verifyPackReleaseSignature({ signature: sig, publicKeyBase64: record.publicKeyBase64! })).toBe(true);
  });

  it("rejects a wrong-purpose key (webhook_signing)", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({ tenantId: TENANT, algorithm: "hmac-sha256", purpose: "webhook_signing" });
    await expect(
      signPackReleaseWithStore({
        manifest: fixtureManifest(),
        version: "1.0.0",
        bundleSha256: BUNDLE,
        store,
        handle: record.handle,
        tenantId: TENANT,
        signedAt: SIGNED_AT,
      }),
    ).rejects.toThrow(/pack_signing|ed25519/);
  });

  it("rejects cross-tenant signing", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({ tenantId: TENANT, algorithm: "ed25519", purpose: "pack_signing" });
    await expect(
      signPackReleaseWithStore({
        manifest: fixtureManifest(),
        version: "1.0.0",
        bundleSha256: BUNDLE,
        store,
        handle: record.handle,
        tenantId: "00000000-0000-4000-8000-000000000002",
        signedAt: SIGNED_AT,
      }),
    ).rejects.toThrow(/tenant/);
  });
});
