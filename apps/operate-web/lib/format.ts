export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCell(value: unknown, kind?: string): string {
  if (value === null || value === undefined) return "—";
  if (kind === "money") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
  }
  if (kind === "date") {
    const s = String(value);
    return s.length >= 10 ? s.slice(0, 10) : s;
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
