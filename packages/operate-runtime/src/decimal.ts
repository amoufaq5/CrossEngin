/**
 * The wire type of a manifest `decimal` field.
 *
 * A `decimal` field compiles to `NUMERIC(precision, scale)`. node-postgres hands a `NUMERIC`
 * back as a **string**, deliberately: no JS primitive holds one. An IEEE-754 double round-trips
 * a decimal losslessly only up to {@link MAX_EXACT_DOUBLE_DIGITS} significant digits, and **51
 * of the 92 `decimal` fields the shipped packs declare have `precision >= 16`** — four of them
 * `NUMERIC(20, 10)` exchange rates. So a `number` is not a convenience with a theoretical cost;
 * it is a silent truncation of most of the catalog's declared range.
 *
 * The wire type is therefore a **canonical decimal string**, and the canonical form is not
 * invented here: it is the text Postgres itself prints for `value::numeric(precision, scale)` —
 * exactly `scale` fraction digits, `-` for negative, no exponent, no leading `+`. The typed store
 * already produces it, so bringing the JSONB and in-memory stores to the same form is a
 * convergence rather than three stores each inventing one.
 *
 * Everything here is exact. Parsing goes through `BigInt`; no value passes through a double on
 * its way to or from the wire, so this module cannot itself be the thing that loses a digit.
 */

/** A `decimal` field's declaration: total significant digits and digits after the point. */
export interface DecimalSpec {
  readonly precision: number;
  readonly scale: number;
}

/**
 * Significant decimal digits an IEEE-754 binary64 round-trips exactly (`DBL_DIG`). A decimal of
 * at most this many digits converts to the nearest double and back to the same decimal; at 16 it
 * may not. This is the number that decides a `decimal` cannot be a JS `number`.
 */
export const MAX_EXACT_DOUBLE_DIGITS = 15;

/** Whether every value a field's declaration permits survives a double round trip. */
export function decimalSpecFitsDouble(spec: DecimalSpec): boolean {
  return spec.precision <= MAX_EXACT_DOUBLE_DIGITS;
}

/** An exact decimal: `(negative ? -1 : 1) * units / 10^scale`. `units` is unsigned. */
export interface ExactDecimal {
  readonly negative: boolean;
  readonly units: bigint;
  readonly scale: number;
}

/** Why a value could not become a wire decimal. */
export const DECIMAL_REFUSALS = ["not_a_decimal", "precision_overflow"] as const;
export type DecimalRefusal = (typeof DECIMAL_REFUSALS)[number];

export type DecimalConversion =
  | { readonly ok: true; readonly wire: string }
  | { readonly ok: false; readonly reason: DecimalRefusal };

const LITERAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Whether a string is a plain decimal numeral (no exponent, no sign-only, no whitespace). */
export function isPlainDecimalLiteral(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value);
}

/**
 * Parses a decimal from a string, a JS `number` or a `bigint`; returns null for anything else,
 * for a non-finite number, and for text that is not a numeral.
 *
 * A `number` is rendered with `String()` first. That is lossless *with respect to the double*:
 * `String()` produces the shortest decimal that round-trips, so the parse captures the double
 * exactly as JS itself spells it. It cannot recover precision the double never held — which is
 * the whole argument for not putting a decimal in one.
 */
export function parseDecimal(value: unknown): ExactDecimal | null {
  if (typeof value === "bigint") {
    return { negative: value < 0n, units: value < 0n ? -value : value, scale: 0 };
  }
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? Number.isFinite(value)
          ? String(value)
          : ""
        : "";
  if (text === "" || !LITERAL_RE.test(text)) return null;

  const negative = text.startsWith("-");
  let body = negative || text.startsWith("+") ? text.slice(1) : text;
  let exponent = 0;
  const e = body.search(/[eE]/);
  if (e >= 0) {
    exponent = Number.parseInt(body.slice(e + 1), 10);
    body = body.slice(0, e);
  }
  const point = body.indexOf(".");
  const fraction = point < 0 ? "" : body.slice(point + 1);
  const digits = (point < 0 ? body : body.slice(0, point) + fraction) || "0";
  const scale = fraction.length - exponent;
  const units = BigInt(digits);
  // A negative scale means the exponent moved the point right past every digit, e.g. `1.5e3`.
  // Multiply it out so every ExactDecimal has a non-negative scale and one spelling per value.
  const normalised = scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
  return { negative: normalised.units === 0n ? false : negative, ...normalised };
}

