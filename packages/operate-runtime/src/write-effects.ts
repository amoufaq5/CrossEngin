import type { EntityRecord, ListFilter } from "./store.js";
import type { WriteGuardInput } from "./write-guards.js";

/** A side effect run after a write has been persisted (the after-commit sibling of WriteGuard). */
export type WriteEffectInput = WriteGuardInput;
export type WriteEffect = (input: WriteEffectInput) => Promise<void>;

/** Runs effects in order; an effect that throws aborts the chain (caller maps it to 500). */
export async function runWriteEffects(effects: readonly WriteEffect[], input: WriteEffectInput): Promise<void> {
  for (const effect of effects) {
    await effect(input);
  }
}

export interface JournalReversalConfig {
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly postedState?: string;
  readonly reversedState?: string;
  readonly numberField?: string;
  readonly entryDateField?: string;
  readonly postedAtField?: string;
  readonly memoField?: string;
  readonly sourceField?: string;
  readonly reversalSource?: string;
  readonly lineEntryRefField?: string;
  readonly debitField?: string;
  readonly creditField?: string;
  readonly functionalDebitField?: string;
  readonly functionalCreditField?: string;
  readonly descriptionField?: string;
  readonly maxLines?: number;
  readonly clock?: { now(): Date };
}

const DEFAULTS = {
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  postedState: "posted",
  reversedState: "reversed",
  numberField: "entry_number",
  entryDateField: "entry_date",
  postedAtField: "posted_at",
  memoField: "memo",
  sourceField: "source",
  reversalSource: "system",
  lineEntryRefField: "journal_entry_id",
  debitField: "debit",
  creditField: "credit",
  functionalDebitField: "functional_debit",
  functionalCreditField: "functional_credit",
  descriptionField: "description",
  maxLines: 1000,
} as const;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function swapAmount(a: unknown, b: unknown): boolean {
  return num(a) !== 0 || num(b) !== 0;
}

/**
 * On the posted→reversed edge of a journal entry, auto-creates the mirror
 * reversing entry: a new posted entry (same book/period, dated today, numbered
 * `<original>-REV`) whose lines negate the original by swapping debit↔credit (and
 * the functional-currency pair), preserving every other line dimension. The new
 * records are written directly through the store, so they bypass the handler's
 * guards/effects (no recursion) and are balanced by construction.
 */
export function journalReversalEffect(config: JournalReversalConfig = {}): WriteEffect {
  const c = { ...DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.entryEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const wasPosted = input.before?.[c.stateField] === c.postedState;
    const nowReversed = input.after[c.stateField] === c.reversedState;
    if (!wasPosted || !nowReversed) return;

    const original = input.after;
    const originalId = input.id;
    if (originalId === null) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const origNumber = typeof original[c.numberField] === "string" ? (original[c.numberField] as string) : originalId;

    const reversalEntry: EntityRecord = {
      [c.numberField]: `${origNumber}-REV`,
      [c.entryDateField]: today,
      [c.sourceField]: c.reversalSource,
      [c.stateField]: c.postedState,
      [c.memoField]: `Reversal of ${origNumber}`,
      [c.postedAtField]: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    };
    for (const carry of ["book_id", "fiscal_period_id"]) {
      if (typeof original[carry] === "string") reversalEntry[carry] = original[carry];
    }
    const created = await input.store.create(input.tenantId, c.entryEntity, reversalEntry);
    const newId = String(created["id"]);

    const filter: ListFilter = { field: c.lineEntryRefField, op: "eq", value: originalId };
    const page = await input.store.listPage(input.tenantId, c.lineEntity, {
      limit: c.maxLines,
      cursor: null,
      sort: [],
      filters: [filter],
    });
    const lines = page.records.filter((r) => String(r[c.lineEntryRefField] ?? "") === originalId);

    const skip = new Set([
      "id",
      "created_at",
      "updated_at",
      c.lineEntryRefField,
      c.debitField,
      c.creditField,
      c.functionalDebitField,
      c.functionalCreditField,
      c.descriptionField,
    ]);
    for (const line of lines) {
      const reversed: EntityRecord = {};
      for (const [k, v] of Object.entries(line)) {
        if (!skip.has(k)) reversed[k] = v;
      }
      reversed[c.lineEntryRefField] = newId;
      reversed[c.debitField] = num(line[c.creditField]);
      reversed[c.creditField] = num(line[c.debitField]);
      if (swapAmount(line[c.functionalDebitField], line[c.functionalCreditField])) {
        reversed[c.functionalDebitField] = num(line[c.functionalCreditField]);
        reversed[c.functionalCreditField] = num(line[c.functionalDebitField]);
      }
      const desc = typeof line[c.descriptionField] === "string" ? (line[c.descriptionField] as string) : "";
      reversed[c.descriptionField] = `Reversal: ${desc}`.trim();
      reversed.created_at = nowIso;
      reversed.updated_at = nowIso;
      await input.store.create(input.tenantId, c.lineEntity, reversed);
    }
  };
}

