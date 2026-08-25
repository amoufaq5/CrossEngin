import {
  DIGEST_FREQUENCIES,
  DigestBatchSchema,
  type DigestFrequency,
  type QuietHoursConfig,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_POLICY,
  DIGEST_WINDOW_MINUTES,
  NotificationPolicySchema,
  buildDigestBatch,
  decideThrottle,
  digestIdFor,
  digestWindowFor,
  isBatchableFrequency,
  localMinutesSinceMidnight,
  nextDigestDispatchAt,
  nextQuietHoursEnd,
  parseNotificationPolicy,
  type NotificationPolicy,
} from "./delivery-throttle.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const quiet = (overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig => ({
  startTime: "22:00",
  endTime: "07:00",
  timezone: "UTC",
  behavior: "defer_to_morning",
  bypassCategories: [],
  ...overrides,
});

const policy = (
  overrides: Partial<NotificationPolicy> = {},
): NotificationPolicy => ({ ...DEFAULT_NOTIFICATION_POLICY, ...overrides });

const localAt = (config: QuietHoursConfig, iso: string): number =>
  localMinutesSinceMidnight(new Date(iso), config.timezone);

describe("parseNotificationPolicy", () => {
  it("parses a full policy document", () => {
    const parsed = parseNotificationPolicy({
      quietHours: {
        startTime: "22:00",
        endTime: "07:00",
        timezone: "Asia/Dubai",
        behavior: "batch_until_morning",
        bypassCategories: ["security_alert"],
      },
      digest: { frequency: "hourly", maxItems: 20 },
    });
    expect(parsed.quietHours?.timezone).toBe("Asia/Dubai");
    expect(parsed.quietHours?.behavior).toBe("batch_until_morning");
    expect(parsed.quietHours?.bypassCategories).toEqual(["security_alert"]);
    expect(parsed.digestFrequency).toBe("hourly");
    expect(parsed.digestMaxItems).toBe(20);
    expect(
      parseNotificationPolicy({
        quietHours: {
          startTime: "22:00",
          endTime: "07:00",
          timezone: "UTC",
          behavior: "drop_silently",
        },
      }).quietHours?.bypassCategories,
    ).toEqual([]);
  });

  it("degrades an absent or non-object document to the default policy", () => {
    for (const raw of [undefined, null, "policy", 42, true, [], [{ digest: {} }]]) {
      expect(parseNotificationPolicy(raw)).toEqual(DEFAULT_NOTIFICATION_POLICY);
    }
  });

  it("reads the digest half when quietHours is absent", () => {
    const parsed = parseNotificationPolicy({
      digest: { frequency: "daily", maxItems: 7 },
    });
    expect(parsed.quietHours).toBeNull();
    expect(parsed.digestFrequency).toBe("daily");
    expect(parsed.digestMaxItems).toBe(7);
  });

  it("degrades a malformed quiet-hours time to null", () => {
    expect(
      parseNotificationPolicy({
        quietHours: {
          startTime: "25:00",
          endTime: "07:00",
          timezone: "UTC",
          behavior: "defer_to_morning",
        },
      }).quietHours,
    ).toBeNull();
  });

  it("degrades a config failing the superRefine (start === end) to null", () => {
    expect(
      parseNotificationPolicy({
        quietHours: {
          startTime: "07:00",
          endTime: "07:00",
          timezone: "UTC",
          behavior: "defer_to_morning",
        },
      }).quietHours,
    ).toBeNull();
  });

  it("degrades marketing-in-bypassCategories to null", () => {
    expect(
      parseNotificationPolicy({
        quietHours: {
          startTime: "22:00",
          endTime: "07:00",
          timezone: "UTC",
          behavior: "defer_to_morning",
          bypassCategories: ["marketing"],
        },
      }).quietHours,
    ).toBeNull();
  });

  it("degrades a wrong-typed quietHours value to null without throwing", () => {
    for (const raw of ["22:00-07:00", [], 7, { startTime: {} }]) {
      expect(parseNotificationPolicy({ quietHours: raw }).quietHours).toBeNull();
    }
  });

  it("degrades an unknown frequency or out-of-range maxItems to the defaults", () => {
    const bad = parseNotificationPolicy({
      digest: { frequency: "fortnightly", maxItems: 12 },
    });
    expect(bad.digestFrequency).toBe("immediate");
    expect(bad.digestMaxItems).toBe(12);
    for (const maxItems of [0, 1001, 2.5, "20", null]) {
      expect(parseNotificationPolicy({ digest: { maxItems } }).digestMaxItems).toBe(50);
    }
    const nonObject = parseNotificationPolicy({ digest: "hourly" });
    expect(nonObject.digestFrequency).toBe("immediate");
    expect(nonObject.digestMaxItems).toBe(50);
  });

  it("produces a policy accepted by NotificationPolicySchema", () => {
    expect(() => NotificationPolicySchema.parse(DEFAULT_NOTIFICATION_POLICY)).not.toThrow();
    const parsed = parseNotificationPolicy({
      quietHours: quiet(),
      digest: { frequency: "weekly", maxItems: 100 },
    });
    expect(() => NotificationPolicySchema.parse(parsed)).not.toThrow();
  });
});

