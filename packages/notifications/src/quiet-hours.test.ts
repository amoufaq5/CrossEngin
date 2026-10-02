import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS_BEHAVIOR,
  QUIET_HOURS_OVERRIDE_SCOPES,
  USER_QUIET_HOURS_SOURCES,
  UserQuietHoursPreferenceSchema,
  decideUserQuietHoursAction,
  isValidTimeZone,
  localMinutesInTimeZone,
  resolveEffectiveQuietHours,
  type UserQuietHoursPreference,
} from "./quiet-hours.js";
import type { QuietHoursConfig } from "./throttling.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const tenantConfig = (
  overrides: Partial<QuietHoursConfig> = {},
): QuietHoursConfig => ({
  startTime: "22:00",
  endTime: "07:00",
  timezone: "America/Los_Angeles",
  behavior: "defer_to_morning",
  bypassCategories: ["security_alert"],
  ...overrides,
});

const userPref = (
  overrides: Partial<UserQuietHoursPreference> = {},
): UserQuietHoursPreference => ({
  tenantId: TENANT,
  userId: USER,
  enabled: true,
  startTime: null,
  endTime: null,
  timezone: null,
  behavior: null,
  bypassCategories: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  source: "user_set",
  ...overrides,
});

describe("constants", () => {
  it("has 3 override scopes", () => {
    expect(QUIET_HOURS_OVERRIDE_SCOPES).toHaveLength(3);
    expect(QUIET_HOURS_OVERRIDE_SCOPES).toEqual(["none", "timezone_only", "full"]);
  });
  it("has 3 user preference sources", () => {
    expect(USER_QUIET_HOURS_SOURCES).toHaveLength(3);
  });
  it("defaults to the behavior that neither delivers nor drops", () => {
    expect(DEFAULT_QUIET_HOURS_BEHAVIOR).toBe("defer_to_morning");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones the platform already stores", () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/Riga"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });
  it("rejects a typo", () => {
    expect(isValidTimeZone("Amerca/Los_Angeles")).toBe(false);
  });
  it("rejects an offset string, which is the form this deliberately does not use", () => {
    expect(isValidTimeZone("UTC-8")).toBe(false);
  });
  it("rejects the empty string", () => {
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("localMinutesInTimeZone", () => {
  const instant = new Date("2026-07-15T06:30:00.000Z");

  it("reads UTC directly", () => {
    expect(localMinutesInTimeZone(instant, "UTC")).toBe(6 * 60 + 30);
  });
  it("reads a zone behind UTC", () => {
    // PDT in July: UTC-7.
    expect(localMinutesInTimeZone(instant, "America/Los_Angeles")).toBe(23 * 60 + 30);
  });
  it("reads a zone ahead of UTC", () => {
    expect(localMinutesInTimeZone(instant, "Asia/Tokyo")).toBe(15 * 60 + 30);
  });
  it("renders midnight as 0, not 1440", () => {
    expect(localMinutesInTimeZone(new Date("2026-07-15T00:00:00.000Z"), "UTC")).toBe(0);
  });
  it("renders 00:30 as 30", () => {
    expect(localMinutesInTimeZone(new Date("2026-07-15T00:30:00.000Z"), "UTC")).toBe(30);
  });
  it("tracks DST rather than a fixed offset", () => {
    // The same wall clock instant of day, six months apart: PST is UTC-8, PDT is UTC-7. An offset
    // stored once would be an hour wrong for half the year.
    const winter = localMinutesInTimeZone(
      new Date("2026-01-15T06:30:00.000Z"),
      "America/Los_Angeles",
    );
    const summer = localMinutesInTimeZone(instant, "America/Los_Angeles");
    expect(summer - winter).toBe(60);
  });
  it("is stable across repeated calls (the formatter cache changes no answer)", () => {
    expect(localMinutesInTimeZone(instant, "Asia/Tokyo")).toBe(
      localMinutesInTimeZone(instant, "Asia/Tokyo"),
    );
  });
});

describe("UserQuietHoursPreferenceSchema", () => {
  it("accepts an inherit-everything record", () => {
    expect(() => UserQuietHoursPreferenceSchema.parse(userPref())).not.toThrow();
  });
  it("accepts a full override", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(
        userPref({
          startTime: "23:30",
          endTime: "06:15",
          timezone: "Asia/Tokyo",
          behavior: "batch_until_morning",
          bypassCategories: ["security_alert", "transactional"],
        }),
      ),
    ).not.toThrow();
  });
  it("rejects half a window", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(userPref({ startTime: "23:00" })),
    ).toThrow(/both be set or both be null/);
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(userPref({ endTime: "07:00" })),
    ).toThrow(/both be set or both be null/);
  });
  it("rejects a degenerate window", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(
        userPref({ startTime: "22:00", endTime: "22:00" }),
      ),
    ).toThrow(/must differ/);
  });
  it("rejects a malformed time", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(
        userPref({ startTime: "25:00", endTime: "07:00" }),
      ),
    ).toThrow();
  });
  it("rejects an unknown time zone", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(userPref({ timezone: "Mars/Olympus" })),
    ).toThrow(/unknown IANA time zone/);
  });
  it("rejects marketing in the user's bypass list, as for the tenant", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(
        userPref({ bypassCategories: ["marketing"] }),
      ),
    ).toThrow(/marketing cannot bypass quiet hours/);
  });
  it("accepts an empty bypass list, which is not the same as inheriting", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(userPref({ bypassCategories: [] })),
    ).not.toThrow();
  });
  it("rejects an unknown source", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse({ ...userPref(), source: "guessed" }),
    ).toThrow();
  });
  it("rejects a non-uuid user", () => {
    expect(() =>
      UserQuietHoursPreferenceSchema.parse(userPref({ userId: "me" })),
    ).toThrow();
  });
});

