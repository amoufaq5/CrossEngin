import type { Manifest } from "@crossengin/kernel/manifest";

import { lifecycleStateField } from "./list-query.js";
import { lockedDocumentGuard, type LockedDocumentConfig, type WriteGuard } from "./write-guards.js";

/**
 * The documents `defaultWriteGuards` locks once their state has made them a legal or ledger record,
 * declared **once** (ADR-0480).
 *
 * Before this the lock lived in two hand-kept places: the `lockedDocumentGuard` configs in
 * `compile.ts`, and `STATE_LOCKED_ENTITIES`, a list beside them naming the entities whose `state`
 * field a write is conditioned on (ADR-0422) — "mirrors the guard list by hand" in ADR-0433's own
 * words, which is ADR-0288's maintained-list shape. A document added to one and not the other was
 * either locked with no compare-and-set on its state (two concurrent confirms posting twice) or
 * conditioned with no lock. Both are now read off this table, so they cannot disagree.
 *
 * Where each state field comes from is part of the declaration, because the shipped guards differ:
 * - `state` — the guard reads `state` whatever the manifest's lifecycle says, which is what every
 *   pack's documents use;
 * - `lifecycle_or_state` — the lifecycle's own field where there is one, else `state` with the
 *   plain-update allowances below (`WhtCertificate`, which no shipped pack gives a lifecycle);
 * - `lifecycle` — only where a lifecycle declares the field, and no guard at all without one
 *   (`FiscalPeriod`: with no lifecycle the status is a plain field and a lock would forbid reopening
 *   outright, which is a decision nobody has made).
 *
 * The documents whose state has caused a general-ledger posting — `Bill`, `Payment`,
 * `WhtCertificate`, `FiscalPeriod` — were enumerated from `defaultWriteEffects`' own triggers rather
 * than chosen: `Bill`'s recognition fires on entering `approved`, a `Payment`'s settlement on
 * entering `completed`, a `WhtCertificate`'s clearing on entering `confirmed`. The rule is *a
 * document whose state has caused a posting cannot be deleted, and its posting-relevant fields and
 * lines cannot change* — otherwise deleting it and creating it again with the same number posts a
 * second time, which was measured live for an approved Bill (204, 201, 200: two journal entries for
 * one bill number). The locked set is every state at or past the trigger, including the ones that
 * post no reversal of their own. `void` is reachable from `draft` too, so a bill voided without ever
 * being approved is locked as well; refusing to delete a void document is the `Invoice` precedent.
 * Deliberately **not** here: `Expense`, which no effect posts from in any state, and `GoodsReceipt`,
 * whose lock is the inventory accounting's and is built only where that accounting is wired.
 */
export type LockedStateFieldSource = "state" | "lifecycle_or_state" | "lifecycle";

export interface LockedDocumentChild {
  readonly entity: string;
  readonly parentField: string;
}

export interface LockedDocumentSpec {
  readonly entity: string;
  readonly stateFieldSource: LockedStateFieldSource;
  readonly lockedStates: readonly string[];
  /**
   * Line entities locked with the parent. Each one the manifest declares gets its own guard; none
   * declared gets one guard with no child arm. `SalesOrder` lists two because core's line entity is
   * `SalesOrderLine` and retail's is `OrderLine`, and a resolved retail manifest carries both.
   */
  readonly children: readonly LockedDocumentChild[];
  readonly lockedError: string;
  readonly childLockedError?: string;
  readonly noun: string;
  readonly nounByState?: Readonly<Record<string, string>>;
  /** Transition name → the remedy sentence, read off the entity's lifecycle per locked state. */
  readonly corrections: Readonly<Record<string, string>>;
  /**
   * For `lifecycle_or_state` with no lifecycle: the plain-update moves still allowed while locked,
   * the fields ignored when deciding "only the state changed", and the fixed remedies.
   */
  readonly withoutLifecycle?: {
    readonly allowedUpdateTransitions: Readonly<Record<string, readonly string[]>>;
    readonly ignoredFields: readonly string[];
    readonly hintByState: Readonly<Record<string, string>>;
  };
}

const SALES_ORDER_LOCKED_STATES = ["confirmed", "fulfilled", "invoiced", "closed", "placed", "returned"] as const;

