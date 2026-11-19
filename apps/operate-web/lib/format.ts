import { getActiveFormatting, type UiFieldSchema, type UiFormatting } from "@/lib/schema";

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const NUMBER_LOCALE: Record<string, string> = {
  "1,234.56": "en-US",
  "1.234,56": "de-DE",
  "1 234,56": "fr-FR",
};

/** The fraction digits every ledger amount column declares — what a number with no text of its own is shown at. */
const LEDGER_MONEY_SCALE = 2;

function separators(fmt: UiFormatting): { group: string; decimal: string } {
  if (fmt.numberFormat === "1234.56") return { group: "", decimal: "." };
  const locale = (fmt.numberFormat ? NUMBER_LOCALE[fmt.numberFormat] : undefined) ?? fmt.locale;
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  } catch {
    parts = new Intl.NumberFormat("en-US").formatToParts(12345.6);
  }
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

/**
 * A money value as exact decimal text, or null when it is not one.
 *
 * A decimal arrives as a canonical string at its own declared scale, so it is used as it is: no
 * double touches it, and it is shown at the scale it carries rather than at a fixed two places — a
 * zero-decimal currency's `1500` is not `1,500.00`. A JS number (a report total) has no scale of its
 * own, so it is spelled exactly by `String()` and padded to the ledger's scale.
 */
function moneyText(value: unknown): string | null {
  if (typeof value === "string") return /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return value.toFixed(LEDGER_MONEY_SCALE);
    const point = text.indexOf(".");
    const frac = point < 0 ? "" : text.slice(point + 1);
    if (frac.length >= LEDGER_MONEY_SCALE) return text;
    return `${point < 0 ? text : text.slice(0, point)}.${frac.padEnd(LEDGER_MONEY_SCALE, "0")}`;
  }
  return null;
}

/** Groups exact decimal text with the tenant's separators, digit for digit. */
function groupDecimalText(text: string, fmt: UiFormatting): string {
  const { group, decimal } = separators(fmt);
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf(".");
  const whole = point < 0 ? body : body.slice(0, point);
  const frac = point < 0 ? "" : body.slice(point + 1);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${negative ? "-" : ""}${grouped}${frac === "" ? "" : decimal + frac}`;
}

/**
 * The tenant's functional currency — the right label for a figure the ledger states in it (a
 * functional debit or credit, a revaluation), and the wrong one for a document amount, which is in
 * the document's own currency.
 */
export function functionalCurrency(): string | null {
  return getActiveFormatting().currency ?? null;
}

/**
 * The currency a money field of a record is stated in. A record's own `currency` is its transaction
 * currency, which is right for its amounts and wrong for the two kinds of field that carry the base
 * currency beside them: a journal line's `functional_debit`/`functional_credit`, and a payment's
 * `cash_amount` (the base-currency cash the settlement posts as such). Labelling those with the
 * record's currency put `EUR` beside a USD figure.
 */
export function moneyFieldCurrency(fieldName: string, recordCurrency: unknown): string | null {
  if (fieldName.startsWith("functional_") || fieldName === "cash_amount") return functionalCurrency();
  return typeof recordCurrency === "string" && recordCurrency !== "" ? recordCurrency : null;
}

function formatDate(iso: string, fmt: UiFormatting): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso.length >= 10 ? iso.slice(0, 10) : iso;
  const [, y, mo, d] = m;
  switch (fmt.dateFormat) {
    case "DD/MM/YYYY":
      return `${d}/${mo}/${y}`;
    case "MM/DD/YYYY":
      return `${mo}/${d}/${y}`;
    case "DD.MM.YYYY":
      return `${d}.${mo}.${y}`;
    default:
      return `${y}-${mo}-${d}`;
  }
}

const MONEY_NAME = /(total|amount|price|cost|tax|budget|salary|debit|credit|payable|receivable|value|balance|fee)/;
const NOT_MONEY_NAME = /(_pct|percent|hours|days|quantity|qty|rate|weight|probability)/;

/**
 * Whether a field holds money. The schema carries no money marker — a manifest has no money field
 * kind, so a `decimal` is a price, a percentage or a quantity alike — and this is a name guess,
 * narrowed by the one fact the schema does carry: money is a `decimal`. Measured over `erp-core`'s
 * fields, the earlier guess (any number named like a total) missed seven money fields, among them
 * `JournalLine.debit`/`credit` and both functional amounts, and matched none it should not; this one
 * matches the 48 `decimal` money fields and nothing else. A manifest-declared marker is the real
 * fix, and it is a schema decision.
 */
export function isMoneyField(field: UiFieldSchema): boolean {
  return field.decimal !== undefined && MONEY_NAME.test(field.name) && !NOT_MONEY_NAME.test(field.name);
}

/**
 * Renders a cell. A `money` value is labelled with `currency` when the caller states it — the
 * record's own `currency`, or {@link functionalCurrency} for a figure the ledger states in it — and
 * with nothing when it does not. It used to be labelled with the tenant's currency unconditionally,
 * which put `USD` beside every EUR invoice's total.
 */
export function formatCell(value: unknown, kind?: string, currency?: string | null): string {
  if (value === null || value === undefined) return "—";
  const fmt = getActiveFormatting();
  if (kind === "money") {
    const text = moneyText(value);
    if (text === null) return String(value);
    const grouped = groupDecimalText(text, fmt);
    return typeof currency === "string" && currency !== "" ? `${grouped} ${currency}` : grouped;
  }
  if (kind === "date") {
    return formatDate(String(value), fmt);
  }
  return String(value);
}

/** Compact human age from a millisecond duration: "just now", "5m", "3h", "4d", "2w". */
export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** A deterministic surface tone for an enum/badge value. */
export function badgeTone(value: string): string {
  const v = value.toLowerCase();
  if (["active", "paid", "approved", "completed", "posted", "received", "reimbursed", "filled", "open"].includes(v)) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
  }
  if (["draft", "pending", "submitted", "prospect", "scheduled"].includes(v)) {
    return "bg-amber-50 text-amber-700 ring-amber-600/20";
  }
  if (["void", "cancelled", "rejected", "failed", "overdue", "suspended", "blacklisted", "terminated", "discontinued", "closed"].includes(v)) {
    return "bg-brand-50 text-brand-700 ring-brand-600/20";
  }
  return "bg-surface-sunken text-ink-muted ring-line";
}
