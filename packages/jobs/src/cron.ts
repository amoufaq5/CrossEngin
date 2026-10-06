import { z } from "zod";

import type { JobDeclaration } from "./types.js";

const CRON_FIELD = String.raw`(?:\*|(?:\*\/\d+)|(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?:\/\d+)?)`;
const CRON_REGEX = new RegExp(`^${CRON_FIELD}(?: ${CRON_FIELD}){4,5}$`);

export const CronExpressionSchema = z.string().regex(CRON_REGEX, {
  message: "schedule must be a 5- or 6-field crontab expression",
});

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

/**
 * One `Intl.DateTimeFormat` per zone, for the life of the process.
 *
 * `zonedFields` used to construct one **per stepped minute**, inside a loop bounded at `MAX_STEPS`.
 * Measured on this file before the cache, `cronPrevOnOrBefore("0 0 1 * *", …)`: **26 ms with no zone
 * against 4,644 ms with `timezone: "UTC"`** — 179×, for the same answer. It is not an exotic path:
 * all eight scheduled jobs in the seven shipped packs declare `timezone: "UTC"` literally, so every
 * deployment pays it, per scheduled job per tenant per scheduler tick.
 *
 * A `null` entry caches the *refusal* for an unresolvable zone, so a bad declaration costs one throw
 * rather than one per step. The map is keyed by the zone string, whose key space is the set of zones
 * a deployment's manifests declare, and `MAX_CACHED_ZONES` bounds it anyway because a tenant-authored
 * manifest is an input: eviction is free, since this is a pure function of the key.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();
const MAX_CACHED_ZONES = 512;

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined || zoneFormatters.has(timeZone)) return cached ?? null;
  let formatter: Intl.DateTimeFormat | null;
  try {
    // Pinned to `en-US` so the numeric parts are always Latin digits (some default locales emit
    // non-Latin digit glyphs that `Number` cannot parse).
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = null;
  }
  if (zoneFormatters.size >= MAX_CACHED_ZONES) zoneFormatters.clear();
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Whether this runtime can resolve an IANA zone name.
 *
 * Exported because the alternative is the silent fallback below: a declaration naming
 * `Erope/London` ran on UTC's schedule and said nothing, which for a month-end close in Asia/Tokyo
 * is nine hours early, every month, with no error anywhere. A caller that holds a *declaration* can
 * now refuse it (see `ScheduledTriggerSchema`) instead of discovering it from a wrong fire time.
 *
 * It answers for **this process's tzdata**, which is the honest caveat: a zone added in a later ICU
 * release resolves on one node and not another. That is still strictly better than substituting a
 * schedule nobody declared, which is ADR-0331's rule about the table a value is read back from.
 */
export function isResolvableTimeZone(timeZone: string): boolean {
  return formatterFor(timeZone) !== null;
}

/**
 * Zones whose cron fields are identical to UTC's, so the `Intl` path can be skipped entirely.
 *
 * This is a maintained list and that is safe **here specifically**, which is worth stating because
 * ADR-0288's lesson is that a maintained list is how `needsAuditEmitter` was wrong three times. The
 * difference is the cost of being wrong: a name missing from this set takes the slower path and gets
 * **the same answer**. The list is an optimisation, not a semantic, so it cannot be wrong in the
 * direction that matters — which is exactly what was not true of `needsAuditEmitter`.
 *
 * `Etc/GMT+0` and `Etc/GMT-0` are both here and both mean UTC; the POSIX sign inversion that makes
 * `Etc/GMT+5` *behind* UTC does not apply at zero, so neither is a trap. `Europe/London` is **not**
 * here (BST), which is why this is a name set and not a prefix match.
 *
 * **Every member must itself be resolvable**, and that is the one way this set could be wrong in the
 * direction that matters. `"Z"` is a legal ISO offset designator and `Intl.DateTimeFormat` *rejects*
 * it as a zone — so listing it would have short-circuited an **unresolvable** zone straight to the
 * UTC reader, turning `isResolvableTimeZone`'s refusal into a silent accept, which is the exact
 * defect this file is closing. It was in the first draft of this set. A test asserts the invariant
 * rather than trusting the list.
 */
export const UTC_EQUIVALENT_ZONES: ReadonlySet<string> = new Set([
  "UTC",
  "Etc/UTC",
  "GMT",
  "Etc/GMT",
  "Etc/GMT+0",
  "Etc/GMT-0",
  "Etc/GMT0",
  "Etc/Greenwich",
  "UCT",
  "Etc/UCT",
  "Universal",
  "Etc/Universal",
  "Zulu",
  "Etc/Zulu",
]);

function zonedFields(date: Date, timeZone: string): CronFields | null {
  const formatter = formatterFor(timeZone);
  if (formatter === null) return null;
  const parts = formatter.formatToParts(date);
  // One pass rather than six `parts.find` scans: this runs once per stepped minute, and the parts
  // list is re-walked for every field otherwise.
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  // The weekday of the *local* calendar date, read in UTC so no offset can shift it.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { second, minute, hour, day, month, weekday };
}

