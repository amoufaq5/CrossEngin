/**
 * The tax remittance a `TaxReturn` posts when it is marked paid (ADR-0467), as a pure contract: what
 * the return's declared figures mean in ledger legs, which of them are refused, and whether a
 * manifest carries everything the posting needs. No store I/O happens here; the effects that read
 * accounts, balances and other returns live in `write-effects.ts`.
 *
 * The figures are **typed** by whoever prepares the return, not derived from the ledger: the ledger
 * carries no tax point, no jurisdiction and no tax code on a line, and manual remittances already sit
 * in the same accounts. So the rule is to post exactly the declaration and refuse one that cannot be
 * cleared correctly — the bound against the books is the effect's.
 */
import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { FinanceAccountCodeKey } from "./settings.js";
import { lifecycleStateField } from "./list-query.js";
import { moneyUnits } from "./money.js";
import type { EntityRecord } from "./store.js";

/** How a return's three figures turn into ledger legs. */
export type TaxRemittanceShape = "credit_invoice" | "sales_tax" | "withholding";

/** `TaxReturn.return_type` → shape, over the five values `erp-core` declares. */
export const TAX_RETURN_REMITTANCE_SHAPE: Readonly<Record<string, TaxRemittanceShape>> = Object.freeze({
  vat: "credit_invoice",
  gst: "credit_invoice",
  consumption_tax: "credit_invoice",
  sales_tax: "sales_tax",
  withholding: "withholding",
});

/** What a credit-invoice return with a negative net does with the credit. */
export const TAX_CREDIT_DISPOSITIONS = ["refund_received", "carried_forward"] as const;
export type TaxCreditDisposition = (typeof TAX_CREDIT_DISPOSITIONS)[number];

/**
 * The TaxReturn fields the posting reads, and the three it stamps. A stamp the entity does not
 * declare lands as a JSONB key on `--store pg` and nowhere on `--store pg-columns`, so wiring
 * requires every one of them rather than stamping what happens to exist.
 */
export const TAX_RETURN_REMITTANCE_FIELDS = Object.freeze({
  required: Object.freeze([
    "return_number",
    "jurisdiction_id",
    "fiscal_period_id",
    "return_type",
    "period_start",
    "period_end",
    "output_tax",
    "input_tax",
    "net_payable",
    "currency",
    "credit_disposition",
  ] as const),
  stamps: Object.freeze(["remitted_at", "remittance_entry_number", "remittance_count"] as const),
});

export const TAX_REMITTANCE_ENTRY_INFIX = "-REMIT-";
export const TAX_REMITTANCE_REVERSAL_SUFFIX = "-REV";

/**
 * The entry number of the next remittance: `TAX-2026-00001-REMIT-1` for the first. Counted from the
 * stored `remittance_count` and never reset by a reversal, so a payment recorded again after
 * `reverse_payment` gets a fresh number instead of colliding with the reversed entry's.
 */
export function taxRemittanceEntryNumber(returnNumber: string, priorCount: number): string {
  if (!Number.isSafeInteger(priorCount) || priorCount < 0) {
    throw new RangeError("a remittance count is a non-negative integer");
  }
  return `${returnNumber}${TAX_REMITTANCE_ENTRY_INFIX}${(priorCount + 1).toString()}`;
}

/** The entities the posting reads or writes besides TaxReturn itself. */
const TAX_REMITTANCE_ENTITIES = [
  "TaxReturn",
  "JournalEntry",
  "JournalLine",
  "LedgerAccount",
  "TaxJurisdiction",
  "FiscalPeriod",
] as const;

/** The states the effects trigger on. Named, because a lifecycle spelling them otherwise posts nothing. */
const FILED_STATE = "filed";
const PAID_STATE = "paid";
const REVERSE_TRANSITION = "reverse_payment";

export interface TaxRemittanceWiring {
  readonly entity: "TaxReturn";
  readonly stateField: string;
  /**
   * Always `reverse_payment`, `paid → filed`: a manifest without it is unwired, because a posted
   * remittance it could not undo would be refused by the journal-reverse guard and by the return.
   */
  readonly reverseTransition: "reverse_payment";
}

