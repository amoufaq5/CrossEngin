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

/**
 * Pure: reconciles tax withheld at recognition (each invoice's `withholding_total`) against
 * the WHT certificates confirmed for it (`certifiedByInvoice`). Only invoices with a
 * positive withheld amount appear; each row's gap = withheld − certified, classified
 * certified / partial / uncertified. Rows are ordered by the largest open gap first so the
 * uncertified exposure surfaces at the top.
 */
export function computeWhtReconciliation(input: {
  readonly invoices: readonly Record<string, unknown>[];
  readonly certifiedByInvoice: ReadonlyMap<string, number>;
  readonly numberField?: string;
  readonly withholdingField?: string;
  readonly currencyField?: string;
}): WhtReconciliation {
  const numberField = input.numberField ?? "invoice_number";
  const withholdingField = input.withholdingField ?? "withholding_total";
  const currencyField = input.currencyField ?? "currency";

  // Exact ledger units throughout; the rows and totals become numbers only as they are returned.
  const rows: (WhtReconRow & { readonly gapUnits: bigint; readonly withheldUnits: bigint; readonly certifiedUnits: bigint })[] = [];
  let totalWithheld = 0n;
  let totalCertified = 0n;
  for (const inv of input.invoices) {
    const withheld = units(inv[withholdingField]);
    if (withheld <= 0n) continue;
    const id = String(inv["id"] ?? "");
    if (id === "") continue;
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