export interface InvoiceCreditNoteConfig {
  readonly invoiceEntity?: string;
  /** Line entity to mirror; when omitted, no credit-note lines are written. */
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly voidState?: string;
  /** Only an invoice voided from one of these (issued) states gets a credit note. */
  readonly issuedStates?: readonly string[];
  readonly numberField?: string;
  readonly documentTypeField?: string;
  readonly creditNoteType?: string;
  readonly creditNoteRefField?: string;
  readonly issuedState?: string;
  readonly lineInvoiceRefField?: string;
  readonly notesField?: string;
  readonly issueDateField?: string;
  readonly dueDateField?: string;
  readonly sentAtField?: string;
  readonly descriptionField?: string;
  /** Optional invoice field carrying a partial credit amount (< total → partial credit note). */
  readonly creditAmountField?: string;
  readonly totalField?: string;
  readonly subtotalField?: string;
  readonly taxTotalField?: string;
  readonly linePositionField?: string;
  readonly lineQuantityField?: string;
  readonly lineUnitPriceField?: string;
  readonly lineTaxRateField?: string;
  readonly lineTotalField?: string;
  readonly maxLines?: number;
  readonly clock?: { now(): Date };
}

const CN_DEFAULTS = {
  invoiceEntity: "Invoice",
  stateField: "state",
  voidState: "void",
  issuedStates: ["sent", "overdue"] as readonly string[],
  numberField: "invoice_number",
  documentTypeField: "document_type",
  creditNoteType: "credit_note",
  creditNoteRefField: "credit_note_of",
  issuedState: "sent",
  lineInvoiceRefField: "invoice_id",
  notesField: "notes",
  issueDateField: "issue_date",
  dueDateField: "due_date",
  sentAtField: "sent_at",
  descriptionField: "description",
  creditAmountField: "credit_amount",
  totalField: "total",
  subtotalField: "subtotal",
  taxTotalField: "tax_total",
  linePositionField: "position",
  lineQuantityField: "quantity",
  lineUnitPriceField: "unit_price",
  lineTaxRateField: "tax_rate_pct",
  lineTotalField: "line_total",
  maxLines: 1000,
} as const;

/**
 * On voiding an *issued* invoice (state `sent`/`overdue` → `void`), auto-creates a
 * credit note: a `document_type = credit_note` invoice numbered `<original>-CN`,
 * linked back via `credit_note_of`, carrying the original's account/currency/totals
 * (positive — the `credit_note` type denotes the reduction), issued today, with a
 * line per original line. Voiding a never-issued draft creates nothing, and a
 * credit note is never itself credit-noted. Written directly through the store, so
 * it bypasses the handler's guards/effects (no recursion) and rides the same
 * transaction as the void (atomic).
 */
