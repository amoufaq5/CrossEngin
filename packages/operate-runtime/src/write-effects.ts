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
  /**
   * When set, the tax split is derived from the document's *lines* — each line's
   * `TaxCode` (or flat rate) drives a per-code tax line in the GL, instead of one
   * aggregate tax line from the document's `tax_total`. Falls back to the
   * document-level split when the line-derived net+tax doesn't reconcile to total.
   */
  readonly taxLines?: RecognitionTaxLinesConfig;
  readonly clock?: { now(): Date };
}

export interface RecognitionTaxLinesConfig {
  /** The document's line entity, e.g. "InvoiceLine" / "BillLine". */
  readonly entity: string;
  /** The line field referencing the parent document, e.g. "invoice_id" / "bill_id". */
  readonly refField: string;
  /** The line's net (pre-tax) amount field, e.g. "line_total" / "amount". */
  readonly netField: string;
  /** The line's optional TaxCode reference field. */
  readonly taxCodeField?: string;
  /** The line's optional flat tax-rate-percent field, used when no TaxCode is set. */
  readonly flatRateField?: string;
  /** The TaxCode entity + its rate / label fields. */
  readonly codeEntity?: string;
  readonly codeRateField?: string;
  readonly codeLabelField?: string;
  /** Optional TaxCode field naming a LedgerAccount account_code for this code's tax line. */
  readonly codeAccountField?: string;
  readonly maxRows?: number;
}

const TAX_LINES_FALLBACKS = {
  taxCodeField: "tax_code_id",
  flatRateField: "tax_rate_pct",
  codeEntity: "TaxCode",
  codeRateField: "rate_pct",
  codeLabelField: "code",
  codeAccountField: "gl_account_code",
  maxRows: 500,
} as const;

export interface TaxBreakdownLine {
  readonly net: number;
  readonly taxCodeId: string | null;
  readonly flatRatePct: number | null;
}

export interface TaxBreakdown {
  readonly netTotal: number;
  readonly taxTotal: number;
  /** One entry per distinct tax label with non-zero tax, in first-seen order. */
  readonly groups: readonly { readonly label: string; readonly tax: number; readonly accountCode: string | null }[];
}

/**
 * Pure: given document lines + a resolved `taxCodeId → {rate, label, accountCode?}` map,
 * sums the net, computes each line's tax (`net × rate%`, rounded to the cent), and groups
 * the tax by label (the TaxCode's label, or `<rate>%` for an unlabeled flat-rate line).
 * Each group carries the first-seen account code for that label (null when none / flat-rate).
 */
