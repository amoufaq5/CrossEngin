/**
 * The wire type of a manifest `date`, `time` and `datetime` field.
 *
 * The defect this closes is the same shape as the `decimal` one, and the reason it was invisible is
 * that it looked like it had been answered. Every *server-side* writer in this workspace spells an
 * instant `new Date().toISOString()` — `YYYY-MM-DDTHH:mm:ss.sssZ`, fixed width, always `Z` — and
 * that form's byte order **is** its chronological order, so ordering a `datetime` as text was
 * correct everywhere anyone looked. But `validateBody` had no rule for a `date`, `time` or
 * `datetime` field at all, so a **client** could store any string, and four spellings of one
 * instant then sort into three positions straddling an instant an hour later (measured on
 * PostgreSQL 16.13):
 *
 * ```
 * 2026-01-31T05:00:00-05:00   ->  2026-01-31 10:00:00+00
 * 2026-01-31T10:00:00.000Z    ->  2026-01-31 10:00:00+00
 * 2026-01-31T10:00:00Z       ->  2026-01-31 10:00:00+00
 * 2026-01-31T11:00:00.000Z    ->  2026-01-31 11:00:00+00   <- an hour LATER, sorts third
 * 2026-01-31T19:00:00+09:00   ->  2026-01-31 10:00:00+00   <- the first instant again, sorts last
 * ```
 *
 * So the canonical form is not invented here either: it is **the form every server writer already
 * produces**, which is also what `kernel-pg`'s `isoInstant` and `isoCalendarDate` produce for a
 * `TIMESTAMPTZ` and a `DATE` column. Bringing the JSONB and in-memory stores to it is a
 * convergence, and the point of pinning it is that text order becomes chronological **by
 * construction** rather than by every writer happening to agree.
 *
 * Nothing here goes through `Date.parse`. That is deliberate and measured: `Date.parse("2026")` is
 * a valid date (1 January), `Date.parse("Jan 31 2026")` parses, and
 * `Date.parse("2026-01-31T19:00:00+09")` — a form Postgres accepts — is `NaN`. A guard that admits
 * what Postgres admits and a parser that accepts a different set is two spellings of one rule, so
 * the fields are read out of the match itself and the epoch computed with `Date.UTC`.
 */

/** The three manifest field kinds that name a point or a part of civil time. */
export const TEMPORAL_KINDS = ["date", "time", "datetime"] as const;
export type TemporalKind = (typeof TEMPORAL_KINDS)[number];

/** Whether a field kind has a temporal wire form. */
export function isTemporalKind(kind: string): kind is TemporalKind {
  return (TEMPORAL_KINDS as readonly string[]).includes(kind);
}

/** Why a value could not become a wire date, time or instant. */
export const TEMPORAL_REFUSALS = [
  "not_an_instant",
  "not_a_calendar_date",
  "not_a_time_of_day",
  "submillisecond_precision",
] as const;
export type TemporalRefusal = (typeof TEMPORAL_REFUSALS)[number];

export type TemporalConversion =
  | { readonly ok: true; readonly wire: string }
  | { readonly ok: false; readonly reason: TemporalRefusal };

/**
 * The set of stored spellings that **name an instant**, as one pattern with two consumers: a
 * `RegExp` here and a POSIX-ERE literal inside the SQL a text-holding store emits. Two spellings
 * of one set is ADR-0332's `FEATURE_FLAG_COLUMN_NAMES` defect, so there is one string.
 *
 * It is deliberately **wider** than the canonical wire form — a space separator, an absent or
 * longer fractional part, and a `+hh:mm` / `+hhmm` / `+hh` offset all match — because
 * `withDatetimeWireType` *serves* every one of those as an instant, and a row shown as an instant
 * must not be ordered as unknown.
 *
 * It is deliberately **narrower** than `timestamptz` itself. `infinity`, `-infinity`, `now`,
 * `today`, `epoch` and a bare `2026` all cast successfully and none of them is an instant a row
 * holds; admitting them would let `ORDER BY (x)::timestamptz` sort by a value the serving contract
 * never issued.
 *
 * An **offset is required**, which is the one narrowing worth the sentence: `2026-01-31T10:00:00`
 * does not name an instant. Postgres reads it in the session's `TimeZone`, ECMAScript reads it in
 * the process's local zone, and the two are routinely different — so a cast would order rows by a
 * deployment-dependent guess. It lands in the NULL tail instead.
 */
const DATETIME_PATTERN_BODY =
  "[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|z|[+-][0-9]{2}(:?[0-9]{2})?)";

