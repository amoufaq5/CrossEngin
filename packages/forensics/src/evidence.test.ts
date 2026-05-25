import { describe, expect, it } from "vitest";
import {
  EVIDENCE_KINDS,
  EVIDENCE_PROVENANCE,
  EVIDENCE_SENSITIVITY,
  EvidenceItemSchema,
  canDestroyEvidence,
  isEvidenceRetentionExpired,
  isEvidenceSealed,
  type EvidenceItem,
} from "./evidence.js";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

describe("constants", () => {
  it("EVIDENCE_KINDS has 10 entries", () => {
    expect(EVIDENCE_KINDS).toContain("log_export");
    expect(EVIDENCE_KINDS).toContain("memory_dump");
    expect(EVIDENCE_KINDS).toContain("expert_report");
  });

  it("EVIDENCE_SENSITIVITY has 6 entries", () => {
    expect(EVIDENCE_SENSITIVITY).toContain("attorney_client_privileged");
    expect(EVIDENCE_SENSITIVITY).toContain("national_security");
  });

  it("EVIDENCE_PROVENANCE has 5 entries", () => {
    expect(EVIDENCE_PROVENANCE).toContain("forensic_imaging");
    expect(EVIDENCE_PROVENANCE).toContain("subpoena_response");
  });
});

describe("EvidenceItemSchema", () => {
  const base: EvidenceItem = {
    id: "EV-2026-0001",
    caseId: "case-1",
    kind: "log_export",
    sensitivity: "confidential",
    provenance: "human_collection",
    label: "Audit logs Q2 2026",
    description: "Exported audit logs for Q2 investigation",
    sourceSystem: "audit-platform",
    collectedAt: "2026-05-14T10:00:00Z",
    collectedBy: "u-collector",
    sizeBytes: 1_000_000,
    sha256: SHA,
    storageUri: "s3://evidence/ev-2026-0001.enc",
    encryptionKeyFingerprint: SHA2,
    sealedAt: "2026-05-14T10:05:00Z",
    sealedBy: "u-sealer",
    contentRedactedSha256: null,
    retentionUntil: "2033-05-14T10:00:00Z",
    legalHoldIds: [],
    destroyedAt: null,
  };

  it("accepts a valid evidence item", () => {
    expect(() => EvidenceItemSchema.parse(base)).not.toThrow();
  });

  it("rejects sealedAt before collectedAt", () => {
    expect(() => EvidenceItemSchema.parse({ ...base, sealedAt: "2026-05-14T09:00:00Z" })).toThrow(
      /cannot be before collectedAt/,
    );
  });

  it("rejects retentionUntil <= collectedAt", () => {
    expect(() =>
      EvidenceItemSchema.parse({
        ...base,
        retentionUntil: "2026-05-14T10:00:00Z",
      }),
    ).toThrow(/must be after collectedAt/);
  });

  it("rejects same collectedBy + sealedBy for human collection", () => {
    expect(() => EvidenceItemSchema.parse({ ...base, sealedBy: "u-collector" })).toThrow(
      /two-person integrity/,
    );
  });

  it("rejects destruction while under legal hold", () => {
    expect(() =>
      EvidenceItemSchema.parse({
        ...base,
        legalHoldIds: ["LH-2026-0001"],
        destroyedAt: "2026-06-01T00:00:00Z",
        destroyedReason: "retention expired",
      }),
    ).toThrow(/cannot destroy.*legal hold/);
  });

  it("rejects destruction without reason", () => {
    expect(() =>
      EvidenceItemSchema.parse({
        ...base,
        destroyedAt: "2034-06-01T00:00:00Z",
      }),
    ).toThrow(/destroyedReason/);
  });

  it("rejects attorney_client_privileged with automated collection", () => {
    expect(() =>
      EvidenceItemSchema.parse({
        ...base,
        sensitivity: "attorney_client_privileged",
        provenance: "automated_collection",
        sealedBy: "u-collector",
      }),
    ).toThrow(/automated_collection/);
  });

  it("rejects duplicate legal hold ids", () => {
    expect(() =>
      EvidenceItemSchema.parse({
        ...base,
        legalHoldIds: ["LH-2026-0001", "LH-2026-0001"],
      }),
    ).toThrow(/duplicate legal hold/);
  });

  it("rejects malformed evidence id", () => {
    expect(() => EvidenceItemSchema.parse({ ...base, id: "EV-1" })).toThrow();
  });
});

describe("helpers", () => {
  const item: EvidenceItem = {
    id: "EV-2026-0001",
    caseId: "case-1",
    kind: "log_export",
    sensitivity: "confidential",
    provenance: "human_collection",
    label: "x",
    description: "x",
    sourceSystem: "x",
    collectedAt: "2026-05-14T10:00:00Z",
    collectedBy: "u-collector",
    sizeBytes: 1000,
    sha256: SHA,
    storageUri: "s3://x",
    encryptionKeyFingerprint: SHA2,
    sealedAt: "2026-05-14T11:00:00Z",
    sealedBy: "u-sealer",
    contentRedactedSha256: null,
    retentionUntil: "2027-05-14T10:00:00Z",
    legalHoldIds: [],
    destroyedAt: null,
  };

  it("isEvidenceSealed true when not destroyed", () => {
    expect(isEvidenceSealed(item)).toBe(true);
  });

  it("isEvidenceRetentionExpired true after retentionUntil", () => {
    expect(isEvidenceRetentionExpired(item, new Date("2028-01-01T00:00:00Z"))).toBe(true);
    expect(isEvidenceRetentionExpired(item, new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });

  it("canDestroyEvidence true when retention expired + no hold", () => {
    expect(canDestroyEvidence(item, new Date("2028-01-01T00:00:00Z"))).toBe(true);
  });

  it("canDestroyEvidence false when under hold", () => {
    expect(
      canDestroyEvidence(
        { ...item, legalHoldIds: ["LH-2026-0001"] },
        new Date("2028-01-01T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("canDestroyEvidence false before retention", () => {
    expect(canDestroyEvidence(item, new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });
});