function cronFields(date: Date, timezone?: string): CronFields {
  if (timezone === undefined || UTC_EQUIVALENT_ZONES.has(timezone)) return utcFields(date);
  return zonedFields(date, timezone) ?? utcFields(date);
}

/** Whether the *date* fields match — month plus the dom/dow OR-when-both-restricted rule. */
function dateMatches(parsed: ParsedCron, f: CronFields): boolean {
  if (!parsed.month.has(f.month)) return false;
  const domOk = parsed.dom.has(f.day);
  const dowOk = parsed.dow.has(f.weekday);
  return parsed.domRestricted && parsed.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

/** Whether the *time* fields match. Independent of `dateMatches` — see `SKIP` below. */
function timeMatches(parsed: ParsedCron, f: CronFields): boolean {
  if (parsed.second !== undefined && !parsed.second.has(f.second)) return false;
  if (!parsed.minute.has(f.minute)) return false;
  return parsed.hour.has(f.hour);
}

/**
 * Whether an instant matches a parsed cron, with the standard dom/dow OR-when-both-restricted rule.
 * With no `timezone` the fields are read in UTC; with an IANA `timezone` they are read at the
 * wall-clock time in that zone (invalid zones fall back to UTC — see `isResolvableTimeZone`).
 */
export function cronMatches(parsed: ParsedCron, date: Date, timezone?: string): boolean {
  const f = cronFields(date, timezone);
  return dateMatches(parsed, f) && timeMatches(parsed, f);
}

/**
 * The step budget for a search. It is a **step** count, not a wall-clock horizon, and the day-skip
 * below is what makes the distinction matter in the right direction.
 *
 * It used to be a step count that the comment described as covering "yearly (5-field) crons", and
 * that was false: 550,000 minutes is 382 days, so `0 0 29 2 *` — a valid crontab expression — was
 * searched over a window that **cannot contain a 29 February**, took 68 seconds of blocked CPU, and
 * returned `null`. `scheduledJobsDue` skips a job whose tick is `null`, so the job never ran and
 * nothing anywhere said so, which is this file's version of the defect ADR-0333 and ADR-0334 swept.
 */
const MAX_STEPS = 550_000;

/**
 * How far one date-mismatched step may skip ahead: to the next (or previous) local day boundary.
 *
 * **This is the fix for the leap-day case, and it is exact rather than heuristic.** `cronMatches` is
 * `dateMatches && timeMatches`, and `dateMatches` reads only `month` / `day` / `weekday` — fields
 * that are constant across a whole local day. So when the date part fails, *every* instant in that
 * local day fails, and stepping through its remaining 1,439 minutes one at a time can only produce
 * the same answer. Skipping is therefore equivalence-preserving by construction, not an
 * approximation — and a brute-force test pins that against the naive one-step-at-a-time search.
 *
 * The distance is computed from the local fields the step already read, so it needs no assumption
 * about the zone's offset: a day is 1,440 local minutes whatever UTC offset it sits at, and on a DST
 * transition day the skip simply lands early or late inside the next day, which costs extra steps
 * and never a missed match.
 *
 * What it buys: the 550,000-step budget now reaches ~1,500 years for a date-sparse expression while
 * still reaching ~382 days for a time-dense one, so the budget covers every 5-field cron there is.
 */
function minutesRemainingInLocalDay(f: CronFields, hasSeconds: boolean): number {
  const elapsed = f.hour * 60 + f.minute;
  const steps = (24 * 60 - elapsed) * (hasSeconds ? 60 : 1) - (hasSeconds ? f.second : 0);
  return Math.max(steps, 1);
}

function stepsElapsedInLocalDay(f: CronFields, hasSeconds: boolean): number {
  const elapsed = (f.hour * 60 + f.minute) * (hasSeconds ? 60 : 1) + (hasSeconds ? f.second : 0);
  return Math.max(elapsed + 1, 1);
}

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
    const f = cronFields(cursor, timezone);
    if (dateMatches(parsed, f)) {
      if (timeMatches(parsed, f)) return cursor;
      cursor = new Date(cursor.getTime() - stepMs);
    } else {
      // The whole local day is excluded, so jump behind its first instant in one step.
      cursor = new Date(cursor.getTime() - stepsElapsedInLocalDay(f, parsed.hasSeconds) * stepMs);
    }
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
    const f = cronFields(cursor, timezone);
    if (dateMatches(parsed, f)) {
      if (timeMatches(parsed, f)) return cursor;
      cursor = new Date(cursor.getTime() + stepMs);
    } else {
      // The whole local day is excluded, so jump past its last instant in one step.
      cursor = new Date(cursor.getTime() + minutesRemainingInLocalDay(f, parsed.hasSeconds) * stepMs);
    }
  }
  return null;
}