export function computeLineTaxBreakdown(
  lines: readonly TaxBreakdownLine[],
  rateByCode: ReadonlyMap<string, { readonly rate: number; readonly label: string; readonly accountCode?: string | null }>,
): TaxBreakdown {
  let netTotal = 0;
  const order: string[] = [];
  const taxByLabel = new Map<string, number>();
  const accountByLabel = new Map<string, string | null>();
  for (const line of lines) {
    const net = Math.round(line.net * 100) / 100;
    netTotal += net;
    let rate = 0;
    let label: string | null = null;
    let accountCode: string | null = null;
    if (line.taxCodeId !== null && rateByCode.has(line.taxCodeId)) {
      const resolved = rateByCode.get(line.taxCodeId)!;
      rate = resolved.rate;
      label = resolved.label;
      accountCode = resolved.accountCode ?? null;
    } else if (line.flatRatePct !== null) {
      rate = line.flatRatePct;
    }
    if (rate <= 0) continue;
    const tax = Math.round(net * (rate / 100) * 100) / 100;
    if (tax <= 0) continue;
    const key = label !== null && label.length > 0 ? label : `${rate}%`;
    if (!taxByLabel.has(key)) {
      order.push(key);
      accountByLabel.set(key, accountCode);
    }
    taxByLabel.set(key, (taxByLabel.get(key) ?? 0) + tax);
  }
  netTotal = Math.round(netTotal * 100) / 100;
  let taxTotal = 0;
  const groups = order.map((label) => {
    const tax = Math.round((taxByLabel.get(label) ?? 0) * 100) / 100;
    taxTotal += tax;
    return { label, tax, accountCode: accountByLabel.get(label) ?? null };
  });
  return { netTotal, taxTotal: Math.round(taxTotal * 100) / 100, groups };
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

    // Line-level tax codes: when configured and the line-derived split reconciles to
    // the document total, post one tax line per TaxCode instead of one aggregate line.
    let taxGroups: TaxBreakdown["groups"] | null = null;
    if (config.taxLines !== undefined) {
      const tc = { ...TAX_LINES_FALLBACKS, ...config.taxLines };
      const page = await input.store.listPage(input.tenantId, tc.entity, {
        limit: tc.maxRows,
        cursor: null,
        sort: [],
        filters: [{ field: tc.refField, op: "eq", value: docId }],
      });
      const lineRows = page.records.filter((r) => String(r[tc.refField] ?? "") === docId);
      if (lineRows.length > 0) {
        // Resolve each distinct TaxCode once.
        const rateByCode = new Map<string, { rate: number; label: string; accountCode: string | null }>();
        const codeIds = new Set<string>();
        for (const r of lineRows) {
          const id = r[tc.taxCodeField];
          if (typeof id === "string" && id.length > 0) codeIds.add(id);
        }
        for (const id of codeIds) {
          const code = await input.store.get(input.tenantId, tc.codeEntity, id);
          if (code !== null) {
            const label = typeof code[tc.codeLabelField] === "string" ? (code[tc.codeLabelField] as string) : id;
            const acct = code[tc.codeAccountField];
            rateByCode.set(id, {
              rate: num(code[tc.codeRateField]),
              label,
              accountCode: typeof acct === "string" && acct.length > 0 ? acct : null,
            });
          }
        }
        const breakdown = computeLineTaxBreakdown(
          lineRows.map((r) => {
            const codeId = r[tc.taxCodeField];
            const flat = r[tc.flatRateField];
            return {
              net: num(r[tc.netField]),
              taxCodeId: typeof codeId === "string" && codeId.length > 0 ? codeId : null,
              flatRatePct: typeof flat === "number" ? flat : null,
            };
          }),
          rateByCode,
        );
        // Accept the line-derived split only when it reconciles to the document total.
        if (breakdown.netTotal > 0 && Math.abs(breakdown.netTotal + breakdown.taxTotal - total) <= EPSILON) {
          subtotal = breakdown.netTotal;
          tax = breakdown.taxTotal;
          taxGroups = breakdown.groups;
        }
      }
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
    if (taxGroups !== null && taxGroups.length > 0) {
      // One tax line per TaxCode, each tagged with the code in its description and
      // posted to the code's own GL account when it carries one (else the default).
      const acctCache = new Map<string, string>();
      for (const group of taxGroups) {
        if (group.tax <= EPSILON) continue;
        let account = taxAccount;
        if (group.accountCode !== null) {
          const cached = acctCache.get(group.accountCode);
          if (cached !== undefined) {
            account = cached;
          } else {
            const resolved = (await resolveAccountId(input, c, group.accountCode)) ?? taxAccount;
            acctCache.set(group.accountCode, resolved);
            account = resolved;
          }
        }
        await input.store.create(
          input.tenantId,
          c.lineEntity,
          glLine(base, account, `${c.taxDescription} (${group.label})`, opposite, group.tax),
        );
      }
    } else if (tax > EPSILON) {
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

/** One open foreign-currency document side (receivable or payable) for revaluation. */
interface FxRevalDocSpec {
  readonly entity: string;
  readonly openStates: readonly string[];
  readonly paymentRefField: string;
  /** "ar" → control is AR (asset); "ap" → control is AP (liability). */
  readonly side: "ar" | "ap";
}

export interface UnrealizedFxRevaluationConfig {
  readonly periodEntity?: string;
  readonly periodStateField?: string;
  readonly closedState?: string;
  readonly periodNumberField?: string;
  readonly periodEndDateField?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  /** Functional/reporting currency the open foreign balances are revalued into. */
  readonly functionalCurrency?: string;
  /** Per-tenant functional currency (from `defaults.currency`); overrides `functionalCurrency` when it returns a value. */
  readonly resolveFunctionalCurrency?: (tenantId: string) => Promise<string | undefined>;
  /** Receivable/payable document sides to revalue (default Invoice + Bill). */
  readonly documents?: readonly FxRevalDocSpec[];
  readonly paymentEntity?: string;
  readonly paymentStateField?: string;
  readonly paymentCompletedState?: string;
  readonly paymentAmountField?: string;
  readonly totalField?: string;
  readonly currencyField?: string;
  /** Document field carrying the rate it was booked at (absent → treated as 1). */
  readonly bookingRateField?: string;
  readonly currencyEntity?: string;
  readonly currencyCodeField?: string;
  readonly exchangeRateEntity?: string;
  readonly rateFromField?: string;
  readonly rateToField?: string;
  readonly rateField?: string;
  readonly rateDateField?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /** Resolves the unrealized-FX + AR + AP LedgerAccount codes (typically from settings). */
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ fx?: string; ar?: string; ap?: string }>;
  readonly fxAccountRef?: string;
  readonly arAccountRef?: string;
  readonly apAccountRef?: string;
  readonly maxRows?: number;
  readonly clock?: { now(): Date };
}

const FX_REVAL_FALLBACKS = {
  periodEntity: "FiscalPeriod",
  periodStateField: "status",
  closedState: "closed",
  periodNumberField: "name",
  periodEndDateField: "end_date",
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  functionalCurrency: "USD",
  documents: [
    { entity: "Invoice", openStates: ["sent", "overdue"], paymentRefField: "invoice_id", side: "ar" },
    { entity: "Bill", openStates: ["approved", "overdue"], paymentRefField: "bill_id", side: "ap" },
  ] as readonly FxRevalDocSpec[],
  paymentEntity: "Payment",
  paymentStateField: "state",
  paymentCompletedState: "completed",
  paymentAmountField: "amount",
  totalField: "total",
  currencyField: "currency",
  bookingRateField: "booking_rate",
  currencyEntity: "Currency",
  currencyCodeField: "code",
  exchangeRateEntity: "ExchangeRate",
  rateFromField: "from_currency_id",
  rateToField: "to_currency_id",
  rateField: "rate",
  rateDateField: "rate_date",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  fxAccountRef: "unrealized_fx_gain_loss",
  arAccountRef: "accounts_receivable",
  apAccountRef: "accounts_payable",
  maxRows: 5000,
} as const;

const FX_EPSILON = 0.005;

/**
 * Unrealized FX revaluation at period close: when a `FiscalPeriod` transitions into
 * `closed` (status edge), revalues every open foreign-currency receivable/payable to
 * the period-end exchange rate and posts ONE balanced adjusting `JournalEntry`
 * (`<period>-FXREVAL`, posted, source `fx_revaluation`).
 *
 * Model assumptions (the entity model lacks per-line functional-currency tracking,
 * so the convention is deliberately simple and documented here):
 *  - "Functional currency" is the tenant's reporting currency (`config.functionalCurrency`,
 *    from `defaults.currency`); only documents whose `currency` differs are revalued.
 *  - Open balance = document total − sum of completed linked payments (same approach
 *    as the aging report); fully-paid documents are skipped.
 *  - Period-end rate: the `ExchangeRate` (document-currency → functional-currency) with
 *    the latest `rate_date` ≤ the period `end_date`. Currencies are matched by resolving
 *    the `Currency` whose `code` equals the document/functional currency to its id, then
 *    finding an `ExchangeRate` (from_currency_id → to_currency_id) at that rate. When no
 *    rate is found for a currency, that currency is skipped (it cannot be revalued).
 *  - Because the model does not store the original booking rate, the unrealized delta is
 *    approximated as `open × (periodEndRate − 1)` — i.e. the foreign open balance is
 *    treated as if carried at rate 1, and revalued to the period-end rate. This is an
 *    approximation; the offset is booked to the unrealized-FX account so the entry stays
 *    balanced regardless.
 *
 * AR gain (foreign asset worth more) debits AR, credits unrealized FX; an AR loss is the
 * mirror. AP is the inverse (a higher rate increases a foreign liability → loss → debit
 * unrealized FX, credit AP). One combined entry carries a balanced line pair per revalued
 * currency/side, so total debits == total credits by construction. Written directly through
 * the store (bypasses guards/effects) inside the close transaction (atomic with the close).
 */
export function unrealizedFxRevaluationEffect(config: UnrealizedFxRevaluationConfig = {}): WriteEffect {
  const c = { ...FX_REVAL_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.periodEntity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const wasClosed = input.before?.[c.periodStateField] === c.closedState;
    const nowClosed = input.after[c.periodStateField] === c.closedState;
    if (wasClosed || !nowClosed) return; // fire once, on the →closed edge

    const period = input.after;
    const periodId = input.id;
    if (periodId === null) return;

    const resolvedFunctional = config.resolveFunctionalCurrency
      ? await config.resolveFunctionalCurrency(input.tenantId)
      : undefined;
    const functional = (resolvedFunctional ?? c.functionalCurrency).toUpperCase();
    const endDateRaw = period[c.periodEndDateField];
    const endDate = typeof endDateRaw === "string" && endDateRaw.length > 0 ? endDateRaw.slice(0, 10) : null;
    if (endDate === null) return;

    // Resolve the functional currency's Currency id once (period-end rates target it).
    const functionalCurrencyId = await resolveCurrencyId(input, c, functional);
    if (functionalCurrencyId === null) return; // can't revalue without a functional currency record

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const fxAccount = (await resolveAccountId(input, c, codes.fx)) ?? c.fxAccountRef;
    const arAccount = (await resolveAccountId(input, c, codes.ar)) ?? c.arAccountRef;
    const apAccount = (await resolveAccountId(input, c, codes.ap)) ?? c.apAccountRef;

    // Sum completed payments once, grouped by each document side's ref field.
    const payments = await input.store.listPage(input.tenantId, c.paymentEntity, {
      limit: c.maxRows,
      cursor: null,
      sort: [],
      filters: [{ field: c.paymentStateField, op: "eq", value: c.paymentCompletedState }],
    });
    const completed = payments.records.filter((p) => p[c.paymentStateField] === c.paymentCompletedState);

    // Accumulate the open foreign balance per (currency, side); then one rate lookup per currency.
    // We also accumulate Σ(open × bookingRate) so the revaluation compares against each
    // document's *original booking rate* rather than a flat rate of 1.
    const openByCurrencySide = new Map<string, number>(); // key `${currency}|${side}`
    const bookedByCurrencySide = new Map<string, number>(); // Σ(open × booking_rate) in functional terms
    const rateCache = new Map<string, number | null>();

    for (const doc of c.documents) {
      const applied = new Map<string, number>();
      for (const p of completed) {
        const ref = p[doc.paymentRefField];
        if (typeof ref === "string" && ref.length > 0) {
          applied.set(ref, (applied.get(ref) ?? 0) + num(p[c.paymentAmountField]));
        }
      }
      const page = await input.store.listPage(input.tenantId, doc.entity, {
        limit: c.maxRows,
        cursor: null,
        sort: [],
        filters: [{ field: "state", op: "in", value: [...doc.openStates] }],
      });
      for (const record of page.records) {
        if (!doc.openStates.includes(String(record["state"] ?? ""))) continue;
        const docId = String(record["id"] ?? "");
        if (docId === "") continue;
        const currency = typeof record[c.currencyField] === "string" ? (record[c.currencyField] as string).toUpperCase() : functional;
        if (currency === functional) continue; // only foreign-currency documents are revalued
        const total = num(record[c.totalField]);
        const open = Math.round((total - (applied.get(docId) ?? 0)) * 100) / 100;
        if (open <= 0) continue; // fully paid → nothing to revalue
        // The rate the document was booked at; absent → 1 (matching the legacy approximation).
        const bookingRate = record[c.bookingRateField] !== undefined ? num(record[c.bookingRateField]) : 1;
        const key = `${currency}|${doc.side}`;
        openByCurrencySide.set(key, (openByCurrencySide.get(key) ?? 0) + open);
        bookedByCurrencySide.set(key, (bookedByCurrencySide.get(key) ?? 0) + open * bookingRate);
      }
    }

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const periodLabel = typeof period[c.periodNumberField] === "string" ? (period[c.periodNumberField] as string) : periodId;

    const lines: Record<string, unknown>[] = [];
    for (const [key, open] of openByCurrencySide) {
      const sep = key.lastIndexOf("|");
      const currency = key.slice(0, sep);
      const side = key.slice(sep + 1) as "ar" | "ap";

      let rate = rateCache.get(currency);
      if (rate === undefined) {
        rate = await lookupPeriodEndRate(input, c, currency, functionalCurrencyId, endDate);
        rateCache.set(currency, rate);
      }
      if (rate === null) continue; // no rate for this currency → skip

      // Unrealized = (open × period-end rate) − Σ(open × booking rate). With no booking
      // rate stored this collapses to open × (rate − 1) — the prior behavior.
      const booked = bookedByCurrencySide.get(key) ?? open;
      const delta = Math.round((open * rate - booked) * 100) / 100;
      if (Math.abs(delta) < FX_EPSILON) continue;

      const controlAccount = side === "ar" ? arAccount : apAccount;
      const controlDesc = side === "ar"
        ? `Unrealized FX revaluation — AR ${currency}`
        : `Unrealized FX revaluation — AP ${currency}`;
      const fxDesc = `Unrealized FX gain/loss — ${currency}`;
      const base = { journal_entry_id: "", currency, fx_rate: rate, created_at: nowIso, updated_at: nowIso };

      // AR: a positive delta is a gain → debit AR, credit unrealized FX (mirror when negative).
      // AP: a higher rate raises a foreign liability → loss → debit unrealized FX, credit AP
      //     (so the AP control moves opposite to AR for the same delta sign).
      const amount = Math.abs(delta);
      const arGain = side === "ar" ? delta > 0 : delta < 0; // does the control account get debited?
      const controlSide: GlSide = arGain ? "debit" : "credit";
      const fxSide: GlSide = arGain ? "credit" : "debit";
      lines.push(glLine(base, controlAccount, controlDesc, controlSide, amount));
      lines.push(glLine(base, fxAccount, fxDesc, fxSide, amount));
    }

    if (lines.length === 0) return; // nothing to revalue → no entry

    const entry = await input.store.create(input.tenantId, c.entryEntity, {
      entry_number: `${periodLabel}-FXREVAL`,
      entry_date: endDate,
      source: "fx_revaluation",
      state: "posted",
      memo: `Unrealized FX revaluation for period ${periodLabel}`,
      posted_at: nowIso,
      fiscal_period_id: periodId,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const entryId = String(entry["id"]);
    for (const line of lines) {
      await input.store.create(input.tenantId, c.lineEntity, { ...line, journal_entry_id: entryId });
    }
  };
}

export interface BookingRateStampConfig {
  readonly entity: string;
  readonly stateField?: string;
  readonly triggerState: string;
  /** The document's recognition date field (issue/bill date) used to pick the booking rate. */
  readonly dateField: string;
  readonly currencyField?: string;
  readonly bookingRateField?: string;
  readonly functionalCurrency?: string;
  readonly resolveFunctionalCurrency?: (tenantId: string) => Promise<string | undefined>;
  readonly currencyEntity?: string;
  readonly currencyCodeField?: string;
  readonly exchangeRateEntity?: string;
  readonly rateFromField?: string;
  readonly rateToField?: string;
  readonly rateField?: string;
  readonly rateDateField?: string;
  readonly maxRows?: number;
  readonly clock?: { now(): Date };
}

const BOOKING_RATE_FALLBACKS = {
  stateField: "state",
  currencyField: "currency",
  bookingRateField: "booking_rate",
  functionalCurrency: "USD",
  currencyEntity: "Currency",
  currencyCodeField: "code",
  exchangeRateEntity: "ExchangeRate",
  rateFromField: "from_currency_id",
  rateToField: "to_currency_id",
  rateField: "rate",
  rateDateField: "rate_date",
  maxRows: 5000,
} as const;

/**
 * Captures the foreign→functional exchange rate a document is booked at, on its
 * recognition edge (invoice →sent, bill →approved). When the document currency
 * differs from the tenant's functional currency, it looks up the latest
 * `ExchangeRate` on/before the document's date and stamps it on `booking_rate` —
 * the rate period-close revaluation later compares the period-end rate against. A
 * functional-currency document, an already-stamped one, or a missing rate is left
 * untouched. Runs inside the recognition transaction.
 */
export function bookingRateStampEffect(config: BookingRateStampConfig): WriteEffect {
  const c = { ...BOOKING_RATE_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    if (input.before?.[c.stateField] === c.triggerState || input.after[c.stateField] !== c.triggerState) return;

    const doc = input.after;
    const docId = input.id;
    if (docId === null) return;
    if (doc[c.bookingRateField] !== undefined && num(doc[c.bookingRateField]) > 0) return; // already stamped

    const resolved = config.resolveFunctionalCurrency ? await config.resolveFunctionalCurrency(input.tenantId) : undefined;
    const functional = (resolved ?? c.functionalCurrency).toUpperCase();
    const currency = typeof doc[c.currencyField] === "string" ? (doc[c.currencyField] as string).toUpperCase() : functional;
    if (currency === functional) return; // functional-currency document → rate 1, nothing to stamp

    const dateRaw = doc[c.dateField];
    const date = typeof dateRaw === "string" && dateRaw.length > 0 ? dateRaw.slice(0, 10) : null;
    if (date === null) return;

    const functionalCurrencyId = await resolveCurrencyId(input, c, functional);
    if (functionalCurrencyId === null) return;
    const rate = await lookupPeriodEndRate(input, c, currency, functionalCurrencyId, date);
    if (rate === null) return;

    const nowIso = (c.clock?.now() ?? new Date()).toISOString();
    await input.store.update(input.tenantId, c.entity, docId, { [c.bookingRateField]: rate, updated_at: nowIso });
  };
}

/** Resolves a Currency `code` to its record id within the tenant, or null. */
async function resolveCurrencyId(
  input: WriteEffectInput,
  c: { currencyEntity: string; currencyCodeField: string },
  code: string,
): Promise<string | null> {
  const page = await input.store.listPage(input.tenantId, c.currencyEntity, {
    limit: 50,
    cursor: null,
    sort: [],
    filters: [{ field: c.currencyCodeField, op: "eq", value: code }],
  });
  const rec =
    page.records.find((r) => String(r[c.currencyCodeField] ?? "").toUpperCase() === code) ?? undefined;
  return rec !== undefined ? String(rec["id"]) : null;
}

/**
 * Period-end rate for (docCurrency → functional): the ExchangeRate from the doc currency's
 * Currency id to the functional currency id with the latest `rate_date` ≤ `endDate`. Returns
 * null when the doc currency has no Currency record or no eligible rate.
 */
async function lookupPeriodEndRate(
  input: WriteEffectInput,
  c: {
    currencyEntity: string;
    currencyCodeField: string;
    exchangeRateEntity: string;
    rateFromField: string;
    rateToField: string;
    rateField: string;
    rateDateField: string;
    maxRows: number;
  },
  docCurrency: string,
  functionalCurrencyId: string,
  endDate: string,
): Promise<number | null> {
  const fromId = await resolveCurrencyId(input, c, docCurrency);
  if (fromId === null) return null;
  const page = await input.store.listPage(input.tenantId, c.exchangeRateEntity, {
    limit: c.maxRows,
    cursor: null,
    sort: [],
    filters: [
      { field: c.rateFromField, op: "eq", value: fromId },
      { field: c.rateToField, op: "eq", value: functionalCurrencyId },
    ],
  });
  let best: { date: string; rate: number } | null = null;
  for (const r of page.records) {
    if (String(r[c.rateFromField] ?? "") !== fromId) continue;
    if (String(r[c.rateToField] ?? "") !== functionalCurrencyId) continue;
    const dateRaw = r[c.rateDateField];
    const date = typeof dateRaw === "string" && dateRaw.length > 0 ? dateRaw.slice(0, 10) : null;
    if (date === null || date > endDate) continue; // rate must be on/before the period end
    if (best === null || date > best.date) best = { date, rate: num(r[c.rateField]) };
  }
  return best !== null ? best.rate : null;
}
