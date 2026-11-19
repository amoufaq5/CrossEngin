import { generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { PackManifestSchema, type PackAuthorKind, type PackManifest } from "./packs.js";
import {
  PackPublisherRegistry,
  PackPublisherRegistryError,
  namespaceCovers,
  parsePackPublisherSpec,
  verifyPackPublisher,
} from "./publishers.js";
import { signPackManifest } from "./signing.js";

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

function signed(m: PackManifest, kp = generateEd25519Keypair()) {
  return {
    kp,
    signature: signPackManifest({
      manifest: m,
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
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v.ok).toBe(true);
  });

  it("refuses a self-asserted key: the signer is valid and simply not registered", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const other = generateEd25519Keypair();
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, registry: registryFor("com.acme", "community", other.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "publisher_unregistered" });
  });

  it("refuses a pack id outside the publisher's namespace", () => {
    const m = manifest("org.rival.pharmacy", "community");
    const s = signed(m);
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "pack_outside_publisher_namespace" });
  });

  it("refuses an author kind the publisher was not registered as, which is how review exemption was claimed", () => {
    const m = manifest("com.acme.pharmacy", "crossengin_official");
    const s = signed(m);
    const v = verifyPackPublisher({ manifest: m, signature: s.signature, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "author_kind_not_registered" });
  });

  it("refuses a manifest altered after signing", () => {
    const m = manifest("com.acme.pharmacy", "community");
    const s = signed(m);
    const tampered = { ...m, name: "Tampered" };
    const v = verifyPackPublisher({ manifest: tampered, signature: s.signature, registry: registryFor("com.acme", "community", s.kp.publicKeyBase64) });
    expect(v).toMatchObject({ ok: false, refusal: "signature_invalid" });
  });
});
