import { moneyUnits, unitsToNumber } from "./money.js";

/** A single invoice's withholding-vs-certified reconciliation row. */
export interface WhtReconRow {
  readonly invoiceId: string;
  readonly number: string;
  readonly currency: string | null;
  readonly withheld: number;
  readonly certified: number;
  readonly gap: number;
  readonly status: "certified" | "partial" | "uncertified";
}

/** A per-currency subtotal across the reconciliation rows. */
export interface WhtCurrencySubtotal {
  readonly currency: string;
  readonly withheld: number;
  readonly certified: number;
  readonly uncertified: number;
}

export interface WhtReconciliation {
  /** Summed over every currency; a quantity only when one currency is present — `byCurrency` is the per-currency form. */
  readonly totals: { readonly withheld: number; readonly certified: number; readonly uncertified: number };
  readonly byCurrency: readonly WhtCurrencySubtotal[];
  readonly rows: readonly WhtReconRow[];
}

/** A figure in exact ledger units; an unreadable one is zero, the column default it stands for. */
function units(v: unknown): bigint {
  return moneyUnits(v) ?? 0n;
}

/** How a credit note is told apart from the invoice it credits, and how it names that invoice. */
export interface WhtCreditNoteShape {
  readonly typeField: string;
  readonly typeValue: string;
  readonly refField: string;
}

/**
 * Pure: reconciles tax withheld at recognition (each invoice's `withholding_total`) against
 * the WHT certificates confirmed for it (`certifiedByInvoice`). Only invoices with a
 * positive withheld amount appear; each row's gap = withheld − certified, classified
 * certified / partial / uncertified. Rows are ordered by the largest open gap first so the
 * uncertified exposure surfaces at the top.
 *
 * **What an invoice withheld is its own figure less what its credit notes took back** (ADR-0475).
 * A void issues a credit note that copies the invoice's `withholding_total` (scaled, on a partial
 * credit), and that copy is a reversal of the withholding, not a second one — so counting both
 * doubled the withheld total for every voided invoice while the ledger held none of it. So:
 *
 * - a credit note (`creditNote`) is never a row; its withholding is netted against the invoice it
 *   names (`creditedByInvoice`), and one in `voidedStates` itself is not netted, since a withdrawn
 *   credit took nothing back;
 * - an invoice in `voidedStates` that no credit note names withheld nothing — the void that issues a
 *   credit note fires only from an issued state, so a void with none was voided before it was issued,
 *   and a figure on it is not tax a customer withheld;
 * - a voided invoice a credit note *does* name keeps whatever that credit left standing, which is
 *   zero for a full void and the remainder for a partial one — the aging report's reading of the
 *   same pair.
 */
export function computeWhtReconciliation(input: {
  readonly invoices: readonly Record<string, unknown>[];
  readonly certifiedByInvoice: ReadonlyMap<string, number>;
  /** The lifecycle states that cancel an invoice. Required: an omitted set would count every void. */
  readonly voidedStates: readonly string[];
  readonly stateField?: string;
  readonly creditNote?: WhtCreditNoteShape;
  /** Withholding the credit notes naming each invoice took back, in ledger units. */
  readonly creditedByInvoice?: ReadonlyMap<string, bigint>;
  readonly numberField?: string;
  readonly withholdingField?: string;
  readonly currencyField?: string;
}): WhtReconciliation {
  const numberField = input.numberField ?? "invoice_number";
  const withholdingField = input.withholdingField ?? "withholding_total";
  const currencyField = input.currencyField ?? "currency";
  const stateField = input.stateField ?? "state";
  const voided = new Set(input.voidedStates);
  const cn = input.creditNote;

  // Exact ledger units throughout; the rows and totals become numbers only as they are returned.
  const rows: (WhtReconRow & { readonly gapUnits: bigint; readonly withheldUnits: bigint; readonly certifiedUnits: bigint })[] = [];
  let totalWithheld = 0n;
  let totalCertified = 0n;
  for (const inv of input.invoices) {
    if (cn !== undefined && inv[cn.typeField] === cn.typeValue) continue;
    const id = String(inv["id"] ?? "");
    if (id === "") continue;
    const credited = input.creditedByInvoice?.get(id) ?? 0n;
    const state = inv[stateField];
    if (typeof state === "string" && voided.has(state) && credited === 0n) continue;
    const withheld = units(inv[withholdingField]) - credited;
    if (withheld <= 0n) continue;
    const certified = units(input.certifiedByInvoice.get(id) ?? 0);
    const gap = withheld - certified;
    const status: WhtReconRow["status"] = gap <= 0n ? "certified" : certified > 0n ? "partial" : "uncertified";
    const numberRaw = inv[numberField];
    const currencyRaw = inv[currencyField];
    rows.push({
      invoiceId: id,
      number: typeof numberRaw === "string" && numberRaw.length > 0 ? numberRaw : id,
      currency: typeof currencyRaw === "string" && currencyRaw.length > 0 ? currencyRaw : null,
      withheld: unitsToNumber(withheld),
      certified: unitsToNumber(certified),
      gap: unitsToNumber(gap),
      status,
      gapUnits: gap,
      withheldUnits: withheld,
      certifiedUnits: certified,
    });
    totalWithheld += withheld;
    totalCertified += certified;
  }
  rows.sort((a, b) => (a.gapUnits === b.gapUnits ? a.number.localeCompare(b.number) : b.gapUnits > a.gapUnits ? 1 : -1));

  // Per-currency subtotals: a null currency groups under the "" key. Ordered by
  // descending uncertified exposure, then currency ascending.
  const groups = new Map<string, { withheld: bigint; certified: bigint }>();
  for (const row of rows) {
    const key = row.currency ?? "";
    const acc = groups.get(key) ?? { withheld: 0n, certified: 0n };
    acc.withheld += row.withheldUnits;
    acc.certified += row.certifiedUnits;
    groups.set(key, acc);
  }
  const byCurrency: WhtCurrencySubtotal[] = [...groups.entries()]
    .map(([currency, acc]) => ({
      currency,
      withheld: unitsToNumber(acc.withheld),
      certified: unitsToNumber(acc.certified),
      uncertified: unitsToNumber(acc.withheld - acc.certified),
    }))
    .sort((a, b) => b.uncertified - a.uncertified || a.currency.localeCompare(b.currency));

  return {
    totals: {
      withheld: unitsToNumber(totalWithheld),
      certified: unitsToNumber(totalCertified),
      uncertified: unitsToNumber(totalWithheld - totalCertified),
    },
    byCurrency,
    rows: rows.map(({ gapUnits: _g, withheldUnits: _w, certifiedUnits: _c, ...row }) => row),
  };
}
