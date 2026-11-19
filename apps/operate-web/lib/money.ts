/**
 * Exact money arithmetic for the browser.
 *
 * A ledger amount arrives as a canonical decimal string (or, from a report, a JS number), and the
 * sums this app shows are sums of those. Adding them as doubles is wrong in the last cent at the
 * top of a `NUMERIC(16, 2)` column and, more commonly, makes a balance check need a tolerance — so
 * they are added here as integer hundredths, which is what the server's `money.ts` does too.
 */

/** Fraction digits every ledger amount column declares. */
export const LEDGER_MONEY_SCALE = 2;

const UNIT = 10n ** BigInt(LEDGER_MONEY_SCALE);

/** A money value as exact ledger units (rounded half away from zero), or null when it is not a decimal. */
export function moneyUnits(value: unknown): bigint | null {
  const text =
    typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null;
  const [, sign, whole, frac = ""] = m;
  const padded = frac.padEnd(LEDGER_MONEY_SCALE + 1, "0");
  let units = BigInt(whole!) * UNIT + BigInt(padded.slice(0, LEDGER_MONEY_SCALE) || "0");
  // Half away from zero: the first dropped digit decides, as NUMERIC(_, 2) does.
  if (Number(padded[LEDGER_MONEY_SCALE]) >= 5) units += 1n;
  return sign === "-" && units !== 0n ? -units : units;
}

/** Ledger units as canonical decimal text, e.g. `-12.30`. */
export function unitsText(units: bigint): string {
  const negative = units < 0n;
  const abs = (negative ? -units : units).toString().padStart(LEDGER_MONEY_SCALE + 1, "0");
  const text = `${abs.slice(0, abs.length - LEDGER_MONEY_SCALE)}.${abs.slice(abs.length - LEDGER_MONEY_SCALE)}`;
  return negative ? `-${text}` : text;
}

/** The exact sum of money values; an unreadable value is skipped, as a blank column is. */
export function sumMoney(values: Iterable<unknown>): bigint {
  let total = 0n;
  for (const v of values) total += moneyUnits(v) ?? 0n;
  return total;
}