/** In the order `defaultWriteGuards` pushes them; `compile.ts` interleaves other guards between some. */
export const LOCKED_DOCUMENT_SPECS: readonly LockedDocumentSpec[] = [
  // Issued invoices are legal records: once out of draft they can't be edited or deleted (correct by
  // void/credit note); their lines lock with them. `void` fires from `draft` too, so a void invoice
  // may never have been issued.
  {
    entity: "Invoice",
    stateFieldSource: "state",
    lockedStates: ["sent", "overdue", "paid", "void"],
    children: [{ entity: "InvoiceLine", parentField: "invoice_id" }],
    lockedError: "invoice_locked",
    childLockedError: "invoice_locked_lines",
    noun: "issued invoice",
    nounByState: { void: "void invoice" },
    corrections: { void: "void it instead" },
  },
  // Filed tax returns are submitted to authorities: correct via `amend`, or a paid one via
  // `reverse_payment`.
  {
    entity: "TaxReturn",
    stateFieldSource: "state",
    lockedStates: ["filed", "paid"],
    children: [],
    lockedError: "tax_return_locked",
    noun: "filed tax return",
    nounByState: { paid: "paid tax return" },
    corrections: { amend: "amend it instead", reverse_payment: "reverse the payment instead" },
  },
  // A committed sales order is a customer commitment; the states span the core
  // (confirmed→…→closed) and retail (placed/returned) lifecycles.
  {
    entity: "SalesOrder",
    stateFieldSource: "state",
    lockedStates: SALES_ORDER_LOCKED_STATES,
    children: [
      { entity: "SalesOrderLine", parentField: "sales_order_id" },
      { entity: "OrderLine", parentField: "sales_order_id" },
    ],
    lockedError: "sales_order_locked",
    childLockedError: "sales_order_locked_lines",
    noun: "committed sales order",
    corrections: { cancel: "cancel it instead" },
  },
  // An approved purchase order is a supplier commitment: locked once submitted. `submitted` precedes
  // approval, so "an approved purchase order" was false of it.
  {
    entity: "PurchaseOrder",
    stateFieldSource: "state",
    lockedStates: ["submitted", "approved", "received", "closed"],
    children: [{ entity: "PurchaseOrderLine", parentField: "purchase_order_id" }],
    lockedError: "purchase_order_locked",
    childLockedError: "purchase_order_locked_lines",
    noun: "approved purchase order",
    nounByState: { submitted: "submitted purchase order", received: "received purchase order", closed: "closed purchase order" },
    corrections: { cancel: "cancel it instead" },
  },
  {
    entity: "Bill",
    stateFieldSource: "state",
    lockedStates: ["approved", "overdue", "paid", "void"],
    children: [{ entity: "BillLine", parentField: "bill_id" }],
    lockedError: "bill_locked",
    childLockedError: "bill_locked_lines",
    noun: "approved bill",
    nounByState: { void: "void bill", paid: "paid bill", overdue: "overdue bill" },
    corrections: { void: "void it instead, which reverses its posting" },
  },
  {
    entity: "Payment",
    stateFieldSource: "state",
    lockedStates: ["completed", "refunded"],
    children: [],
    lockedError: "payment_locked",
    noun: "completed payment",
    nounByState: { refunded: "refunded payment" },
    corrections: { refund: "refund it if the money was returned, which reverses its settlement" },
  },
  // No lifecycle in any shipped pack, so its state moves by a plain update: `confirmed → draft →
  // confirmed` posted the clearing entry once per arrival. The one move left open is
  // `confirmed → void`, which posts nothing and lands in a locked state.
  {
    entity: "WhtCertificate",
    stateFieldSource: "lifecycle_or_state",
    lockedStates: ["confirmed", "void"],
    children: [],
    lockedError: "wht_certificate_locked",
    noun: "confirmed WHT certificate",
    nounByState: { void: "void WHT certificate" },
    corrections: { void: "void it instead, which reverses its clearing" },
    withoutLifecycle: {
      allowedUpdateTransitions: { confirmed: ["void"] },
      ignoredFields: ["confirmed_at"],
      hintByState: { confirmed: "set its state to 'void' instead, which reverses its clearing" },
    },
  },
  // A closed period's dates decide which postings it holds, so editing them reopens it by another
  // name, while `reopen` is the named, permission-gated way.
  {
    entity: "FiscalPeriod",
    stateFieldSource: "lifecycle",
    lockedStates: ["closed", "locked"],
    children: [],
    lockedError: "fiscal_period_locked",
    noun: "closed fiscal period",
    nounByState: { locked: "locked fiscal period" },
    corrections: { reopen: "reopen it instead, which is its own permission and its own audit row" },
  },
];