export function invoiceVoidCreditNoteEffect(config: InvoiceCreditNoteConfig = {}): WriteEffect {
  const c = { ...CN_DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.invoiceEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const beforeState = input.before?.[c.stateField];
    const wasIssued = typeof beforeState === "string" && c.issuedStates.includes(beforeState);
    const nowVoid = input.after[c.stateField] === c.voidState;
    if (!wasIssued || !nowVoid) return;
    if (input.before?.[c.documentTypeField] === c.creditNoteType) return; // never credit-note a credit note

    const original = input.after;
    const originalId = input.id;
    if (originalId === null) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const origNumber = typeof original[c.numberField] === "string" ? (original[c.numberField] as string) : originalId;

    const headerSkip = new Set([
      "id",
      c.numberField,
      c.stateField,
      c.documentTypeField,
      c.creditNoteRefField,
      c.issueDateField,
      c.dueDateField,
      c.notesField,
      c.sentAtField,
      "paid_at",
      "created_at",
      "updated_at",
    ]);
    const creditNote: EntityRecord = {};
    for (const [k, v] of Object.entries(original)) {
      if (!headerSkip.has(k)) creditNote[k] = v;
    }
    creditNote[c.documentTypeField] = c.creditNoteType;
    creditNote[c.creditNoteRefField] = originalId;
    creditNote[c.numberField] = `${origNumber}-CN`;
    creditNote[c.stateField] = c.issuedState;
    creditNote[c.issueDateField] = today;
    creditNote[c.dueDateField] = today;
    creditNote[c.sentAtField] = nowIso;

    // Partial credit: when the invoice carries a `credit_amount` below its total,
    // the credit note is for that amount (single summary line); otherwise the
    // full invoice is credited (every line mirrored).
    const total = num(original[c.totalField]);
    const requested = original[c.creditAmountField];
    const isPartial = typeof requested === "number" && requested > 0 && requested < total;
    const amount = isPartial ? (requested as number) : total;
    if (isPartial) {
      creditNote[c.totalField] = amount;
      creditNote[c.subtotalField] = amount;
      creditNote[c.taxTotalField] = 0;
      creditNote[c.notesField] = `Partial credit note for ${origNumber}`;
    } else {
      creditNote[c.notesField] = `Credit note for ${origNumber}`;
    }
    creditNote.created_at = nowIso;
    creditNote.updated_at = nowIso;
    const created = await input.store.create(input.tenantId, c.invoiceEntity, creditNote);
    const newId = String(created["id"]);

    if (config.lineEntity === undefined) return;
    const lineEntity = config.lineEntity;

    if (isPartial) {
      await input.store.create(input.tenantId, lineEntity, {
        [c.lineInvoiceRefField]: newId,
        [c.linePositionField]: 1,
        [c.descriptionField]: "Partial credit",
        [c.lineQuantityField]: 1,
        [c.lineUnitPriceField]: amount,
        [c.lineTaxRateField]: 0,
        [c.lineTotalField]: amount,
        created_at: nowIso,
        updated_at: nowIso,
      });
      return;
    }

    const filter: ListFilter = { field: c.lineInvoiceRefField, op: "eq", value: originalId };
    const page = await input.store.listPage(input.tenantId, lineEntity, {
      limit: c.maxLines,
      cursor: null,
      sort: [],
      filters: [filter],
    });
    const lines = page.records.filter((r) => String(r[c.lineInvoiceRefField] ?? "") === originalId);
    const lineSkip = new Set(["id", c.lineInvoiceRefField, c.descriptionField, "created_at", "updated_at"]);
    for (const line of lines) {
      const cnLine: EntityRecord = {};
      for (const [k, v] of Object.entries(line)) {
        if (!lineSkip.has(k)) cnLine[k] = v;
      }
      cnLine[c.lineInvoiceRefField] = newId;
      const desc = typeof line[c.descriptionField] === "string" ? (line[c.descriptionField] as string) : "";
      cnLine[c.descriptionField] = `Credit: ${desc}`.trim();
      cnLine.created_at = nowIso;
      cnLine.updated_at = nowIso;
      await input.store.create(input.tenantId, lineEntity, cnLine);
    }
  };
}

export interface CreditNoteGlConfig {
  readonly invoiceEntity?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly voidState?: string;
  readonly issuedStates?: readonly string[];
  readonly documentTypeField?: string;
  readonly creditNoteType?: string;
  readonly numberField?: string;
  readonly totalField?: string;
  readonly creditAmountField?: string;
  readonly currencyField?: string;
  /** Ledger account entity + its code field, used to resolve configured account codes to ids. */
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /**
   * Resolves the tenant's AR/revenue LedgerAccount *codes* (typically from tenant
   * settings). When a code resolves to a real account it's used as the posting
   * line's `ledger_account_id`; otherwise the placeholder ref below is used.
   */
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ ar?: string; revenue?: string }>;
  /** Fallback placeholder account references when no code is configured/found. */
  readonly arAccountRef?: string;
  readonly revenueAccountRef?: string;
  readonly clock?: { now(): Date };
}

const GL_DEFAULTS = {
  invoiceEntity: "Invoice",
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  voidState: "void",
  issuedStates: ["sent", "overdue"] as readonly string[],
  documentTypeField: "document_type",
  creditNoteType: "credit_note",
  numberField: "invoice_number",
  totalField: "total",
  creditAmountField: "credit_amount",
  currencyField: "currency",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  arAccountRef: "accounts_receivable",
  revenueAccountRef: "revenue",
} as const;