interface TransitionLike {
  readonly name?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

interface LifecycleLike {
  readonly kind?: unknown;
  readonly entity?: unknown;
  readonly transitions?: readonly TransitionLike[];
}

function taxReturnLifecycle(manifest: Manifest): LifecycleLike | null {
  for (const wf of Object.values(manifest.workflows ?? {}) as readonly LifecycleLike[]) {
    if (wf.kind === "entityLifecycle" && wf.entity === "TaxReturn") return wf;
  }
  return null;
}

function fromStates(t: TransitionLike): readonly unknown[] {
  return Array.isArray(t.from) ? (t.from as readonly unknown[]) : [t.from];
}

function reversesPayment(t: TransitionLike): boolean {
  return t.name === REVERSE_TRANSITION && t.to === FILED_STATE && fromStates(t).includes(PAID_STATE);
}

/**
 * Why this manifest cannot post a remittance, one sentence per missing piece; `[]` exactly when
 * {@link taxRemittanceWiring} is non-null. The two share this function, so the boot line and the
 * effect gate cannot disagree about one manifest.
 */
export function taxRemittanceUnwiredReasons(manifest: Manifest): readonly string[] {
  const reasons: string[] = [];
  const entities = manifest.entities ?? [];
  for (const name of TAX_REMITTANCE_ENTITIES) {
    if (!entities.some((e) => e.name === name)) reasons.push(`the manifest declares no ${name} entity`);
  }
  const taxReturn = entities.find((e) => e.name === "TaxReturn");
  if (taxReturn === undefined) return reasons;

  const declared = new Set(resolvedFields(taxReturn, manifest.traits ?? []).map((f) => f.name));
  for (const field of [...TAX_RETURN_REMITTANCE_FIELDS.required, ...TAX_RETURN_REMITTANCE_FIELDS.stamps]) {
    if (!declared.has(field)) reasons.push(`TaxReturn declares no field '${field}'`);
  }

  const lifecycle = taxReturnLifecycle(manifest);
  if (lifecycle === null || lifecycleStateField(manifest, "TaxReturn") === null) {
    reasons.push("TaxReturn has no entityLifecycle workflow");
    return reasons;
  }
  const transitions = lifecycle.transitions ?? [];
  if (!transitions.some((t) => t.to === FILED_STATE)) {
    reasons.push(`TaxReturn's lifecycle has no transition into '${FILED_STATE}'`);
  }
  if (!transitions.some((t) => t.to === PAID_STATE)) {
    reasons.push(`TaxReturn's lifecycle has no transition into '${PAID_STATE}'`);
  }
  if (!transitions.some(reversesPayment)) {
    reasons.push(`TaxReturn's lifecycle has no '${REVERSE_TRANSITION}' transition from '${PAID_STATE}' to '${FILED_STATE}'`);
  }
  return reasons;
}

/** Whether, and how, this manifest posts a remittance on `TaxReturn → paid`. */
export function taxRemittanceWiring(manifest: Manifest): TaxRemittanceWiring | null {
  if (taxRemittanceUnwiredReasons(manifest).length > 0) return null;
  const stateField = lifecycleStateField(manifest, "TaxReturn");
  if (stateField === null) return null;
  return { entity: "TaxReturn", stateField, reverseTransition: REVERSE_TRANSITION };
}

/** Which account a leg posts to, by what it does. */
export type TaxRemittanceRole = "output" | "input" | "withholding" | "cash";

/** The finance setting naming each role's account. There are no literal fallbacks. */
export const TAX_REMITTANCE_ACCOUNT_SETTINGS: Readonly<Record<TaxRemittanceRole, FinanceAccountCodeKey>> =
  Object.freeze({
    output: "taxPayableAccountCode",
    input: "taxInputAccountCode",
    withholding: "whtPayableAccountCode",
    cash: "cashAccountCode",
  });

export interface TaxRemittanceLeg {
  readonly role: TaxRemittanceRole;
  readonly side: "debit" | "credit";
  /** Strictly positive ledger units; a zero leg is dropped rather than posted. */
  readonly units: bigint;
}

export interface TaxRemittancePlan {
  readonly shape: TaxRemittanceShape;
  /** Balanced legs; `[]` is a nil return, which posts no entry. */
  readonly legs: readonly TaxRemittanceLeg[];
}

export const TAX_REMITTANCE_REFUSAL_CODES = [
  "tax_return_type_unsupported",
  "tax_return_figures_invalid",
  "tax_return_figures_disagree",
  "tax_return_withholding_negative",
  "tax_return_credit_disposition_required",
  "tax_return_credit_disposition_unexpected",
  "tax_return_period_invalid",
  "functional_currency_undeclared",
  "tax_return_currency_not_functional",
  "tax_remittance_account_unresolved",
  "tax_remittance_routing_unsupported",
  "tax_return_period_overlaps",
  "tax_remittance_number_taken",
  "tax_remittance_already_reversed",
  "tax_remittance_paid_outside_posting",
  "tax_remittance_reverse_via_return",
  "tax_remittance_reinstate_via_return",
  "tax_ledger_unconverted",
  "tax_remittance_exceeds_ledger",
] as const;
export type TaxRemittanceRefusalCode = (typeof TAX_REMITTANCE_REFUSAL_CODES)[number];

/** The refusals {@link planTaxRemittance} itself produces; the rest belong to the effects that read the store. */
export const TAX_REMITTANCE_FIGURE_REFUSAL_CODES = [
  "tax_return_type_unsupported",
  "tax_return_figures_invalid",
  "tax_return_figures_disagree",
  "tax_return_withholding_negative",
  "tax_return_credit_disposition_required",
  "tax_return_credit_disposition_unexpected",
  "tax_return_period_invalid",
] as const satisfies readonly TaxRemittanceRefusalCode[];

/**
 * Every refusal's status and sentence. Each detail is a literal: a return's figures, a ledger
 * balance or a record id would reach a caller (a `tax_manager` holds no ledger grant), so nothing a
 * record carries is interpolated (ADR-0367). 422 is a return that is wrong in itself; 409 is one the
 * tenant's configuration or books cannot serve.
 */
export const TAX_REMITTANCE_REFUSALS: Readonly<
  Record<TaxRemittanceRefusalCode, { readonly status: 409 | 422; readonly detail: string }>
> = Object.freeze({
  tax_return_type_unsupported: {
    status: 422,
    detail: "this return_type has no remittance posting; record the remittance as a manual journal entry",
  },
  tax_return_figures_invalid: {
    status: 422,
    detail: "output_tax, input_tax and net_payable must each be a decimal, and output_tax and input_tax not negative",
  },
  tax_return_figures_disagree: {
    status: 422,
    detail:
      "the figures do not agree with the return type: VAT, GST and consumption tax need net_payable = output_tax - input_tax; sales tax needs input_tax 0 and net_payable = output_tax; withholding needs output_tax and input_tax 0",
  },
  tax_return_withholding_negative: {
    status: 422,
    detail: "a withholding return's net_payable cannot be negative",
  },
  tax_return_credit_disposition_required: {
    status: 422,
    detail: "a return whose net_payable is negative needs credit_disposition: refund_received or carried_forward",
  },
  tax_return_credit_disposition_unexpected: {
    status: 422,
    detail:
      "credit_disposition may be set only on a VAT, GST or consumption-tax return whose net_payable is negative, and only to refund_received or carried_forward",
  },
  tax_return_period_invalid: {
    status: 422,
    detail: "period_start and period_end must be dates, with period_start not after period_end",
  },
  functional_currency_undeclared: {
    status: 409,
    detail: "set the tenant's default currency (settings defaults.currency) before a tax return can post a remittance",
  },
  tax_return_currency_not_functional: {
    status: 409,
    detail: "the return's currency is not the tenant's default currency; a remittance posts only in the functional currency",
  },
  tax_remittance_account_unresolved: {
    status: 409,
    detail: "a finance account code this remittance needs is unset or names no ledger account",
  },
  tax_remittance_routing_unsupported: {
    status: 409,
    detail:
      "this tenant routes tax to accounts by jurisdiction or by tax code, which a remittance cannot clear per account; set finance.taxRemittancePosting to manual_journal and post the remittance by hand",
  },
  tax_return_period_overlaps: {
    status: 409,
    detail: "another filed, amended or paid return of this type for this jurisdiction covers part of the same period",
  },
  tax_remittance_number_taken: {
    status: 409,
    detail: "a journal entry already carries this return's next remittance number",
  },
  tax_remittance_already_reversed: {
    status: 409,
    detail: "this return's remittance entry has already been reversed",
  },
  tax_remittance_paid_outside_posting: {
    status: 409,
    detail:
      "this return was marked paid with no remittance posted here, so its payment is a manual journal; set finance.taxRemittancePosting to manual_journal to reverse the return, and reverse that journal by hand",
  },
  tax_remittance_reverse_via_return: {
    status: 409,
    detail: "this entry is a paid tax return's remittance; reverse it with the return's reverse_payment transition",
  },
  tax_remittance_reinstate_via_return: {
    status: 409,
    detail:
      "this entry reverses a tax return's remittance; record the payment again with the return's mark_paid, which posts a new remittance entry",
  },
  tax_ledger_unconverted: {
    status: 409,
    detail: "a foreign-currency line on a tax account carries no functional amount, so the account's balance cannot be read",
  },
  tax_remittance_exceeds_ledger: {
    status: 409,
    detail: "the return clears more from a tax account than the account holds",
  },
});

/** The account-unresolved sentence naming which setting: a key the server chose, not a record value. */
export function taxRemittanceAccountUnresolvedDetail(role: TaxRemittanceRole): string {
  return `${TAX_REMITTANCE_REFUSALS.tax_remittance_account_unresolved.detail}: set finance.${TAX_REMITTANCE_ACCOUNT_SETTINGS[role]}`;
}

export type TaxRemittancePlanResult = TaxRemittancePlan | { readonly refusal: TaxRemittanceRefusalCode };

export function isTaxRemittanceRefusal(
  result: TaxRemittancePlanResult,
): result is { readonly refusal: TaxRemittanceRefusalCode } {
  return "refusal" in result;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that names a real day, or null; compared as text, which orders it. */
function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = CALENDAR_DATE.exec(value);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? value : null;
}

/** Absent, null and `""` are no disposition; a value outside the enum is its own answer. */
function creditDisposition(value: unknown): TaxCreditDisposition | null | "unreadable" {
  if (value === undefined || value === null || value === "") return null;
  return (TAX_CREDIT_DISPOSITIONS as readonly unknown[]).includes(value) ? (value as TaxCreditDisposition) : "unreadable";
}

/**
 * The legs a return's figures post, or the refusal. Checks the figures alone (ADR-0467 §5.1); the
 * currency, routing, accounts and the ledger bound are the effect's.
 */
export function planTaxRemittance(record: EntityRecord): TaxRemittancePlanResult {
  const returnType = record["return_type"];
  // An own-property lookup: `return_type: "constructor"` must not find Object.prototype's.
  const shape =
    typeof returnType === "string" && Object.prototype.hasOwnProperty.call(TAX_RETURN_REMITTANCE_SHAPE, returnType)
      ? TAX_RETURN_REMITTANCE_SHAPE[returnType]
      : undefined;
  if (shape === undefined) return { refusal: "tax_return_type_unsupported" };

  const o = moneyUnits(record["output_tax"]);
  const i = moneyUnits(record["input_tax"]);
  const n = moneyUnits(record["net_payable"]);
  if (o === null || i === null || n === null || o < 0n || i < 0n) return { refusal: "tax_return_figures_invalid" };

  const start = calendarDate(record["period_start"]);
  const end = calendarDate(record["period_end"]);
  if (start === null || end === null || start > end) return { refusal: "tax_return_period_invalid" };

  const disposition = creditDisposition(record["credit_disposition"]);
  if (disposition === "unreadable") return { refusal: "tax_return_credit_disposition_unexpected" };

  const legs: TaxRemittanceLeg[] = [];
  const push = (role: TaxRemittanceRole, side: "debit" | "credit", units: bigint): void => {
    if (units !== 0n) legs.push({ role, side, units });
  };

  switch (shape) {
    case "credit_invoice": {
      if (n !== o - i) return { refusal: "tax_return_figures_disagree" };
      if (n >= 0n) {
        if (disposition !== null) return { refusal: "tax_return_credit_disposition_unexpected" };
        push("output", "debit", o);
        push("input", "credit", i);
        push("cash", "credit", n);
      } else if (disposition === null) {
        return { refusal: "tax_return_credit_disposition_required" };
      } else if (disposition === "refund_received") {
        push("output", "debit", o);
        push("cash", "debit", -n);
        push("input", "credit", i);
      } else {
        // Only the part input tax offsets is cleared; the remaining |N| stays in the input account
        // as the credit carried to the next return.
        push("output", "debit", o);
        push("input", "credit", o);
      }
      break;
    }
    case "sales_tax": {
      if (i !== 0n || n !== o) return { refusal: "tax_return_figures_disagree" };
      if (disposition !== null) return { refusal: "tax_return_credit_disposition_unexpected" };
      push("output", "debit", o);
      push("cash", "credit", o);
      break;
    }
    case "withholding": {
      if (o !== 0n || i !== 0n) return { refusal: "tax_return_figures_disagree" };
      if (n < 0n) return { refusal: "tax_return_withholding_negative" };
      if (disposition !== null) return { refusal: "tax_return_credit_disposition_unexpected" };
      push("withholding", "debit", n);
      push("cash", "credit", n);
      break;
    }
  }
  return { shape, legs };
}