describe("localMinutesSinceMidnight", () => {
  it("reads the wall-clock minute of day in UTC", () => {
    expect(localMinutesSinceMidnight(new Date("2026-08-23T13:45:59.999Z"), "UTC")).toBe(
      13 * 60 + 45,
    );
    expect(localMinutesSinceMidnight(new Date("2026-08-23T00:00:00.000Z"), "UTC")).toBe(0);
  });

  it("shifts into a fixed-offset zone", () => {
    expect(
      localMinutesSinceMidnight(new Date("2026-08-23T13:45:00.000Z"), "Asia/Dubai"),
    ).toBe(17 * 60 + 45);
  });

  it("wraps across midnight in a fixed-offset zone", () => {
    expect(
      localMinutesSinceMidnight(new Date("2026-08-23T21:30:00.000Z"), "Asia/Dubai"),
    ).toBe(60 + 30);
  });

  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    const now = new Date("2026-08-23T13:45:00.000Z");
    expect(localMinutesSinceMidnight(now, "Mars/Olympus_Mons")).toBe(
      localMinutesSinceMidnight(now, "UTC"),
    );
  });
});

describe("digest frequencies", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  it("classifies every declared frequency", () => {
    expect(DIGEST_FREQUENCIES.filter((f) => isBatchableFrequency(f))).toEqual([
      "every_15_minutes",
      "hourly",
      "daily",
      "weekly",
    ]);
    expect(DIGEST_WINDOW_MINUTES.immediate).toBeNull();
    expect(DIGEST_WINDOW_MINUTES.never).toBeNull();
  });

  it("advances nextDigestDispatchAt by each batchable window", () => {
    expect(nextDigestDispatchAt("every_15_minutes", now)).toBe("2026-08-23T12:15:00.000Z");
    expect(nextDigestDispatchAt("hourly", now)).toBe("2026-08-23T13:00:00.000Z");
    expect(nextDigestDispatchAt("daily", now)).toBe("2026-08-24T12:00:00.000Z");
    expect(nextDigestDispatchAt("weekly", now)).toBe("2026-08-30T12:00:00.000Z");
  });

  it("throws from nextDigestDispatchAt for immediate and never", () => {
    expect(() => nextDigestDispatchAt("immediate", now)).toThrow(/not batchable/);
    expect(() => nextDigestDispatchAt("never", now)).toThrow(/not batchable/);
  });
});

