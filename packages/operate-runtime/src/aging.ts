import type { EntityRecord } from "./store.js";

/** An aging bucket by days overdue; `maxDays === null` is the open-ended tail. */
export interface AgingBucket {
  readonly label: string;
  readonly minDays: number;
  readonly maxDays: number | null;
}

/** Standard receivable/payable aging buckets (days past due). */
export const DEFAULT_AGING_BUCKETS: readonly AgingBucket[] = [
  { label: "current", minDays: -Infinity, maxDays: 0 },
  { label: "1-30", minDays: 1, maxDays: 30 },
  { label: "31-60", minDays: 31, maxDays: 60 },
  { label: "61-90", minDays: 61, maxDays: 90 },
  { label: "90+", minDays: 91, maxDays: null },
];

export interface DocumentAging {
  readonly id: string;
  readonly number: string;
  readonly currency: string;
  readonly total: number;
  readonly applied: number;
  readonly open: number;
  readonly dueDate: string | null;
  readonly daysOverdue: number;
  readonly bucket: string;
}

export interface AgingReport {
  readonly asOf: string;
  readonly documents: readonly DocumentAging[];
  readonly totalsByBucket: Readonly<Record<string, number>>;
  readonly totalOpen: number;
  readonly currency: string | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Whole days between two ISO dates (a − b), UTC; positive when `a` is later. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((ta - tb) / 86_400_000);
}

/** The bucket label for a days-overdue value (first matching range). */
export function bucketFor(daysOverdue: number, buckets: readonly AgingBucket[] = DEFAULT_AGING_BUCKETS): string {
  for (const b of buckets) {
    if (daysOverdue >= b.minDays && (b.maxDays === null || daysOverdue <= b.maxDays)) return b.label;
  }
  return buckets[buckets.length - 1]?.label ?? "current";
}

export interface AgingInput {
  /** Open documents (already filtered to issued, unpaid states). */
  readonly documents: readonly EntityRecord[];
  /** Completed payment amounts applied per document id. */
  readonly appliedByDocument: ReadonlyMap<string, number>;
  readonly asOf: string;
  readonly numberField?: string;
  readonly totalField?: string;
  readonly dueDateField?: string;
  readonly currencyField?: string;
  readonly buckets?: readonly AgingBucket[];
}

/**
 * Pure aging computation: for each document, open = total − applied; days overdue =
 * asOf − due date (0 when not yet due); bucketed by `buckets`. Fully-settled
 * documents (open ≤ 0) are dropped. Totals are summed per bucket. Deterministic,
 * store-agnostic — the report handler supplies the documents + applied amounts.
 */
export function computeAging(input: AgingInput): AgingReport {
  const numberField = input.numberField ?? "id";
  const totalField = input.totalField ?? "total";
  const dueDateField = input.dueDateField ?? "due_date";
  const currencyField = input.currencyField ?? "currency";
  const buckets = input.buckets ?? DEFAULT_AGING_BUCKETS;

  const documents: DocumentAging[] = [];
  const totalsByBucket: Record<string, number> = {};
  for (const b of buckets) totalsByBucket[b.label] = 0;
  let totalOpen = 0;
  const currencies = new Set<string>();

  for (const doc of input.documents) {
    const id = String(doc["id"] ?? "");
    if (id === "") continue;
    const total = num(doc[totalField]);
    const applied = input.appliedByDocument.get(id) ?? 0;
    const open = Math.round((total - applied) * 100) / 100;
    if (open <= 0) continue;
    const dueRaw = doc[dueDateField];
    const dueDate = typeof dueRaw === "string" && dueRaw.length > 0 ? dueRaw.slice(0, 10) : null;
    const daysOverdue = dueDate !== null ? Math.max(0, daysBetween(input.asOf, dueDate)) : 0;
    const bucket = bucketFor(daysOverdue, buckets);
    const currency = typeof doc[currencyField] === "string" ? (doc[currencyField] as string) : "USD";
    currencies.add(currency);
    totalsByBucket[bucket] = Math.round((totalsByBucket[bucket]! + open) * 100) / 100;
    totalOpen = Math.round((totalOpen + open) * 100) / 100;
    documents.push({
      id,
      number: typeof doc[numberField] === "string" ? (doc[numberField] as string) : id,
      currency,
      total,
      applied,
      open,
      dueDate,
      daysOverdue,
      bucket,
    });
  }

  documents.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number));
  return {
    asOf: input.asOf.slice(0, 10),
    documents,
    totalsByBucket,
    totalOpen,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
  };
}