/**
 * AR↔GL bridge: when an issued invoice is voided (the same edge that issues a
 * credit note), auto-posts the matching balanced GL entry — a posted
 * `JournalEntry` numbered `<invoice>-CN-GL` with two lines that reverse the sale
 * (debit revenue, credit AR) for the credited amount (partial when the invoice
 * carries `credit_amount`). The AR and revenue lines use the tenant's configured
 * chart-of-accounts entries (`finance.arAccountCode` / `revenueAccountCode`
 * resolved to `LedgerAccount` ids); when a code isn't configured/found, a
 * placeholder ref is used so the bridge still posts. Fires only when the manifest
 * models a GL (JournalEntry + line). Written directly through the store (bypasses
 * guards/effects; balanced by construction) inside the void transaction, so AR and
 * GL move atomically.
 */
export function creditNoteGlPostingEffect(config: CreditNoteGlConfig = {}): WriteEffect {
  const c = { ...GL_DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.invoiceEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const beforeState = input.before?.[c.stateField];
    const wasIssued = typeof beforeState === "string" && c.issuedStates.includes(beforeState);
    const nowVoid = input.after[c.stateField] === c.voidState;
    if (!wasIssued || !nowVoid) return;
    if (input.before?.[c.documentTypeField] === c.creditNoteType) return;

    const original = input.after;
    const originalId = input.id;
    if (originalId === null) return;
    const total = num(original[c.totalField]);
    const requested = original[c.creditAmountField];
    const amount = typeof requested === "number" && requested > 0 && requested < total ? requested : total;
    if (amount <= 0) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const origNumber = typeof original[c.numberField] === "string" ? (original[c.numberField] as string) : originalId;
    const currency = typeof original[c.currencyField] === "string" ? (original[c.currencyField] as string) : "USD";

    // Resolve configured account codes to real LedgerAccount ids; fall back to placeholders.
    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const arAccount = (await resolveAccountId(input, c, codes.ar)) ?? c.arAccountRef;
    const revenueAccount = (await resolveAccountId(input, c, codes.revenue)) ?? c.revenueAccountRef;

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${origNumber}-CN-GL`,
      entry_date: today,
      source: "system",
      state: "posted",
      memo: `Credit note GL posting for ${origNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const entryId = String(entry["id"]);
    const baseLine = { journal_entry_id: entryId, currency, fx_rate: 1, created_at: nowIso, updated_at: nowIso };
    // Reverse the sale: debit revenue, credit AR — balanced by construction.
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: revenueAccount,
      description: "Credit note — revenue reversal",
      debit: amount,
      credit: 0,
      functional_debit: amount,
      functional_credit: 0,
    });
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: arAccount,
      description: "Credit note — AR reversal",
      debit: 0,
      credit: amount,
      functional_debit: 0,
      functional_credit: amount,
    });
  };
}

/** Resolves a LedgerAccount `account_code` to its record id within the tenant, or null. */
async function resolveAccountId(
  input: WriteEffectInput,
  c: { ledgerAccountEntity: string; accountCodeField: string },
  code: string | undefined,
): Promise<string | null> {
  if (code === undefined || code.length === 0) return null;
  const page = await input.store.listPage(input.tenantId, c.ledgerAccountEntity, {
    limit: 1,
    cursor: null,
    sort: [],
    filters: [{ field: c.accountCodeField, op: "eq", value: code }],
  });
  const rec = page.records.find((r) => String(r[c.accountCodeField] ?? "") === code) ?? page.records[0];
  return rec !== undefined ? String(rec["id"]) : null;
}

export interface BillGlConfig {
  readonly billEntity?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly approvedState?: string;
  readonly numberField?: string;
  readonly totalField?: string;
  readonly currencyField?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /** Resolves the tenant's AP/expense LedgerAccount codes (typically from settings). */
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ ap?: string; expense?: string }>;
  readonly apAccountRef?: string;
  readonly expenseAccountRef?: string;
  readonly clock?: { now(): Date };
}

const BILL_GL_DEFAULTS = {
  billEntity: "Bill",
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  approvedState: "approved",
  numberField: "bill_number",
  totalField: "total",
  currencyField: "currency",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  apAccountRef: "accounts_payable",
  expenseAccountRef: "expense",
} as const;