describe("digestWindowFor", () => {
  it("quantizes to the enclosing grid cell and brackets now", () => {
    const now = new Date("2026-08-23T23:30:12.345Z");
    expect(digestWindowFor("hourly", now)).toEqual({
      windowStart: "2026-08-23T23:00:00.000Z",
      scheduledDispatchAt: "2026-08-24T00:00:00.000Z",
    });
    for (const frequency of DIGEST_FREQUENCIES) {
      if (!isBatchableFrequency(frequency)) continue;
      const window = digestWindowFor(frequency, now);
      expect(Date.parse(window.windowStart)).toBeLessThanOrEqual(now.getTime());
      expect(Date.parse(window.scheduledDispatchAt)).toBeGreaterThan(now.getTime());
    }
  });

  it("gives two instants in the same cell the same window, and throws off-grid", () => {
    const first = digestWindowFor("every_15_minutes", new Date("2026-08-23T23:31:00.000Z"));
    expect(digestWindowFor("every_15_minutes", new Date("2026-08-23T23:44:59.999Z"))).toEqual(
      first,
    );
    expect(first.windowStart).toBe("2026-08-23T23:30:00.000Z");
    expect(() => digestWindowFor("immediate", new Date())).toThrow(/not batchable/);
    expect(() => digestWindowFor("never", new Date())).toThrow(/not batchable/);
  });
});

describe("nextQuietHoursEnd", () => {
  it("resolves a same-day window to today's endTime", () => {
    const config = quiet({ startTime: "09:00", endTime: "17:00" });
    const next = nextQuietHoursEnd(config, new Date("2026-08-23T12:00:00.000Z"));
    expect(next).toBe("2026-08-23T17:00:00.000Z");
    expect(localAt(config, next)).toBe(17 * 60);
    expect(nextQuietHoursEnd(config, new Date("2026-08-23T18:30:00.000Z"))).toBe(
      "2026-08-24T17:00:00.000Z",
    );
  });

  it("resolves an overnight window from either side of midnight", () => {
    const config = quiet({ startTime: "22:00", endTime: "07:00" });
    const beforeMidnight = nextQuietHoursEnd(config, new Date("2026-08-23T23:10:00.000Z"));
    expect(beforeMidnight).toBe("2026-08-24T07:00:00.000Z");
    expect(localAt(config, beforeMidnight)).toBe(7 * 60);
    expect(nextQuietHoursEnd(config, new Date("2026-08-24T03:00:00.000Z"))).toBe(
      "2026-08-24T07:00:00.000Z",
    );
  });

  it("is strictly after now when now sits on or just past endTime", () => {
    const config = quiet({ startTime: "22:00", endTime: "07:00" });
    const onEnd = new Date("2026-08-24T07:00:00.000Z");
    expect(nextQuietHoursEnd(config, onEnd)).toBe("2026-08-25T07:00:00.000Z");
    const justPast = new Date("2026-08-24T07:00:00.500Z");
    expect(Date.parse(nextQuietHoursEnd(config, justPast))).toBeGreaterThan(
      justPast.getTime(),
    );
  });

  it("resolves endTime in the config zone, not in UTC, from every hour of a day", () => {
    const config = quiet({
      startTime: "22:00",
      endTime: "06:30",
      timezone: "Asia/Dubai",
    });
    expect(nextQuietHoursEnd(config, new Date("2026-08-23T20:00:00.000Z"))).toBe(
      "2026-08-24T02:30:00.000Z",
    );
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 7, 23, hour, 17, 0));
      const next = nextQuietHoursEnd(config, now);
      expect(Date.parse(next)).toBeGreaterThan(now.getTime());
      expect(localAt(config, next)).toBe(6 * 60 + 30);
      expect(Date.parse(next) - now.getTime()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    }
  });
});