describe("resolveEffectiveQuietHours", () => {
  it("returns no policy when neither side has one", () => {
    const eff = resolveEffectiveQuietHours({ tenant: null, user: null, scope: "full" });
    expect(eff.config).toBeNull();
    expect(eff.windowSource).toBe("none");
  });
  it("uses the tenant policy verbatim when the user has no record", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: null,
      scope: "full",
    });
    expect(eff.config?.startTime).toBe("22:00");
    expect(eff.timeZone).toBe("America/Los_Angeles");
    expect(eff.windowSource).toBe("tenant");
    expect(eff.timeZoneSource).toBe("tenant");
  });
  it("ignores the user record entirely under scope none", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({ timezone: "Asia/Tokyo", startTime: "01:00", endTime: "02:00" }),
      scope: "none",
    });
    expect(eff.timeZone).toBe("America/Los_Angeles");
    expect(eff.config?.startTime).toBe("22:00");
    expect(eff.timeZoneSource).toBe("tenant");
  });
  it("takes the user's zone under timezone_only but keeps the tenant's window", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({ timezone: "Asia/Tokyo", startTime: "01:00", endTime: "02:00" }),
      scope: "timezone_only",
    });
    expect(eff.timeZone).toBe("Asia/Tokyo");
    expect(eff.timeZoneSource).toBe("user");
    expect(eff.config?.startTime).toBe("22:00");
    expect(eff.windowSource).toBe("tenant");
  });
  it("takes the user's window and behavior under full", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({
        startTime: "01:00",
        endTime: "05:00",
        behavior: "drop_silently",
      }),
      scope: "full",
    });
    expect(eff.config?.startTime).toBe("01:00");
    expect(eff.config?.behavior).toBe("drop_silently");
    expect(eff.windowSource).toBe("user");
    expect(eff.behaviorSource).toBe("user");
    // Zone untouched: each field falls back on its own.
    expect(eff.timeZoneSource).toBe("tenant");
  });
  it("lets a user under full opt out entirely", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({ enabled: false }),
      scope: "full",
    });
    expect(eff.config).toBeNull();
    expect(eff.disabledByUser).toBe(true);
  });
  it("does not let a user opt out under timezone_only", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({ enabled: false, timezone: "Asia/Tokyo" }),
      scope: "timezone_only",
    });
    expect(eff.config).not.toBeNull();
    expect(eff.disabledByUser).toBe(false);
  });
  it("applies a user-only window with the invented default behavior", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: null,
      user: userPref({ startTime: "23:00", endTime: "06:00", timezone: "Asia/Tokyo" }),
      scope: "full",
    });
    expect(eff.config?.behavior).toBe(DEFAULT_QUIET_HOURS_BEHAVIOR);
    expect(eff.behaviorSource).toBe("default");
    expect(eff.config?.bypassCategories).toEqual([]);
  });
  it("gives no policy for a user window with no readable zone anywhere", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: null,
      user: userPref({ startTime: "23:00", endTime: "06:00" }),
      scope: "full",
    });
    expect(eff.config).toBeNull();
  });
  it("falls back to the tenant zone when the user's is unknown", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: { ...userPref(), timezone: "Mars/Olympus" },
      scope: "timezone_only",
    });
    expect(eff.timeZone).toBe("America/Los_Angeles");
    expect(eff.timeZoneSource).toBe("tenant");
  });
  it("fails open to no policy when the tenant zone is unreadable and the user has none", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig({ timezone: "Mars/Olympus" }),
      user: null,
      scope: "full",
    });
    expect(eff.config).toBeNull();
  });
  it("still honours a valid user zone when the tenant zone is unreadable", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig({ timezone: "Mars/Olympus" }),
      user: userPref({ timezone: "Asia/Tokyo" }),
      scope: "timezone_only",
    });
    expect(eff.timeZone).toBe("Asia/Tokyo");
  });
  it("fails open on a degenerate window rather than holding everything", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig({ startTime: "22:00", endTime: "22:00" }),
      user: null,
      scope: "full",
    });
    expect(eff.config).toBeNull();
  });
  it("takes the user's empty bypass list under full as an override, not an absence", () => {
    const eff = resolveEffectiveQuietHours({
      tenant: tenantConfig(),
      user: userPref({ bypassCategories: [] }),
      scope: "full",
    });
    expect(eff.config?.bypassCategories).toEqual([]);
  });
});

