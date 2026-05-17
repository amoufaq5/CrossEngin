import { describe, expect, it } from "vitest";
import {
  PERMANENT_SUPPRESSION_REASONS,
  SUPPRESSION_REASONS,
  SuppressionRecordSchema,
  UserPreferenceMatrixSchema,
  computeDispatchEligibility,
  findActiveSuppression,
  isPreferenceOptedIn,
  isSuppressionActive,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "./preferences.js";

const baseMatrix: UserPreferenceMatrix = {
  userId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  entries: [
    {
      category: "transactional",
      channel: "email",
      optedIn: true,
      updatedAt: "2026-05-16T10:00:00.000Z",
      source: "default_policy",
    },
    {
      category: "marketing",
      channel: "email",
      optedIn: true,
      updatedAt: "2026-05-16T10:00:00.000Z",
      source: "user_set",
    },
  ],
  updatedAt: "2026-05-16T10:00:00.000Z",
};

const baseSuppression: SuppressionRecord = {
  id: "supp_abc12345",
  tenantId: "22222222-2222-2222-2222-222222222222",
  channel: "email",
  recipientAddress: "alice@acme.com",
  reason: "hard_bounce",
  appliedAt: "2026-05-16T10:00:00.000Z",
  appliedBy: null,
  expiresAt: null,
  sourceDeliveryId: null,
};

describe("constants", () => {
  it("has 7 suppression reasons", () => {
    expect(SUPPRESSION_REASONS).toHaveLength(7);
  });
  it("hard_bounce, spam_complaint, do_not_contact_register, regulatory_block are permanent", () => {
    expect(PERMANENT_SUPPRESSION_REASONS.has("hard_bounce")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("spam_complaint")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("regulatory_block")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("unsubscribe")).toBe(false);
  });
});

describe("UserPreferenceMatrixSchema", () => {
  it("accepts a valid matrix", () => {
    expect(() => UserPreferenceMatrixSchema.parse(baseMatrix)).not.toThrow();
  });

  it("rejects duplicate (category, channel) entries", () => {
    expect(() =>
      UserPreferenceMatrixSchema.parse({
        ...baseMatrix,
        entries: [...baseMatrix.entries, baseMatrix.entries[0]],
      }),
    ).toThrow(/duplicate matrix entry/);
  });

  it("rejects user opting out of transactional category", () => {
    expect(() =>
      UserPreferenceMatrixSchema.parse({
        ...baseMatrix,
        entries: [
          {
            category: "transactional",
            channel: "email",
            optedIn: false,
            updatedAt: "2026-05-16T10:00:00.000Z",
            source: "user_set",
          },
        ],
      }),
    ).toThrow(/cannot be opted-out by user/);
  });
});

describe("isPreferenceOptedIn", () => {
  it("returns explicit entry value when present", () => {
    expect(isPreferenceOptedIn(baseMatrix, "marketing", "email")).toBe(true);
  });

  it("defaults transactional to opt-in when no entry", () => {
    expect(isPreferenceOptedIn(baseMatrix, "transactional", "sms")).toBe(true);
  });

  it("defaults marketing to opt-out when no entry", () => {
    expect(isPreferenceOptedIn(baseMatrix, "marketing", "sms")).toBe(false);
  });
});

describe("SuppressionRecordSchema", () => {
  it("accepts a hard_bounce with null expiresAt (permanent)", () => {
    expect(() => SuppressionRecordSchema.parse(baseSuppression)).not.toThrow();
  });

  it("rejects permanent reason with non-null expiresAt", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        expiresAt: "2026-06-16T10:00:00.000Z",
      }),
    ).toThrow(/permanent reason; expiresAt must be null/);
  });

  it("rejects manual_block without appliedBy", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "manual_block",
      }),
    ).toThrow(/manual_block requires appliedBy/);
  });

  it("rejects expiresAt <= appliedAt", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "soft_bounce_exceeded",
        expiresAt: baseSuppression.appliedAt,
      }),
    ).toThrow(/expiresAt must be after appliedAt/);
  });
});

describe("isSuppressionActive", () => {
  it("returns true for permanent suppression", () => {
    expect(
      isSuppressionActive(baseSuppression, new Date("2050-01-01T00:00:00Z")),
    ).toBe(true);
  });

  it("returns true within expiry window", () => {
    expect(
      isSuppressionActive(
        {
          ...baseSuppression,
          reason: "soft_bounce_exceeded",
          expiresAt: "2026-06-16T10:00:00.000Z",
        },
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBe(true);
  });

  it("returns false past expiry", () => {
    expect(
      isSuppressionActive(
        {
          ...baseSuppression,
          reason: "soft_bounce_exceeded",
          expiresAt: "2026-06-16T10:00:00.000Z",
        },
        new Date("2026-07-01T10:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("findActiveSuppression", () => {
  it("matches by channel + address", () => {
    expect(
      findActiveSuppression(
        [baseSuppression],
        "email",
        "alice@acme.com",
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBeTruthy();
  });

  it("does not match different channel", () => {
    expect(
      findActiveSuppression(
        [baseSuppression],
        "sms",
        "alice@acme.com",
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("computeDispatchEligibility", () => {
  it("returns eligible when no suppression + opted in", () => {
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(true);
  });

  it("blocks marketing when hard_bounce suppression exists", () => {
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [baseSuppression],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("suppressed");
    expect(r.suppressionId).toBe("supp_abc12345");
  });

  it("allows transactional even when suppression exists (non-suppressible category)", () => {
    const r = computeDispatchEligibility({
      category: "transactional",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [baseSuppression],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(true);
  });

  it("blocks marketing when not opted in", () => {
    const noOptIn: UserPreferenceMatrix = {
      ...baseMatrix,
      entries: [
        {
          category: "marketing",
          channel: "email",
          optedIn: false,
          updatedAt: "2026-05-16T10:00:00.000Z",
          source: "user_set",
        },
      ],
    };
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: noOptIn,
      suppressions: [],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("not_opted_in");
  });
});
