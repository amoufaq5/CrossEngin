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
  /** Tax withheld at source: the payer owes the total less it, so it is never open. */
  readonly withholdingField?: string;
  /** How a credit note names itself and the document it credits; absent, none is recognised. */
  readonly creditNote?: CreditNoteShape;
}

export interface CreditNoteShape {
  readonly typeField: string;
  readonly typeValue: string;
  readonly refField: string;
}

/**
 * Pure aging computation: for each document, open = total − withheld − applied; days overdue =
 * asOf − due date (0 when not yet due); bucketed by `buckets`. Fully-settled documents (open ≤ 0)
 * are dropped. Totals are summed per bucket. Deterministic, store-agnostic — the report handler
 * supplies the documents + applied amounts.
 *
 * **A credit note is negative, and it ages with the document it credits.** Its `total` is stored
 * positive (the type denotes the reduction), so it used to be aged as one more receivable: measured,
 * an invoice of 80 sent and voided showed `-CN` open 80 against a GL whose receivable was 0. Negating
 * it alone is not enough either, because the voided original is not in an open state — the report
 * would read −80 against 0. So a credit note and the document it credits are reported as a group,
 * both rows, dated by the original's due date: the group is dropped when it nets to nothing (a full
 * credit) and kept when it does not (a partial credit leaves the remainder owed). A credit note whose
 * original is not supplied stands on its own as a credit balance.
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

  const cn = input.creditNote;
  const isCreditNote = (doc: EntityRecord): boolean => cn !== undefined && doc[cn.typeField] === cn.typeValue;
  const byId = new Map<string, EntityRecord>();
  for (const doc of input.documents) byId.set(String(doc["id"] ?? ""), doc);
  const originalOf = (doc: EntityRecord): EntityRecord | null => {
    if (cn === undefined || !isCreditNote(doc)) return null;
    const ref = doc[cn.refField];
    return typeof ref === "string" ? (byId.get(ref) ?? null) : null;
  };
  const openOf = (doc: EntityRecord): number => {
    const id = String(doc["id"] ?? "");
    const withheld = input.withholdingField === undefined ? 0 : Math.max(0, num(doc[input.withholdingField]));
    const owed = num(doc[totalField]) - withheld - (input.appliedByDocument.get(id) ?? 0);
    return Math.round((isCreditNote(doc) ? -owed : owed) * 100) / 100;
  };
  // Each credited document's open balance, net of every credit note against it.
  const groupOpen = new Map<string, number>();
  for (const doc of input.documents) {
    const original = originalOf(doc);
    if (original === null) continue;
    const key = String(original["id"]);
    groupOpen.set(key, Math.round(((groupOpen.get(key) ?? openOf(original)) + openOf(doc)) * 100) / 100);
  }

  for (const doc of input.documents) {
    const id = String(doc["id"] ?? "");
    if (id === "") continue;
    const total = num(doc[totalField]);
    const applied = input.appliedByDocument.get(id) ?? 0;
    const open = openOf(doc);
    const original = originalOf(doc);
    const group = groupOpen.get(original !== null ? String(original["id"]) : id);
    if (group !== undefined) {
      if (group === 0) continue;
    } else if (isCreditNote(doc) ? open === 0 : open <= 0) {
      continue;
    }
    const dueRaw = (original ?? doc)[dueDateField];
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
