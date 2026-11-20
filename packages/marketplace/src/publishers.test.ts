import { generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { PackManifestSchema, type PackAuthorKind, type PackManifest } from "./packs.js";
import {
  PackPublisherRegistry,
  PackPublisherRegistryError,
  namespaceCovers,
  STORED_RELEASE_REFUSALS,
  PUBLISHER_REFUSALS,
  parsePackPublisherSpec,
  verifyPackPublisher,
  verifyStoredRelease,
  type StoredRelease,
} from "./publishers.js";
import { packManifestDigest } from "./signing.js";
import { signPackRelease } from "./signing.js";

function manifest(id: string, kind: PackAuthorKind): PackManifest {
  const trusted = kind === "crossengin_official" || kind === "certified_partner";
  return PackManifestSchema.parse({
    id,
    name: "Example",
    description: "An example pack",
    kind: "vertical_template",
    author: { kind, name: "Acme", ...(trusted ? { verifiedAt: "2026-01-01T00:00:00.000Z" } : {}) },
    license: "MIT",
    minPlatformVersion: "1.0.0",
  });
}

const BUNDLE = "a".repeat(64);
const SUBMITTED = { version: "1.0.0", bundleSha256: BUNDLE };

function signed(m: PackManifest, kp = generateEd25519Keypair()) {
  return {
    kp,
    signature: signPackRelease({
      manifest: m,
      version: SUBMITTED.version,
      bundleSha256: SUBMITTED.bundleSha256,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      signedAt: "2026-05-16T12:00:00.000Z",
    }),
  };
}

describe("parsePackPublisherSpec", () => {
  it("parses namespace, author kind and key, deriving the fingerprint", () => {
    const kp = generateEd25519Keypair();
    const p = parsePackPublisherSpec(`com.acme:community:${kp.publicKeyBase64}`);
    expect(p.namespace).toBe("com.acme");
    expect(p.authorKind).toBe("community");
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["too few fields", "com.acme:community"],
    ["an unknown author kind", "com.acme:wizard:AAAA"],
    ["an uppercase namespace", "Com.Acme:community:AAAA"],
    ["a key that is not 32 bytes", "com.acme:community:AAAA"],
  ])("refuses %s", (_label, spec) => {
    expect(() => parsePackPublisherSpec(spec)).toThrow(PackPublisherRegistryError);
  });
});

describe("namespaceCovers", () => {
  it("covers itself and dotted children, never a sibling sharing a prefix", () => {
    expect(namespaceCovers("com.acme", "com.acme")).toBe(true);
    expect(namespaceCovers("com.acme", "com.acme.pharmacy")).toBe(true);
    expect(namespaceCovers("com.acme", "com.acmeco.pharmacy")).toBe(false);
  });
});

describe("PackPublisherRegistry", () => {
  const spec = (ns: string, kind: PackAuthorKind) =>
    parsePackPublisherSpec(`${ns}:${kind}:${generateEd25519Keypair().publicKeyBase64}`);

  it("admits several keys for one namespace of one kind, which is how a key rotates", () => {
    const r = new PackPublisherRegistry([spec("com.acme", "community"), spec("com.acme", "community")]);
    expect(r.size).toBe(2);
  });

  it("refuses overlapping namespaces, which would give one pack id two publishers", () => {
    expect(() => new PackPublisherRegistry([spec("com.acme", "community"), spec("com.acme.labs", "community")])).toThrow(
      /overlap/,
    );
  });

  it("refuses one namespace under two author kinds", () => {
    expect(
      () => new PackPublisherRegistry([spec("com.acme", "community"), spec("com.acme", "certified_partner")]),
    ).toThrow(/registered as both/);
  });

  it("refuses one key registered twice", () => {
    const kp = generateEd25519Keypair();
    expect(
      () =>
        new PackPublisherRegistry([
          parsePackPublisherSpec(`com.acme:community:${kp.publicKeyBase64}`),
          parsePackPublisherSpec(`org.other:community:${kp.publicKeyBase64}`),
        ]),
    ).toThrow(/registered twice/);
  });
});

describe("verifyPackPublisher", () => {
  function registryFor(ns: string, kind: PackAuthorKind, publicKeyBase64: string): PackPublisherRegistry {
    return new PackPublisherRegistry([parsePackPublisherSpec(`${ns}:${kind}:${publicKeyBase64}`)]);
  }

  it("accepts a pack signed by the registered key inside its namespace", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v.ok).toBe(true);
  });

  it("refuses a self-asserted key: the signer is valid and simply not registered", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const other = generateEd25519Keypair();
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", other.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "publisher_unregistered" });
  });

  it("refuses a pack id outside the publisher's namespace", () => {
    const m = manifest("org.rival.pharmacy", "community");
    const s = signed(m);
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "pack_outside_publisher_namespace" });
  });

  it("refuses an author kind the publisher was not registered as, which is how review exemption was claimed", () => {
    const m = manifest("com.acme.pharmacy", "crossengin_official");
    const s = signed(m);
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "author_kind_not_registered" });
  });

  it("refuses a manifest altered after signing: the release names the original manifest's digest", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const tampered = { ...m, name: "Tampered" };
    const v = verifyPackPublisher({ manifest: tampered, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "release_manifest_mismatch" });
  });

  // ADR-0452 measured the replay live: one publisher signature re-sent under another version with a
  // new bundle answered 201. Each arm below is that capture replayed against one changed fact.
  it("refuses a captured signature replayed under a different version", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const v = verifyPackPublisher({
      manifest: m,
      signature: s.signature,
      submitted: { ...SUBMITTED, version: "9.9.9" },
      registry: registryFor("com.acme", "community", s.kp.publicKeyBase64),
    });
    expect(v).toMatchObject({ ok: false, refusal: "release_version_mismatch" });
  });

  it("refuses a captured signature replayed with a different bundle", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const v = verifyPackPublisher({
      manifest: m,
      signature: s.signature,
      submitted: { ...SUBMITTED, bundleSha256: "b".repeat(64) },
      registry: registryFor("com.acme", "community", s.kp.publicKeyBase64),
    });
    expect(v).toMatchObject({ ok: false, refusal: "release_bundle_mismatch" });
  });

  it("refuses a captured signature whose release was rewritten to match the replay", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const rewritten = { ...s.signature, release: { ...s.signature.release!, version: "9.9.9" } };
    const v = verifyPackPublisher({
      manifest: m,
      signature: rewritten,
      submitted: { ...SUBMITTED, version: "9.9.9" },
      registry: registryFor("com.acme", "community", s.kp.publicKeyBase64),
    });
    expect(v).toMatchObject({ ok: false, refusal: "signature_invalid" });
  });

  it("refuses a release signed for another pack id inside the same namespace", () => {
    const signedFor = manifest("com.acme.pharmacy", "community");
    const s = signed(signedFor);
    const other = manifest("com.acme.clinic", "community");
    const v = verifyPackPublisher({ manifest: other, signature: s.signature, submitted: SUBMITTED, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "release_pack_mismatch" });
  });

  it("refuses a manifest-only signature by name, before asking the registry anything", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const { release: _release, ...legacy } = s.signature;
    // An unregistered registry: the legacy form is refused first, because no key could verify it.
    const v = verifyPackPublisher({ manifest: m, signature: legacy, submitted: SUBMITTED, registry: new PackPublisherRegistry([]) });
    expect(v).toMatchObject({ ok: false, refusal: "legacy_signature_form" });
  });

});

