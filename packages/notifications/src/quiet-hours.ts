import { z } from "zod";
import { CONTENT_CATEGORIES, type ContentCategory } from "./templates.js";
import type { PriorityLevel } from "./delivery.js";
import {
  QUIET_HOURS_BEHAVIORS,
  decideQuietHoursAction,
  type QuietHoursBehavior,
  type QuietHoursConfig,
  type QuietHoursDecision,
} from "./throttling.js";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How much of the tenant's quiet-hours policy a user may override.
 *
 * Quiet hours is two different things wearing one name. Usually it is a courtesy to the recipient —
 * do not wake me — and then it belongs on the recipient's clock. Sometimes it is a tenant-local
 * blackout the business is obliged to enforce (a labour rule about contacting staff outside its own
 * working hours), and then it belongs on the tenant's clock and no user may move it. The scope is
 * the tenant stating which one it has.
 */
export const QUIET_HOURS_OVERRIDE_SCOPES = [
  "none",
  "timezone_only",
  "full",
] as const;
export type QuietHoursOverrideScope =
  (typeof QUIET_HOURS_OVERRIDE_SCOPES)[number];

/**
 * The behavior used when a window exists but nothing supplies a behavior for it — a user who set a
 * window in a tenant that has no policy of its own. It is the only default invented here, and it is
 * `defer_to_morning` because that is the one behavior that neither delivers inside the window nor
 * loses the notice.
 */
