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
 * never edit". Implemented on the generic `lockedDocumentGuard`.
 */
export function postedEntryImmutabilityGuard(config: JournalPostingGuardConfig = {}): WriteGuard {
  const c = { ...DEFAULTS, ...config };
  return lockedDocumentGuard({
    entity: c.entryEntity,
    stateField: c.stateField,
    lockedStates: [c.postedState],
    allowedUpdateTransitions: { [c.postedState]: [c.reversedState] },
    ignoredFields: ["posted_at"],
    childEntity: c.lineEntity,
    childParentField: c.lineEntryRefField,
    lockedError: "posted_entry_immutable",
    childLockedError: "posted_entry_locked_lines",
    noun: "posted journal entry",
    reverseHint: "reverse it instead",
  });
}

export interface LockedDocumentConfig {
  readonly entity: string;
  readonly stateField?: string;
  /** States in which the document is immutable (e.g. ["posted"], ["sent","paid"]). */
  readonly lockedStates: readonly string[];
  /**
   * State changes a *plain update* may still make while locked, `from → [to]`.
   * Used where a lifecycle move isn't a transition op (e.g. a journal reversal
   * done via `update state=reversed`). Documents with lifecycle transition ops
   * leave this empty — their state moves go through the (allowed) transition path.
   */
  readonly allowedUpdateTransitions?: Readonly<Record<string, readonly string[]>>;
  /** Extra fields ignored when deciding "only the state changed" (besides audit fields). */
  readonly ignoredFields?: readonly string[];
  /** Child line entity locked while its parent is locked. */
  readonly childEntity?: string;
  /** The child's FK field pointing at the parent's id. */
  readonly childParentField?: string;
  readonly lockedError?: string;
  readonly childLockedError?: string;
  /** Human noun for the detail message, e.g. "issued invoice", "filed tax return". */
  readonly noun?: string;
  /** Suffix appended to the "cannot be edited" detail (e.g. "reverse it instead"). */
  readonly reverseHint?: string;
}

/**
 * Generic "locked document" immutability: once a record's `state` enters a locked
 * set, a plain `update` (field edit) and a `delete` are rejected, and — if a child
 * line entity is configured — its lines can't be created/edited/deleted while the
 * parent is locked. Declared lifecycle `transition` ops are always allowed (they
 * carry their own RBAC + from-state guard), so the document still advances; an
 * `allowedUpdateTransitions` entry additionally permits a pure state change via
 * `update` for documents that lack a transition op. Captures the legal-record
 * pattern shared by posted journal entries, issued invoices, and filed tax returns.
 */
export function lockedDocumentGuard(config: LockedDocumentConfig): WriteGuard {
  const stateField = config.stateField ?? "state";
  const lockedError = config.lockedError ?? "document_locked";
  const childLockedError = config.childLockedError ?? "document_locked_lines";
  const noun = config.noun ?? "document";
  const lockedStates = new Set(config.lockedStates);
  const editHint = config.reverseHint !== undefined ? `; ${config.reverseHint}` : "";

  return async (input) => {
    if (config.childEntity !== undefined && config.childParentField !== undefined && input.entity === config.childEntity) {
      const ref = input.after[config.childParentField] ?? input.before?.[config.childParentField];
      if (typeof ref !== "string" || ref.length === 0) return null;
      const parent = await input.store.get(input.tenantId, config.entity, ref);
      const parentState = parent?.[stateField];
      if (typeof parentState === "string" && lockedStates.has(parentState)) {
        return { status: 422, error: childLockedError, detail: `cannot modify the lines of a ${noun}` };
      }
      return null;
    }

    if (input.entity !== config.entity) return null;
    const beforeState = input.before?.[stateField];
    if (typeof beforeState !== "string" || !lockedStates.has(beforeState)) return null;

    // Declared lifecycle transitions advance a locked document (RBAC + from-state enforce validity).
    if (input.operation === "transition") return null;

    if (input.operation === "delete") {
      return { status: 422, error: lockedError, detail: `a ${noun} cannot be deleted${editHint}` };
    }

    if (input.operation === "update") {
      const target = input.after[stateField];
      const allowed = config.allowedUpdateTransitions?.[beforeState] ?? [];
      if (
        typeof target === "string" &&
        allowed.includes(target) &&
        onlyChange(input.before ?? {}, input.after, new Set([stateField, ...(config.ignoredFields ?? [])]))
      ) {
        return null;
      }
      return { status: 422, error: lockedError, detail: `a ${noun} cannot be edited${editHint}` };
    }

    return null;
  };
}
