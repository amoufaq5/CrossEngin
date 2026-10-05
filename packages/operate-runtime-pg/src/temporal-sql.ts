import { DATETIME_SQL_PATTERN, parseInstant } from "@crossengin/operate-runtime";

/**
 * The SQL side of a `timestamptz` list key: a cast to `timestamptz` that **cannot raise**, over a
 * JSONB document column that has no type enforcing its contents.
 *
 * ## Why a guard at all
 *
 * `document ->> 'occurred'` is TEXT whichever way the JSON held the value, so one row written
 * before `withDatetimeWireType` existed — or by a path that bypassed it — makes an unguarded
 * `ORDER BY (document ->> 'occurred')::timestamptz` raise for **every** page of that entity,
 * including the pages that do not contain the row, because the sort evaluates the cast on every
 * candidate before `LIMIT` applies. This is `guardedNumericCast`'s argument verbatim.
 *
 * ## Why the guard is not one regex
 *
 * `DATETIME_SQL_PATTERN` is a *syntax* filter and nothing more. Measured on PostgreSQL 16.13,
 * every one of these matches it and `::timestamptz` **raises** on all of them:
 *
 * | text | why it raises |
 * |---|---|
 * | `2026-02-30T00:00:00Z` | no 30th of February |
 * | `2026-02-29T00:00:00Z` | 2026 is not a leap year |
 * | `2026-04-31T00:00:00Z` | April has 30 days |
 * | `2026-13-01T00:00:00Z` | month 13 |
 * | `0000-01-01T00:00:00Z` | year 0 does not exist |
 * | `2026-01-31T11:60:00Z` | minute 60 |
 * | `2026-01-31T11:00:00+99:00` | offset beyond ±15:59 |
 *
 * So the guard is `DATETIME_SQL_PATTERN` **and** {@link DATETIME_SQL_RANGE_PATTERN} **and** one
 * calendar conjunct. The range half is a regex because month, day, hour, minute and second sit at
 * *fixed* offsets in every spelling the syntax pattern admits (`YYYY-MM-DDTHH:MM:SS` is 19
 * characters wide before the fraction), so a regex states their ranges exactly. The offset is
 * matched end-anchored, because the fraction makes its position variable.
 *
 * The one thing left is **day-beyond-month-length**, which a regex cannot express without a
 * leap-year parser written in it — ADR-0292's refused problem. So it is **asked of Postgres**
 * instead (ADR-0330's rule): `make_date(y, m, 1) + (d - 1)` is total for every `y ≥ 100`,
 * `m ∈ 1..12`, `d ∈ 1..31` the regexes already guarantee, and it lands in the *following* month
 * exactly when `d` overflows — so comparing its month back to `m` is Postgres's own calendar
 * answering the question, for the price of one `make_date` and one date addition.
 *
 * `pg_input_is_valid(text, 'timestamptz')` would be this question asked in one call, and is not
 * available: it arrived in **PostgreSQL 16** and `MIN_POSTGRES_MAJOR` is **14** (a tripwire test in
 * `list-sql.test.ts` asserts that, and says to swap when the floor rises). `to_timestamp` is not
 * an alternative either — its `OF` field is output-only (`formatting field "OF" is only supported
 * in to_char`, measured), so it cannot read an offset, which is the one conversion the cast exists
 * for.
 *
 * ## Why this is a cast and not a text normalisation
 *
 * Because the admitted set is wider than the canonical wire form, deliberately: a legacy
 * `2026-01-31T19:00:00+09:00` *is* an instant, `withDatetimeWireType` serves it as one, and a row
 * shown as an instant must not be ordered as unknown. Text order cannot place it — measured live,
 * the JSONB store put it five positions away from where the column store put it.
 *
 * The cost is named rather than hidden: `timestamptz_in` is **STABLE**, not IMMUTABLE (measured,
 * `pg_proc.provolatile = 's'`), so unlike `::numeric` this expression **cannot back an index** —
 * `CREATE INDEX … ((document ->> 'f')::timestamptz)` is refused with *functions in index expression
 * must be marked IMMUTABLE*. Nothing indexes a document field today, so this costs no plan that
 * exists; it does mean a future index on a `datetime` list key has to be a generated column.
 * `timestamptz_in` is stable because a text with no offset is read in the session's `TimeZone` —
 * which is why `DATETIME_SQL_PATTERN` requires one, and why this guard inherits determinism from
 * that requirement rather than from the cast.
 */