describe("decideUserQuietHoursAction — the cross-timezone rule", () => {
  // 2026-07-15T14:00Z is 07:00 in Los Angeles (PDT) and 23:00 in Tokyo.
  const instant = new Date("2026-07-15T14:00:00.000Z");

  it("sends to a tenant-zone user outside their window", () => {
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: null,
      scope: "timezone_only",
      category: "system_notice",
      priority: "normal",
      instant,
    });
    expect(decision.localMinutesSinceMidnight).toBe(7 * 60);
    expect(decision.action).toBe("send_now");
  });

  it("defers for a Tokyo user at the same instant, reading the tenant window on their clock", () => {
    // This is the whole rule: one tenant policy of 22:00-07:00, two users, one absolute instant,
    // two different answers — because the window describes the recipient's night.
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: userPref({ timezone: "Asia/Tokyo" }),
      scope: "timezone_only",
      category: "system_notice",
      priority: "normal",
      instant,
    });
    expect(decision.effective.timeZoneSource).toBe("user");
    expect(decision.localMinutesSinceMidnight).toBe(23 * 60);
    expect(decision.action).toBe("defer");
  });

  it("sends to that same Tokyo user under scope none, which pins the window to the tenant clock", () => {
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: userPref({ timezone: "Asia/Tokyo" }),
      scope: "none",
      category: "system_notice",
      priority: "normal",
      instant,
    });
    expect(decision.localMinutesSinceMidnight).toBe(7 * 60);
    expect(decision.action).toBe("send_now");
  });
});