/**
 * AP↔GL bridge: when a vendor bill is approved (draft→approved), auto-posts the
 * payable recognition — a posted `JournalEntry` numbered `<bill>-GL` with two
 * balanced lines (debit expense, credit AP) for the bill total. AP and expense
 * lines use the tenant's configured chart-of-accounts entries
 * (`finance.apAccountCode` / `expenseAccountCode` resolved to `LedgerAccount`
 * ids), falling back to placeholder refs when unconfigured. The symmetric AR-side
 * counterpart of `creditNoteGlPostingEffect`. Fires only when the manifest models
 * a GL; written directly through the store (balanced by construction) inside the
 * approval transaction, so the bill and its GL entry move atomically.
 */
export function billGlPostingEffect(config: BillGlConfig = {}): WriteEffect {
  const c = { ...BILL_GL_DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.billEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const wasApproved = input.before?.[c.stateField] === c.approvedState;
    const nowApproved = input.after[c.stateField] === c.approvedState;
    if (wasApproved || !nowApproved) return; // fire once, on the →approved edge

    const bill = input.after;
    const billId = input.id;
    if (billId === null) return;
    const amount = num(bill[c.totalField]);
    if (amount <= 0) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const billNumber = typeof bill[c.numberField] === "string" ? (bill[c.numberField] as string) : billId;
    const currency = typeof bill[c.currencyField] === "string" ? (bill[c.currencyField] as string) : "USD";

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const apAccount = (await resolveAccountId(input, c, codes.ap)) ?? c.apAccountRef;
    const expenseAccount = (await resolveAccountId(input, c, codes.expense)) ?? c.expenseAccountRef;

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${billNumber}-GL`,
      entry_date: today,
      source: "bill",
      state: "posted",
      memo: `Bill GL posting for ${billNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const entryId = String(entry["id"]);
    const baseLine = { journal_entry_id: entryId, currency, fx_rate: 1, created_at: nowIso, updated_at: nowIso };
    // Recognize the payable: debit expense, credit AP — balanced by construction.
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: expenseAccount,
      description: "Bill — expense",
      debit: amount,
      credit: 0,
      functional_debit: amount,
      functional_credit: 0,
    });
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: apAccount,
      description: "Bill — accounts payable",
      debit: 0,
      credit: amount,
      functional_debit: 0,
      functional_credit: amount,
    });
  };
}

export interface PaymentGlConfig {
  readonly entity: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  /** The state whose →edge triggers the posting (e.g. "paid" to settle, "sent" to recognize). */
  readonly paidState?: string;
  /** JournalEntry.source tag for the posting (e.g. "payment", "invoice"). */
  readonly sourceValue?: string;
  readonly numberField: string;
  readonly totalField?: string;
  readonly currencyField?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /** Skip the posting when the document is of this type (e.g. a credit note isn't "paid" like an invoice). */
  readonly skipDocumentType?: { readonly field: string; readonly value: string };
  /** Resolves the debit + credit LedgerAccount codes for the payment (typically from settings). */
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ debit?: string; credit?: string }>;
  readonly debitAccountRef: string;
  readonly creditAccountRef: string;
  readonly debitDescription: string;
  readonly creditDescription: string;
  readonly entrySuffix?: string;
  readonly clock?: { now(): Date };
}

const PAYMENT_GL_FALLBACKS = {
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  paidState: "paid",
  sourceValue: "payment",
  totalField: "total",
  currencyField: "currency",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  entrySuffix: "-PAY",
} as const;

/**
 * Generic balanced GL posting on a document state edge: when a document reaches a
 * target state, auto-posts a `JournalEntry` `<number><suffix>` with a debit and a
 * credit line for the document total. Drives both invoice/bill recognition (→sent
 * / →approved: debit AR / credit revenue, debit expense / credit AP) and cash
 * settlement (→paid: debit cash / credit AR, debit AP / credit cash) by configuring
 * the two accounts + `sourceValue`. Account codes resolve to real `LedgerAccount`
 * ids (else placeholder refs). Fires once on the target-state edge, written through
 * the store inside the same transaction (atomic, balanced by construction).
 */