export const DATETIME_SQL_RANGE_PATTERN =
  "^(0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" +
  "[T ]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";

/**
 * The offset-hour ceiling Postgres enforces, stated as a number as well as inside
 * {@link DATETIME_SQL_OFFSET_PATTERN}, because {@link isDatetimeComparable} tests it
 * arithmetically while the SQL tests it with a regex. A test asserts the pattern's `1[0-5]` bound
 * and this number are the same ceiling — one set with two spellings is only safe when something
 * checks they agree, which is ADR-0332's rule.
 */
export const TIMESTAMPTZ_OFFSET_HOURS_SQL = 15;

/**
 * The offset half of the range guard, end-anchored because the fractional part makes the offset's
 * position variable.
 *
 * `parseInstant` admits `±00:00` through `±23:59` and Postgres accepts no more than `±15:59`, so
 * this is the one place the two sides genuinely differ and the difference is resolved **in favour
 * of Postgres** — narrowing SQL to match JS would mean admitting a text that raises, which is the
 * whole thing this module exists to prevent. `isDatetimeComparable` applies the same bound, so the
 * two still admit one set.
 */
export const DATETIME_SQL_OFFSET_PATTERN = "(Z|z|[+-](0[0-9]|1[0-5])(:?[0-5][0-9])?)$";

/**
 * Whether `value` is a spelling this module's SQL guard admits — one predicate for both sides of the
 * seam, so a cursor component and the ordering expression agree about which rows have an ordering
 * value at all.
 *
 * It is `parseInstant`, not `isDatetimeSqlSafe`: the latter is `DATETIME_SQL_PATTERN` alone and so
 * answers true for every row in the table above. `parseInstant` rejects all of them (impossible
 * calendar date, leap second, hour > 23, minute > 59, offset > 23:59, year < 100) and is therefore
 * the set the SQL guard is built to reproduce. {@link guardedTimestamptzCast}'s cross-check test
 * pins the two against each other live.
 *
 * The one place they still differ is an offset of ±16:00 … ±23:59, which `parseInstant` accepts and
 * Postgres refuses. That difference is resolved in favour of **Postgres**, here, by the extra
 * offset-hour bound — because the alternative is a cast that raises.
 */
export function isDatetimeComparable(value: string): boolean {
  // `parseInstant` trims; every pattern here is anchored, so it does not. Surrounding whitespace is
  // therefore **outside** the set on both sides — the narrower of the two readings and the safe
  // direction, since such a row sorts in the NULL tail and never raises. This is the decimal
  // guard's measured lesson in a second place: JS `.trim()` strips every Unicode space while
  // Postgres's `~ '^…'` and `btrim` do not agree about which, so nothing may rest on whose
  // whitespace definition wins.
  if (value !== value.trim()) return false;
  if (parseInstant(value) === null) return false;
  const offset = /[+-](\d{2}):?(\d{2})?$/.exec(value);
  return offset === null || Number(offset[1]) <= TIMESTAMPTZ_OFFSET_HOURS_SQL;
}

/**
 * Wraps a text-valued expression in a cast to `timestamptz` that cannot raise. See the module
 * documentation on {@link DATETIME_SQL_RANGE_PATTERN} for why it is three conjuncts and not one.
 *
 * The calendar conjunct sits in a **nested** `CASE` rather than beside the regexes in one `WHEN`:
 * `substring(expr, 1, 4)::int` raises on a text that is not four digits there, and Postgres does not
 * guarantee the evaluation order of `AND` operands, so a flat conjunction could evaluate the
 * arithmetic against a row the regexes were meant to have excluded. The nesting makes the
 * short-circuit a property of `CASE` — which *is* guaranteed — rather than of operand order.
 */
export function guardedTimestamptzCast(expr: string): string {
  const year = `substring(${expr}, 1, 4)::int`;
  const month = `substring(${expr}, 6, 2)::int`;
  const day = `substring(${expr}, 9, 2)::int`;
  const asDeclared = `make_date(${year}, ${month}, 1) + (${day} - 1)`;
  return (
    `CASE WHEN ${expr} ~ '${DATETIME_SQL_PATTERN}'` +
    ` AND ${expr} ~ '${DATETIME_SQL_RANGE_PATTERN}'` +
    ` AND ${expr} ~ '${DATETIME_SQL_OFFSET_PATTERN}'` +
    ` THEN CASE WHEN EXTRACT(MONTH FROM ${asDeclared}) = ${month}` +
    ` THEN (${expr})::timestamptz END END`
  );
}
