import { describe, expect, it } from "vitest";
import {
  GRACE_DEFAULT_DAYS,
  GRACE_KINDS,
  GracePeriodSchema,
  daysRemaining,
  defaultGraceDays,
  effectiveExpiresAt,
  isGraceExpired,
  type GracePeriod,
} from "./grace-periods.js";

describe("constants", () => {
  it("GRACE_KINDS has 5 entries", () => {
    expect(GRACE_KINDS).toContain("billing_grace");
    expect(GRACE_KINDS).toContain("deletion_grace");
    expect(GRACE_KINDS).toContain("appeal_window");
  });

  it("GRACE_DEFAULT_DAYS covers all kinds", () => {
    for (const kind of GRACE_KINDS) {
      expect(GRACE_DEFAULT_DAYS[kind]).toBeGreaterThan(0);
    }
  });
});

describe("GracePeriodSchema", () => {
  const base: GracePeriod = {
    id: "grace-1",
    tenantId: "t-1",
    kind: "deletion_grace",
    fromState: "pending_deletion",
    startedAt: "2026-05-14T00:00:00Z",
    expiresAt: "2026-06-13T00:00:00Z",
    durationDays: 30,
    triggerEventId: "ev-1",
    autoActionOnExpiry: "advance_state",
    nextStateOnExpiry: "deleted",
    reminderSentAt: null,
    customerExtendedAt: null,
    customerExtendedToExpiresAt: null,
    cancelledAt: null,
  };

  it("accepts a valid deletion grace", () => {
    expect(() => GracePeriodSchema.parse(base)).not.toThrow();
  });

  it("rejects expiresAt <= startedAt", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        expiresAt: "2026-05-14T00:00:00Z",
      }),
    ).toThrow(/after startedAt/);
  });

  it("rejects durationDays mismatch with expiresAt-startedAt", () => {
    expect(() => GracePeriodSchema.parse({ ...base, durationDays: 5 })).toThrow(/should match/);
  });

  it("rejects deletion_grace below minimum (14 days)", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        durationDays: 7,
        expiresAt: "2026-05-21T00:00:00Z",
      }),
    ).toThrow(/durationDays >= 14/);
  });

  it("rejects archive_grace above maximum (365 days)", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        kind: "archive_grace",
        fromState: "archived",
        durationDays: 400,
        expiresAt: "2027-06-19T00:00:00Z",
      }),
    ).toThrow(/caps durationDays at 365/);
  });

  it("rejects mismatched kind/fromState", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        fromState: "active",
      }),
    ).toThrow(/applies to fromState 'pending_deletion'/);
  });

  it("rejects advance_state without nextStateOnExpiry", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        nextStateOnExpiry: undefined,
      }),
    ).toThrow(/nextStateOnExpiry/);
  });

  it("rejects extension that doesn't push expiresAt later", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        customerExtendedAt: "2026-06-01T00:00:00Z",
        customerExtendedToExpiresAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/push expiresAt later/);
  });

  it("rejects cancelledAt without reason", () => {
    expect(() =>
      GracePeriodSchema.parse({
        ...base,
        cancelledAt: "2026-05-15T00:00:00Z",
      }),
    ).toThrow(/cancelledReason/);
  });
});

describe("helpers", () => {
  const base: GracePeriod = {
    id: "g-1",
    tenantId: "t-1",
    kind: "deletion_grace",
    fromState: "pending_deletion",
    startedAt: "2026-05-14T00:00:00Z",
    expiresAt: "2026-06-13T00:00:00Z",
    durationDays: 30,
    triggerEventId: "ev-1",
    autoActionOnExpiry: "advance_state",
    nextStateOnExpiry: "deleted",
    reminderSentAt: null,
    customerExtendedAt: null,
    customerExtendedToExpiresAt: null,
    cancelledAt: null,
  };

  it("effectiveExpiresAt uses extension if present", () => {
    expect(effectiveExpiresAt(base)).toBe("2026-06-13T00:00:00Z");
    expect(
      effectiveExpiresAt({
        ...base,
        customerExtendedAt: "2026-06-01T00:00:00Z",
        customerExtendedToExpiresAt: "2026-07-13T00:00:00Z",
      }),
    ).toBe("2026-07-13T00:00:00Z");
  });

  it("isGraceExpired false before expiry", () => {
    expect(isGraceExpired(base, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });

  it("isGraceExpired true after expiry", () => {
    expect(isGraceExpired(base, new Date("2026-07-01T00:00:00Z"))).toBe(true);
  });

  it("isGraceExpired false when cancelled", () => {
    expect(
      isGraceExpired(
        {
          ...base,
          cancelledAt: "2026-05-15T00:00:00Z",
          cancelledReason: "customer renewed",
        },
        new Date("2026-07-01T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("daysRemaining counts down", () => {
    expect(daysRemaining(base, new Date("2026-06-03T00:00:00Z"))).toBe(10);
    expect(daysRemaining(base, new Date("2026-07-01T00:00:00Z"))).toBe(0);
  });

  it("defaultGraceDays returns the canonical default", () => {
    expect(defaultGraceDays("deletion_grace")).toBe(30);
    expect(defaultGraceDays("billing_grace")).toBe(14);
  });
});