export function paymentGlPostingEffect(config: PaymentGlConfig): WriteEffect {
  const c = { ...PAYMENT_GL_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const wasPaid = input.before?.[c.stateField] === c.paidState;
    const nowPaid = input.after[c.stateField] === c.paidState;
    if (wasPaid || !nowPaid) return;
    if (c.skipDocumentType !== undefined && input.after[c.skipDocumentType.field] === c.skipDocumentType.value) return;

    const doc = input.after;
    const docId = input.id;
    if (docId === null) return;
    const amount = num(doc[c.totalField]);
    if (amount <= 0) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const docNumber = typeof doc[c.numberField] === "string" ? (doc[c.numberField] as string) : docId;
    const currency = typeof doc[c.currencyField] === "string" ? (doc[c.currencyField] as string) : "USD";

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const debitAccount = (await resolveAccountId(input, c, codes.debit)) ?? c.debitAccountRef;
    const creditAccount = (await resolveAccountId(input, c, codes.credit)) ?? c.creditAccountRef;

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${docNumber}${c.entrySuffix}`,
      entry_date: today,
      source: c.sourceValue,
      state: "posted",
      memo: `GL posting for ${docNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const entryId = String(entry["id"]);
    const baseLine = { journal_entry_id: entryId, currency, fx_rate: 1, created_at: nowIso, updated_at: nowIso };
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: debitAccount,
      description: c.debitDescription,
      debit: amount,
      credit: 0,
      functional_debit: amount,
      functional_credit: 0,
    });
    await input.store.create(input.tenantId, c.lineEntity, {
      ...baseLine,
      ledger_account_id: creditAccount,
      description: c.creditDescription,
      debit: 0,
      credit: amount,
      functional_debit: 0,
      functional_credit: amount,
    });
  };
}

type GlSide = "debit" | "credit";

function glLine(
  base: Record<string, unknown>,
  account: string,
  description: string,
  side: GlSide,
  amount: number,
): Record<string, unknown> {
  const debit = side === "debit" ? amount : 0;
  const credit = side === "credit" ? amount : 0;
  return { ...base, ledger_account_id: account, description, debit, credit, functional_debit: debit, functional_credit: credit };
}

export interface RecognitionGlConfig {
  readonly entity: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly triggerState: string;
  readonly sourceValue?: string;
  readonly entrySuffix?: string;
  readonly numberField: string;
  readonly totalField?: string;
  readonly subtotalField?: string;
  readonly taxField?: string;
  readonly currencyField?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /** Which side the control account (AR for sales, AP for purchases) sits on. */
  readonly controlSide: GlSide;
  readonly controlAccountRef: string;
  readonly netAccountRef: string;
  readonly taxAccountRef: string;
  readonly controlDescription: string;
  readonly netDescription: string;
  readonly taxDescription: string;
  readonly skipDocumentType?: { readonly field: string; readonly value: string };
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ control?: string; net?: string; tax?: string }>;
  readonly clock?: { now(): Date };
}

const RECOGNITION_FALLBACKS = {
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  sourceValue: "system",
  entrySuffix: "-GL",
  totalField: "total",
  subtotalField: "subtotal",
  taxField: "tax_total",
  currencyField: "currency",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
} as const;

const EPSILON = 0.005;

/**
 * Recognition GL posting with a tax split: when a document reaches its recognized
 * state, posts the control account (AR/AP) at the gross total on `controlSide`,
 * and the net (revenue/expense) + tax lines on the opposite side at subtotal and
 * tax. When subtotal+tax doesn't reconcile to total (or tax is zero) it degrades
 * to a single net line at the total. Drives invoice issue (debit AR; credit
 * revenue + tax payable) and bill approval (credit AP; debit expense + input tax).
 * Balanced by construction, written inside the triggering transaction.
 */
