/**
 * Ledger money as exact integers.
 *
 * Every amount column a posting writes is `decimal(_, 2)`, so the ledger's unit is the hundredth of
 * its currency and every sum, difference and conversion here is done in that unit as a `bigint`. A
 * value read from a record goes through `parseDecimal` (no double on the way in), and one written
 * goes out as `Number(units) / 100`, which is the double whose shortest spelling is the decimal
 * itself while the units fit a double exactly (|amount| below 2^53 hundredths, about 9.0e13 — a
 * `NUMERIC(16, 2)` column reaches 1e14, so the top tenth of its range is not exact on the way out).
 */
import {
  type ExactDecimal,
  multiplyDecimal,
  parseDecimal,
  quantizeDecimal,
  renderDecimal,
} from "./decimal.js";

/** The fraction digits every ledger amount column declares. */
export const LEDGER_MONEY_SCALE = 2;

const UNIT = 10n ** BigInt(LEDGER_MONEY_SCALE);

/** A value as exact ledger units (rounded half away from zero to two places), or null when it is no decimal. */
export function moneyUnits(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseDecimal(value);
  if (parsed === null) return null;
  const q = quantizeDecimal(parsed, LEDGER_MONEY_SCALE);
  return q.negative ? -q.units : q.units;
}

/** {@link moneyUnits}, with an absent or unreadable value as zero — the column default it stands for. */
export function unitsOf(value: unknown): bigint {
  return moneyUnits(value) ?? 0n;
}

/** Ledger units as the number a record carries; exact while |units| < 2^53 (see the module note). */
export function unitsToNumber(units: bigint): number {
  return Number(units) / Number(UNIT);
}

/** Ledger units as their canonical decimal text, e.g. `-12.30`. */
export function renderMoney(units: bigint): string {
  const negative = units < 0n;
  return renderDecimal({ negative, units: negative ? -units : units, scale: LEDGER_MONEY_SCALE });
}

/** Ledger units as an exact decimal. */
export function unitsToDecimal(units: bigint): ExactDecimal {
  const negative = units < 0n;
  return { negative, units: negative ? -units : units, scale: LEDGER_MONEY_SCALE };
}

/** An exact decimal rounded to ledger units, half away from zero. */
export function decimalToUnits(d: ExactDecimal): bigint {
  const q = quantizeDecimal(d, LEDGER_MONEY_SCALE);
  return q.negative ? -q.units : q.units;
}

/** The rate a functional-currency posting carries. */
export const RATE_ONE: ExactDecimal = { negative: false, units: 1n, scale: 0 };

/** A strictly positive exchange rate, or null. */
export function positiveRate(value: unknown): ExactDecimal | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseDecimal(value);
  if (parsed === null || parsed.negative || parsed.units === 0n) return null;
  return parsed;
}

export function isRateOne(rate: ExactDecimal): boolean {
  return !rate.negative && rate.units === 10n ** BigInt(rate.scale);
}

/** A rate as the value a `fx_rate` column is written with: `1` for the identity, else its exact text. */
export function rateWire(rate: ExactDecimal): number | string {
  return isRateOne(rate) ? 1 : renderDecimal(rate);
}

/** `units × rate`, rounded half away from zero to ledger units. */
export function convertUnits(units: bigint, rate: ExactDecimal): bigint {
  return decimalToUnits(multiplyDecimal(unitsToDecimal(units), rate));
}

/** One side of a line in ledger units: what it debits and what it credits. */
export interface UnitPair {
  readonly d: bigint;
  readonly c: bigint;
}

/**
 * The functional amounts of a set of lines that balance in their own currency, at one rate, such
 * that **the functional amounts balance too and every one of them is a rounding of its exact
 * product** — the two properties `journalPostingGuard` checks and that rounding each line on its own
 * does not give: three lines of 33.33 at 1.5 round to 50.00 each against a 100.00 they balance, so
 * the functional legs come out 150.00 against 149.99 or 150.01.
 *
 * Each line starts at its nearest rounding; while the legs disagree, the line whose move to its
 * *other* rounding costs the least extra error is moved, at most once each. That always closes:
 * the exact products balance (one rate, balanced amounts), so the floors and the ceilings bracket a
 * balanced choice. Largest remainder, for the same reason an apportionment uses it.
 */
export function convertBalanced(lines: readonly UnitPair[], rate: ExactDecimal): UnitPair[] {
  if (isRateOne(rate)) return lines.map((l) => ({ d: l.d, c: l.c }));
  const divisor = 10n ** BigInt(rate.scale);
  const rateUnits = rate.units;
  interface Leg {
    value: bigint;
    floor: bigint;
    remainder: bigint;
    moved: boolean;
  }
  const leg = (amount: bigint): Leg => {
    const product = amount * rateUnits;
    // `bigint` division truncates toward zero, so a negative product needs the floor taken by hand:
    // otherwise its "floor" is a ceiling, its remainder is negative, and a move can step a leg away
    // from its exact product instead of to its other rounding.
    let floor = product / divisor;
    let remainder = product % divisor;
    if (remainder < 0n) {
      floor -= 1n;
      remainder += divisor;
    }
    const nearest = remainder * 2n >= divisor ? floor + 1n : floor;
    return { value: nearest, floor, remainder, moved: false };
  };
  const debits = lines.map((l) => leg(l.d));
  const credits = lines.map((l) => leg(l.c));
  const total = (legs: readonly Leg[]): bigint => legs.reduce((a, l) => a + l.value, 0n);
  let gap = total(debits) - total(credits);
  // Each move changes one leg by one unit toward its other rounding. Its cost is how much further
  // from the exact product that leaves it: (2r − 1) for a leg rounded up and moved down, (1 − 2r)
  // for one rounded down and moved up, in units of `divisor`.
  while (gap !== 0n) {
    let best: { leg: Leg; delta: bigint; cost: bigint } | null = null;
    const consider = (l: Leg, delta: bigint): void => {
      if (l.moved || l.remainder === 0n) return;
      const roundedUp = l.value === l.floor + 1n;
      if (delta < 0n && !roundedUp) return;
      if (delta > 0n && roundedUp) return;
      const cost = roundedUp ? 2n * l.remainder - divisor : divisor - 2n * l.remainder;
      if (best === null || cost < best.cost) best = { leg: l, delta, cost };
    };
    // A surplus of debits is closed by lowering a debit or raising a credit, and the reverse.
    for (const l of debits) consider(l, gap > 0n ? -1n : 1n);
    for (const l of credits) consider(l, gap > 0n ? 1n : -1n);
    const chosen = best as { leg: Leg; delta: bigint } | null;
    if (chosen === null) throw new Error("functional amounts cannot be balanced at this rate");
    chosen.leg.value += chosen.delta;
    chosen.leg.moved = true;
    gap = total(debits) - total(credits);
  }
  return lines.map((_, i) => ({ d: debits[i]!.value, c: credits[i]!.value }));
}
