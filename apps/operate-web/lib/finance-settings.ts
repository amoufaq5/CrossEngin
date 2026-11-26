// The finance section of the tenant settings form, as data: which account-code keys the form edits,
// how each is labelled, and how a save keeps every finance key the form does not edit.
//
// One list rather than three spellings. The page used to name each account code three times — a
// picker row, a `FORM_FINANCE_KEYS` entry and a `buildFinance` line — and the six codes the
// depreciation, inventory and receiving postings read (ADR-0430, ADR-0431) were in none of the three,
// so the form could neither show nor set them and its help text sent an operator to `PUT` by hand
// (ADR-0430 Q6 / register P1.6b, closed by ADR-0478).

/** An account-code setting the form edits, in the order it is shown. */
export interface AccountCodeField {
  readonly key: string;
  readonly label: string;
}

export const ACCOUNT_CODE_FIELDS: readonly AccountCodeField[] = Object.freeze([
  { key: "arAccountCode", label: "AR account code" },
  { key: "revenueAccountCode", label: "Revenue account code" },
  { key: "apAccountCode", label: "AP account code" },
  { key: "expenseAccountCode", label: "Expense account code" },
  { key: "cashAccountCode", label: "Cash / bank account code" },
  { key: "taxPayableAccountCode", label: "Tax payable (output) code" },
  { key: "taxInputAccountCode", label: "Input tax code" },
  { key: "fxGainLossAccountCode", label: "FX gain/loss code" },
  { key: "unrealizedFxGainLossAccountCode", label: "Unrealized FX code" },
  { key: "whtReceivableAccountCode", label: "WHT receivable code" },
  { key: "whtPayableAccountCode", label: "WHT payable code" },
  { key: "taxRecoverableAccountCode", label: "Tax recoverable code" },
  { key: "depreciationExpenseAccountCode", label: "Depreciation expense code" },
  { key: "accumulatedDepreciationAccountCode", label: "Accumulated depreciation code" },
  { key: "inventoryAccountCode", label: "Inventory code" },
  { key: "cogsAccountCode", label: "Cost of goods sold code" },
  { key: "grniAccountCode", label: "Goods received not invoiced (GRNI) code" },
  { key: "inventoryVarianceAccountCode", label: "Inventory price variance code" },
]);

/** The finance keys the form edits other than the account codes. */
const OTHER_FORM_FINANCE_KEYS: readonly string[] = [
  "accountingStandard",
  "rounding",
  "defaultTaxJurisdiction",
  "defaultPaymentTermsDays",
  "multiCurrencyEnabled",
  "pricesIncludeTax",
  "taxAccountsByJurisdiction",
  "taxRemittancePosting",
];

/** The finance keys this form edits; every other finance key is carried through a save unchanged. */
export const FORM_FINANCE_KEYS: ReadonlySet<string> = new Set([
  ...OTHER_FORM_FINANCE_KEYS,
  ...ACCOUNT_CODE_FIELDS.map((f) => f.key),
]);

/**
 * The loaded finance keys the form does not edit. `PUT /v1/admin/settings` replaces the whole
 * document, so a key the form does not show would otherwise be erased by the first save.
 */
export function unmanagedFinance(loaded: unknown): Record<string, unknown> {
  if (loaded === null || typeof loaded !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
    if (!FORM_FINANCE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The finance keys the form edits, from its string state. A blank account code is omitted rather
 * than saved as `""`: the server reads an absent code as "not configured" and refuses a posting that
 * needs it by name, where an empty string would be a code that resolves to no account.
 */
export function buildFinance(f: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.accountingStandard) out.accountingStandard = f.accountingStandard;
  if (f.rounding) out.rounding = f.rounding;
  if (f.defaultTaxJurisdiction?.trim()) out.defaultTaxJurisdiction = f.defaultTaxJurisdiction.trim();
  if (f.defaultPaymentTermsDays?.trim() && Number.isFinite(Number(f.defaultPaymentTermsDays))) {
    out.defaultPaymentTermsDays = Number(f.defaultPaymentTermsDays);
  }
  if (f.multiCurrencyEnabled === "true") out.multiCurrencyEnabled = true;
  if (f.pricesIncludeTax === "true") out.pricesIncludeTax = true;
  for (const { key } of ACCOUNT_CODE_FIELDS) {
    const v = f[key]?.trim();
    if (v) out[key] = v;
  }
  if (f.taxRemittancePosting === "manual_journal" || f.taxRemittancePosting === "on_mark_paid") {
    out.taxRemittancePosting = f.taxRemittancePosting;
  }
  return out;
}
