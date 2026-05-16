import { describe, expect, it } from "vitest";

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