describe("verifyStoredRelease", () => {
  function storedRow(): { stored: StoredRelease; registry: PackPublisherRegistry } {
    const m = manifest("com.acme.loyalty", "community");
    const { kp, signature } = signed(m);
    return {
      stored: {
        packId: m.id,
        version: SUBMITTED.version,
        manifestSha256: packManifestDigest(m),
        bundleSha256: BUNDLE,
        signature,
      },
      registry: new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:community:${kp.publicKeyBase64}`)]),
    };
  }

  it("verifies a row exactly as it was submitted", () => {
    const { stored, registry } = storedRow();
    const v = verifyStoredRelease({ stored, registry });
    expect(v.ok).toBe(true);
  });

  it("refuses the two-column rewrite ADR-0454 measured: the column and the claim both say 9.9.9", () => {
    const { stored, registry } = storedRow();
    const rewritten: StoredRelease = {
      ...stored,
      version: "9.9.9",
      signature: { ...stored.signature, release: { ...stored.signature.release!, version: "9.9.9" } },
    };
    const v = verifyStoredRelease({ stored: rewritten, registry });
    expect(v).toMatchObject({ ok: false, refusal: "signature_invalid" });
  });

  it("refuses a rewritten bundle digest carried into the claim too", () => {
    const { stored, registry } = storedRow();
    const other = "b".repeat(64);
    const v = verifyStoredRelease({
      stored: { ...stored, bundleSha256: other, signature: { ...stored.signature, release: { ...stored.signature.release!, bundleSha256: other } } },
      registry,
    });
    expect(v).toMatchObject({ ok: false, refusal: "signature_invalid" });
  });

  it("names a column-only edit after the signature verifies", () => {
    const { stored, registry } = storedRow();
    expect(verifyStoredRelease({ stored: { ...stored, version: "9.9.9" }, registry })).toMatchObject({
      ok: false,
      refusal: "release_version_mismatch",
    });
  });

  it("refuses a legacy row, which can never be re-verified", () => {
    const { stored, registry } = storedRow();
    const { release: _release, ...legacy } = stored.signature;
    expect(verifyStoredRelease({ stored: { ...stored, signature: legacy }, registry })).toMatchObject({
      ok: false,
      refusal: "legacy_signature_form",
    });
  });

  it("refuses a row whose key is no longer registered (the registry is asked now)", () => {
    const { stored } = storedRow();
    const other = generateEd25519Keypair();
    const registry = new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:community:${other.publicKeyBase64}`)]);
    expect(verifyStoredRelease({ stored, registry })).toMatchObject({ ok: false, refusal: "publisher_unregistered" });
  });

  it("refuses a row whose pack id moved outside the signer's namespace", () => {
    const { stored, registry } = storedRow();
    const moved: StoredRelease = {
      ...stored,
      packId: "org.other.loyalty",
      signature: { ...stored.signature, release: { ...stored.signature.release!, packId: "org.other.loyalty" } },
    };
    expect(verifyStoredRelease({ stored: moved, registry })).toMatchObject({
      ok: false,
      refusal: "pack_outside_publisher_namespace",
    });
  });

  it("never echoes a digest or key material in a refusal", () => {
    const { stored, registry } = storedRow();
    const v = verifyStoredRelease({ stored: { ...stored, bundleSha256: "c".repeat(64) }, registry });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.detail).not.toContain("c".repeat(64));
      expect(v.detail).not.toContain(stored.signature.signature);
    }
  });

  it("answers only publisher refusals that need no manifest", () => {
    for (const r of STORED_RELEASE_REFUSALS) expect(PUBLISHER_REFUSALS).toContain(r);
    expect(STORED_RELEASE_REFUSALS).not.toContain("author_kind_not_registered");
  });
});
