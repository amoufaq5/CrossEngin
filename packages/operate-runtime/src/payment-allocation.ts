import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";

import { moneyUnits } from "./money.js";
import { fieldAdmitsValue } from "./validation.js";
import {
  APPLIED_PAYMENT_FALLBACKS,
  PAYMENT_DIRECTION,
  paymentDirectionOf,
  paymentNamesDocument,
  settlementDocumentsFor,
  type SettlementCoverageConfig,
  type WriteGuard,
  type WriteGuardInput,
} from "./write-guards.js";

/**
 * Payment allocation (ADR-0468): a completed `Payment` counts toward a document, and may name it,
 * only when its amount is positive, it names exactly one document, and its direction posts to that
 * document's control side.
 *
 * The rule is the settlement posting's, stated as a guard. `paymentSettlementGlPostingEffect` clears
 * AR for an inbound payment and AP for any other, and skips a zero or negative amount, while the
 * application effect settled whatever document the payment named — so measured on the shipped pack an
 * outbound payment naming an invoice marked it paid with the receivable still on the GL, one inbound
 * payment naming an invoice and a bill marked both paid while only AR moved, and a completed −50
 * lowered the applied figure while posting nothing. Every one of those entries balanced, so no other
 * check could see it. The fold now counts only what the posting cleared; this guard keeps new rows
 * from being in a shape the fold has to ignore.
 *
 * **A fourth axis is checked here and not in the fold: currency.** The posting clears a control
 * account in the *payment's* currency, while the fold sums `amount` into the named document's bucket
 * as though it were in the document's — so a USD payment of 100 naming a EUR invoice of 100 marked it
 * paid with the EUR receivable untouched (measured). The guard refuses a payment whose currency is
 * not its document's, which makes the fold's figure what the posting cleared **for every guarded
 * write**. A cross-currency row stored before this guard is still counted at face value; the fold
 * cannot see a document's currency, and the remedy for such a row is refund, as for the others.
 */

/** What the manifest gives the guard to check against, or null where there is nothing to check. */
export interface PaymentAllocationShape {
  /** The declaration's entries whose document the manifest declares, in declaration order. */
  readonly documents: readonly SettlementCoverageConfig[];
  /**
   * Of {@link documents}, those whose reference field `Payment` declares — the references a payment
   * can name here. Narrower than the settlement wiring (`paymentSettlementDocuments`), which keeps a
   * declared document whose reference `Payment` lacks: its coverage guard still has to refuse a
   * settlement nothing can pay, while no payment here can carry the reference (ADR-0421 refuses an
   * undeclared field), so there is nothing for this guard to read.
   */
  readonly references: readonly SettlementCoverageConfig[];
  /**
   * Whether `Payment`'s direction field can hold the inbound value — whether a write would be
   * allowed to store it, asked of the write validator itself. An enum carrying the value can, so can
   * a `text` field; a field that is absent, an enum without it, or a kind that refuses a string
   * cannot. When it cannot, every payment reads outbound (`paymentDirectionOf`, the posting's own
   * reading), so none may name a document settled by inbound money.
   */
  readonly directionExpressible: boolean;
}

/**
 * The guard's input from the manifest: null when there is no `Payment` entity or no document the
 * declaration names, otherwise the references a payment can carry and whether its direction can say
 * inbound. One function for the guard and the boot line, so the line cannot describe a different
 * check from the one that runs.
 */
export function paymentAllocationShape(manifest: Manifest): PaymentAllocationShape | null {
  const entities = manifest.entities ?? [];
  const payment = entities.find((e) => e.name === APPLIED_PAYMENT_FALLBACKS.paymentEntity);
  if (payment === undefined) return null;
  const documents = settlementDocumentsFor(new Set(entities.map((e) => e.name)));
  if (documents.length === 0) return null;
  const fields = resolvedFields(payment, manifest.traits ?? []);
  const fieldNames = new Set(fields.map((f) => f.name));
  const direction = fields.find((f) => f.name === PAYMENT_DIRECTION.field);
  const directionExpressible = direction !== undefined && fieldAdmitsValue(direction, PAYMENT_DIRECTION.inboundValue);
  return { documents, references: documents.filter((doc) => fieldNames.has(doc.refField)), directionExpressible };
}

/** The refusals, in the order the guard checks them: the first that holds is the answer. */
export const PAYMENT_ALLOCATION_REFUSAL_CODES = [
  "payment_names_several_documents",
  "payment_direction_mismatch",
  "payment_amount_negative",
  "payment_currency_mismatch",
] as const;

export type PaymentAllocationRefusalCode = (typeof PAYMENT_ALLOCATION_REFUSAL_CODES)[number];

