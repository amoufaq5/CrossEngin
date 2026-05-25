import { describe, expect, it } from "vitest";
import {
  AccessReviewExceptionSchema,
  EXCEPTION_REASONS,
  EXCEPTION_STATUSES,
  MAX_EXCEPTION_DURATION_DAYS,
  RESTRICTED_EXCEPTION_REASONS,
  canTransitionException,
  daysRemainingOnException,
  isExceptionExpired,
  isRestrictedReason,
  requiresReattestation,
  type AccessReviewException,
} from "./exceptions.js";

const baseException: AccessReviewException = {
  id: "are_abc12345",
  itemId: "ari_abc12345",
  campaignId: "arc_q22026adm",
  tenantId: "11111111-1111-1111-1111-111111111111",
  status: "approved",
  reason: "system_account_required",
  justification:
    "Service account needs continued admin access to run nightly imports per ADR-0028.",
  requestedAt: "2026-04-15T10:00:00.000Z",
  requestedByUserId: "22222222-2222-2222-2222-222222222222",
  requestedExpiresAt: "2026-10-15T10:00:00.000Z",
  approvedAt: "2026-04-16T10:00:00.000Z",
  approvedByUserId: "33333333-3333-3333-3333-333333333333",
  approvedJustification: "Approved by CISO for nightly imports.",
  grantedExpiresAt: "2026-10-15T10:00:00.000Z",
  rejectedAt: null,
  rejectedByUserId: null,
  rejectedReason: null,
  expiredAt: null,
  revokedEarlyAt: null,
  revokedEarlyByUserId: null,
  revokedEarlyReason: null,
  supersededByExceptionId: null,
  notificationCount: 0,
  lastNotificationAt: null,
  requiresQuarterlyReattestation: false,
  lastReattestedAt: null,
};

describe("constants", () => {
  it("has 6 exception statuses", () => {
    expect(EXCEPTION_STATUSES).toHaveLength(6);
  });
  it("has 8 exception reasons", () => {
    expect(EXCEPTION_REASONS).toHaveLength(8);
  });
  it("emergency_break_glass + regulatory_exemption are restricted", () => {
    expect(RESTRICTED_EXCEPTION_REASONS.has("emergency_break_glass")).toBe(true);
    expect(RESTRICTED_EXCEPTION_REASONS.has("regulatory_exemption")).toBe(true);
  });
  it("emergency_break_glass max duration is 7 days", () => {
    expect(MAX_EXCEPTION_DURATION_DAYS.emergency_break_glass).toBe(7);
  });
  it("vendor_support_requirement max duration is 30 days", () => {
    expect(MAX_EXCEPTION_DURATION_DAYS.vendor_support_requirement).toBe(30);
  });
});

describe("canTransitionException", () => {
  it("allows requested → approved", () => {
    expect(canTransitionException("requested", "approved")).toBe(true);
  });
  it("blocks rejected → approved (terminal)", () => {
    expect(canTransitionException("rejected", "approved")).toBe(false);
  });
  it("allows approved → revoked_early", () => {
    expect(canTransitionException("approved", "revoked_early")).toBe(true);
  });
});

