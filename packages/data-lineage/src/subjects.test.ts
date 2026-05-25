import { describe, expect, it } from "vitest";
import {
  DELIVERY_FORMATS,
  DataSubjectSchema,
  STRONG_SUBJECT_IDENTIFIERS,
  SUBJECT_ACCESS_LEGAL_BASES,
  SUBJECT_ACCESS_STATUSES,
  SUBJECT_ACCESS_TRANSITIONS,
  SUBJECT_DEADLINE_DAYS,
  SUBJECT_IDENTIFIER_KINDS,
  SubjectAccessRequestSchema,
  SubjectNodeOccurrenceSchema,
  canTransitionSubjectAccess,
  computeDeadline,
  isRequestOverdue,
  isStrongIdentifier,
  type DataSubject,
  type SubjectAccessRequest,
} from "./subjects.js";

const baseSubject: DataSubject = {
  id: "ds_alice0001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  primaryIdentifierKind: "email_address",
  primaryIdentifierSha256: "a".repeat(64),
  alternateIdentifiers: [
    {
      kind: "user_id",
      identifierSha256: "b".repeat(64),
    },
  ],
  isVerified: true,
  verifiedAt: "2026-05-15T10:00:00.000Z",
  verificationMethod: "email_link",
  firstSeenAt: "2025-01-15T10:00:00.000Z",
  lastSeenAt: "2026-05-16T09:00:00.000Z",
  nodeOccurrenceCount: 12,
};

const baseRequest: SubjectAccessRequest = {
  id: "sar_alice0001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subjectId: "ds_alice0001",
  legalBasis: "gdpr_article_15",
  status: "submitted",
  submittedAt: "2026-05-16T10:00:00.000Z",
  submittedByContact: "alice@example.com",
  deadlineAt: "2026-06-15T10:00:00.000Z",
  verifiedAt: null,
  inProgressAt: null,
  completedAt: null,
  rejectedAt: null,
  rejectedReason: null,
  deferredUntil: null,
  deferralReason: null,
  requestedFormat: "json",
  includeDerivedData: true,
  nodeCount: 0,
  edgeCount: 0,
  bytesProduced: null,
  bundleSha256: null,
  bundleStorageUri: null,
  bundleEncryptionKeyFingerprint: null,
  deliveredAt: null,
  downloadCount: 0,
  maxDownloads: 3,
};

describe("constants", () => {
  it("has 10 subject identifier kinds", () => {
    expect(SUBJECT_IDENTIFIER_KINDS).toHaveLength(10);
  });
  it("has 7 access request statuses", () => {
    expect(SUBJECT_ACCESS_STATUSES).toHaveLength(7);
  });
  it("has 6 legal bases", () => {
    expect(SUBJECT_ACCESS_LEGAL_BASES).toHaveLength(6);
  });
  it("has 5 delivery formats", () => {
    expect(DELIVERY_FORMATS).toHaveLength(5);
  });
  it("STRONG_SUBJECT_IDENTIFIERS includes email/user_id/patient_mrn/national/tax", () => {
    expect(STRONG_SUBJECT_IDENTIFIERS.has("email_address")).toBe(true);
    expect(STRONG_SUBJECT_IDENTIFIERS.has("patient_mrn")).toBe(true);
    expect(STRONG_SUBJECT_IDENTIFIERS.has("ip_address")).toBe(false);
  });
  it("GDPR Article 15 deadline is 30 days", () => {
    expect(SUBJECT_DEADLINE_DAYS.gdpr_article_15).toBe(30);
  });
  it("LGPD Article 18 deadline is 15 days", () => {
    expect(SUBJECT_DEADLINE_DAYS.lgpd_article_18).toBe(15);
  });
  it("CCPA deadline is 45 days", () => {
    expect(SUBJECT_DEADLINE_DAYS.ccpa_right_to_know).toBe(45);
  });
});

describe("canTransitionSubjectAccess", () => {
  it("allows submitted → verified", () => {
    expect(canTransitionSubjectAccess("submitted", "verified")).toBe(true);
  });
  it("blocks submitted → complete (must verify first)", () => {
    expect(canTransitionSubjectAccess("submitted", "complete")).toBe(false);
  });
  it("complete is terminal", () => {
    expect(SUBJECT_ACCESS_TRANSITIONS.complete).toEqual([]);
  });
});