export function recognitionGlPostingEffect(config: RecognitionGlConfig): WriteEffect {
  const c = { ...RECOGNITION_FALLBACKS, ...config };
  const opposite: GlSide = c.controlSide === "debit" ? "credit" : "debit";
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    if (input.before?.[c.stateField] === c.triggerState || input.after[c.stateField] !== c.triggerState) return;
    if (c.skipDocumentType !== undefined && input.after[c.skipDocumentType.field] === c.skipDocumentType.value) return;

    const doc = input.after;
    const docId = input.id;
    if (docId === null) return;
    const total = num(doc[c.totalField]);
    if (total <= 0) return;
    let subtotal = num(doc[c.subtotalField]);
    let tax = num(doc[c.taxField]);
    // Reconcile: fall back to a single net line at total when the split doesn't add up.
    if (subtotal <= 0 || Math.abs(subtotal + tax - total) > EPSILON) {
      subtotal = total;
      tax = 0;
    }

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const docNumber = typeof doc[c.numberField] === "string" ? (doc[c.numberField] as string) : docId;
    const currency = typeof doc[c.currencyField] === "string" ? (doc[c.currencyField] as string) : "USD";

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const controlAccount = (await resolveAccountId(input, c, codes.control)) ?? c.controlAccountRef;
    const netAccount = (await resolveAccountId(input, c, codes.net)) ?? c.netAccountRef;
    const taxAccount = (await resolveAccountId(input, c, codes.tax)) ?? c.taxAccountRef;

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${docNumber}${c.entrySuffix}`,
      entry_date: today,
      source: c.sourceValue,
      state: "posted",
      memo: `GL posting for ${docNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const base = { journal_entry_id: String(entry["id"]), currency, fx_rate: 1, created_at: nowIso, updated_at: nowIso };
    await input.store.create(input.tenantId, c.lineEntity, glLine(base, controlAccount, c.controlDescription, c.controlSide, total));
    await input.store.create(input.tenantId, c.lineEntity, glLine(base, netAccount, c.netDescription, opposite, subtotal));
    if (tax > EPSILON) {
      await input.store.create(input.tenantId, c.lineEntity, glLine(base, taxAccount, c.taxDescription, opposite, tax));
    }
  };
}

export interface PaymentSettlementGlConfig {
  readonly paymentEntity?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly completedState?: string;
  readonly directionField?: string;
  readonly inboundValue?: string;
  readonly amountField?: string;
  readonly cashAmountField?: string;
  readonly numberField?: string;
  readonly currencyField?: string;
  readonly entrySuffix?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ cash?: string; ar?: string; ap?: string; fx?: string }>;
  readonly cashAccountRef?: string;
  readonly arAccountRef?: string;
  readonly apAccountRef?: string;
  readonly fxAccountRef?: string;
  readonly clock?: { now(): Date };
}

const SETTLEMENT_FALLBACKS = {
  paymentEntity: "Payment",
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  completedState: "completed",
  directionField: "direction",
  inboundValue: "inbound",
  amountField: "amount",
  cashAmountField: "cash_amount",
  numberField: "payment_number",
  currencyField: "currency",
  entrySuffix: "-SETTLE",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  cashAccountRef: "cash",
  arAccountRef: "accounts_receivable",
  apAccountRef: "accounts_payable",
  fxAccountRef: "fx_gain_loss",
} as const;

/**
 * Payment-driven settlement: when a Payment completes, posts a balanced entry for
 * its amount — inbound (customer) → debit cash, credit AR; outbound (vendor) →
 * debit AP, credit cash. Because each Payment carries its own amount, **partial
 * payments** settle naturally (one entry per payment). When `cash_amount` (the
 * reporting-currency cash actually moved) differs from `amount` (the receivable/
 * payable cleared), the gap is booked to the **FX gain/loss** account so the
 * entry stays balanced — realized FX on settlement. Account codes resolve to real
 * `LedgerAccount` ids; runs inside the completion transaction.
 */