function rescale(d: ExactDecimal, scale: number): ExactDecimal {
  if (scale === d.scale) return d;
  if (scale > d.scale) {
    return { ...d, units: d.units * 10n ** BigInt(scale - d.scale), scale };
  }
  // Half away from zero, which is what Postgres NUMERIC does: 0.005::numeric(16,2) is 0.01.
  const divisor = 10n ** BigInt(d.scale - scale);
  const quotient = d.units / divisor;
  const remainder = d.units % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return { negative: rounded === 0n ? false : d.negative, units: rounded, scale };
}

/** Digits before the point, after rounding to `scale` — what Postgres checks against `p - s`. */
function integerDigits(d: ExactDecimal): number {
  const whole = d.units / 10n ** BigInt(d.scale);
  return whole === 0n ? 0 : whole.toString().length;
}

/** Renders an exact decimal at its own scale, in Postgres's `numeric` output spelling. */
export function renderDecimal(d: ExactDecimal): string {
  const text = d.units.toString().padStart(d.scale + 1, "0");
  const body =
    d.scale === 0 ? text : `${text.slice(0, text.length - d.scale)}.${text.slice(text.length - d.scale)}`;
  return d.negative ? `-${body}` : body;
}

/**
 * The wire form of `value` for a field declared `spec`: quantised to the declared scale (half
 * away from zero) and padded to it, exactly as `value::numeric(precision, scale)` would print.
 *
 * Quantising rather than refusing is the right behaviour **at the store boundary**, where the
 * value may be a computed result (a tax split, an FX conversion) rather than something a client
 * typed: refusing would turn a correct computation into a 500. The loss is not the silent kind
 * this module exists to end — the field's declaration *is* `scale`, and what was silent before
 * was that only one of the three stores applied it. A client literal carrying more scale than
 * the field holds is a different case and is refused upstream, in `validateBody`.
 *
 * Integer overflow is refused, because Postgres refuses it: there is no scale at which
 * `12345.00` fits `NUMERIC(4, 2)`, so quantising cannot rescue it and rounding to the nearest
 * representable value would invent a figure.
 */
export function toDecimalWire(value: unknown, spec: DecimalSpec): DecimalConversion {
  const parsed = parseDecimal(value);
  if (parsed === null) return { ok: false, reason: "not_a_decimal" };
  const quantised = rescale(parsed, spec.scale);
  if (integerDigits(quantised) > spec.precision - spec.scale) {
    return { ok: false, reason: "precision_overflow" };
  }
  return { ok: true, wire: renderDecimal(quantised) };
}

/**
 * Whether `value` carries more fraction digits than the field declares — the check that makes a
 * client's over-precise literal a 422 instead of a quiet rounding. Answers false for a value
 * that is not a decimal at all (that is a type error, reported separately).
 */
export function decimalScaleExceeded(value: unknown, spec: DecimalSpec): boolean {
  const parsed = parseDecimal(value);
  if (parsed === null) return false;
  if (parsed.scale <= spec.scale) return false;
  // Trailing zeros are not extra precision: 10.2500 is 10.25 at scale 2.
  return !equalsDecimal(parsed, rescale(parsed, spec.scale));
}

/** Whether `value`'s integer part is wider than the field declares. */
export function decimalPrecisionExceeded(value: unknown, spec: DecimalSpec): boolean {
  const parsed = parseDecimal(value);
  if (parsed === null) return false;
  return integerDigits(rescale(parsed, spec.scale)) > spec.precision - spec.scale;
}

function equalsDecimal(a: ExactDecimal, b: ExactDecimal): boolean {
  return compareDecimal(a, b) === 0;
}

/** Exact three-way comparison of two parsed decimals (no double involved). */
export function compareDecimal(a: ExactDecimal, b: ExactDecimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  const lv = left.negative ? -left.units : left.units;
  const rv = right.negative ? -right.units : right.units;
  return lv === rv ? 0 : lv < rv ? -1 : 1;
}

/**
 * Exact comparison of two decimal numerals, or null when either side is not one. Used by the
 * in-memory store's sort: with decimals on the wire as strings, a `localeCompare` would order
 * `"9.50"` after `"10.25"` and so disagree with the typed store's `ORDER BY` on the same field.
 */
export function compareDecimalText(a: string, b: string): number | null {
  if (!isPlainDecimalLiteral(a) || !isPlainDecimalLiteral(b)) return null;
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  return left === null || right === null ? null : compareDecimal(left, right);
}

/**
 * A wire decimal as a JS `number` — the one named place a consumer leaves exact arithmetic. It
 * is lossy by construction above {@link MAX_EXACT_DOUBLE_DIGITS} significant digits; the point
 * of naming it is that a search for its callers lists everywhere that loss can happen.
 */
export function decimalToNumber(wire: string): number {
  return Number(wire);
}