describe("decideUserQuietHoursAction", () => {
  const night = new Date("2026-07-15T08:00:00.000Z"); // 01:00 in Los Angeles

  it("sends when there is no policy at all", () => {
    const decision = decideUserQuietHoursAction({
      tenant: null,
      user: null,
      scope: "full",
      category: "marketing",
      priority: "low",
      instant: night,
    });
    expect(decision.action).toBe("send_now");
    expect(decision.reason).toBe("no_quiet_hours_configured");
    expect(decision.localMinutesSinceMidnight).toBeNull();
  });
  it("names the user when they disabled it", () => {
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: userPref({ enabled: false }),
      scope: "full",
      category: "marketing",
      priority: "low",
      instant: night,
    });
    expect(decision.action).toBe("send_now");
    expect(decision.reason).toBe("quiet_hours_disabled_by_user");
  });
  it("defers inside the window", () => {
    expect(
      decideUserQuietHoursAction({
        tenant: tenantConfig(),
        user: null,
        scope: "full",
        category: "system_notice",
        priority: "normal",
        instant: night,
      }).action,
    ).toBe("defer");
  });
  it("lets a bypass category through inside the window", () => {
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: null,
      scope: "full",
      category: "security_alert",
      priority: "normal",
      instant: night,
    });
    expect(decision.action).toBe("send_now");
    expect(decision.reason).toBe("category_bypasses_quiet_hours");
  });
  it("lets critical priority through inside the window", () => {
    expect(
      decideUserQuietHoursAction({
        tenant: tenantConfig(),
        user: null,
        scope: "full",
        category: "system_notice",
        priority: "critical",
        instant: night,
      }).action,
    ).toBe("send_now");
  });
  it("honours the user's own behavior inside their own window", () => {
    const decision = decideUserQuietHoursAction({
      tenant: tenantConfig(),
      user: userPref({
        startTime: "00:00",
        endTime: "03:00",
        behavior: "batch_until_morning",
        bypassCategories: [],
      }),
      scope: "full",
      category: "system_notice",
      priority: "normal",
      instant: night,
    });
    expect(decision.action).toBe("batch");
    expect(decision.reason).toBe("behavior_batch_until_morning");
  });
  it("sends when the user's narrower window has already closed", () => {
    expect(
      decideUserQuietHoursAction({
        tenant: tenantConfig(),
        user: userPref({ startTime: "22:00", endTime: "00:30" }),
        scope: "full",
        category: "system_notice",
        priority: "normal",
        instant: night,
      }).action,
    ).toBe("send_now");
  });
  it("is deterministic for one instant and one input", () => {
    const input = {
      tenant: tenantConfig(),
      user: userPref({ timezone: "Asia/Tokyo" }),
      scope: "timezone_only" as const,
      category: "system_notice" as const,
      priority: "normal" as const,
      instant: night,
    };
    expect(decideUserQuietHoursAction(input)).toEqual(decideUserQuietHoursAction(input));
  });
  it("never matches an hour that does not exist on a spring-forward day", () => {
    // 2026-03-08: Los Angeles jumps 02:00 -> 03:00. A 02:00-02:59 window has no local instant, so
    // nothing is ever held by it — the honest outcome of asking a zone for the wall clock.
    const window = tenantConfig({ startTime: "02:00", endTime: "02:59" });
    const probes = [
      "2026-03-08T09:00:00.000Z",
      "2026-03-08T09:30:00.000Z",
      "2026-03-08T10:00:00.000Z",
      "2026-03-08T10:30:00.000Z",
    ];
    for (const probe of probes) {
      expect(
        decideUserQuietHoursAction({
          tenant: window,
          user: null,
          scope: "none",
          category: "system_notice",
          priority: "normal",
          instant: new Date(probe),
        }).action,
      ).toBe("send_now");
    }
  });
  it("holds across a fall-back repeated hour on both passes", () => {
    // 2026-11-01: Los Angeles repeats 01:00-01:59. A 01:00-02:00 window must match both passes.
    const window = tenantConfig({ startTime: "01:00", endTime: "02:00" });
    for (const probe of ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"]) {
      expect(
        decideUserQuietHoursAction({
          tenant: window,
          user: null,
          scope: "none",
          category: "system_notice",
          priority: "normal",
          instant: new Date(probe),
        }).action,
      ).toBe("defer");
    }
  });
});