/** The entity the posted-entry immutability guard locks by its `state` field. */
export const POSTED_ENTRY_ENTITY = "JournalEntry";

/**
 * The entities whose write is conditioned on a `state` field even where no lifecycle declares one:
 * every spec whose guard may read `state`, and the posted-entry guard's entity. Derived, so a spec
 * added above is conditioned by the same change (ADR-0433 Q6).
 */
export const STATE_LOCKED_ENTITIES: readonly string[] = Object.freeze([
  ...LOCKED_DOCUMENT_SPECS.filter((s) => s.stateFieldSource !== "lifecycle").map((s) => s.entity),
  POSTED_ENTRY_ENTITY,
]);

export function lockedDocumentSpec(entity: string): LockedDocumentSpec {
  const spec = LOCKED_DOCUMENT_SPECS.find((s) => s.entity === entity);
  if (spec === undefined) throw new RangeError(`no locked-document spec for '${entity}'`);
  return spec;
}

/**
 * The remedy a locked document's refusal names, per locked state: the declared transitions out of
 * that state which correct the document, each with the sentence that names it.
 *
 * Read off the entity's own lifecycle rather than written once per document, because one sentence
 * per document was false of some of its locked states — `void it instead` to a `paid` invoice
 * (`void` fires from draft, sent and overdue), `amend it instead` to a `paid` tax return. A state no
 * correction leaves gets no remedy at all, which is ADR-0334's rule: naming a fix that cannot work
 * is worse than naming none. An entity with no lifecycle has no transitions to name, so it gets an
 * empty map rather than the sentence a pack's lifecycle would have earned.
 */
export function correctionHints(
  manifest: Manifest,
  entity: string,
  lockedStates: readonly string[],
  corrections: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {};
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle" || wf.entity !== entity) continue;
    for (const state of lockedStates) {
      const clauses = wf.transitions
        .filter((t) => corrections[t.name] !== undefined && (Array.isArray(t.from) ? t.from : [t.from]).includes(state))
        .map((t) => corrections[t.name] as string);
      if (clauses.length > 0) hints[state] = clauses.join("; or ");
    }
  }
  return hints;
}

/** The `lockedDocumentGuard` configs a spec yields on this manifest: none when it does not apply. */
export function lockedDocumentConfigs(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  spec: LockedDocumentSpec,
): readonly LockedDocumentConfig[] {
  if (!entityNames.has(spec.entity)) return [];
  const lifecycleField = lifecycleStateField(manifest, spec.entity);
  if (spec.stateFieldSource === "lifecycle" && lifecycleField === null) return [];
  const useLifecycle = spec.stateFieldSource !== "state" && lifecycleField !== null;
  const plain = spec.stateFieldSource === "lifecycle_or_state" && lifecycleField === null ? spec.withoutLifecycle : undefined;
  const base: LockedDocumentConfig = {
    entity: spec.entity,
    ...(useLifecycle ? { stateField: lifecycleField } : {}),
    lockedStates: spec.lockedStates,
    ...(plain !== undefined
      ? { allowedUpdateTransitions: plain.allowedUpdateTransitions, ignoredFields: plain.ignoredFields }
      : {}),
    lockedError: spec.lockedError,
    ...(spec.childLockedError !== undefined ? { childLockedError: spec.childLockedError } : {}),
    noun: spec.noun,
    ...(spec.nounByState !== undefined ? { nounByState: spec.nounByState } : {}),
    hintByState: plain !== undefined ? plain.hintByState : correctionHints(manifest, spec.entity, spec.lockedStates, spec.corrections),
  };
  const present = spec.children.filter((c) => entityNames.has(c.entity));
  if (present.length === 0) return [base];
  return present.map((c) => ({ ...base, childEntity: c.entity, childParentField: c.parentField }));
}

/** The guards `defaultWriteGuards` pushes for one locked document, in its position. */
export function lockedDocumentGuardsFor(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  entity: string,
): readonly WriteGuard[] {
  return lockedDocumentConfigs(manifest, entityNames, lockedDocumentSpec(entity)).map(lockedDocumentGuard);
}