export const DEFAULT_QUIET_HOURS_BEHAVIOR: QuietHoursBehavior =
  "defer_to_morning";

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl.DateTimeFormat` rather than a stored UTC offset.
 *
 * An offset is wrong twice a year: a window stored as "22:00 at UTC-8" silences the wrong hour from
 * March to November, and the error is invisible in tests pinned to a single date. The platform
 * already stores IANA zone names (`OncallShift.timezone`, `QuietHoursConfig.timezone`), Node 20
 * carries full ICU, and asking the zone where the clock is sidesteps DST entirely — including the
 * hours that do not exist on a spring-forward day, which simply never match a window.
 *
 * Deterministic for a given Node build: no clock is read, the instant is the caller's. The
 * dependency is on ICU's zone table, which moves when governments move, the same risk the stored
 * zone name already carries.
 */
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  zoneFormatters.set(timeZone, made);
  return made;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

export const localMinutesInTimeZone = (
  instant: Date,
  timeZone: string,
): number => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  // `hourCycle: "h23"` is load-bearing: the default for en-US renders midnight as hour 24 under
  // h24, which would place 00:30 at minute 1470 and never match a window ending at 07:00.
  return hour * 60 + minute;
};

export const USER_QUIET_HOURS_SOURCES = [
  "user_set",
  "admin_set",
  "import",
] as const;
export type UserQuietHoursSource = (typeof USER_QUIET_HOURS_SOURCES)[number];

export const UserQuietHoursPreferenceSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    enabled: z.boolean(),
    startTime: z.string().regex(HHMM).nullable(),
    endTime: z.string().regex(HHMM).nullable(),
    timezone: z.string().min(1).max(64).nullable(),
    behavior: z.enum(QUIET_HOURS_BEHAVIORS).nullable(),
    bypassCategories: z.array(z.enum(CONTENT_CATEGORIES)).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    source: z.enum(USER_QUIET_HOURS_SOURCES),
  })
  .superRefine((p, ctx) => {
    if ((p.startTime === null) !== (p.endTime === null)) {
      // Half a window is not a window, and inheriting the other half from the tenant would build a
      // span neither party asked for — a user's 23:00 against a tenant's 07:00.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [p.startTime === null ? "startTime" : "endTime"],
        message: "startTime and endTime must both be set or both be null",
      });
    }
    if (p.startTime !== null && p.startTime === p.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "quiet hours startTime and endTime must differ",
      });
    }
    if (p.timezone !== null && !isValidTimeZone(p.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: `unknown IANA time zone: ${p.timezone}`,
      });
    }
    if (p.bypassCategories !== null && p.bypassCategories.includes("marketing")) {
      // The same rule the tenant config carries. A user cannot opt their own 3am into marketing;
      // the reason it is forbidden is not consent, it is that a marketing send inside a quiet
      // window is the pattern providers rate a whole sending domain on.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bypassCategories"],
        message: "marketing cannot bypass quiet hours",
      });
    }
  });
export type UserQuietHoursPreference = z.infer<
  typeof UserQuietHoursPreferenceSchema
>;

export type QuietHoursFieldSource = "tenant" | "user" | "default" | "none";

export interface EffectiveQuietHours {
  readonly config: QuietHoursConfig | null;
  readonly timeZone: string | null;
  readonly windowSource: QuietHoursFieldSource;
  readonly timeZoneSource: QuietHoursFieldSource;
  readonly behaviorSource: QuietHoursFieldSource;
  readonly disabledByUser: boolean;
}

const NO_QUIET_HOURS: EffectiveQuietHours = {
  config: null,
  timeZone: null,
  windowSource: "none",
  timeZoneSource: "none",
  behaviorSource: "none",
  disabledByUser: false,
};

/**
 * Resolve the tenant policy and the user's preference into one window read in one zone.
 *
 * **The rule when the user's zone differs from the tenant's.** Outside `scope: "none"`, the
 * timezone is the user's whenever they declare one, and the window may still be the tenant's. A
 * tenant policy of 22:00–07:00 therefore silences a user in `Asia/Tokyo` during Tokyo's
 * 22:00–07:00 — a *different absolute interval* from the tenant's, by nine hours. That is
 * deliberate: a window is a statement about the recipient's night, and translating the tenant's
 * clock would silence a Tokyo user through their afternoon while mailing them at 2am. A tenant that
 * genuinely needs one absolute interval for everyone sets `scope: "none"`, which reads the tenant
 * window in the tenant zone and ignores the user record entirely.
 *
 * Each field falls back on its own, so a user who sets only a zone keeps the tenant's window and
 * behavior, and a user who sets only a window keeps the tenant's zone.
 *
 * Fail-open to no policy, as ADR-0275 decided for the tenant document: a window that cannot be read
 * — no zone, an unknown zone, a degenerate span — resolves to no quiet hours, never to a blanket
 * hold. Not sending is the failure mode worth avoiding here; quiet hours only ever delays.
 */
export const resolveEffectiveQuietHours = (input: {
  readonly tenant: QuietHoursConfig | null;
  readonly user: UserQuietHoursPreference | null;
  readonly scope: QuietHoursOverrideScope;
}): EffectiveQuietHours => {
  const user = input.scope === "none" ? null : input.user;
  const mayReplacePolicy = input.scope === "full";

  if (user !== null && mayReplacePolicy && !user.enabled) {
    return { ...NO_QUIET_HOURS, disabledByUser: true };
  }

  const userWindow =
    mayReplacePolicy && user !== null && user.startTime !== null && user.endTime !== null
      ? { startTime: user.startTime, endTime: user.endTime }
      : null;
  const window =
    userWindow ??
    (input.tenant === null
      ? null
      : { startTime: input.tenant.startTime, endTime: input.tenant.endTime });
  if (window === null || window.startTime === window.endTime) return NO_QUIET_HOURS;

  const userZone =
    user !== null && user.timezone !== null && isValidTimeZone(user.timezone)
      ? user.timezone
      : null;
  const tenantZone =
    input.tenant !== null && isValidTimeZone(input.tenant.timezone)
      ? input.tenant.timezone
      : null;
  const timeZone = userZone ?? tenantZone;
  if (timeZone === null) return NO_QUIET_HOURS;

  const userBehavior = mayReplacePolicy && user !== null ? user.behavior : null;
  const behavior =
    userBehavior ?? input.tenant?.behavior ?? DEFAULT_QUIET_HOURS_BEHAVIOR;
  const behaviorSource: QuietHoursFieldSource =
    userBehavior !== null
      ? "user"
      : input.tenant !== null
        ? "tenant"
        : "default";

  const userBypass =
    mayReplacePolicy && user !== null ? user.bypassCategories : null;
  const bypassCategories = userBypass ?? input.tenant?.bypassCategories ?? [];

  return {
    config: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: timeZone,
      behavior,
      bypassCategories,
    },
    timeZone,
    windowSource: userWindow !== null ? "user" : "tenant",
    timeZoneSource: userZone !== null ? "user" : "tenant",
    behaviorSource,
    disabledByUser: false,
  };
};

export interface UserQuietHoursDecision extends QuietHoursDecision {
  readonly effective: EffectiveQuietHours;
  readonly localMinutesSinceMidnight: number | null;
}

/**
 * The quiet-hours decision for one recipient at one instant. Pure: the instant is the caller's, and
 * the only other input is contract data.
 */
export const decideUserQuietHoursAction = (input: {
  readonly tenant: QuietHoursConfig | null;
  readonly user: UserQuietHoursPreference | null;
  readonly scope: QuietHoursOverrideScope;
  readonly category: ContentCategory;
  readonly priority: PriorityLevel;
  readonly instant: Date;
}): UserQuietHoursDecision => {
  const effective = resolveEffectiveQuietHours({
    tenant: input.tenant,
    user: input.user,
    scope: input.scope,
  });
  if (effective.config === null || effective.timeZone === null) {
    return {
      action: "send_now",
      reason: effective.disabledByUser
        ? "quiet_hours_disabled_by_user"
        : "no_quiet_hours_configured",
      effective,
      localMinutesSinceMidnight: null,
    };
  }
  const localMinutesSinceMidnight = localMinutesInTimeZone(
    input.instant,
    effective.timeZone,
  );
  const decision = decideQuietHoursAction({
    config: effective.config,
    category: input.category,
    priority: input.priority,
    localMinutesSinceMidnight,
  });
  return { ...decision, effective, localMinutesSinceMidnight };
};
