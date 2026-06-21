import type { EntityStore, ListFilter } from "./store.js";

/** A write the guard is asked to vet, just before it is persisted. */
export interface WriteGuardInput {
  readonly operation: "create" | "update" | "transition" | "delete";
  readonly entity: string;
  readonly tenantId: string;
  /** Record id for update/transition/delete; null on create. */
  readonly id: string | null;
  /** Stored record before the write (null on create). */
  readonly before: Record<string, unknown> | null;
  /** Record as it will be after the write (merged for update/transition, body for create, = before for delete). */
  readonly after: Record<string, unknown>;
  readonly store: EntityStore;
}

/** A guard returns null to allow the write, or a block to reject it with an HTTP-ish status. */
export interface WriteGuardBlock {
  readonly status: number;
  readonly error: string;
  readonly detail?: string;
}

export type WriteGuardResult = WriteGuardBlock | null;
export type WriteGuard = (input: WriteGuardInput) => Promise<WriteGuardResult>;

/** Runs guards in order; the first block short-circuits and is returned. */
export async function runWriteGuards(
  guards: readonly WriteGuard[],
  input: WriteGuardInput,
): Promise<WriteGuardResult> {
  for (const guard of guards) {
    const result = await guard(input);
    if (result !== null) return result;
  }
  return null;
}

// ---- Journal posting guard ---------------------------------------------------

export interface JournalPostingGuardConfig {
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly postedState?: string;
  readonly reversedState?: string;
  readonly lineEntryRefField?: string;
  readonly debitField?: string;
  readonly creditField?: string;
  readonly periodRefField?: string;
  readonly periodEntity?: string;
  readonly periodStateField?: string;
  readonly lockedPeriodStates?: readonly string[];
  /** Largest absolute debit/credit difference treated as balanced (rounding slack). */
  readonly tolerance?: number;
  /** Max lines fetched when summing (a single entry should be well under this). */
  readonly maxLines?: number;
}

const DEFAULTS = {
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  postedState: "posted",
  reversedState: "reversed",
  lineEntryRefField: "journal_entry_id",
  debitField: "debit",
  creditField: "credit",
  periodRefField: "fiscal_period_id",
  periodEntity: "FiscalPeriod",
  periodStateField: "status",
  lockedPeriodStates: ["closed", "locked"] as readonly string[],
  tolerance: 0.005,
  maxLines: 1000,
} as const;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Enforces double-entry integrity when a journal entry is posted: the entry's
 * fiscal period must be open (not closed/locked), it must have at least one line,
 * and total debits must equal total credits (within `tolerance`). Fires only on
 * the draft→posted edge; all other writes pass. Domain field/entity names are
 * configurable so the guard isn't hard-wired to one manifest.
 */
export function journalPostingGuard(config: JournalPostingGuardConfig = {}): WriteGuard {
  const c = { ...DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.entryEntity) return null;
    const becomingPosted =
      input.after[c.stateField] === c.postedState && input.before?.[c.stateField] !== c.postedState;
    if (!becomingPosted) return null;

    // Period lock: a posting into a closed/locked period is rejected.
    const periodId = input.after[c.periodRefField];
    if (typeof periodId === "string" && periodId.length > 0) {
      const period = await input.store.get(input.tenantId, c.periodEntity, periodId);
      const status = period?.[c.periodStateField];
      if (typeof status === "string" && c.lockedPeriodStates.includes(status)) {
        return {
          status: 422,
          error: "period_locked",
          detail: `cannot post into fiscal period in '${status}' state`,
        };
      }
    }

    // Balance: total debits must equal total credits across the entry's lines.
    const entryId = input.id ?? (typeof input.after["id"] === "string" ? (input.after["id"] as string) : null);
    if (entryId === null) return null;
    const filter: ListFilter = { field: c.lineEntryRefField, op: "eq", value: entryId };
    const page = await input.store.listPage(input.tenantId, c.lineEntity, {
      limit: c.maxLines,
      cursor: null,
      sort: [],
      filters: [filter],
    });
    const lines = page.records.filter((r) => String(r[c.lineEntryRefField] ?? "") === entryId);
    if (lines.length === 0) {
      return { status: 422, error: "empty_journal_entry", detail: "a posted journal entry must have at least one line" };
    }
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      debit += num(line[c.debitField]);
      credit += num(line[c.creditField]);
    }
    if (Math.abs(debit - credit) > c.tolerance) {
      return {
        status: 422,
        error: "unbalanced_journal_entry",
        detail: `debits (${debit.toFixed(2)}) must equal credits (${credit.toFixed(2)})`,
      };
    }
    return null;
  };
}

/** Fields whose change is always allowed (audit/lifecycle), so they don't count as an "edit". */
const IMMUTABILITY_IGNORED_FIELDS = new Set(["updated_at", "created_at"]);

function onlyChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (allowed.has(k) || IMMUTABILITY_IGNORED_FIELDS.has(k)) continue;
    if (before[k] !== after[k]) return false;
  }
  return true;
}

/**
 * Makes a posted journal entry immutable: once `state === posted`, the entry can
 * only be reversed (a state change to `reversed`, with no other field edits) — no
 * other update, and no delete — and its lines can't be created, edited, or deleted
 * while the parent entry is posted. The accounting rule is "post then reverse,
 * never edit". Field/entity names are configurable, mirroring the posting guard.
 */
export function postedEntryImmutabilityGuard(config: JournalPostingGuardConfig = {}): WriteGuard {
  const c = { ...DEFAULTS, ...config };
  return async (input) => {
    if (input.entity === c.entryEntity) {
      if (input.before?.[c.stateField] !== c.postedState) return null;
      if (input.operation === "delete") {
        return { status: 422, error: "posted_entry_immutable", detail: "a posted journal entry cannot be deleted; reverse it instead" };
      }
      const becomingReversed = input.after[c.stateField] === c.reversedState;
      if (becomingReversed && onlyChange(input.before, input.after, new Set([c.stateField, "posted_at"]))) {
        return null;
      }
      return { status: 422, error: "posted_entry_immutable", detail: "a posted journal entry cannot be edited; reverse it instead" };
    }

    if (input.entity === c.lineEntity) {
      const ref = input.after[c.lineEntryRefField] ?? input.before?.[c.lineEntryRefField];
      if (typeof ref !== "string" || ref.length === 0) return null;
      const entry = await input.store.get(input.tenantId, c.entryEntity, ref);
      if (entry?.[c.stateField] === c.postedState) {
        return { status: 422, error: "posted_entry_locked_lines", detail: "cannot modify the lines of a posted journal entry" };
      }
      return null;
    }

    return null;
  };
}
