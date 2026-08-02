import { CronExpressionSchema, type JobDeclaration } from "./types.js";

/**
 * A parsed cron expression, each field expanded to the concrete set of values it matches. `second` is
 * present only for 6-field expressions. `domRestricted` / `dowRestricted` record whether the
 * day-of-month / day-of-week field was narrowed from `*`, which drives the standard cron OR-semantics
 * when both are restricted.
 */
export interface ParsedCron {
  readonly second?: ReadonlySet<number>;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
  readonly hasSeconds: boolean;
}

function parseField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${JSON.stringify(part)}`);
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === undefined) {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map((n) => Number(n));
      lo = a!;
      hi = b!;
    } else {
      lo = Number(rangePart);
      hi = stepPart !== undefined ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid cron field value: ${JSON.stringify(part)} (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a 5- or 6-field crontab expression into concrete matcher sets (UTC-evaluated). */
export function parseCron(expr: string): ParsedCron {
  CronExpressionSchema.parse(expr);
  const fields = expr.trim().split(/\s+/);
  const hasSeconds = fields.length === 6;
  const [secondSpec, minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = hasSeconds
    ? fields
    : [undefined, ...fields];

  const dowSet = parseField(dowSpec!, 0, 7);
  if (dowSet.delete(7)) dowSet.add(0); // 0 and 7 both mean Sunday

  return {
    ...(hasSeconds ? { second: parseField(secondSpec!, 0, 59) } : {}),
    minute: parseField(minuteSpec!, 0, 59),
    hour: parseField(hourSpec!, 0, 23),
    dom: parseField(domSpec!, 1, 31),
    month: parseField(monthSpec!, 1, 12),
    dow: dowSet,
    domRestricted: domSpec !== "*",
    dowRestricted: dowSpec !== "*",
    hasSeconds,
  };
}

interface CronFields {
  readonly second: number;
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

function utcFields(date: Date): CronFields {
  return {
    second: date.getUTCSeconds(),
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    weekday: date.getUTCDay(),
  };
}

// Pinned to `en-US` so the numeric parts are always Latin digits (some default locales emit
// non-Latin digit glyphs that `Number` cannot parse). Returns null on an invalid IANA zone, which
// makes `Intl.DateTimeFormat` throw — the caller then falls back to UTC.
function zonedFields(date: Date, timeZone: string): CronFields | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part !== undefined ? Number(part.value) : 0;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { second: get("second"), minute: get("minute"), hour: get("hour"), day, month, weekday };
}

function cronFields(date: Date, timezone?: string): CronFields {
  if (timezone === undefined) return utcFields(date);
  return zonedFields(date, timezone) ?? utcFields(date);
}

/**
 * Whether an instant matches a parsed cron, with the standard dom/dow OR-when-both-restricted rule.
 * With no `timezone` the fields are read in UTC; with an IANA `timezone` they are read at the
 * wall-clock time in that zone (invalid zones fall back to UTC).
 */
export function cronMatches(parsed: ParsedCron, date: Date, timezone?: string): boolean {
  const f = cronFields(date, timezone);
  if (parsed.second !== undefined && !parsed.second.has(f.second)) return false;
  if (!parsed.minute.has(f.minute)) return false;
  if (!parsed.hour.has(f.hour)) return false;
  if (!parsed.month.has(f.month)) return false;
  const domOk = parsed.dom.has(f.day);
  const dowOk = parsed.dow.has(f.weekday);
  return parsed.domRestricted && parsed.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

// A backward/forward search of ~382 days of minutes covers yearly (5-field) crons; a 6-field
// seconds cron is searched over the same step budget (a shorter wall-clock horizon, ample for the
// sub-hour periods seconds-resolution jobs actually use).
const MAX_STEPS = 550_000;

function floorToStep(date: Date, hasSeconds: boolean): Date {
  const d = new Date(date.getTime());
  d.setUTCMilliseconds(0);
  if (!hasSeconds) d.setUTCSeconds(0);
  return d;
}

/**
 * The latest cron fire instant at or before `now` (UTC) — the job's "current tick". Stepping back
 * from `now` by one minute (or one second for a 6-field cron), it returns the first match, or `null`
 * if none within the bounded search horizon. Deterministic in `now`, so repeated scheduler passes
 * compute the same tick — the basis for idempotent enqueue.
 */
export function cronPrevOnOrBefore(expr: string, now: Date, timezone?: string): Date | null {
  const parsed = parseCron(expr);
  const stepMs = parsed.hasSeconds ? 1_000 : 60_000;
  let cursor = floorToStep(now, parsed.hasSeconds);
  for (let i = 0; i < MAX_STEPS; i += 1) {
    if (cronMatches(parsed, cursor, timezone)) return cursor;
    cursor = new Date(cursor.getTime() - stepMs);
  }
  return null;
}

/**
 * The next cron fire instant strictly after `after` (UTC), or `null` if none within the search
 * horizon. Symmetric to `cronPrevOnOrBefore`; useful for "when does this next run" displays.
 */
export function cronNextAfter(expr: string, after: Date, timezone?: string): Date | null {
  const parsed = parseCron(expr);
  const stepMs = parsed.hasSeconds ? 1_000 : 60_000;
  let cursor = new Date(floorToStep(after, parsed.hasSeconds).getTime() + stepMs);
  for (let i = 0; i < MAX_STEPS; i += 1) {
    if (cronMatches(parsed, cursor, timezone)) return cursor;
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return null;
}

/** A scheduled job that is due at a concrete fire instant (its current tick). */
export interface ScheduledDue {
  readonly jobId: string;
  readonly fireAt: string;
}

/**
 * The scheduled jobs due as of `now` — each at its current cron tick (`cronPrevOnOrBefore`). Since
 * the tick is deterministic in `now`, every scheduler pass returns the same `fireAt` until the clock
 * crosses into the next tick, so persistence keyed on `(job, fireAt)` is naturally idempotent and
 * needs no separate last-fired state. Deprecated and non-scheduled jobs are skipped.
 */
export function scheduledJobsDue(
  jobs: readonly JobDeclaration[],
  opts: { readonly now: string },
): readonly ScheduledDue[] {
  const now = new Date(opts.now);
  const due: ScheduledDue[] = [];
  for (const job of jobs) {
    if (job.deprecated === true || job.trigger.kind !== "scheduled") continue;
    const tick = cronPrevOnOrBefore(job.trigger.cron, now, job.trigger.timezone);
    if (tick !== null) due.push({ jobId: job.id, fireAt: tick.toISOString() });
  }
  return due;
}
