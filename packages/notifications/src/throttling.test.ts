import { describe, expect, it } from "vitest";
import {
  DIGEST_FREQUENCIES,
  DIGEST_STATUSES,
  DIGEST_TRANSITIONS,
  DigestBatchSchema,
  TERMINAL_DIGEST_STATUSES,
  canTransitionDigest,
  QUIET_HOURS_BEHAVIORS,
  QuietHoursConfigSchema,
  RateLimitPolicySchema,
  countRecentDeliveries,
  decideQuietHoursAction,
  evaluateRateLimit,
  isWithinQuietHours,
  type DigestBatch,
  type QuietHoursConfig,
  type RateLimitPolicy,
} from "./throttling.js";
import type { DeliveryAttempt } from "./delivery.js";

const baseQuietHours: QuietHoursConfig = {
  startTime: "22:00",
  endTime: "07:00",
  timezone: "America/Los_Angeles",
  behavior: "defer_to_morning",
  bypassCategories: ["security_alert"],
};

const baseRateLimit: RateLimitPolicy = {
  id: "rlp_email-std",
  tenantId: null,
  channel: "email",
  perRecipientPerHour: 10,
  perRecipientPerDay: 50,
  perTenantPerSecond: 100,
  burstAllowance: 20,
  appliesToCategories: ["marketing", "operational_digest"],
  overrideForPriorities: ["critical"],
};

const baseDigest: DigestBatch = {
  id: "dgst_abc12345",
  tenantId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  channel: "email",
  frequency: "daily",
  status: "open",
  openedAt: "2026-05-16T08:00:00.000Z",
  scheduledDispatchAt: "2026-05-17T08:00:00.000Z",
  assembledAt: null,
  dispatchedAt: null,
  itemCount: 5,
  maxItems: 100,
  dedupSha256: null,
};

describe("constants", () => {
  it("has 6 digest frequencies", () => {
    expect(DIGEST_FREQUENCIES).toHaveLength(6);
  });
  it("has 4 quiet hours behaviors", () => {
    expect(QUIET_HOURS_BEHAVIORS).toHaveLength(4);
  });
  it("has 5 digest statuses", () => {
    expect(DIGEST_STATUSES).toHaveLength(5);
  });
});

describe("QuietHoursConfigSchema", () => {
  it("accepts a 22:00 → 07:00 (overnight) configuration", () => {
    expect(() => QuietHoursConfigSchema.parse(baseQuietHours)).not.toThrow();
  });

  it("rejects start == end", () => {
    expect(() =>
      QuietHoursConfigSchema.parse({
        ...baseQuietHours,
        startTime: "08:00",
        endTime: "08:00",
      }),
    ).toThrow(/startTime and endTime must differ/);
  });

  it("rejects marketing in bypassCategories", () => {
    expect(() =>
      QuietHoursConfigSchema.parse({
        ...baseQuietHours,
        bypassCategories: ["marketing"],
      }),
    ).toThrow(/marketing cannot bypass/);
  });
});

describe("isWithinQuietHours", () => {
  it("returns true at 23:00 with 22:00-07:00 overnight quiet hours", () => {
    expect(isWithinQuietHours(baseQuietHours, 23 * 60)).toBe(true);
  });

  it("returns true at 06:00 (still in quiet hours)", () => {
    expect(isWithinQuietHours(baseQuietHours, 6 * 60)).toBe(true);
  });

  it("returns false at 12:00 (outside quiet hours)", () => {
    expect(isWithinQuietHours(baseQuietHours, 12 * 60)).toBe(false);
  });

  it("handles daytime quiet hours (09:00 → 17:00)", () => {
    const config: QuietHoursConfig = {
      ...baseQuietHours,
      startTime: "09:00",
      endTime: "17:00",
    };
    expect(isWithinQuietHours(config, 10 * 60)).toBe(true);
    expect(isWithinQuietHours(config, 20 * 60)).toBe(false);
  });
});

describe("decideQuietHoursAction", () => {
  it("sends immediately when no quiet hours configured", () => {
    const r = decideQuietHoursAction({
      config: null,
      category: "marketing",
      priority: "normal",
      localMinutesSinceMidnight: 23 * 60,
    });
    expect(r.action).toBe("send_now");
  });

  it("sends immediately when outside quiet hours", () => {
    const r = decideQuietHoursAction({
      config: baseQuietHours,
      category: "marketing",
      priority: "normal",
      localMinutesSinceMidnight: 12 * 60,
    });
    expect(r.action).toBe("send_now");
  });

  it("sends immediately when category bypasses", () => {
    const r = decideQuietHoursAction({
      config: baseQuietHours,
      category: "security_alert",
      priority: "normal",
      localMinutesSinceMidnight: 23 * 60,
    });
    expect(r.action).toBe("send_now");
    expect(r.reason).toContain("category_bypasses");
  });

  it("sends critical priority even inside quiet hours", () => {
    const r = decideQuietHoursAction({
      config: baseQuietHours,
      category: "marketing",
      priority: "critical",
      localMinutesSinceMidnight: 23 * 60,
    });
    expect(r.action).toBe("send_now");
    expect(r.reason).toContain("critical_priority_bypasses");
  });

  it("defers when behavior is defer_to_morning", () => {
    const r = decideQuietHoursAction({
      config: baseQuietHours,
      category: "marketing",
      priority: "normal",
      localMinutesSinceMidnight: 23 * 60,
    });
    expect(r.action).toBe("defer");
  });

  it("batches when behavior is batch_until_morning", () => {
    const r = decideQuietHoursAction({
      config: { ...baseQuietHours, behavior: "batch_until_morning" },
      category: "operational_digest",
      priority: "normal",
      localMinutesSinceMidnight: 23 * 60,
    });
    expect(r.action).toBe("batch");
  });
});

