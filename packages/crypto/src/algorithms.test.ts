import { describe, expect, it } from "vitest";

import { AEAD_ALGORITHM } from "./aead.js";
import {
  CRYPTO_VERSION,
  HASH_ALGORITHMS,
  KEY_ALGORITHMS,
  KEY_PURPOSES,
  MAC_ALGORITHMS,
  SIGNATURE_ALGORITHMS,
  allowedPurposesForAlgorithm,
  isHashAlgorithm,
  isKeyAlgorithm,
  isKeyPurpose,
  isMacAlgorithm,
  isPurposeAllowed,
  isSignatureAlgorithm,
} from "./algorithms.js";

describe("algorithm enumerations", () => {
  it("declares two hash algorithms", () => {
    expect(HASH_ALGORITHMS).toEqual(["sha256", "blake2b-512"]);
  });

  it("declares HMAC-SHA256 as the only MAC", () => {
    expect(MAC_ALGORITHMS).toEqual(["hmac-sha256"]);
  });

  it("declares ed25519 as the only signature algorithm", () => {
    expect(SIGNATURE_ALGORITHMS).toEqual(["ed25519"]);
  });

  it("composes KEY_ALGORITHMS from MAC + signature", () => {
    expect(KEY_ALGORITHMS).toEqual(["hmac-sha256", "ed25519"]);
  });

  it("declares four key purposes", () => {
    expect(KEY_PURPOSES).toEqual([
      "pack_signing",
      "webhook_signing",
      "evidence_sealing",
      "tombstone_anchoring",
    ]);
  });

  it("uses CRYPTO_VERSION = 1", () => {
    expect(CRYPTO_VERSION).toBe(1);
  });

  it("excludes the AEAD cipher, because a derived key is not a handle", () => {
    // This package has a cipher (`aead.ts`) and `KEY_ALGORITHMS` still does not name
    // it — not as an omission, but because these three enumerations describe the key
    // *registry*: which algorithms a registered `KeyHandle` may have, what a handle may
    // be for, and which key-management acts are audited. Every key the AEAD is used
    // with is derived on demand from a deployment secret, so it has no material at
    // rest, no `meta.crypto_keys` row and no lifecycle — there is nothing for the
    // registry to hold and nothing for the key-management audit to record.
    // `isCryptoOperation("encrypt")` is pinned false in audit.test.ts for the same
    // reason. Adding a cipher here would mean a *registered* cipher key, which would
    // need a private-material column `meta.crypto_keys` does not have.
    expect(KEY_ALGORITHMS as readonly string[]).not.toContain(AEAD_ALGORITHM);
    expect(isKeyAlgorithm(AEAD_ALGORITHM)).toBe(false);
    expect(KEY_PURPOSES as readonly string[]).not.toContain("column_encryption");
    expect(KEY_PURPOSES as readonly string[]).not.toContain("cursor_encryption");
  });
});

describe("type guards", () => {
  it("identifies hash algorithms", () => {
    expect(isHashAlgorithm("sha256")).toBe(true);
    expect(isHashAlgorithm("blake2b-512")).toBe(true);
    expect(isHashAlgorithm("md5")).toBe(false);
    expect(isHashAlgorithm(undefined)).toBe(false);
  });

  it("identifies MAC algorithms", () => {
    expect(isMacAlgorithm("hmac-sha256")).toBe(true);
    expect(isMacAlgorithm("hmac-md5")).toBe(false);
  });

  it("identifies signature algorithms", () => {
    expect(isSignatureAlgorithm("ed25519")).toBe(true);
    expect(isSignatureAlgorithm("rsa-pss")).toBe(false);
  });

  it("identifies key algorithms", () => {
    expect(isKeyAlgorithm("ed25519")).toBe(true);
    expect(isKeyAlgorithm("hmac-sha256")).toBe(true);
    expect(isKeyAlgorithm("sha256")).toBe(false);
  });

  it("identifies key purposes", () => {
    expect(isKeyPurpose("pack_signing")).toBe(true);
    expect(isKeyPurpose("login")).toBe(false);
  });
});

describe("allowedPurposesForAlgorithm", () => {
  it("restricts HMAC keys to webhook signing", () => {
    expect(allowedPurposesForAlgorithm("hmac-sha256")).toEqual(["webhook_signing"]);
  });

  it("allows ed25519 keys for pack/evidence/tombstone purposes", () => {
    const purposes = allowedPurposesForAlgorithm("ed25519");
    expect(purposes).toContain("pack_signing");
    expect(purposes).toContain("evidence_sealing");
    expect(purposes).toContain("tombstone_anchoring");
    expect(purposes).not.toContain("webhook_signing");
  });
});

describe("isPurposeAllowed", () => {
  it("permits HMAC for webhook signing only", () => {
    expect(isPurposeAllowed("hmac-sha256", "webhook_signing")).toBe(true);
    expect(isPurposeAllowed("hmac-sha256", "pack_signing")).toBe(false);
  });

  it("permits ed25519 for pack/evidence/tombstone but not webhook", () => {
    expect(isPurposeAllowed("ed25519", "pack_signing")).toBe(true);
    expect(isPurposeAllowed("ed25519", "evidence_sealing")).toBe(true);
    expect(isPurposeAllowed("ed25519", "tombstone_anchoring")).toBe(true);
    expect(isPurposeAllowed("ed25519", "webhook_signing")).toBe(false);
  });
});
