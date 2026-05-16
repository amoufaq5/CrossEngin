import { describe, expect, it } from "vitest";

import { type AccessReviewEvidence } from "./evidence.js";
import {
  canonicalEvidenceBundleBytes,
  computeEvidenceSealSha256,
  sealEvidenceWithBundle,
  verifyEvidenceSeal,
} from "./evidence-sealing.js";

function fixtureEvidence(overrides: Partial<AccessReviewEvidence> = {}): AccessReviewEvidence {
  return {
    id: "arv_evi00001",
    tenantId: "00000000-0000-4000-8000-000000000001",
    framework: "soc2_type2",
    periodStartAt: "2026-01-01T00:00:00.000Z",
    periodEndAt: "2026-03-31T23:59:59.000Z",
    campaignIds: ["arc_camp0001", "arc_camp0002"],
    controlMappings: ["CC6.3"],
    totalItemsAcrossCampaigns: 100,
    completionRate: 1,
    keepRate: 0.8,
    revokeRate: 0.15,
    autoRevokeRate: 0.05,
    exceptionRate: 0,
    strongAttestationRate: 1,
    overdueRate: 0,
    status: "compiled",
    compiledAt: "2026-04-01T00:00:00.000Z",
    sealedAt: null,
    sealedSha256: null,
    submittedAt: null,
    submittedToAuditorId: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    storageUri: null,
    createdBy: "00000000-0000-4000-8000-000000000099",
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("canonicalEvidenceBundleBytes", () => {
  it("produces deterministic output for the same input", () => {
    const evidence = fixtureEvidence();
    const a = canonicalEvidenceBundleBytes({ evidence, bundleBytes: "some bundle" });
    const b = canonicalEvidenceBundleBytes({ evidence, bundleBytes: "some bundle" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("is stable under campaignIds reordering", () => {
    const a = canonicalEvidenceBundleBytes({
      evidence: fixtureEvidence({ campaignIds: ["arc_camp0001", "arc_camp0002"] }),
      bundleBytes: "x",
    });
    const b = canonicalEvidenceBundleBytes({
      evidence: fixtureEvidence({ campaignIds: ["arc_camp0002", "arc_camp0001"] }),
      bundleBytes: "x",
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("differs when bundle bytes differ", () => {
    const a = canonicalEvidenceBundleBytes({ evidence: fixtureEvidence(), bundleBytes: "a" });
    const b = canonicalEvidenceBundleBytes({ evidence: fixtureEvidence(), bundleBytes: "b" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("computeEvidenceSealSha256", () => {
  it("returns 64-char hex", () => {
    expect(
      computeEvidenceSealSha256({ evidence: fixtureEvidence(), bundleBytes: "x" }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bundle payloads", () => {
    const a = computeEvidenceSealSha256({ evidence: fixtureEvidence(), bundleBytes: "a" });
    const b = computeEvidenceSealSha256({ evidence: fixtureEvidence(), bundleBytes: "b" });
    expect(a).not.toBe(b);
  });
});

describe("sealEvidenceWithBundle", () => {
  it("produces a sealed evidence record with populated sealedSha256", () => {
    const sealed = sealEvidenceWithBundle({
      evidence: fixtureEvidence(),
      bundleBytes: "the bundle",
      storageUri: "s3://evidence/arv_evi00001.tar.gz",
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    expect(sealed.status).toBe("sealed");
    expect(sealed.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.storageUri).toBe("s3://evidence/arv_evi00001.tar.gz");
    expect(sealed.sealedAt).toBe("2026-04-15T00:00:00.000Z");
  });

  it("rejects sealing from a non-compiled status", () => {
    expect(() =>
      sealEvidenceWithBundle({
        evidence: fixtureEvidence({ status: "draft" }),
        bundleBytes: "x",
        storageUri: "s3://x",
        now: new Date(),
      }),
    ).toThrow(/sealed/);
  });
});

describe("verifyEvidenceSeal", () => {
  it("returns ok=true for a freshly sealed evidence", () => {
    const sealed = sealEvidenceWithBundle({
      evidence: fixtureEvidence(),
      bundleBytes: "bundle-A",
      storageUri: "s3://x",
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    const result = verifyEvidenceSeal({ evidence: sealed, bundleBytes: "bundle-A" });
    expect(result.ok).toBe(true);
  });

  it("detects a tampered bundle", () => {
    const sealed = sealEvidenceWithBundle({
      evidence: fixtureEvidence(),
      bundleBytes: "bundle-A",
      storageUri: "s3://x",
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    const result = verifyEvidenceSeal({ evidence: sealed, bundleBytes: "bundle-tampered" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match");
  });

  it("returns ok=false when evidence is not sealed", () => {
    const result = verifyEvidenceSeal({
      evidence: fixtureEvidence(),
      bundleBytes: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not sealed");
  });
});