/** Which sentence of a refusal applies; a code with one sentence has one case. */
export const PAYMENT_ALLOCATION_REFUSAL_CASES = {
  payment_names_several_documents: ["several_documents"],
  payment_direction_mismatch: [
    "outbound_names_inbound_document",
    "unset_names_inbound_document",
    "inbound_names_outbound_document",
    "inbound_inexpressible",
  ],
  payment_amount_negative: ["amount_negative"],
  payment_currency_mismatch: ["currency_differs"],
} as const satisfies Readonly<Record<PaymentAllocationRefusalCode, readonly string[]>>;

export type PaymentAllocationRefusalCase<C extends PaymentAllocationRefusalCode = PaymentAllocationRefusalCode> =
  (typeof PAYMENT_ALLOCATION_REFUSAL_CASES)[C][number];

/**
 * Every refusal's status and sentences. Each detail is a literal: no record value is interpolated
 * (ADR-0367), so a sentence states the rule and the act that satisfies it, never the figure or id
 * that broke it. All 422: the payment is wrong in itself, which is `period_locked`'s shape and not a
 * conflict with stored state.
 *
 * The sentences name `invoice_id` and `bill_id` literally; a test holds every `*_id` they name to a
 * reference the declaration carries.
 */
export const PAYMENT_ALLOCATION_REFUSALS: {
  readonly [C in PaymentAllocationRefusalCode]: {
    readonly status: 422;
    readonly details: { readonly [K in PaymentAllocationRefusalCase<C>]: string };
  };
} = Object.freeze({
  payment_names_several_documents: {
    status: 422,
    details: {
      several_documents:
        "a payment settles one document: name either invoice_id or bill_id, not both, and record a separate payment for each",
    },
  },
  payment_direction_mismatch: {
    status: 422,
    details: {
      outbound_names_inbound_document:
        "an outbound payment cannot name an invoice: money paid out does not settle a receivable. If the money was received, set direction to 'inbound'; if it pays a supplier, name the bill in bill_id instead; to return an overpayment, refund that payment",
      unset_names_inbound_document:
        "a payment with no direction reads as outbound and cannot name an invoice: set direction to 'inbound' if the money was received, or name the bill in bill_id if it pays a supplier",
      inbound_names_outbound_document:
        "an inbound payment cannot name a bill: money received does not settle a payable. If the money was paid out, set direction to 'outbound'; if it is a customer's payment, name the invoice in invoice_id instead",
      inbound_inexpressible:
        "this deployment's Payment cannot record an 'inbound' direction, so every payment reads as outbound and none may name an invoice",
    },
  },
  payment_amount_negative: {
    status: 422,
    details: {
      amount_negative: "a payment amount cannot be negative: to take money back, refund the payment it reverses",
    },
  },
  payment_currency_mismatch: {
    status: 422,
    details: {
      currency_differs:
        "a payment settles a document in that document's own currency: record it in the currency of the document it names, or name no document",
    },
  },
});

/** Appended to a refusal met on the way into `completed`, where the payment can still be corrected. */
export const PAYMENT_ALLOCATION_COMPLETION_SUFFIX = " — correct it by an update before completing it";

/** A refusal: the code, and which of its sentences applies. */
export type PaymentAllocationViolation = {
  readonly [C in PaymentAllocationRefusalCode]: { readonly code: C; readonly case: PaymentAllocationRefusalCase<C> };
}[PaymentAllocationRefusalCode];

/** The sentence a violation is answered with. */
export function paymentAllocationDetail(violation: PaymentAllocationViolation): string {
  const details: Readonly<Record<string, string>> = PAYMENT_ALLOCATION_REFUSALS[violation.code].details;
  return details[violation.case]!;
}

/**
 * The first rule a payment record breaks, or null. Pure, and read by the guard and the tests.
 *
 * In order: it names more than one document; the one it names is settled by the other direction (or
 * by inbound money this `Payment` cannot express); its amount is negative. A zero or unreadable
 * amount passes — zero posts and counts nothing, and an unreadable one is the validator's to refuse.
 * The currency check needs the named document, so it is the guard's, after these.
 */
export function paymentAllocationViolation(
  record: Record<string, unknown>,
  shape: PaymentAllocationShape,
): PaymentAllocationViolation | null {
  const named = shape.references.filter((doc) => paymentNamesDocument(record[doc.refField]));
  if (named.length > 1) return { code: "payment_names_several_documents", case: "several_documents" };
  const doc = named[0];
  if (doc !== undefined && paymentDirectionOf(record, PAYMENT_DIRECTION) !== doc.settledBy) {
    if (doc.settledBy === "outbound") return { code: "payment_direction_mismatch", case: "inbound_names_outbound_document" };
    if (!shape.directionExpressible) return { code: "payment_direction_mismatch", case: "inbound_inexpressible" };
    // Absent reads outbound (the posting's reading), but the caller never said outbound, so the
    // sentence says what they did send.
    const stated = record[PAYMENT_DIRECTION.field];
    return stated === undefined || stated === null || stated === ""
      ? { code: "payment_direction_mismatch", case: "unset_names_inbound_document" }
      : { code: "payment_direction_mismatch", case: "outbound_names_inbound_document" };
  }
  const amount = moneyUnits(record[APPLIED_PAYMENT_FALLBACKS.amountField]);
  if (amount !== null && amount < 0n) return { code: "payment_amount_negative", case: "amount_negative" };
  return null;
}