describe("decideThrottle", () => {
  const now = new Date("2026-08-23T23:30:00.000Z");

  it("sends now when no quiet hours are configured", () => {
    expect(
      decideThrottle({ policy: policy(), category: "marketing", priority: "low", now }),
    ).toEqual({
      action: "send_now",
      reason: "no_quiet_hours_configured",
      releaseAt: null,
    });
  });

  it("sends now outside the quiet-hours window", () => {
    expect(
      decideThrottle({
        policy: policy({ quietHours: quiet() }),
        category: "operational_digest",
        priority: "normal",
        now: new Date("2026-08-23T12:00:00.000Z"),
      }),
    ).toEqual({ action: "send_now", reason: "outside_quiet_hours", releaseAt: null });
  });

  it("lets a bypass category through the window", () => {
    expect(
      decideThrottle({
        policy: policy({ quietHours: quiet({ bypassCategories: ["security_alert"] }) }),
        category: "security_alert",
        priority: "low",
        now,
      }),
    ).toEqual({
      action: "send_now",
      reason: "category_bypasses_quiet_hours",
      releaseAt: null,
    });
  });

  it("lets critical priority through the window", () => {
    const decision = decideThrottle({
      policy: policy({ quietHours: quiet({ behavior: "drop_silently" }) }),
      category: "operational_digest",
      priority: "critical",
      now,
    });
    expect(decision.action).toBe("send_now");
    expect(decision.reason).toBe("critical_priority_bypasses");
  });

  it("sends now under deliver_anyway", () => {
    expect(
      decideThrottle({
        policy: policy({ quietHours: quiet({ behavior: "deliver_anyway" }) }),
        category: "system_notice",
        priority: "normal",
        now,
      }),
    ).toEqual({ action: "send_now", reason: "behavior_deliver_anyway", releaseAt: null });
  });

  it("defers to the end of the window under defer_to_morning", () => {
    expect(
      decideThrottle({
        policy: policy({ quietHours: quiet({ behavior: "defer_to_morning" }) }),
        category: "system_notice",
        priority: "normal",
        now,
      }),
    ).toEqual({
      action: "defer",
      reason: "behavior_defer_to_morning",
      releaseAt: "2026-08-24T07:00:00.000Z",
    });
  });

  it("batches to the next digest window under batch_until_morning", () => {
    expect(
      decideThrottle({
        policy: policy({
          quietHours: quiet({ behavior: "batch_until_morning" }),
          digestFrequency: "hourly",
        }),
        category: "operational_digest",
        priority: "low",
        now,
      }),
    ).toEqual({
      action: "batch",
      reason: "behavior_batch_until_morning",
      releaseAt: "2026-08-24T00:30:00.000Z",
    });
  });

  it("falls back to the quiet-hours end for non-batchable frequencies", () => {
    for (const digestFrequency of ["immediate", "never"] as const) {
      const decision = decideThrottle({
        policy: policy({
          quietHours: quiet({ behavior: "batch_until_morning" }),
          digestFrequency,
        }),
        category: "operational_digest",
        priority: "low",
        now,
      });
      expect(decision.action).toBe("batch");
      expect(decision.releaseAt).toBe("2026-08-24T07:00:00.000Z");
    }
  });

  it("drops with no releaseAt under drop_silently", () => {
    expect(
      decideThrottle({
        policy: policy({ quietHours: quiet({ behavior: "drop_silently" }) }),
        category: "operational_digest",
        priority: "background",
        now,
      }),
    ).toEqual({ action: "drop", reason: "behavior_drop_silently", releaseAt: null });
  });

  it("reads the window in the config timezone", () => {
    const at1930Utc = new Date("2026-08-23T19:30:00.000Z");
    const inDubai = decideThrottle({
      policy: policy({ quietHours: quiet({ timezone: "Asia/Dubai" }) }),
      category: "system_notice",
      priority: "normal",
      now: at1930Utc,
    });
    const inUtc = decideThrottle({
      policy: policy({ quietHours: quiet({ timezone: "UTC" }) }),
      category: "system_notice",
      priority: "normal",
      now: at1930Utc,
    });
    expect(inDubai.action).toBe("defer");
    expect(inUtc.action).toBe("send_now");
  });

  it("always releases strictly after now when it defers or batches", () => {
    for (const behavior of ["defer_to_morning", "batch_until_morning"] as const) {
      for (const digestFrequency of DIGEST_FREQUENCIES) {
        const decision = decideThrottle({
          policy: policy({ quietHours: quiet({ behavior }), digestFrequency }),
          category: "system_notice",
          priority: "normal",
          now,
        });
        expect(decision.releaseAt).not.toBeNull();
        expect(Date.parse(decision.releaseAt as string)).toBeGreaterThan(now.getTime());
      }
    }
  });
});

