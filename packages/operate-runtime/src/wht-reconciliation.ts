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

export interface WhtReconciliation {
  readonly totals: { readonly withheld: number; readonly certified: number; readonly uncertified: number };
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
  return {
    totals: { withheld: totalWithheld, certified: totalCertified, uncertified: round2(totalWithheld - totalCertified) },
    rows,
  };
}
