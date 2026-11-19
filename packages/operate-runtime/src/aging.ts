import { moneyUnits, unitsOf, unitsToNumber } from "./money.js";
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

/** One currency's open balances. */
export interface AgingCurrencyTotals {
  readonly totalsByBucket: Readonly<Record<string, number>>;
  readonly totalOpen: number;
}

export interface AgingReport {
  readonly asOf: string;
  readonly documents: readonly DocumentAging[];
  /**
   * Summed over every document, whatever its currency — a figure only when `currency` is non-null.
   * With documents in more than one currency it adds euros to dollars, so a reader wanting a total
   * then reads `totalsByCurrency`.
   */
  readonly totalsByBucket: Readonly<Record<string, number>>;
  readonly totalOpen: number;
  /** The one currency every document is in, or null when they are in several. */
  readonly currency: string | null;
  /** The same totals per currency, which is the only form that is a quantity with mixed currencies. */
  readonly totalsByCurrency: Readonly<Record<string, AgingCurrencyTotals>>;
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

  // Every figure in exact ledger units, handed back as numbers only at the end: the per-addition
  // rounding of doubles this replaced is exact only while every partial sum stays under 2^53 / 100.
  const documents: DocumentAging[] = [];
  const bucketUnits = new Map<string, bigint>(buckets.map((b) => [b.label, 0n]));
  let openUnitsTotal = 0n;
  const perCurrency = new Map<string, { buckets: Map<string, bigint>; open: bigint }>();
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
  const openOf = (doc: EntityRecord): bigint => {
    const id = String(doc["id"] ?? "");
    const withheldRaw = input.withholdingField === undefined ? 0n : unitsOf(doc[input.withholdingField]);
    const withheld = withheldRaw > 0n ? withheldRaw : 0n;
    const owed = unitsOf(doc[totalField]) - withheld - (moneyUnits(input.appliedByDocument.get(id) ?? 0) ?? 0n);
    return isCreditNote(doc) ? -owed : owed;
  };
  // Each credited document's open balance, net of every credit note against it.
  const groupOpen = new Map<string, bigint>();
  for (const doc of input.documents) {
    const original = originalOf(doc);
    if (original === null) continue;
    const key = String(original["id"]);
    groupOpen.set(key, (groupOpen.get(key) ?? openOf(original)) + openOf(doc));
  }

  for (const doc of input.documents) {
    const id = String(doc["id"] ?? "");
    if (id === "") continue;
    const total = unitsToNumber(unitsOf(doc[totalField]));
    const applied = input.appliedByDocument.get(id) ?? 0;
    const open = openOf(doc);
    const original = originalOf(doc);
    const group = groupOpen.get(original !== null ? String(original["id"]) : id);
    if (group !== undefined) {
      if (group === 0n) continue;
    } else if (isCreditNote(doc) ? open === 0n : open <= 0n) {
      continue;
    }
    const dueRaw = (original ?? doc)[dueDateField];
    const dueDate = typeof dueRaw === "string" && dueRaw.length > 0 ? dueRaw.slice(0, 10) : null;
    const daysOverdue = dueDate !== null ? Math.max(0, daysBetween(input.asOf, dueDate)) : 0;
    const bucket = bucketFor(daysOverdue, buckets);
    const currency = typeof doc[currencyField] === "string" ? (doc[currencyField] as string) : "USD";
    currencies.add(currency);
    bucketUnits.set(bucket, (bucketUnits.get(bucket) ?? 0n) + open);
    openUnitsTotal += open;
    const mine = perCurrency.get(currency) ?? { buckets: new Map(buckets.map((b) => [b.label, 0n])), open: 0n };
    mine.buckets.set(bucket, (mine.buckets.get(bucket) ?? 0n) + open);
    mine.open += open;
    perCurrency.set(currency, mine);
    documents.push({
      id,
      number: typeof doc[numberField] === "string" ? (doc[numberField] as string) : id,
      currency,
      total,
      applied,
      open: unitsToNumber(open),
      dueDate,
      daysOverdue,
      bucket,
    });
  }

  documents.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number));
  const asNumbers = (m: ReadonlyMap<string, bigint>): Record<string, number> =>
    Object.fromEntries([...m].map(([k, v]) => [k, unitsToNumber(v)]));
  return {
    asOf: input.asOf.slice(0, 10),
    documents,
    totalsByBucket: asNumbers(bucketUnits),
    totalOpen: unitsToNumber(openUnitsTotal),
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    totalsByCurrency: Object.fromEntries(
      [...perCurrency].map(([currency, t]) => [currency, { totalsByBucket: asNumbers(t.buckets), totalOpen: unitsToNumber(t.open) }]),
    ),
  };
}
