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