/** The instant guard as a POSIX ERE, for a SQL `~` literal. Anchored. */
export const DATETIME_SQL_PATTERN = `^${DATETIME_PATTERN_BODY}$`;

/** The same guard as a JS `RegExp` — one pattern, two consumers. */
export const DATETIME_WIRE_RE = new RegExp(DATETIME_SQL_PATTERN);

/** Whether `value` is a spelling a guarded `::timestamptz` cast may safely order by. */
export function isDatetimeSqlSafe(value: string): boolean {
  return DATETIME_WIRE_RE.test(value);
}

const DATETIME_PARTS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|([+-])(\d{2}):?(\d{2})?)$/;
const DATE_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PARTS_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

/** A parsed instant, truncated to the millisecond the wire form carries. */
export interface ParsedInstant {
  readonly epochMs: number;
  /** Fraction digits the literal carried, before truncation. */
  readonly fractionDigits: number;
  /** True when a digit past the third is non-zero, i.e. the wire form cannot hold this value. */
  readonly submillisecond: boolean;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/**
 * Parses an instant from a `Date` or from a string matching {@link DATETIME_WIRE_RE}; returns null
 * for anything else, including an invalid `Date` and a syntactically valid but impossible date
 * (`2026-02-30`).
 *
 * Sub-millisecond digits are **truncated**, not rounded, and reported: Postgres holds microseconds
 * and node-postgres truncates them building the `Date`, so truncating is what the typed store
 * already does, and rounding here would make the two disagree at exactly the boundary.
 */
export function parseInstant(value: unknown): ParsedInstant | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : { epochMs: ms, fractionDigits: 3, submillisecond: false };
  }
  if (typeof value !== "string") return null;
  const m = DATETIME_PARTS_RE.exec(value.trim());
  if (m === null) return null;
  const [, y, mo, d, hh, mm, ss, frac, zone, sign, offH, offM] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!isCalendarDate(year, month, day)) return null;
  const hour = Number(hh);
  const minute = Number(mm);
  const second = Number(ss);
  // A leap second (`:60`) is refused: `Date.UTC` would roll it into the next minute, so accepting
  // it would silently move the instant rather than reject a value nothing in this workspace emits.
  if (hour > 23 || minute > 59 || second > 59) return null;
  const digits = frac ?? "";
  const millis = Number((digits + "000").slice(0, 3));
  let epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (zone !== "Z" && zone !== "z") {
    const offsetMinutes = Number(offH) * 60 + Number(offM ?? "0");
    if (Number(offH) > 23 || Number(offM ?? "0") > 59) return null;
    epochMs += (sign === "-" ? 1 : -1) * offsetMinutes * 60_000;
  }
  if (!Number.isFinite(epochMs)) return null;
  return {
    epochMs,
    fractionDigits: digits.length,
    // Trailing zeros are not extra precision, exactly as `decimalScaleExceeded` reads `10.2500`.
    submillisecond: /[1-9]/.test(digits.slice(3)),
  };
}

/**
 * The canonical wire form of a `datetime` value: `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Fixed width, always UTC, always three fraction digits — so byte order is chronological for every
 * value the field can hold, which is the whole purpose of naming a form.
 *
 * An offset is **normalised**, not refused, because the question a refusal answers is *does the
 * canonical form hold the same value?* and `2026-01-31T19:00:00+09:00` is the same instant as
 * `2026-01-31T10:00:00.000Z`. A `TIMESTAMPTZ` column does not retain the offset either, so
 * refusing would refuse a value the database itself accepts, in the most common JSON spelling
 * there is. Sub-millisecond digits are the case the form genuinely cannot hold; they are truncated
 * here, where the value may be computed, and refused upstream in `validateBody`, where a client
 * can still correct it — ADR-0332's provenance split.
 */
export function toDatetimeWire(value: unknown): TemporalConversion {
  const parsed = parseInstant(value);
  if (parsed === null) return { ok: false, reason: "not_an_instant" };
  return { ok: true, wire: new Date(parsed.epochMs).toISOString() };
}

/**
 * The canonical wire form of a `date` value: `YYYY-MM-DD`.
 *
 * Nothing else is accepted, and that asymmetry with `datetime` is the decision. A `datetime`'s
 * alternative spellings name the same instant unambiguously; a `date`'s do not. `01/31/2026` and
 * `31/01/2026` are one string with two readings, and a full instant like
 * `2026-01-31T23:00:00.000Z` is a calendar date only once somebody picks a time zone to read it in
 * — which is precisely the local-versus-UTC midnight error ADR-0331 measured, where
 * `toISOString().slice(0, 10)` answers the previous day anywhere east of UTC. So there is one
 * spelling, and anything else is a refusal rather than a guess.
 *
 * A `Date` is read through its **local** calendar parts, for `isoCalendarDate`'s measured reason:
 * node-postgres parses a `DATE` into local midnight, so the local parts are the written date in
 * every zone and the UTC parts are not.
 */
