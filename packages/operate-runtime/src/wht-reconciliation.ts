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
  readonly totals: { readonly withheld: number; readonly certified: number; readonly uncertified: number };
  readonly byCurrency: readonly WhtCurrencySubtotal[];
  readonly rows: readonly WhtReconRow[];
}

const EPSILON = 0.005;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

  const rows: WhtReconRow[] = [];
  let totalWithheld = 0;
  let totalCertified = 0;
  for (const inv of input.invoices) {
    const withheld = round2(num(inv[withholdingField]));
    if (withheld <= EPSILON) continue;
    const id = String(inv["id"] ?? "");
    if (id === "") continue;
    const certified = round2(input.certifiedByInvoice.get(id) ?? 0);
    const gap = round2(withheld - certified);
    const status: WhtReconRow["status"] = gap <= EPSILON ? "certified" : certified > EPSILON ? "partial" : "uncertified";
    const numberRaw = inv[numberField];
    const currencyRaw = inv[currencyField];
    rows.push({
      invoiceId: id,
      number: typeof numberRaw === "string" && numberRaw.length > 0 ? numberRaw : id,
      currency: typeof currencyRaw === "string" && currencyRaw.length > 0 ? currencyRaw : null,
      withheld,
      certified,
      gap,
      status,
    });
    totalWithheld += withheld;
    totalCertified += certified;
  }
  rows.sort((a, b) => b.gap - a.gap || a.number.localeCompare(b.number));
  totalWithheld = round2(totalWithheld);
  totalCertified = round2(totalCertified);

  // Per-currency subtotals: a null currency groups under the "" key. Ordered by
  // descending uncertified exposure, then currency ascending.
  const groups = new Map<string, { withheld: number; certified: number }>();
  for (const row of rows) {
    const key = row.currency ?? "";
    const acc = groups.get(key) ?? { withheld: 0, certified: 0 };
    acc.withheld += row.withheld;
    acc.certified += row.certified;
    groups.set(key, acc);
  }
  const byCurrency: WhtCurrencySubtotal[] = [...groups.entries()]
    .map(([currency, acc]) => {
      const withheld = round2(acc.withheld);
      const certified = round2(acc.certified);
      return { currency, withheld, certified, uncertified: round2(withheld - certified) };
    })
    .sort((a, b) => b.uncertified - a.uncertified || a.currency.localeCompare(b.currency));

  return {
    totals: { withheld: totalWithheld, certified: totalCertified, uncertified: round2(totalWithheld - totalCertified) },
    byCurrency,
    rows,
  };
}
