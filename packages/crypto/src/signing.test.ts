import { describe, expect, it } from "vitest";

import { sha256 } from "./hashing.js";
import {
  ed25519PublicKeyFingerprint,
  ed25519PublicKeyFromSeed,
  generateEd25519Keypair,
  isEd25519PrivateSeedBase64,
  isEd25519PublicKeyBase64,
  signEd25519,
  verifyEd25519,
} from "./signing.js";

describe("generateEd25519Keypair", () => {
  it("returns base64-encoded public and private keys", () => {
    const kp = generateEd25519Keypair();
    expect(kp.publicKeyBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(kp.privateKeyBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("decodes the public key to 32 bytes", () => {
    const kp = generateEd25519Keypair();
    expect(Buffer.from(kp.publicKeyBase64, "base64").length).toBe(32);
  });

  it("decodes the private seed to 32 bytes", () => {
    const kp = generateEd25519Keypair();
    expect(Buffer.from(kp.privateKeyBase64, "base64").length).toBe(32);
  });

  it("produces unique keypairs", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(a.publicKeyBase64).not.toBe(b.publicKeyBase64);
  });
});

describe("signEd25519 + verifyEd25519", () => {
  it("verifies its own signature", () => {
    const kp = generateEd25519Keypair();
    const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, "hello");
    expect(verifyEd25519(kp.publicKeyBase64, sig, "hello")).toBe(true);
  });

  it("produces 88-char base64 signatures (64 bytes)", () => {
    const kp = generateEd25519Keypair();
    const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, "x");
    expect(Buffer.from(sig, "base64").length).toBe(64);
  });

  it("rejects tampered messages", () => {
    const kp = generateEd25519Keypair();
    const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, "hello");
    expect(verifyEd25519(kp.publicKeyBase64, sig, "hello!")).toBe(false);
  });

  it("rejects signatures from a different key", () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const sig = signEd25519(kp1.privateKeyBase64, kp1.publicKeyBase64, "hello");
    expect(verifyEd25519(kp2.publicKeyBase64, sig, "hello")).toBe(false);
  });

  it("rejects malformed public keys gracefully", () => {
    expect(verifyEd25519("not-base64!", "AA==", "x")).toBe(false);
  });

  it("rejects malformed signatures gracefully", () => {
    const kp = generateEd25519Keypair();
    expect(verifyEd25519(kp.publicKeyBase64, "not!base64!", "x")).toBe(false);
  });

  it("rejects wrong-length signatures", () => {
    const kp = generateEd25519Keypair();
    expect(verifyEd25519(kp.publicKeyBase64, Buffer.from("short").toString("base64"), "x")).toBe(
      false,
    );
  });

  it("handles Uint8Array messages", () => {
    const kp = generateEd25519Keypair();
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, msg);
    expect(verifyEd25519(kp.publicKeyBase64, sig, msg)).toBe(true);
  });

  it("rejects wrong-length private key", () => {
    const kp = generateEd25519Keypair();
    expect(() =>
      signEd25519(Buffer.from([1, 2, 3]).toString("base64"), kp.publicKeyBase64, "x"),
    ).toThrow(/private key/);
  });
});

describe("ed25519PublicKeyFingerprint", () => {
  it("returns the sha256 of the public key bytes", () => {
    const kp = generateEd25519Keypair();
    const fp = ed25519PublicKeyFingerprint(kp.publicKeyBase64);
    expect(fp).toBe(sha256(Buffer.from(kp.publicKeyBase64, "base64")));
  });

  it("is 64 hex chars", () => {
    const kp = generateEd25519Keypair();
    expect(ed25519PublicKeyFingerprint(kp.publicKeyBase64)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed input", () => {
    expect(() => ed25519PublicKeyFingerprint("not-base64!")).toThrow();
  });
});

describe("isEd25519PublicKeyBase64", () => {
  it("accepts a well-formed key", () => {
    const kp = generateEd25519Keypair();
    expect(isEd25519PublicKeyBase64(kp.publicKeyBase64)).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isEd25519PublicKeyBase64(Buffer.from([1, 2, 3]).toString("base64"))).toBe(false);
  });

  it("rejects non-base64", () => {
    expect(isEd25519PublicKeyBase64("not!base64!")).toBe(false);
  });
});

describe("isEd25519PrivateSeedBase64", () => {
  it("accepts a well-formed seed and rejects the wrong width", () => {
    const kp = generateEd25519Keypair();
    expect(isEd25519PrivateSeedBase64(kp.privateKeyBase64)).toBe(true);
    expect(isEd25519PrivateSeedBase64(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(isEd25519PrivateSeedBase64("not!base64!")).toBe(false);
  });
});

describe("ed25519PublicKeyFromSeed", () => {
  it("recovers the public half of a generated pair", () => {
    // This is what lets a deployment that signs its own tokens hold ONE secret: without it the
    // public key has to be configured beside the private one, and a pair that can be stated twice
    // can be stated inconsistently.
    for (let i = 0; i < 5; i += 1) {
      const kp = generateEd25519Keypair();
      expect(ed25519PublicKeyFromSeed(kp.privateKeyBase64)).toBe(kp.publicKeyBase64);
    }
  });

  it("the derived key verifies what the seed signed", () => {
    const kp = generateEd25519Keypair();
    const derived = ed25519PublicKeyFromSeed(kp.privateKeyBase64);
    const sig = signEd25519(kp.privateKeyBase64, derived, "jwt.signing.input");
    expect(verifyEd25519(derived, sig, "jwt.signing.input")).toBe(true);
  });

  it("is deterministic", () => {
    const kp = generateEd25519Keypair();
    expect(ed25519PublicKeyFromSeed(kp.privateKeyBase64)).toBe(
      ed25519PublicKeyFromSeed(kp.privateKeyBase64),
    );
  });

  it("refuses a seed of the wrong width rather than deriving something", () => {
    expect(() => ed25519PublicKeyFromSeed(Buffer.alloc(31).toString("base64"))).toThrow(
      /private seed must decode to 32 bytes/,
    );
    expect(() => ed25519PublicKeyFromSeed("not-base64!")).toThrow();
  });

  it("matches a pinned known-answer vector", () => {
    // An all-0x01 seed is a standard worked example; pinned so a change to the PKCS#8 prefix or
    // the export path cannot silently start deriving a different key, which would make every
    // issued token unverifiable at once.
    expect(ed25519PublicKeyFromSeed(Buffer.alloc(32, 0x01).toString("base64"))).toBe(
      "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
    );
  });
});