describe("DataSubjectSchema", () => {
  it("accepts a verified subject", () => {
    expect(() => DataSubjectSchema.parse(baseSubject)).not.toThrow();
  });

  it("rejects verified without verifiedAt + method", () => {
    expect(() =>
      DataSubjectSchema.parse({
        ...baseSubject,
        verifiedAt: null,
        verificationMethod: null,
      }),
    ).toThrow(/verified subject requires/);
  });

  it("rejects duplicate identifier kinds across primary + alternate", () => {
    expect(() =>
      DataSubjectSchema.parse({
        ...baseSubject,
        alternateIdentifiers: [
          {
            kind: "email_address",
            identifierSha256: "c".repeat(64),
          },
        ],
      }),
    ).toThrow(/duplicate identifier kind/);
  });

  it("rejects lastSeenAt < firstSeenAt", () => {
    expect(() =>
      DataSubjectSchema.parse({
        ...baseSubject,
        lastSeenAt: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow(/cannot precede firstSeenAt/);
  });
});

describe("SubjectNodeOccurrenceSchema", () => {
  it("accepts a valid occurrence", () => {
    expect(() =>
      SubjectNodeOccurrenceSchema.parse({
        id: "sno_alice0001",
        subjectId: "ds_alice0001",
        nodeId: "lng_userstable",
        tenantId: "11111111-1111-1111-1111-111111111111",
        firstObservedAt: "2026-01-15T10:00:00.000Z",
        lastObservedAt: "2026-05-16T09:00:00.000Z",
        occurrenceCount: 7,
        columnsContaining: ["email"],
        derivedThroughEdgeIds: [],
      }),
    ).not.toThrow();
  });
});

describe("SubjectAccessRequestSchema", () => {
  it("accepts a submitted GDPR Article 15 request", () => {
    expect(() => SubjectAccessRequestSchema.parse(baseRequest)).not.toThrow();
  });

  it("rejects deadlineAt beyond legal-basis maximum", () => {
    expect(() =>
      SubjectAccessRequestSchema.parse({
        ...baseRequest,
        deadlineAt: "2026-12-31T10:00:00.000Z",
      }),
    ).toThrow(/exceeds legal basis/);
  });

  it("rejects rejected without rejectedAt + reason", () => {
    expect(() =>
      SubjectAccessRequestSchema.parse({
        ...baseRequest,
        status: "rejected",
      }),
    ).toThrow(/rejected request requires/);
  });

  it("rejects deferred without deferredUntil + reason", () => {
    expect(() =>
      SubjectAccessRequestSchema.parse({
        ...baseRequest,
        status: "deferred",
      }),
    ).toThrow(/deferred request requires/);
  });

  it("rejects complete without bundle fields", () => {
    expect(() =>
      SubjectAccessRequestSchema.parse({
        ...baseRequest,
        status: "complete",
        completedAt: "2026-06-01T10:00:00.000Z",
      }),
    ).toThrow(/bundleSha256/);
  });

  it("rejects downloadCount > maxDownloads", () => {
    expect(() =>
      SubjectAccessRequestSchema.parse({
        ...baseRequest,
        downloadCount: 5,
        maxDownloads: 3,
      }),
    ).toThrow(/cannot exceed maxDownloads/);
  });
});

describe("isRequestOverdue", () => {
  it("returns true past deadline for in-progress request", () => {
    expect(isRequestOverdue(baseRequest, new Date("2026-07-01T00:00:00Z"))).toBe(true);
  });
  it("returns false within deadline", () => {
    expect(isRequestOverdue(baseRequest, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });
  it("returns false for completed request even past deadline", () => {
    expect(
      isRequestOverdue(
        {
          ...baseRequest,
          status: "complete",
          completedAt: "2026-05-25T00:00:00.000Z",
          bundleSha256: "a".repeat(64),
          bundleStorageUri: "s3://x",
          bundleEncryptionKeyFingerprint: "b".repeat(64),
        },
        new Date("2026-07-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("computeDeadline", () => {
  it("computes GDPR Article 15 deadline (+30 days)", () => {
    const d = computeDeadline(new Date("2026-05-16T10:00:00Z"), "gdpr_article_15");
    expect(d.startsWith("2026-06-15")).toBe(true);
  });
});

describe("isStrongIdentifier", () => {
  it("email is strong", () => {
    expect(isStrongIdentifier("email_address")).toBe(true);
  });
  it("ip_address is weak", () => {
    expect(isStrongIdentifier("ip_address")).toBe(false);
  });
});
