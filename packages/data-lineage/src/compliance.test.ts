import { describe, expect, it } from "vitest";
import {
  ARTICLE_15_EVIDENCE_STATUSES,
  Article15EvidencePackSchema,
  REGULATORY_RETENTION_MINIMUMS_DAYS,
  RETENTION_BASES,
  RetentionPolicySchema,
  computeNodeRetentionUntil,
  decideRetention,
  isPackDownloadable,
  isPolicyActive,
  type Article15EvidencePack,
  type RetentionPolicy,
} from "./compliance.js";
import type { LineageNode } from "./nodes.js";

const basePolicy: RetentionPolicy = {
  id: "lrp_hipaa6yr",
  tenantId: null,
  label: "HIPAA PHI 6-year minimum retention",
  basis: "regulatory_minimum",
  minimumRetentionDays: 2190,
  maximumRetentionDays: null,
  appliesToNodeKinds: ["source_table", "derived_table"],
  appliesToClassifications: ["phi_protected"],
  regulatoryReference: "45 CFR §164.530(j)",
  blocksAutoDeletion: true,
  purgeAfterExpiry: false,
  enabledAt: "2026-01-01T00:00:00.000Z",
  enabledByUserId: "22222222-2222-2222-2222-222222222222",
  disabledAt: null,
  disabledByUserId: null,
  disabledReason: null,
};

const baseNode: LineageNode = {
  id: "lng_phi0001a1",
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "source_table",
  label: "PHI records",
  status: "active",
  classification: "phi_protected",
  rowCount: 5000,
  columnCount: 15,
  sizeBytes: 500_000,
  contentSha256: "a".repeat(64),
  storageUri: null,
  externalRef: null,
  sourcePackage: null,
  createdAt: "2026-01-15T10:00:00.000Z",
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdBySystem: null,
  frozenAt: null,
  frozenSha256: null,
  purgedAt: null,
  tombstonedAt: null,
  retentionUntil: null,
  minimumKAnonymity: null,
};

const baseEvidencePack: Article15EvidencePack = {
  id: "a15_alice001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subjectAccessRequestId: "sar_alice0001",
  subjectId: "ds_alice0001",
  status: "compiling",
  nodeIds: ["lng_phi0001a1"],
  edgeIds: [],
  provenanceRecordIds: [],
  totalRowCount: 1,
  derivedNodeCount: 0,
  regulatedNodeCount: 1,
  compiledAt: null,
  sealedAt: null,
  sealedSha256: null,
  storageUri: null,
  encryptionKeyFingerprint: null,
  deliveredAt: null,
  expiresAt: null,
  redactedPiiFields: [],
  redactedReasons: [],
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdAt: "2026-05-17T10:00:00.000Z",
};

describe("constants", () => {
  it("has 6 retention bases", () => {
    expect(RETENTION_BASES).toHaveLength(6);
  });
  it("HIPAA PHI minimum is 6 years (2190 days)", () => {
    expect(REGULATORY_RETENTION_MINIMUMS_DAYS.hipaa_phi).toBe(2190);
  });
  it("SOX financial minimum is 7 years (2555 days)", () => {
    expect(REGULATORY_RETENTION_MINIMUMS_DAYS.sox_financial).toBe(2555);
  });
  it("has 4 evidence pack statuses", () => {
    expect(ARTICLE_15_EVIDENCE_STATUSES).toHaveLength(4);
  });
});

describe("RetentionPolicySchema", () => {
  it("accepts a regulatory minimum policy", () => {
    expect(() => RetentionPolicySchema.parse(basePolicy)).not.toThrow();
  });

  it("rejects maximumRetentionDays < minimumRetentionDays", () => {
    expect(() =>
      RetentionPolicySchema.parse({
        ...basePolicy,
        minimumRetentionDays: 100,
        maximumRetentionDays: 50,
      }),
    ).toThrow(/maximumRetentionDays must be >= minimumRetentionDays/);
  });

  it("rejects regulatory_minimum without regulatoryReference", () => {
    expect(() =>
      RetentionPolicySchema.parse({
        ...basePolicy,
        regulatoryReference: null,
      }),
    ).toThrow(/regulatoryReference \(citation\)/);
  });

  it("rejects indefinite_legal_hold with maximumRetentionDays set", () => {
    expect(() =>
      RetentionPolicySchema.parse({
        ...basePolicy,
        basis: "indefinite_legal_hold",
        maximumRetentionDays: 365,
        regulatoryReference: null,
      }),
    ).toThrow(/indefinite_legal_hold/);
  });

  it("rejects disabled policy without reason", () => {
    expect(() =>
      RetentionPolicySchema.parse({
        ...basePolicy,
        disabledAt: "2026-12-01T00:00:00.000Z",
      }),
    ).toThrow(/disabled policy requires/);
  });

  it("rejects four-eyes violation (disabledByUserId === enabledByUserId)", () => {
    expect(() =>
      RetentionPolicySchema.parse({
        ...basePolicy,
        disabledAt: "2026-12-01T00:00:00.000Z",
        disabledByUserId: basePolicy.enabledByUserId,
        disabledReason: "policy retired",
      }),
    ).toThrow(/four-eyes/);
  });
});

