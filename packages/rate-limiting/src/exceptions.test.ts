import { describe, expect, it } from "vitest";
import {
  EXCEPTION_KINDS,
  EXCEPTION_STATUSES,
  EXCEPTION_TRANSITIONS,
  MAX_EXCEPTION_DURATION_HOURS,
  RateLimitExceptionSchema,
  applyException,
  canTransitionException,
  findActiveException,
  isExceptionActive,
  type RateLimitException,
} from "./exceptions.js";

const baseException: RateLimitException = {
  id: "rle_burst0001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  policyId: "rlp_apistd001",
  scopeKey: "tenant:11111111-1111-1111-1111-111111111111",
  kind: "tenant_burst_allowance",
  status: "active",
  multiplier: 2,
  additiveBurst: 100,
  justification: "Black Friday traffic spike — pre-approved with finance team for 7 days.",
  requestedAt: "2026-11-20T10:00:00.000Z",
  requestedBy: "22222222-2222-2222-2222-222222222222",
  approvedAt: "2026-11-20T11:00:00.000Z",
  approvedBy: "33333333-3333-3333-3333-333333333333",
  rejectedAt: null,
  rejectedBy: null,
  rejectedReason: null,
  activatedAt: "2026-11-25T00:00:00.000Z",
  expiresAt: "2026-11-26T00:00:00.000Z",
  revokedEarlyAt: null,
  revokedEarlyBy: null,
  revokedEarlyReason: null,
  relatedIncidentId: null,
};

describe("constants", () => {
  it("has 6 exception kinds", () => {
    expect(EXCEPTION_KINDS).toHaveLength(6);
  });
  it("has 6 exception statuses", () => {
    expect(EXCEPTION_STATUSES).toHaveLength(6);
  });
  it("incident_response_bypass max 24 hours", () => {
    expect(MAX_EXCEPTION_DURATION_HOURS.incident_response_bypass).toBe(24);
  });
  it("compliance_override max 90 days", () => {
    expect(MAX_EXCEPTION_DURATION_HOURS.compliance_override).toBe(24 * 90);
  });
});

describe("canTransitionException", () => {
  it("allows approved → active", () => {
    expect(canTransitionException("approved", "active")).toBe(true);
  });
  it("blocks expired → active (no resurrection)", () => {
    expect(canTransitionException("expired", "active")).toBe(false);
  });
  it("expired is terminal", () => {
    expect(EXCEPTION_TRANSITIONS.expired).toEqual([]);
  });
});

describe("RateLimitExceptionSchema", () => {
  it("accepts a valid active exception", () => {
    expect(() => RateLimitExceptionSchema.parse(baseException)).not.toThrow();
  });

  it("rejects expiresAt <= requestedAt", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        expiresAt: baseException.requestedAt,
      }),
    ).toThrow(/expiresAt must be after requestedAt/);
  });

  it("rejects exception exceeding kind cap (load_test_temporary = 8 hours)", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        kind: "load_test_temporary",
        requestedAt: "2026-05-16T10:00:00.000Z",
        expiresAt: "2026-05-30T10:00:00.000Z",
      }),
    ).toThrow(/caps exception at 8 hours/);
  });

  it("enforces four-eyes (approvedBy ≠ requestedBy)", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        approvedBy: baseException.requestedBy,
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects multiplier < 1 without additiveBurst", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        multiplier: 0.5,
        additiveBurst: 0,
      }),
    ).toThrow(/tightens, not loosens/);
  });

  it("rejects approved without approvedAt + approvedBy", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        status: "approved",
        approvedAt: null,
        approvedBy: null,
      }),
    ).toThrow(/approved exception requires/);
  });

  it("rejects rejected without rejectedReason", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        status: "rejected",
        approvedAt: null,
        approvedBy: null,
        rejectedAt: "2026-11-20T11:30:00.000Z",
        rejectedBy: "33333333-3333-3333-3333-333333333333",
      }),
    ).toThrow(/rejected exception requires/);
  });

  it("rejects incident_response_bypass without relatedIncidentId", () => {
    expect(() =>
      RateLimitExceptionSchema.parse({
        ...baseException,
        kind: "incident_response_bypass",
        requestedAt: "2026-05-16T10:00:00.000Z",
        expiresAt: "2026-05-16T22:00:00.000Z",
      }),
    ).toThrow(/relatedIncidentId/);
  });
});

describe("isExceptionActive", () => {
  it("returns true for active within expiry", () => {
    expect(isExceptionActive(baseException, new Date("2026-11-25T12:00:00Z"))).toBe(true);
  });
  it("returns false past expiry", () => {
    expect(isExceptionActive(baseException, new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });
});

describe("applyException", () => {
  it("multiplier × base + additive", () => {
    expect(applyException(100, baseException)).toBe(300);
  });
  it("multiplier < 1 with additive yields capped tighter limit", () => {
    expect(applyException(100, { ...baseException, multiplier: 0.5, additiveBurst: 10 })).toBe(60);
  });
});

describe("findActiveException", () => {
  it("returns matching active exception", () => {
    const r = findActiveException(
      [baseException],
      baseException.policyId,
      baseException.scopeKey,
      new Date("2026-11-25T12:00:00Z"),
    );
    expect(r).not.toBeNull();
  });
  it("returns null on policy mismatch", () => {
    const r = findActiveException(
      [baseException],
      "rlp_other0001",
      baseException.scopeKey,
      new Date("2026-11-25T12:00:00Z"),
    );
    expect(r).toBeNull();
  });
});
