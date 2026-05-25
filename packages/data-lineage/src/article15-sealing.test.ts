import { sha256 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { type Article15EvidencePack } from "./compliance.js";
import {
  canonicalArticle15BundleBytes,
  computeArticle15SealSha256,
  deliverArticle15Pack,
  sealArticle15Pack,
  verifyArticle15PackSeal,
} from "./article15-sealing.js";

function fixturePack(overrides: Partial<Article15EvidencePack> = {}): Article15EvidencePack {
  return {
    id: "a15_pack0001",
    tenantId: "00000000-0000-4000-8000-000000000001",
    subjectAccessRequestId: "sar_req00001",
    subjectId: "ds_subj00001",
    status: "compiling",
    nodeIds: ["lng_node0001", "lng_node0002"],
    edgeIds: ["lne_edge0001"],
    provenanceRecordIds: ["prv_prv00001"],
    totalRowCount: 1_000,
    derivedNodeCount: 2,
    regulatedNodeCount: 1,
    compiledAt: "2026-05-15T00:00:00.000Z",
    sealedAt: null,
    sealedSha256: null,
    storageUri: null,
    encryptionKeyFingerprint: null,
    deliveredAt: null,
    expiresAt: "2027-05-15T00:00:00.000Z",
    redactedPiiFields: ["ssn"],
    redactedReasons: ["k-anonymity below threshold"],
    createdByUserId: "00000000-0000-4000-8000-000000000099",
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

const VALID_KEY_FP = sha256("encryption-key-1");

describe("canonicalArticle15BundleBytes", () => {
  it("produces deterministic output for the same input", () => {
    const a = canonicalArticle15BundleBytes({ pack: fixturePack(), bundleBytes: "data" });
    const b = canonicalArticle15BundleBytes({ pack: fixturePack(), bundleBytes: "data" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("is stable under nodeIds reordering", () => {
    const a = canonicalArticle15BundleBytes({
      pack: fixturePack({ nodeIds: ["lng_node0001", "lng_node0002"] }),
      bundleBytes: "x",
    });
    const b = canonicalArticle15BundleBytes({
      pack: fixturePack({ nodeIds: ["lng_node0002", "lng_node0001"] }),
      bundleBytes: "x",
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("differs when bundle bytes differ", () => {
    const a = canonicalArticle15BundleBytes({ pack: fixturePack(), bundleBytes: "a" });
    const b = canonicalArticle15BundleBytes({ pack: fixturePack(), bundleBytes: "b" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("prefixes the article15 domain tag", () => {
    const bytes = canonicalArticle15BundleBytes({ pack: fixturePack(), bundleBytes: "x" });
    expect(new TextDecoder().decode(bytes).startsWith("crossengin.article15.bundle.v1\n")).toBe(
      true,
    );
  });
});

describe("computeArticle15SealSha256", () => {
  it("returns 64-char hex", () => {
    expect(computeArticle15SealSha256({ pack: fixturePack(), bundleBytes: "x" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("differs for differently-redacted packs", () => {
    const a = computeArticle15SealSha256({
      pack: fixturePack({ redactedPiiFields: ["ssn"], redactedReasons: ["x"] }),
      bundleBytes: "same",
    });
    const b = computeArticle15SealSha256({
      pack: fixturePack({ redactedPiiFields: ["ssn", "dob"], redactedReasons: ["x", "y"] }),
      bundleBytes: "same",
    });
    expect(a).not.toBe(b);
  });
});

describe("sealArticle15Pack", () => {
  it("returns a sealed pack with populated sealedSha256 + storageUri + encryption fingerprint", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack(),
      bundleBytes: "the bundle",
      storageUri: "s3://article15/a15_pack0001.tar.gz.gpg",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(sealed.status).toBe("sealed");
    expect(sealed.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.storageUri).toBe("s3://article15/a15_pack0001.tar.gz.gpg");
    expect(sealed.encryptionKeyFingerprint).toBe(VALID_KEY_FP);
  });

  it("rejects sealing from a non-compiling status", () => {
    expect(() =>
      sealArticle15Pack({
        pack: fixturePack({
          status: "delivered",
          sealedAt: "2026-05-15T00:00:00.000Z",
          sealedSha256: "a".repeat(64),
          storageUri: "s3://x",
          encryptionKeyFingerprint: VALID_KEY_FP,
          deliveredAt: "2026-05-15T01:00:00.000Z",
        }),
        bundleBytes: "x",
        storageUri: "s3://y",
        encryptionKeyFingerprint: VALID_KEY_FP,
        sealedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).toThrow(/compiling/);
  });

  it("rejects an invalid encryption key fingerprint shape", () => {
    expect(() =>
      sealArticle15Pack({
        pack: fixturePack(),
        bundleBytes: "x",
        storageUri: "s3://x",
        encryptionKeyFingerprint: "not-a-hash",
        sealedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).toThrow(/lowercase hex sha256/);
  });

  it("threads expiresAt when supplied", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack({ expiresAt: null }),
      bundleBytes: "x",
      storageUri: "s3://x",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
      expiresAt: "2027-05-16T12:00:00.000Z",
    });
    expect(sealed.expiresAt).toBe("2027-05-16T12:00:00.000Z");
  });
});

describe("deliverArticle15Pack", () => {
  it("transitions sealed → delivered", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack(),
      bundleBytes: "x",
      storageUri: "s3://x",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    const delivered = deliverArticle15Pack({
      pack: sealed,
      deliveredAt: "2026-05-17T00:00:00.000Z",
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).toBe("2026-05-17T00:00:00.000Z");
  });

  it("rejects delivering a non-sealed pack", () => {
    expect(() =>
      deliverArticle15Pack({
        pack: fixturePack(),
        deliveredAt: "2026-05-17T00:00:00.000Z",
      }),
    ).toThrow(/sealed/);
  });
});

describe("verifyArticle15PackSeal", () => {
  it("returns ok=true for a freshly sealed pack", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack(),
      bundleBytes: "bundle-A",
      storageUri: "s3://x",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    const result = verifyArticle15PackSeal({ pack: sealed, bundleBytes: "bundle-A" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("detects a tampered bundle", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack(),
      bundleBytes: "bundle-A",
      storageUri: "s3://x",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    const result = verifyArticle15PackSeal({ pack: sealed, bundleBytes: "bundle-tampered" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match");
  });

  it("returns ok=false for an unsealed pack", () => {
    const result = verifyArticle15PackSeal({
      pack: fixturePack(),
      bundleBytes: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not sealed");
  });

  it("survives roundtrip through deliverArticle15Pack", () => {
    const sealed = sealArticle15Pack({
      pack: fixturePack(),
      bundleBytes: "bundle-X",
      storageUri: "s3://x",
      encryptionKeyFingerprint: VALID_KEY_FP,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    const delivered = deliverArticle15Pack({
      pack: sealed,
      deliveredAt: "2026-05-17T00:00:00.000Z",
    });
    const result = verifyArticle15PackSeal({ pack: delivered, bundleBytes: "bundle-X" });
    expect(result.ok).toBe(true);
  });
});