describe("isPolicyActive", () => {
  it("returns true when enabled and not disabled", () => {
    expect(
      isPolicyActive(basePolicy, new Date("2026-06-01T00:00:00Z")),
    ).toBe(true);
  });
  it("returns false before enabledAt", () => {
    expect(
      isPolicyActive(basePolicy, new Date("2025-12-31T00:00:00Z")),
    ).toBe(false);
  });
  it("returns false when disabled", () => {
    expect(
      isPolicyActive(
        {
          ...basePolicy,
          disabledAt: "2026-05-01T00:00:00.000Z",
          disabledByUserId: "33333333-3333-3333-3333-333333333333",
          disabledReason: "retired",
        },
        new Date("2026-06-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("computeNodeRetentionUntil", () => {
  it("returns createdAt + minimumRetentionDays", () => {
    const r = computeNodeRetentionUntil(baseNode, basePolicy);
    const expectedMs =
      Date.parse(baseNode.createdAt) + 2190 * 86_400_000;
    expect(Date.parse(r)).toBe(expectedMs);
  });
});

describe("decideRetention", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("blocks purge when policy active and within retention window", () => {
    const d = decideRetention({
      node: baseNode,
      applicablePolicies: [basePolicy],
      now,
    });
    expect(d.canPurge).toBe(false);
    expect(d.blockingPolicyId).toBe(basePolicy.id);
  });

  it("allows purge when no policy applies and node has no retentionUntil", () => {
    const d = decideRetention({
      node: { ...baseNode, retentionUntil: null },
      applicablePolicies: [],
      now,
    });
    expect(d.canPurge).toBe(true);
  });

  it("blocks purge when node's retentionUntil is in the future", () => {
    const d = decideRetention({
      node: { ...baseNode, retentionUntil: "2030-01-01T00:00:00.000Z" },
      applicablePolicies: [],
      now,
    });
    expect(d.canPurge).toBe(false);
    expect(d.reason).toBe("blocked_by_node_retention_until");
  });

  it("ignores disabled policies", () => {
    const disabled: RetentionPolicy = {
      ...basePolicy,
      disabledAt: "2026-05-01T00:00:00.000Z",
      disabledByUserId: "33333333-3333-3333-3333-333333333333",
      disabledReason: "retired",
    };
    const d = decideRetention({
      node: { ...baseNode, retentionUntil: null },
      applicablePolicies: [disabled],
      now,
    });
    expect(d.canPurge).toBe(true);
  });
});

describe("Article15EvidencePackSchema", () => {
  it("accepts a compiling pack", () => {
    expect(() =>
      Article15EvidencePackSchema.parse(baseEvidencePack),
    ).not.toThrow();
  });

  it("rejects sealed without sealedSha256 + storageUri + encryptionKeyFingerprint", () => {
    expect(() =>
      Article15EvidencePackSchema.parse({
        ...baseEvidencePack,
        status: "sealed",
        sealedAt: "2026-05-17T11:00:00.000Z",
      }),
    ).toThrow(/sealedAt \+ sealedSha256 \+ storageUri/);
  });

  it("rejects delivered without deliveredAt", () => {
    expect(() =>
      Article15EvidencePackSchema.parse({
        ...baseEvidencePack,
        status: "delivered",
        sealedAt: "2026-05-17T11:00:00.000Z",
        sealedSha256: "a".repeat(64),
        storageUri: "s3://evidence/alice.zip",
        encryptionKeyFingerprint: "b".repeat(64),
      }),
    ).toThrow(/deliveredAt/);
  });

  it("rejects expiresAt <= sealedAt", () => {
    expect(() =>
      Article15EvidencePackSchema.parse({
        ...baseEvidencePack,
        status: "sealed",
        sealedAt: "2026-05-17T11:00:00.000Z",
        sealedSha256: "a".repeat(64),
        storageUri: "s3://evidence/alice.zip",
        encryptionKeyFingerprint: "b".repeat(64),
        expiresAt: "2026-05-17T11:00:00.000Z",
      }),
    ).toThrow(/expiresAt must be after sealedAt/);
  });

  it("rejects redactedPiiFields length != redactedReasons length", () => {
    expect(() =>
      Article15EvidencePackSchema.parse({
        ...baseEvidencePack,
        redactedPiiFields: ["ssn"],
        redactedReasons: [],
      }),
    ).toThrow(/equal length/);
  });
});

describe("isPackDownloadable", () => {
  const now = new Date("2026-05-18T00:00:00Z");

  it("returns true for sealed pack with future expiry", () => {
    expect(
      isPackDownloadable(
        {
          ...baseEvidencePack,
          status: "sealed",
          sealedAt: "2026-05-17T10:00:00.000Z",
          sealedSha256: "a".repeat(64),
          storageUri: "s3://x",
          encryptionKeyFingerprint: "b".repeat(64),
          expiresAt: "2026-06-17T10:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false for expired pack", () => {
    expect(
      isPackDownloadable(
        {
          ...baseEvidencePack,
          status: "delivered",
          sealedAt: "2026-05-17T10:00:00.000Z",
          sealedSha256: "a".repeat(64),
          storageUri: "s3://x",
          encryptionKeyFingerprint: "b".repeat(64),
          deliveredAt: "2026-05-17T11:00:00.000Z",
          expiresAt: "2026-05-17T12:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("returns false for compiling pack", () => {
    expect(isPackDownloadable(baseEvidencePack, now)).toBe(false);
  });
});