/** Whether a write moves the payment into `completed` from anything else. */
function entersCompleted(input: WriteGuardInput): boolean {
  const { stateField, completedState } = APPLIED_PAYMENT_FALLBACKS;
  return input.before?.[stateField] !== completedState && input.after[stateField] === completedState;
}

/**
 * The currency field the settlement posting reads off a payment and `settledDocumentRate` off the
 * document it names — the same name on both, so one constant.
 */
const CURRENCY_FIELD = "currency";

/** Whether an update changes one of the fields the rule reads. */
function changesAllocation(input: WriteGuardInput, shape: PaymentAllocationShape): boolean {
  if (input.before === null) return true;
  const before = input.before;
  const fields = [
    PAYMENT_DIRECTION.field,
    APPLIED_PAYMENT_FALLBACKS.amountField,
    CURRENCY_FIELD,
    ...shape.references.map((d) => d.refField),
  ];
  return fields.some((f) => before[f] !== input.after[f]);
}

/**
 * Whether the payment's currency differs from the currency of the document it names. Passes when
 * either side carries no currency (nothing to compare) and when the named document does not exist
 * (a dangling reference is the store's to refuse, H-09). Case-insensitive, as `settledDocumentRate`
 * compares. Runs after {@link paymentAllocationViolation}, so at most one reference is named here.
 */
async function currencyViolation(input: WriteGuardInput, shape: PaymentAllocationShape): Promise<PaymentAllocationViolation | null> {
  const doc = shape.references.find((d) => paymentNamesDocument(input.after[d.refField]));
  if (doc === undefined) return null;
  const paymentCurrency = input.after[CURRENCY_FIELD];
  if (typeof paymentCurrency !== "string" || paymentCurrency.length === 0) return null;
  const named = await input.store.get(input.tenantId, doc.entity, input.after[doc.refField] as string);
  if (named === null) return null;
  const documentCurrency = named[CURRENCY_FIELD];
  if (typeof documentCurrency !== "string" || documentCurrency.length === 0) return null;
  return documentCurrency.toUpperCase() === paymentCurrency.toUpperCase()
    ? null
    : { code: "payment_currency_mismatch", case: "currency_differs" };
}

/**
 * Refuses a payment write that would leave a payment in a shape the settlement posting and the fold
 * disagree about.
 *
 * | operation | checked |
 * |---|---|
 * | create | always |
 * | update | when direction, amount, currency or a reference changes, or the update enters `completed` |
 * | transition | only entering `completed` |
 * | delete | never — `after` is `before` on a delete, so no edge is entered and nothing changes |
 *
 * **Every other transition is exempt, and `refund` most of all**: a completed payment in a bad shape
 * stored before this guard existed is locked, and refund is its only exit — measured, it reverses the
 * settlement, restores the GL and reopens the documents. A guard that checked the record on every
 * transition would refuse exactly that remedy. An update leaving these fields alone (a note, a
 * reference text) on a bad draft is allowed for the same reason the draft is editable at all: the
 * draft can still be corrected, and the completion edge is where the rule must hold.
 *
 * Wired after `Payment`'s lock, so a write to a completed payment answers `payment_locked` first.
 */
export function paymentAllocationGuard(shape: PaymentAllocationShape): WriteGuard {
  return async (input) => {
    if (input.entity !== APPLIED_PAYMENT_FALLBACKS.paymentEntity) return null;
    const completing = entersCompleted(input);
    const checked =
      input.operation === "create" || completing || (input.operation === "update" && changesAllocation(input, shape));
    if (!checked) return null;
    const violation = paymentAllocationViolation(input.after, shape) ?? (await currencyViolation(input, shape));
    if (violation === null) return null;
    // A create landing in `completed` has nothing to correct by an update first. On the compiled path
    // it cannot reach here at all — `lifecycleStateGuard` runs earlier and refuses a create outside
    // the initial state — so the clause matters to a caller that runs this guard on its own.
    const suffix = completing && input.operation !== "create" ? PAYMENT_ALLOCATION_COMPLETION_SUFFIX : "";
    return {
      status: PAYMENT_ALLOCATION_REFUSALS[violation.code].status,
      error: violation.code,
      detail: paymentAllocationDetail(violation) + suffix,
    };
  };
}