describe("RateLimitPolicySchema", () => {
  it("accepts a valid policy", () => {
    expect(() => RateLimitPolicySchema.parse(baseRateLimit)).not.toThrow();
  });

  it("rejects perDay < perHour", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...baseRateLimit,
        perRecipientPerHour: 100,
        perRecipientPerDay: 50,
      }),
    ).toThrow(/perRecipientPerDay must be >= perRecipientPerHour/);
  });
});

describe("evaluateRateLimit", () => {
  it("allows critical priority even when over quota", () => {
    const r = evaluateRateLimit({
      policy: baseRateLimit,
      priority: "critical",
      hourlyCount: 999,
      dailyCount: 999,
      tenantPerSecondCount: 999,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks when hourly quota exceeded", () => {
    const r = evaluateRateLimit({
      policy: baseRateLimit,
      priority: "normal",
      hourlyCount: 10,
      dailyCount: 20,
      tenantPerSecondCount: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("hourly_quota_exceeded");
  });

  it("blocks when daily quota exceeded", () => {
    const r = evaluateRateLimit({
      policy: baseRateLimit,
      priority: "normal",
      hourlyCount: 0,
      dailyCount: 50,
      tenantPerSecondCount: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("daily_quota_exceeded");
  });

  it("blocks when tenant RPS exceeded", () => {
    const r = evaluateRateLimit({
      policy: baseRateLimit,
      priority: "normal",
      hourlyCount: 0,
      dailyCount: 0,
      tenantPerSecondCount: 100,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("tenant_rps_exceeded");
  });

  it("allows when within all limits", () => {
    const r = evaluateRateLimit({
      policy: baseRateLimit,
      priority: "normal",
      hourlyCount: 1,
      dailyCount: 5,
      tenantPerSecondCount: 1,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("countRecentDeliveries", () => {
  const baseAttempt: DeliveryAttempt = {
    id: "dlv_abc11111",
    dispatchId: "disp_abc12345",
    tenantId: "11111111-1111-1111-1111-111111111111",
    channel: "email",
    provider: "sendgrid",
    recipientAddressSha256: "c".repeat(64),
    attemptKind: "initial",
    attemptNumber: 1,
    queuedAt: "2026-05-16T09:55:00.000Z",
    sentAt: "2026-05-16T09:55:01.000Z",
    finalizedAt: "2026-05-16T09:55:01.500Z",
    latencyMs: 500,
    outcome: "delivered",
    providerMessageId: "x",
    httpStatus: 202,
    bytesSent: 100,
    smsSegments: null,
    errorCode: null,
    errorMessage: null,
    nextRetryAt: null,
  };

  it("counts attempts within window", () => {
    const count = countRecentDeliveries(
      [baseAttempt],
      "c".repeat(64),
      "email",
      new Date("2026-05-16T09:00:00Z"),
      new Date("2026-05-16T10:00:00Z"),
    );
    expect(count).toBe(1);
  });

  it("skips suppressed and rate_limited outcomes", () => {
    const count = countRecentDeliveries(
      [{ ...baseAttempt, outcome: "suppressed" }],
      "c".repeat(64),
      "email",
      new Date("2026-05-16T09:00:00Z"),
      new Date("2026-05-16T10:00:00Z"),
    );
    expect(count).toBe(0);
  });

  it("excludes outside window", () => {
    const count = countRecentDeliveries(
      [baseAttempt],
      "c".repeat(64),
      "email",
      new Date("2026-05-16T11:00:00Z"),
      new Date("2026-05-16T12:00:00Z"),
    );
    expect(count).toBe(0);
  });
});

describe("DigestBatchSchema", () => {
  it("accepts a daily digest", () => {
    expect(() => DigestBatchSchema.parse(baseDigest)).not.toThrow();
  });

  it("rejects itemCount > maxItems", () => {
    expect(() =>
      DigestBatchSchema.parse({ ...baseDigest, itemCount: 200, maxItems: 100 }),
    ).toThrow(/exceeds maxItems/);
  });

  it("rejects scheduledDispatchAt <= openedAt", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...baseDigest,
        scheduledDispatchAt: baseDigest.openedAt,
      }),
    ).toThrow(/must be after openedAt/);
  });

  it("rejects dispatched status without dispatchedAt", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...baseDigest,
        status: "dispatched",
      }),
    ).toThrow(/dispatched digest requires dispatchedAt/);
  });
});

describe("DIGEST_TRANSITIONS", () => {
  it("covers every status", () => {
    for (const status of DIGEST_STATUSES) {
      expect(DIGEST_TRANSITIONS[status]).toBeDefined();
    }
  });
  it("never names a status outside the enum", () => {
    for (const status of DIGEST_STATUSES) {
      for (const to of DIGEST_TRANSITIONS[status]) {
        expect(DIGEST_STATUSES).toContain(to);
      }
    }
  });
  it("allows the assembler to close an open pool directly", () => {
    expect(canTransitionDigest("open", "assembled")).toBe(true);
  });
  it("allows the queued path too", () => {
    expect(canTransitionDigest("open", "queued_for_assembly")).toBe(true);
    expect(canTransitionDigest("queued_for_assembly", "assembled")).toBe(true);
  });
  it("only dispatches from assembled", () => {
    expect(canTransitionDigest("assembled", "dispatched")).toBe(true);
    expect(canTransitionDigest("open", "dispatched")).toBe(false);
    expect(canTransitionDigest("queued_for_assembly", "dispatched")).toBe(false);
  });
  it("lets any pending status expire", () => {
    for (const status of ["open", "queued_for_assembly", "assembled"] as const) {
      expect(canTransitionDigest(status, "expired")).toBe(true);
    }
  });
  it("never moves backwards", () => {
    expect(canTransitionDigest("assembled", "open")).toBe(false);
    expect(canTransitionDigest("dispatched", "assembled")).toBe(false);
  });
  it("agrees with TERMINAL_DIGEST_STATUSES", () => {
    for (const status of DIGEST_STATUSES) {
      const hasSuccessors = DIGEST_STATUSES.some((to) =>
        canTransitionDigest(status, to),
      );
      expect(TERMINAL_DIGEST_STATUSES.has(status)).toBe(!hasSuccessors);
    }
  });
  it("names dispatched and expired as the terminal pair", () => {
    expect([...TERMINAL_DIGEST_STATUSES].sort()).toEqual(["dispatched", "expired"]);
  });
});

describe("DigestBatchSchema — assembledAt / dispatchedAt pairing", () => {
  const assembled = {
    ...baseDigest,
    status: "assembled" as const,
    assembledAt: "2026-05-17T08:00:01.000Z",
  };
  const dispatched = {
    ...assembled,
    status: "dispatched" as const,
    dispatchedAt: "2026-05-17T08:00:05.000Z",
  };

  it("accepts an assembled pool that names when it was assembled", () => {
    expect(() => DigestBatchSchema.parse(assembled)).not.toThrow();
  });
  it("accepts a dispatched pool carrying both instants in order", () => {
    expect(() => DigestBatchSchema.parse(dispatched)).not.toThrow();
  });
  it("rejects an assembled pool with no assembledAt", () => {
    expect(() =>
      DigestBatchSchema.parse({ ...assembled, assembledAt: null }),
    ).toThrow(/digest in status assembled requires assembledAt/);
  });
  it("rejects a dispatched pool with no assembledAt — it cannot have been sent unbuilt", () => {
    expect(() =>
      DigestBatchSchema.parse({ ...dispatched, assembledAt: null }),
    ).toThrow(/digest in status dispatched requires assembledAt/);
  });
  it("rejects an open pool that claims to have been dispatched", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...baseDigest,
        dispatchedAt: "2026-05-17T08:00:05.000Z",
      }),
    ).toThrow(/must not have dispatchedAt/);
  });
  it("rejects an assembled pool that claims to have been dispatched", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...assembled,
        dispatchedAt: "2026-05-17T08:00:05.000Z",
      }),
    ).toThrow(/must not have dispatchedAt/);
  });
  it("rejects an open or queued pool that claims to have been assembled", () => {
    for (const status of ["open", "queued_for_assembly"] as const) {
      expect(() =>
        DigestBatchSchema.parse({
          ...baseDigest,
          status,
          assembledAt: "2026-05-17T08:00:01.000Z",
        }),
      ).toThrow(/must not have assembledAt/);
    }
  });
  it("rejects assembledAt before the pool was opened", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...assembled,
        assembledAt: "2026-05-16T07:00:00.000Z",
      }),
    ).toThrow(/assembledAt cannot precede openedAt/);
  });
  it("rejects dispatchedAt before assembledAt", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...dispatched,
        dispatchedAt: "2026-05-17T08:00:00.000Z",
      }),
    ).toThrow(/dispatchedAt cannot precede assembledAt/);
  });
  it("accepts the two instants being equal", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...dispatched,
        dispatchedAt: dispatched.assembledAt,
      }),
    ).not.toThrow();
  });
  it("accepts an expired pool that was never assembled", () => {
    expect(() =>
      DigestBatchSchema.parse({ ...baseDigest, status: "expired" }),
    ).not.toThrow();
  });
  it("rejects an expired pool claiming a dispatch", () => {
    expect(() =>
      DigestBatchSchema.parse({
        ...baseDigest,
        status: "expired",
        dispatchedAt: "2026-05-17T08:00:05.000Z",
      }),
    ).toThrow(/must not have dispatchedAt/);
  });
});
