import { describe, expect, it } from "vitest";
import {
  DELETION_REQUEST_STATUSES,
  GDPR_LEGAL_BASES,
  GdprDeletionRequestSchema,
  RETENTION_OBLIGATIONS,
  canTransitionDeletionRequest,
  daysUntilDeadline,
  hasRetainedData,
  isOverdue,
  type GdprDeletionRequest,
} from "./gdpr-deletion.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("GDPR_LEGAL_BASES has 6 entries", () => {
    expect(GDPR_LEGAL_BASES).toContain("article_17_right_to_erasure");
    expect(GDPR_LEGAL_BASES).toContain("consent_withdrawn");
  });

  it("RETENTION_OBLIGATIONS covers tax/medical/audit/financial/aml/none", () => {
    expect(RETENTION_OBLIGATIONS).toContain("tax_records_7y");
    expect(RETENTION_OBLIGATIONS).toContain("medical_records_10y");
    expect(RETENTION_OBLIGATIONS).toContain("none");
  });

  it("DELETION_REQUEST_STATUSES has 6 entries", () => {
    expect(DELETION_REQUEST_STATUSES).toContain("verified");
    expect(DELETION_REQUEST_STATUSES).toContain("deferred");
  });
});

describe("canTransitionDeletionRequest", () => {
  it("submitted -> verified", () => {
    expect(canTransitionDeletionRequest("submitted", "verified")).toBe(true);
  });

  it("verified -> in_progress", () => {
    expect(canTransitionDeletionRequest("verified", "in_progress")).toBe(true);
  });

  it("in_progress -> completed", () => {
    expect(canTransitionDeletionRequest("in_progress", "completed")).toBe(true);
  });

  it("completed is terminal", () => {
    expect(canTransitionDeletionRequest("completed", "in_progress")).toBe(false);
  });

  it("deferred can resume", () => {
    expect(canTransitionDeletionRequest("deferred", "in_progress")).toBe(true);
  });
});

describe("GdprDeletionRequestSchema", () => {
  const base: GdprDeletionRequest = {
    id: "del-1",
    tenantId: "t-1",
    subjectIdentifier: "user@example.com",
    legalBasis: "article_17_right_to_erasure",
    status: "completed",
    submittedAt: "2026-05-01T00:00:00Z",
    submittedBy: "user@example.com",
    deadlineAt: "2026-05-31T00:00:00Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-05-02T00:00:00Z",
    verifiedBy: "support-1",
    inProgressAt: "2026-05-03T00:00:00Z",
    completedAt: "2026-05-15T00:00:00Z",
    completionSha256: SHA,
    rejectedAt: null,
    deferredUntil: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
  };

  it("accepts a valid completed request", () => {
    expect(() => GdprDeletionRequestSchema.parse(base)).not.toThrow();
  });

  it("rejects deadline > 3 months after submission", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        deadlineAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow(/Article 12\(3\) caps deadlineAt at 3 months/);
  });

  it("rejects deadline <= submission", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        deadlineAt: "2026-05-01T00:00:00Z",
      }),
    ).toThrow(/after submittedAt/);
  });

  it("rejects completed without completionSha256", () => {
    expect(() => GdprDeletionRequestSchema.parse({ ...base, completionSha256: null })).toThrow(
      /completionSha256/,
    );
  });

  it("rejects completion after deadline", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        completedAt: "2026-07-01T00:00:00Z",
      }),
    ).toThrow(/missed Article 12\(3\) deadline/);
  });

  it("rejects verified without verifiedBy", () => {
    expect(() => GdprDeletionRequestSchema.parse({ ...base, verifiedBy: null })).toThrow(
      /verifiedBy/,
    );
  });

  it("rejects rejected without rejectedReason", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        status: "rejected",
        rejectedAt: "2026-05-10T00:00:00Z",
        completionSha256: null,
        completedAt: null,
      }),
    ).toThrow(/rejectedReason/);
  });

  it("rejects deferred without deferredUntil + reason", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        status: "deferred",
        completionSha256: null,
        completedAt: null,
      }),
    ).toThrow(/deferredUntil/);
  });

  it("rejects retention obligation without retained data categories", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retentionObligations: ["tax_records_7y"],
        retainedDataCategories: [],
      }),
    ).toThrow(/must list retainedDataCategories/);
  });

  it("rejects retained categories without an obligation", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retainedDataCategories: ["billing_records"],
      }),
    ).toThrow(/without a stated obligation/);
  });

  it("rejects duplicate retention obligations", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retentionObligations: ["tax_records_7y", "tax_records_7y"],
        retainedDataCategories: ["billing"],
      }),
    ).toThrow(/duplicate obligation/);
  });
});

describe("helpers", () => {
  const base: GdprDeletionRequest = {
    id: "x",
    tenantId: "t-1",
    subjectIdentifier: "user@example.com",
    legalBasis: "article_17_right_to_erasure",
    status: "in_progress",
    submittedAt: "2026-05-01T00:00:00Z",
    submittedBy: "user@example.com",
    deadlineAt: "2026-05-31T00:00:00Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-05-02T00:00:00Z",
    verifiedBy: "support-1",
    inProgressAt: "2026-05-03T00:00:00Z",
    completedAt: null,
    completionSha256: null,
    rejectedAt: null,
    deferredUntil: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
  };

  it("isOverdue true after deadline if not completed", () => {
    expect(isOverdue(base, new Date("2026-06-15T00:00:00Z"))).toBe(true);
  });

  it("isOverdue false if completed", () => {
    expect(
      isOverdue(
        {
          ...base,
          status: "completed",
          completedAt: "2026-05-20T00:00:00Z",
          completionSha256: SHA,
        },
        new Date("2026-06-15T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("daysUntilDeadline counts down", () => {
    expect(daysUntilDeadline(base, new Date("2026-05-21T00:00:00Z"))).toBe(10);
  });

  it("hasRetainedData reflects retainedDataCategories", () => {
    expect(hasRetainedData(base)).toBe(false);
    expect(
      hasRetainedData({
        ...base,
        retentionObligations: ["tax_records_7y"],
        retainedDataCategories: ["billing"],
      }),
    ).toBe(true);
  });
});