export function toDateWire(value: unknown): TemporalConversion {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, reason: "not_a_calendar_date" };
    const y = value.getFullYear().toString().padStart(4, "0");
    const m = (value.getMonth() + 1).toString().padStart(2, "0");
    const d = value.getDate().toString().padStart(2, "0");
    return { ok: true, wire: `${y}-${m}-${d}` };
  }
  if (typeof value !== "string") return { ok: false, reason: "not_a_calendar_date" };
  const m = DATE_PARTS_RE.exec(value.trim());
  if (m === null) return { ok: false, reason: "not_a_calendar_date" };
  if (!isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    return { ok: false, reason: "not_a_calendar_date" };
  }
  return { ok: true, wire: `${m[1]}-${m[2]}-${m[3]}` };
}

/**
 * The canonical wire form of a `time` value: `HH:mm:ss`, plus a fractional part with trailing
 * zeros stripped when one is present — **Postgres's own `TIME` output spelling**, which is what a
 * `TIME` column hands back as text.
 *
 * Not padded to a fixed fraction width, which would be the tidier-looking choice and is wrong
 * twice: it would truncate the microseconds a `TIME` holds, and it would make the canonical form
 * disagree with the one the typed store already produces, so this module would be the only reason
 * the two stores agree. Byte order is still chronological, by the two facts that the `HH:mm:ss`
 * head is fixed-width and zero-padded, and that two fraction strings with no trailing zeros
 * compare lexicographically in the same order as their values.
 *
 * `H:mm` and a missing seconds field are accepted and normalised, unlike a `date`'s alternatives,
 * because neither is ambiguous: `9:00` is one time of day, and `<input type="time">` emits exactly
 * that. `24:00:00` is refused even though Postgres accepts it — nothing in this workspace writes
 * it, and an hour field that may read 24 costs every reader a special case.
 */
export function toTimeWire(value: unknown): TemporalConversion {
  if (typeof value !== "string") return { ok: false, reason: "not_a_time_of_day" };
  const m = TIME_PARTS_RE.exec(value.trim());
  if (m === null) return { ok: false, reason: "not_a_time_of_day" };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "not_a_time_of_day" };
  const head = `${hour.toString().padStart(2, "0")}:${m[2]}:${second.toString().padStart(2, "0")}`;
  const fraction = (m[4] ?? "").replace(/0+$/, "");
  return { ok: true, wire: fraction === "" ? head : `${head}.${fraction}` };
}

/**
 * The wire form of `value` for a field of `kind` — a **total** map over {@link TemporalKind}, so a
 * fourth temporal kind is a compile error here rather than a value passing through unconverted.
 */
export const TEMPORAL_WIRE_CONVERTERS: {
  readonly [K in TemporalKind]: (value: unknown) => TemporalConversion;
} = {
  date: toDateWire,
  time: toTimeWire,
  datetime: toDatetimeWire,
};

/** The wire form of `value` for a field of `kind`. */
export function toTemporalWire(value: unknown, kind: TemporalKind): TemporalConversion {
  return TEMPORAL_WIRE_CONVERTERS[kind](value);
}

/**
 * Whether a `datetime` literal carries more precision than the wire form holds — the check that
 * makes a client's microsecond literal a 422 instead of a quiet truncation. Answers false for a
 * value that is not an instant at all (that is a type error, reported separately), exactly as
 * `decimalScaleExceeded` does.
 */
export function datetimeSubmillisecondExceeded(value: unknown): boolean {
  const parsed = parseInstant(value);
  return parsed !== null && parsed.submillisecond;
}

/**
 * Exact comparison of two canonical `datetime` wire strings, or null when either side is not an
 * instant. The in-memory store's comparator uses it so a *legacy* spelling still orders by its
 * instant rather than by its bytes, which is the one thing a byte comparison of two different
 * spellings cannot do.
 */
export function compareInstantText(a: string, b: string): number | null {
  const left = parseInstant(a);
  const right = parseInstant(b);
  if (left === null || right === null) return null;
  return left.epochMs === right.epochMs ? 0 : left.epochMs < right.epochMs ? -1 : 1;
}