export function paymentSettlementGlPostingEffect(config: PaymentSettlementGlConfig = {}): WriteEffect {
  const c = { ...SETTLEMENT_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.paymentEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    if (input.before?.[c.stateField] === c.completedState || input.after[c.stateField] !== c.completedState) return;

    const pay = input.after;
    const payId = input.id;
    if (payId === null) return;
    const amount = num(pay[c.amountField]);
    if (amount <= 0) return;
    const cashAmount = pay[c.cashAmountField] !== undefined ? num(pay[c.cashAmountField]) : amount;
    const inbound = pay[c.directionField] === c.inboundValue;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const payNumber = typeof pay[c.numberField] === "string" ? (pay[c.numberField] as string) : payId;
    const currency = typeof pay[c.currencyField] === "string" ? (pay[c.currencyField] as string) : "USD";

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const cashAccount = (await resolveAccountId(input, c, codes.cash)) ?? c.cashAccountRef;
    const arAccount = (await resolveAccountId(input, c, codes.ar)) ?? c.arAccountRef;
    const apAccount = (await resolveAccountId(input, c, codes.ap)) ?? c.apAccountRef;
    const fxAccount = (await resolveAccountId(input, c, codes.fx)) ?? c.fxAccountRef;

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${payNumber}${c.entrySuffix}`,
      entry_date: today,
      source: "payment",
      state: "posted",
      memo: `Settlement GL posting for ${payNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const base = { journal_entry_id: String(entry["id"]), currency, fx_rate: 1, created_at: nowIso, updated_at: nowIso };
    const lines: Record<string, unknown>[] = [];
    const fxDiff = cashAmount - amount; // cash moved minus balance cleared
    if (inbound) {
      lines.push(glLine(base, cashAccount, "Settlement — cash", "debit", cashAmount));
      lines.push(glLine(base, arAccount, "Settlement — accounts receivable", "credit", amount));
      if (Math.abs(fxDiff) > EPSILON) {
        // more cash than AR cleared → FX gain (credit); less → FX loss (debit)
        lines.push(glLine(base, fxAccount, "Realized FX gain/loss", fxDiff > 0 ? "credit" : "debit", Math.abs(fxDiff)));
      }
    } else {
      lines.push(glLine(base, apAccount, "Settlement — accounts payable", "debit", amount));
      lines.push(glLine(base, cashAccount, "Settlement — cash", "credit", cashAmount));
      if (Math.abs(fxDiff) > EPSILON) {
        // more cash paid than AP cleared → FX loss (debit); less → FX gain (credit)
        lines.push(glLine(base, fxAccount, "Realized FX gain/loss", fxDiff > 0 ? "debit" : "credit", Math.abs(fxDiff)));
      }
    }
    for (const line of lines) await input.store.create(input.tenantId, c.lineEntity, line);
  };
}

export interface PaymentApplicationConfig {
  readonly paymentEntity?: string;
  readonly documentEntity: string;
  /** The Payment field referencing the document (e.g. "invoice_id"). */
  readonly refField: string;
  readonly stateField?: string;
  readonly completedState?: string;
  readonly amountField?: string;
  readonly documentTotalField?: string;
  readonly documentStateField?: string;
  readonly paidState?: string;
  readonly paidAtField?: string;
  /** Document states from which auto-settlement is allowed (issued/approved, not draft/void). */
  readonly settleableStates?: readonly string[];
  readonly maxPayments?: number;
  readonly clock?: { now(): Date };
}

const APPLICATION_FALLBACKS = {
  paymentEntity: "Payment",
  stateField: "state",
  completedState: "completed",
  amountField: "amount",
  documentTotalField: "total",
  documentStateField: "state",
  paidState: "paid",
  paidAtField: "paid_at",
  maxPayments: 1000,
} as const;

const APPLY_EPSILON = 0.005;

/**
 * Per-document payment application: when a Payment completes against a linked
 * document (`refField`), sums all completed payments for that document and — once
 * they cover its total — auto-transitions the document to paid. So partial
 * payments accumulate against a specific invoice/bill and settle it when fully
 * covered. The document is updated directly through the store (bypassing the
 * issued-document lock) inside the payment transaction, so application is atomic
 * with settlement.
 */
export function paymentApplicationEffect(config: PaymentApplicationConfig): WriteEffect {
  const c = { ...APPLICATION_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.paymentEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    if (input.before?.[c.stateField] === c.completedState || input.after[c.stateField] !== c.completedState) return;

    const docId = input.after[c.refField];
    if (typeof docId !== "string" || docId.length === 0) return;
    const doc = await input.store.get(input.tenantId, c.documentEntity, docId);
    if (doc === null) return;
    const docState = doc[c.documentStateField];
    if (docState === c.paidState) return; // already settled
    if (c.settleableStates !== undefined && (typeof docState !== "string" || !c.settleableStates.includes(docState))) {
      return;
    }
    const total = num(doc[c.documentTotalField]);
    if (total <= 0) return;

    const page = await input.store.listPage(input.tenantId, c.paymentEntity, {
      limit: c.maxPayments,
      cursor: null,
      sort: [],
      filters: [{ field: c.refField, op: "eq", value: docId }],
    });
    let applied = 0;
    for (const p of page.records) {
      if (String(p[c.refField] ?? "") === docId && p[c.stateField] === c.completedState) {
        applied += num(p[c.amountField]);
      }
    }
    if (applied + APPLY_EPSILON < total) return; // not yet fully covered

    const nowIso = (c.clock?.now() ?? new Date()).toISOString();
    await input.store.update(input.tenantId, c.documentEntity, docId, {
      [c.documentStateField]: c.paidState,
      [c.paidAtField]: nowIso,
      updated_at: nowIso,
    });
  };
}
