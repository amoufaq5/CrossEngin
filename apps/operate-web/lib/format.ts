import { getActiveFormatting, type UiFormatting } from "@/lib/schema";

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

function groupNumber(n: number, fmt: UiFormatting): string {
  if (fmt.numberFormat === "1234.56") return n.toFixed(2);
  const locale = (fmt.numberFormat ? NUMBER_LOCALE[fmt.numberFormat] : undefined) ?? fmt.locale;
  return n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/**
 * Whether `n` still names the decimal `text` exactly. `String(n)` alone is too strict — a
 * canonical wire decimal is padded to its declared scale, so `"10.00"` renders as `"10"` while
 * being the same number — so the comparison is made at the text's own scale.
 */
function roundTripsExactly(text: string, n: number): boolean {
  const point = text.indexOf(".");
  const scale = point < 0 ? 0 : text.length - point - 1;
  // `toFixed` only accepts 0-100; past that, treat the value as one a double cannot name.
  if (scale > 100) return false;
  return n.toFixed(scale) === text;
}

export function formatCell(value: unknown, kind?: string): string {
  if (value === null || value === undefined) return "—";
  const fmt = getActiveFormatting();
  if (kind === "money") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    // A decimal arrives as a canonical string and may carry more digits than a double holds, so
    // grouping it would print a figure that is not the stored one — `99999999999999.99` groups as
    // `99,999,999,999,999.98`, a cent out. When the round trip is not exact the raw value is shown
    // instead: harder to read, but a money column that quietly displays the wrong figure is the
    // thing the wire type exists to prevent.
    if (typeof value === "string" && !roundTripsExactly(value, n)) {
      return fmt.currency ? `${value} ${fmt.currency}` : value;
    }
    const grouped = groupNumber(n, fmt);
    return fmt.currency ? `${grouped} ${fmt.currency}` : grouped;
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