/** Days in each month in a **non**-leap year, indexed 1-12 at `[month]`. */
const COMMON_MONTH_LENGTH: readonly number[] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether any instant can ever match — a pure property of the parsed sets, computed without
 * searching.
 *
 * Crontab syntax lets you write a date that does not exist: `0 0 30 2 *` and `0 0 31 4 *` name 30
 * February and 31 April. The search answers `null` for those, which is the right answer, but it
 * answers `null` by **exhausting its whole step budget** — and `null` is also what "we gave up" looks
 * like. Asking the sets directly separates the two, so `ScheduledTriggerSchema` can refuse a
 * declaration that can never fire instead of accepting a job that silently never runs.
 *
 * Impossibility is only reachable in one of the three branches, which is why this is short:
 * - **dom unrestricted** — `dom` is every day 1-31, so every month in `month` matches on day 1.
 * - **both restricted** — the dom/dow rule is OR, and any non-empty `dow` set matches at least four
 *   times in any month, so the dom arm cannot make it unreachable.
 * - **dom restricted, dow not** — AND semantics against an all-days `dow`, so the date part is
 *   exactly `month.has(m) && dom.has(d)`, and that pair has to be a real calendar date.
 *
 * 29 February is reachable and **not** special-cased: the day-skip above made the step budget reach
 * roughly 1,500 years for a date-sparse expression, so the search finds it (verified: 0.7 ms, and
 * `2028-02-29` from a 2026 start). Before that it was indistinguishable from an impossible date.
 */
export function cronCanEverMatch(parsed: ParsedCron): boolean {
  if (!parsed.domRestricted || parsed.dowRestricted) return true;
  for (const month of parsed.month) {
    const longest = month === 2 ? 29 : COMMON_MONTH_LENGTH[month]!;
    for (const day of parsed.dom) if (day <= longest) return true;
  }
  return false;
}

/** `cronCanEverMatch` from the expression text. Throws on an unparseable expression. */
export function cronExpressionCanEverMatch(expr: string): boolean {
  return cronCanEverMatch(parseCron(expr));
}

/** Why a scheduled trigger cannot be served. Each is a declaration a deployment must fix. */
export const SCHEDULED_TRIGGER_DEFECTS = ["timezone_unresolvable", "cron_never_matches"] as const;
export type ScheduledTriggerDefect = (typeof SCHEDULED_TRIGGER_DEFECTS)[number];

/**
 * The defects in a `{cron, timezone}` pair, as a list so a caller sees all of them at once.
 *
 * Both are declarations this evaluator **cannot serve**, and the rule is ADR-0331's: substituting a
 * value for a declaration, in the place that value is read back from, is the defect. A zone
 * `Intl` cannot resolve used to fall through to UTC in silence, so a job declaring `Erope/London`
 * ran on UTC's schedule — for a month-end close in Asia/Tokyo, nine hours early, every month, with
 * nothing anywhere to look at.
 */
export function scheduledTriggerDefects(input: {
  readonly cron: string;
  readonly timezone?: string;
}): readonly ScheduledTriggerDefect[] {
  const defects: ScheduledTriggerDefect[] = [];
  if (input.timezone !== undefined && !isResolvableTimeZone(input.timezone)) {
    defects.push("timezone_unresolvable");
  }
  // A malformed expression is `CronExpressionSchema`'s refusal, not this one's.
  try {
    if (!cronExpressionCanEverMatch(input.cron)) defects.push("cron_never_matches");
  } catch {
    /* left to the expression schema */
  }
  return defects;
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
  opts: { readonly now: string; readonly onUnschedulable?: (input: UnschedulableJob) => void },
): readonly ScheduledDue[] {
  const now = new Date(opts.now);
  const due: ScheduledDue[] = [];
  for (const job of jobs) {
    if (job.deprecated === true || job.trigger.kind !== "scheduled") continue;
    const tick = cronPrevOnOrBefore(job.trigger.cron, now, job.trigger.timezone);
    if (tick !== null) {
      due.push({ jobId: job.id, fireAt: tick.toISOString() });
      continue;
    }
    // A `null` tick used to be skipped in silence, which is how `0 0 29 2 *` became a job that
    // never ran with nothing anywhere to look at. The day-skip makes a reachable date always
    // findable, so a `null` now means the expression can never match — which the trigger schema
    // refuses, so reaching here at all implies a `JobDeclaration` built in code rather than parsed.
    // Reported and not thrown: this runs per tenant per tick, and raising would stop every other
    // tenant's jobs over one bad declaration (ADR-0302's `drainAllTenants` rule).
    opts.onUnschedulable?.({
      jobId: job.id,
      cron: job.trigger.cron,
      ...(job.trigger.timezone !== undefined ? { timezone: job.trigger.timezone } : {}),
      reason: cronExpressionCanEverMatch(job.trigger.cron)
        ? "no_tick_within_horizon"
        : "cron_never_matches",
    });
  }
  return due;
}

/** Why a scheduled job produced no tick. Both mean the job will not run. */
export const UNSCHEDULABLE_REASONS = ["cron_never_matches", "no_tick_within_horizon"] as const;
export type UnschedulableReason = (typeof UNSCHEDULABLE_REASONS)[number];

export interface UnschedulableJob {
  readonly jobId: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly reason: UnschedulableReason;
}