describe("digestIdFor", () => {
  const base = {
    tenantId: TENANT,
    userId: USER,
    channel: "email" as const,
    frequency: "hourly" as DigestFrequency,
    windowStart: "2026-08-23T23:00:00.000Z",
  };

  it("is deterministic and matches the DigestBatch id regex", () => {
    expect(digestIdFor(base)).toBe(digestIdFor({ ...base }));
    expect(digestIdFor(base)).toMatch(/^dgst_[A-Za-z0-9_-]{8,40}$/);
    expect(digestIdFor(base)).toMatch(/^dgst_[0-9a-f]{32}$/);
  });

  it("varies with every input field", () => {
    const ids = new Set([
      digestIdFor(base),
      digestIdFor({ ...base, tenantId: USER }),
      digestIdFor({ ...base, userId: TENANT }),
      digestIdFor({ ...base, channel: "sms" }),
      digestIdFor({ ...base, frequency: "daily" }),
      digestIdFor({ ...base, windowStart: "2026-08-24T00:00:00.000Z" }),
    ]);
    expect(ids.size).toBe(6);
  });
});

describe("buildDigestBatch", () => {
  const input = {
    tenantId: TENANT,
    userId: USER,
    channel: "email" as const,
    frequency: "hourly" as DigestFrequency,
    openedAt: "2026-08-23T23:00:00.000Z",
    scheduledDispatchAt: "2026-08-24T00:00:00.000Z",
    maxItems: 50,
  };

  it("round-trips through DigestBatchSchema as an open batch", () => {
    const batch = buildDigestBatch(input);
    expect(DigestBatchSchema.parse(batch)).toEqual(batch);
    expect(batch.status).toBe("open");
    expect(batch.assembledAt).toBeNull();
    expect(batch.dispatchedAt).toBeNull();
    expect(batch.dedupSha256).toBeNull();
  });

  it("defaults itemCount to zero and keeps an explicit count", () => {
    expect(buildDigestBatch(input).itemCount).toBe(0);
    expect(buildDigestBatch({ ...input, itemCount: 4 }).itemCount).toBe(4);
  });

  it("ids the batch by its open window", () => {
    expect(buildDigestBatch(input).id).toBe(
      digestIdFor({
        tenantId: input.tenantId,
        userId: input.userId,
        channel: input.channel,
        frequency: input.frequency,
        windowStart: input.openedAt,
      }),
    );
  });

  it("throws rather than emitting an invalid non-batchable record", () => {
    expect(() => buildDigestBatch({ ...input, frequency: "immediate" })).toThrow(
      /frequency immediate/,
    );
    expect(() => buildDigestBatch({ ...input, frequency: "never" })).toThrow(
      /frequency never/,
    );
  });

  it("builds a schema-valid batch for every batchable frequency", () => {
    const now = new Date("2026-08-23T23:00:00.000Z");
    for (const frequency of DIGEST_FREQUENCIES) {
      if (!isBatchableFrequency(frequency)) continue;
      const window = digestWindowFor(frequency, now);
      const batch = buildDigestBatch({
        ...input,
        frequency,
        openedAt: window.windowStart,
        scheduledDispatchAt: window.scheduledDispatchAt,
      });
      expect(() => DigestBatchSchema.parse(batch)).not.toThrow();
    }
  });
});