describe("AccessReviewExceptionSchema", () => {
  it("accepts a valid approved exception", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse(baseException),
    ).not.toThrow();
  });

  it("rejects requestedExpiresAt <= requestedAt", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        requestedExpiresAt: baseException.requestedAt,
      }),
    ).toThrow(/must be after requestedAt/);
  });

  it("rejects exception exceeding reason's max duration (emergency = 7 days)", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        reason: "emergency_break_glass",
        requestedExpiresAt: "2026-12-31T00:00:00.000Z",
        requiresQuarterlyReattestation: true,
      }),
    ).toThrow(/caps exception at 7 days/);
  });

  it("rejects four-eyes violation (requester === approver)", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        approvedByUserId: baseException.requestedByUserId,
      }),
    ).toThrow(/approver must differ from requester/);
  });

  it("rejects approved without grantedExpiresAt", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        grantedExpiresAt: null,
      }),
    ).toThrow(/requires grantedExpiresAt/);
  });

  it("rejects rejected without rejectedReason", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        status: "rejected",
        approvedAt: null,
        approvedByUserId: null,
        approvedJustification: null,
        grantedExpiresAt: null,
        rejectedAt: "2026-04-16T10:00:00.000Z",
        rejectedByUserId: "33333333-3333-3333-3333-333333333333",
      }),
    ).toThrow(/rejected exception requires/);
  });

  it("rejects emergency_break_glass without quarterly reattestation", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        reason: "emergency_break_glass",
        requestedExpiresAt: "2026-04-20T10:00:00.000Z",
        grantedExpiresAt: "2026-04-20T10:00:00.000Z",
        requiresQuarterlyReattestation: false,
      }),
    ).toThrow(/quarterly re-attestation/);
  });

  it("rejects grantedExpiresAt <= approvedAt", () => {
    expect(() =>
      AccessReviewExceptionSchema.parse({
        ...baseException,
        grantedExpiresAt: baseException.approvedAt,
      }),
    ).toThrow(/grantedExpiresAt must be after approvedAt/);
  });
});

describe("isExceptionExpired", () => {
  it("returns false before grantedExpiresAt", () => {
    expect(
      isExceptionExpired(baseException, new Date("2026-05-01T00:00:00Z")),
    ).toBe(false);
  });
  it("returns true past grantedExpiresAt", () => {
    expect(
      isExceptionExpired(baseException, new Date("2026-11-01T00:00:00Z")),
    ).toBe(true);
  });
  it("returns false for non-approved status", () => {
    expect(
      isExceptionExpired(
        { ...baseException, status: "rejected" },
        new Date("2026-11-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("daysRemainingOnException", () => {
  it("returns days left for approved exception", () => {
    const r = daysRemainingOnException(
      baseException,
      new Date("2026-05-15T10:00:00Z"),
    );
    expect(r).toBeGreaterThan(150);
  });
  it("returns 0 past expiry", () => {
    expect(
      daysRemainingOnException(baseException, new Date("2027-01-01T00:00:00Z")),
    ).toBe(0);
  });
  it("returns null for non-approved", () => {
    expect(
      daysRemainingOnException(
        { ...baseException, status: "rejected" },
        new Date("2026-05-15T10:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("requiresReattestation", () => {
  it("returns false when not configured", () => {
    expect(
      requiresReattestation(baseException, new Date("2026-05-15T10:00:00Z")),
    ).toBe(false);
  });
  it("returns true on first check when configured", () => {
    expect(
      requiresReattestation(
        { ...baseException, requiresQuarterlyReattestation: true },
        new Date("2026-05-15T10:00:00Z"),
      ),
    ).toBe(true);
  });
  it("returns false within reattestation interval", () => {
    expect(
      requiresReattestation(
        {
          ...baseException,
          requiresQuarterlyReattestation: true,
          lastReattestedAt: "2026-05-01T00:00:00.000Z",
        },
        new Date("2026-05-15T10:00:00Z"),
      ),
    ).toBe(false);
  });
  it("returns true past reattestation interval", () => {
    expect(
      requiresReattestation(
        {
          ...baseException,
          requiresQuarterlyReattestation: true,
          lastReattestedAt: "2026-01-01T00:00:00.000Z",
        },
        new Date("2026-05-15T10:00:00Z"),
      ),
    ).toBe(true);
  });
});

describe("isRestrictedReason", () => {
  it("emergency_break_glass is restricted", () => {
    expect(isRestrictedReason("emergency_break_glass")).toBe(true);
  });
  it("system_account_required is not restricted", () => {
    expect(isRestrictedReason("system_account_required")).toBe(false);
  });
});
