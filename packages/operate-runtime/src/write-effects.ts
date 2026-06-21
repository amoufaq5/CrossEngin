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
