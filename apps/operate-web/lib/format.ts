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

export function formatCell(value: unknown, kind?: string): string {
  if (value === null || value === undefined) return "—";
  const fmt = getActiveFormatting();
  if (kind === "money") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    const grouped = groupNumber(n, fmt);
    return fmt.currency ? `${grouped} ${fmt.currency}` : grouped;
  }
  if (kind === "date") {
    return formatDate(String(value), fmt);
  }
  return String(value);
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
