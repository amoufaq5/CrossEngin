import { drainList } from "./list-drain.js";
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
  /**
   * Largest number of lines this guard reads before it refuses rather than deciding. Reaching it
   * yields `unverifiable_journal_entry` and never a balance verdict over the prefix — which is the
   * whole difference from the `limit` it replaces, since a cap that truncated in silence made this
   * guard wrong in *both* directions from one read.
   */
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
  // 50_000 rather than 1000: `JournalEntry.source` enumerates `payroll` and `depreciation`, and
  // both jobs are declared (`erp-core-payroll-disbursement`, and `erp-core-depreciation-run`, whose
  // own description posts the period's entries to the GL), so a payroll run for 5,000 employees at
  // five lines each is 25,000 lines. A thousand-line cap sits *below* an artifact the entity model
  // has already committed to, which is how a bound stops being a safety margin and starts refusing
  // correct data.
  maxLines: 50_000,
} as const;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- Applied payments, read once ---------------------------------------------

/**
 * `Payment` and its three field names, for the readers below.
 *
 * One object rather than four defaults repeated per caller, because the three sites this replaced
 * each spelled them out and a fourth would have been the fourth chance to disagree about which
 * state means *the money arrived*.
 */
const APPLIED_PAYMENT_FALLBACKS = {
  paymentEntity: "Payment",
  stateField: "state",
  completedState: "completed",
  amountField: "amount",
} as const;

/** Which payment rows count toward a document, and how far the read may go. */
export interface AppliedPaymentsConfig {
  readonly paymentEntity?: string;
  readonly stateField?: string;
  readonly completedState?: string;
  readonly amountField?: string;
  /**
   * The largest payment set this read drains **in full**. Required and never defaulted: the three
   * callers take three different ceilings for three stated reasons (one document's instalments, a
   * tenant-wide fold inside a close transaction, and a report whose ceiling is bounded by its own
   * response), and a default here would be a fourth figure nobody chose.
   */
  readonly ceiling: number;
}

/**
 * One completed-payment total per document, per bucket, with how far the read got.
 *
 * `applied` is positionally aligned with the `refFields` it was asked for — index *i* answers for
 * `refFields[i]` — which is why it is an array and not a record: a caller holding two sides of the
 * ledger (`invoice_id` and `bill_id`) reads its own side by the position it supplied, and a record
 * keyed by field name would let a caller read the other side's map by typing the wrong key.
 */
export interface AppliedPaymentsRead {
  readonly applied: readonly ReadonlyMap<string, number>[];
  /** False when the payment set was larger than `ceiling`; the maps are then a prefix's totals. */
  readonly complete: boolean;
}

/**
 * The one reading of *completed payments summed per document*, folded page by page.
 *
 * ## One map per bucket, and why that is the property worth keeping
 *
 * A bucket's keys are the values of **its own** `refField`, and nothing draws two entities' ids
 * from one space: records are bucketed per `(tenant, entity)` and a caller-supplied `id` is not
 * stripped (the fact `compareIds` records for the keyset). A single map keyed by document id would
 * therefore merge an invoice's payments with a same-id bill's — crediting one document with the
 * other's money and skipping both as overpaid. That is the invariant three independent spellings of
 * this fold each re-derived in a comment, which is the evidence it wanted one home.
 *
 * ## No early stop
 *
 * The fold reads every page even once a running total has crossed whatever the caller is comparing
 * it against, because `Payment.amount`'s declared `min: 0` is enforced by **nothing** — no
 * `FieldErrorCode` member covers a range and `type.min` is read only by two change-detectors in
 * `kernel/ddl/diff.ts` — so a later page can carry a negative correction that takes the total back
 * under. Measured on the effect below: an invoice of 400 with three payments of 200 and a
 * correction of −300 (true applied 300) was written `paid` at a cap of 3 and correctly left `sent`
 * at 99. `drainList` has no halting `onPage` for this reason, so the rule is structural here rather
 * than remembered.
 *
 * ## The reference must be a non-empty string
 *
 * `reference` is `acceptAny` in `FIELD_TYPE_CHECKS`, so `{"invoice_id": 42}` is a body the
 * validator admits and the JSONB store round-trips as the number `42`. Of the three spellings this
 * replaced, two skipped such a row and one counted it (`String(ref ?? "") === docId`), so they
 * disagreed about a reachable record. Converging on the strict form is the fail-closed direction
 * for both readers: a skipped payment understates `applied`, which makes the guard refuse and the
 * effect decline to settle — where counting it would settle a document on a reference nobody can
 * resolve.
 */
async function foldCompletedPayments(
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  refFields: readonly string[],
  filters: readonly ListFilter[],
  config: AppliedPaymentsConfig,
): Promise<{ readonly applied: readonly ReadonlyMap<string, number>[]; readonly complete: boolean }> {
  const c = { ...APPLIED_PAYMENT_FALLBACKS, ...config };
  const applied = refFields.map(() => new Map<string, number>());
  const outcome = await drainList(
    store,
    tenantId,
    c.paymentEntity,
    { sort: [], filters },
    { ceiling: c.ceiling },
    (rows) => {
      for (const p of rows) {
        // Re-checked rather than trusted to the filter: `UNSERVEABLE_SURFACE_REFUSES` makes a
        // dropped filter a refused request on both Postgres stores, but a store wrapper or a
        // direct caller can still hand over rows the filter did not select, and counting a
        // `pending` payment would settle a document nobody has paid.
        if (p[c.stateField] !== c.completedState) continue;
        for (let i = 0; i < refFields.length; i += 1) {
          const ref = p[refFields[i]!];
          if (typeof ref !== "string" || ref.length === 0) continue;
          const bucket = applied[i]!;
          bucket.set(ref, (bucket.get(ref) ?? 0) + num(p[c.amountField]));
        }
      }
    },
  );
  return { applied, complete: outcome.complete };
}

/**
 * Every completed payment in the tenant, summed per document, one map per `refField`.
 *
 * The tenant-wide form, for the two readers that need every document's figure at once: the aging
 * report and the period-close FX revaluation. Filtered on the payment **state** rather than on any
 * document, so it is one pass however many documents the caller goes on to visit — rebuilding the
 * maps per bucket inside a document loop would either re-read every payment per bucket or retain
 * every payment row.
 */
export async function readAppliedPayments(
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  refFields: readonly string[],
  config: AppliedPaymentsConfig,
): Promise<AppliedPaymentsRead> {
  const c = { ...APPLIED_PAYMENT_FALLBACKS, ...config };
  return foldCompletedPayments(
    store,
    tenantId,
    refFields,
    [{ field: c.stateField, op: "eq", value: c.completedState }],
    config,
  );
}

/**
 * What completed payments have applied to **one** document.
 *
 * The degenerate one-bucket form, and the filter is the whole reason it is not just
 * `readAppliedPayments(…).applied[0]!.get(id)`: `refField eq documentId` is one index lookup on the
 * typed store, where draining every completed payment in the tenant to answer about one invoice
 * costs the whole table. The state re-check rides in the fold, and the document re-check is the
 * keying — a payment naming a different document lands under a different key and is never read.
 */
export async function readAppliedToDocument(
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  refField: string,
  documentId: string,
  config: AppliedPaymentsConfig,
): Promise<{ readonly applied: number; readonly complete: boolean }> {
  const read = await foldCompletedPayments(
    store,
    tenantId,
    [refField],
    [{ field: refField, op: "eq", value: documentId }],
    config,
  );
  return { applied: read.applied[0]?.get(documentId) ?? 0, complete: read.complete };
}

/**
 * Rounding slack on the coverage comparison, in the document's currency.
 *
 * Shared by {@link settlementIsCovered}'s two readers, which is the point: the guard below and
 * `paymentApplicationEffect` ask the same question with opposite polarity, and two epsilons that
 * drifted apart would make a document simultaneously unmarkable by hand and auto-marked by the
 * effect — or neither.
 */
export const APPLIED_PAYMENT_EPSILON = 0.005;

/**
 * Whether completed payments cover a document's total, within {@link APPLIED_PAYMENT_EPSILON}.
 *
 * **One predicate with two readers at opposite polarity.** `paymentApplicationEffect` settles a
 * document when this is true; `settlementCoverageGuard` refuses to mark one settled when it is
 * false. Stated as a function rather than as the same comparison written twice because the pair is
 * only sound if the two agree exactly: a guard stricter than the effect leaves a document the
 * effect will settle and a human cannot, and a guard laxer than the effect leaves a state the
 * guard admits and nothing reconciles.
 *
 * A `total` of zero or less is **covered**, which is the right answer for all three of its causes:
 * a nil document, a field the entity does not declare (`num(undefined)` is 0), and a negative
 * total. There is nothing owed, so there is nothing to refuse. The second cause is why an entity
 * with no total field is *declared uncoverable* rather than guarded — a guard over it would pass
 * every write and read as a control.
 */
export function settlementIsCovered(total: number, applied: number): boolean {
  return applied + APPLIED_PAYMENT_EPSILON >= total;
}

/**
 * Enforces double-entry integrity when a journal entry is posted: the entry's
 * fiscal period must be open (not closed/locked), it must have at least one line,
 * and total debits must equal total credits (within `tolerance`). Fires only on
 * the draft→posted edge; all other writes pass. Domain field/entity names are
 * configurable so the guard isn't hard-wired to one manifest.
 *
 * The balance is totalled over **every** line, draining the set rather than reading one page of
 * `maxLines`, because a prefix cannot carry this verdict in either direction. Measured at the old
 * cap of 1000: a 1001-line entry unbalanced by 9999 whose first 1000 lines happen to balance was
 * **allowed to post**, and a genuinely balanced 1001-line entry was **refused** `422
 * unbalanced_journal_entry: debits (10000.00) must equal credits (0.00)` — a detail that is a lie
 * about the entry. A balancing prefix is the ordinary shape here rather than a contrivance, because
 * every GL posting effect writes its lines as a balanced group and the reversal mirrors them
 * pairwise. Past `maxLines` the guard refuses `unverifiable_journal_entry` instead of guessing.
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
    let lines = 0;
    let debit = 0;
    let credit = 0;
    // Folded page by page, so the guard holds two running totals rather than the entry's rows: a
    // depreciation or payroll entry costs O(1) here whatever its size.
    const read = await drainList(
      input.store,
      input.tenantId,
      c.lineEntity,
      { sort: [], filters: [filter] },
      { ceiling: c.maxLines },
      (records) => {
        for (const line of records) {
          if (String(line[c.lineEntryRefField] ?? "") !== entryId) continue;
          lines += 1;
          debit += num(line[c.debitField]);
          credit += num(line[c.creditField]);
        }
      },
    );

    // Neither of these may fall through to the balance verdict, which a prefix cannot support in
    // either direction. What separates them is the completeness conjunct and not their order: a
    // read that matched nothing and had nothing left to read is a complete read of an empty set, so
    // `empty_journal_entry` names what to fix — while an unread set is not an empty one, and a
    // store that ignored the filter could exhaust the ceiling on other entries' lines and match
    // none of this entry's. With the conjunct the two cases partition and swapping these blocks is
    // behaviour-identical; dropping it makes the guard call an entry with lines empty.
    if (lines === 0 && read.complete) {
      return { status: 422, error: "empty_journal_entry", detail: "a posted journal entry must have at least one line" };
    }
    if (!read.complete) {
      // No remedy is named, deliberately: `maxLines` is reachable by no CLI flag, no manifest field
      // and no environment variable (`compileOperateServer` constructs this guard with no config at
      // all), so "raise the cap" is an instruction the operator meeting this cannot carry out.
      return {
        status: 422,
        error: "unverifiable_journal_entry",
        detail:
          `more than ${c.maxLines.toString()} lines match this entry, so the balance of its ` +
          `debits and credits could not be established over the whole set`,
      };
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

// ---- Settlement coverage guard ----------------------------------------------

/**
 * What a document's settled state is called, and the one place the three readers agree on it.
 *
 * Measured on resolved `erp-core`: exactly three lifecycle transitions target it —
 * `Invoice.mark_paid` (from `sent`/`overdue`), `Bill.mark_paid` (from `approved`/`overdue`) and
 * `TaxReturn.mark_paid` (from `filed`) — and the other six packs declare none of their own,
 * inheriting these three through `meta.extends`, which is what bounds this whole guard to one pack.
 */
export const SETTLED_DOCUMENT_STATE = "paid";

export interface SettlementCoverageConfig {
  readonly entity: string;
  /** The `Payment` field referencing this document (e.g. `invoice_id`). */
  readonly refField: string;
  readonly stateField?: string;
  readonly settledState?: string;
  readonly totalField?: string;
  readonly paymentEntity?: string;
  readonly paymentStateField?: string;
  readonly paymentCompletedState?: string;
  readonly paymentAmountField?: string;
  /** Largest payment set the coverage figure is summed over before the guard refuses. */
  readonly maxPayments?: number;
  /** Human noun for the detail, e.g. "an invoice". */
  readonly noun?: string;
  /** What the caller can do about it, appended to the detail. Never a server flag — see below. */
  readonly remedy?: string;
}

const COVERAGE_FALLBACKS = {
  stateField: "state",
  settledState: SETTLED_DOCUMENT_STATE,
  totalField: "total",
  paymentEntity: APPLIED_PAYMENT_FALLBACKS.paymentEntity,
  paymentStateField: APPLIED_PAYMENT_FALLBACKS.stateField,
  paymentCompletedState: APPLIED_PAYMENT_FALLBACKS.completedState,
  paymentAmountField: APPLIED_PAYMENT_FALLBACKS.amountField,
  // The same figure `paymentApplicationEffect` takes, and for its reason: the population is one
  // document's payments, which is smaller than a document's lines but is bounded by nothing in the
  // model either. Two different ceilings would make the guard and the effect refuse at different
  // sizes, which is the one divergence `settlementIsCovered` exists to prevent.
  maxPayments: 10_000,
  noun: "a document",
} as const;

/**
 * The documents the default guards cover, and the `Payment` field each is settled through.
 *
 * **One declaration with two readers**: `defaultWriteGuards` builds a guard per entry, and
 * `apps/operate-server`'s boot survey reads the same list to say which settleable documents are
 * covered and which are not. Two hand-written lists would be ADR-0288's maintained list — wrong
 * four times in this repo — and here the two halves are a guard and the sentence claiming the guard
 * exists, which is the pair where a divergence is worst: a survey naming a document as guarded when
 * no guard was built is a falsely-true control.
 *
 * `TaxReturn` is deliberately **absent**, not an entry with a weaker predicate. Measured on
 * resolved `erp-core`, it has no `total` field (its money columns are `output_tax`, `input_tax` and
 * `net_payable`), no `paid_at`, and `Payment` carries `invoice_id` and `bill_id` and nothing
 * naming it — so the coverage predicate is inexpressible for it in all three of its operands.
 * Adding it with `totalField: "net_payable"` and no reference would make `applied` structurally 0
 * and refuse every filing a tenant ever pays; adding it with `totalField: "total"` would make
 * `num(undefined)` zero and pass every write while reading as a control (ADR-0337's falsely-true
 * direction). The survey names it as uncovered instead, with the reason.
 */
export const SETTLEMENT_COVERAGE_DOCUMENTS: readonly SettlementCoverageConfig[] = [
  {
    entity: "Invoice",
    refField: "invoice_id",
    noun: "an invoice",
    remedy:
      "record the remaining payment and complete it, which settles the invoice automatically; or" +
      " issue a credit note for the balance if it is being written off",
  },
  {
    entity: "Bill",
    refField: "bill_id",
    noun: "a bill",
    // No credit-note arm: `Bill` declares no `document_type`/`credit_note_of` pair, so the
    // AR instrument has no AP counterpart here and naming one would be a remedy that cannot work.
    remedy: "record the remaining payment and complete it, which settles the bill automatically",
  },
];

/**
 * Refuses a write that puts a document into its settled state while completed payments do not
 * cover its total.
 *
 * ## What is wrong, stated as the thing that actually holds
 *
 * The harm is **not** that the general ledger overstates the receivable. Marking an invoice of 120
 * paid against 50 received is one of three business facts the edge cannot tell apart — a write-off,
 * a settlement received off-system, or operator error — and they post to three different accounts,
 * so every posting that *did* happen is individually correct and nothing here can choose between
 * them. What holds under all three readings is the **divergence**: `computeAging` drops a document
 * whose state is not in `openStates`, so the aging subledger reports nothing open, while the GL
 * control account still carries the residual, and no surface in this repository reconciles or even
 * reports the gap. Whichever fact the operator meant, one of the two views is wrong and the two
 * disagree in silence.
 *
 * So this guard closes the **silence** by refusing the writes that produce the uncovered state, and
 * posts nothing. *Refusing the writes* rather than *making the state unreachable*, which is what
 * this comment and ADR-0391's Consequences both said until an adversarial pass reached the state in
 * two ordinary writes — see the predicate below. The honest claim is bounded by the two shapes that
 * predicate covers, and a third route (an effect, a migration, an import) writes rows no guard on
 * the request path sees. ADR-0378 measured the obvious alternative — a residual GL posting on the document's own
 * edge — as actively harmful: it cannot tell *paid with no Payment rows* from *paid via payment
 * application*, so on the ordinary ordering it posts the document total on top of what a Payment
 * already settled (measured AR net −50, cash +170) with no constraint firing, because the entry
 * numbers differ.
 *
 * ## Keyed on the state and the total, never on the operation
 *
 * A write that leaves the document settled and owing more than it did — which fires on a
 * `transition`, on a plain `update` and on a `create` alike. Operation-keying would close one path
 * of two, and the second path is not theoretical: `state` is an ordinary `enum` field on both
 * documents, neither declares any field-level permission (measured: `permissions.Invoice.fields`
 * and `permissions.Bill.fields` are both absent on resolved `erp-core`), `lockedDocumentGuard`
 * returns `null` when the *before* state is unlocked, and **`Bill` has no locked-document guard at
 * all** — four `lockedStates` declarations exist in `compile.ts`, for `Invoice`, `TaxReturn`,
 * `SalesOrder` and `PurchaseOrder`. So `PATCH /v1/invoices/{id} {"state":"paid"}` lands from
 * `draft` and `PATCH /v1/bills/{id} {"state":"paid"}` lands from **any** state, neither of them
 * through the `mark_paid` transition this would otherwise be read as guarding. A `create` carrying
 * `state: "paid"` is the same lie told at insert time, and `before` is `null` there, so the
 * `!==` arm admits it by construction rather than by a third clause.
 *
 * A `delete` can never satisfy it: the handler passes `after: before ?? {}` on that path, so the
 * two states are equal and the second conjunct is false. That is why there is no operation
 * exclusion list — the shape of the predicate is the exclusion.
 *
 * ## An exceeded ceiling refuses
 *
 * `READ_CEILING_EFFECT.guard` is `refuses`, because a decision from a prefix is not a decision —
 * and here the direction is not even bounded: nothing enforces `Payment.amount`'s `min: 0`, so a
 * dropped tail can carry a negative correction and an unread remainder can make the figure wrong
 * either way. `journalPostingGuard`'s precedent exactly.
 *
 * ## The detail carries the figure
 *
 * ADR-0367 forbids interpolating a record value into a refusal, and that rule is about `writeTxn`'s
 * **500 body**: an internal fault names entities, columns and tenant ids nobody chose to disclose,
 * and the caller can act on none of it. A guard block is the opposite — a deliberate 4xx whose job
 * is to tell the caller what to fix — and `lockedDocumentGuard`'s blocks already carry a detail.
 * Measured on resolved `erp-core`, the figure discloses nothing the caller could not already
 * compute: `Invoice.mark_paid` and `Invoice.update` are both `[erp_admin, erp_accountant]`, a
 * subset of `Invoice.read` `[erp_admin, erp_accountant, erp_viewer]`; `Bill.mark_paid` and
 * `Bill.update` are `[erp_admin, ap_clerk]`, a subset of `Bill.read`; `Payment.list` holds all
 * three of those distinct roles ({erp_admin, erp_accountant} ∪ {erp_admin, ap_clerk}); and neither `total` nor `amount` carries a field-level grant. The bound is
 * that this is a property of **this pack's grants** rather than a theorem — a manifest narrowing
 * `read` below `update` would turn the figure into a disclosure — and `remedy` deliberately names
 * only acts the *caller* can perform, never `--allow-uncovered-settlement`, because a 4xx that
 * names a server flag is telling a client to ask for the guard to be switched off.
 *
 * `422` rather than `409`: the request is well-formed and nothing about the body is in conflict, so
 * this is `period_locked`'s shape — refused because *another record* is in a state that forbids the
 * write — and not `uniqueConflict`'s, where the submitted *value* collides with a stored one.
 */
export function settlementCoverageGuard(config: SettlementCoverageConfig): WriteGuard {
  const c = { ...COVERAGE_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.entity) return null;
    // Two ways a write puts a document into an uncovered settled state, and the first spelling had
    // only one of them. Entering the state is the obvious one. The other is **raising the total of
    // a document already in it**, which an adversarial pass reached in two ordinary writes as
    // `ap_clerk` on the shipped pack: a Bill created `approved` with `total 0`, `mark_paid` (allowed
    // by the nothing-owed arm below, correctly — nothing was owed), then `PATCH {"total":120}`,
    // which the edge-only predicate let through because `before[state]` was already `paid`. The
    // result is `paid` with 120 owed and no payments, which is the divergence this guard exists to
    // close, on the one entity nothing else protects: `Invoice` is incidentally covered because
    // `paid` is one of its `lockedStates`, and `Bill` has no locked-document guard at all.
    //
    // So the predicate is *a write that leaves the document settled and owing more than it did*.
    // A write of an already-settled document that does not raise the total still answers `null` —
    // that is a stamp, a note, a correction downward — which is why `owesMore` is a comparison
    // rather than a presence test.
    const settledAfter = input.after[c.stateField] === c.settledState;
    const settledBefore = input.before?.[c.stateField] === c.settledState;
    const owesMore =
      settledBefore && num(input.after[c.totalField]) > num(input.before?.[c.totalField]);
    if (!settledAfter || (settledBefore && !owesMore)) return null;

    // A total that cannot be read is refused rather than allowed, which is the **fourth** cause of
    // an unreadable figure and the only one where allowing is the wrong answer: `num` collapses a
    // non-numeric value to 0, so without this a Bill whose stored `total` is `"n/a"` takes the
    // nothing-owed arm, is marked paid, and is dropped by the aging report in silence. ADR-0367's
    // rule, which the ceiling arm below already follows — a decision from a quantity that could not
    // be read is not a decision. Reachable only from a row `validateEntity` would have refused on
    // the wire (an effect, a migration, an import), and `paymentApplicationEffect` returns early on
    // `total <= 0` so it will not auto-settle such a row either: the two stay consistent.
    const rawTotal = input.after[c.totalField];
    if (rawTotal !== undefined && rawTotal !== null && !Number.isFinite(Number(rawTotal))) {
      return {
        status: 422,
        error: "settlement_coverage_unverifiable",
        detail:
          `this ${c.noun}'s ${c.totalField} is not a number, so what is owed on it could not be` +
          ` read`,
      };
    }
    const total = num(rawTotal);
    // Nothing owed, nothing to refuse — and the read below is skipped, so a nil document costs no
    // round trip. `settlementIsCovered` answers the same way; the early return is the cost saving
    // and not a second spelling of the rule, which is why the predicate is still consulted after it.
    if (total <= 0) return null;

    const documentId =
      input.id ?? (typeof input.after["id"] === "string" ? (input.after["id"] as string) : null);
    // A create whose id the store has not assigned yet can carry no payments: nothing could
    // reference a document that does not exist. So the figure is 0 and the predicate decides,
    // rather than this falling through to an allow — which is the difference between refusing a
    // document created directly as `paid` and admitting it.
    const read =
      documentId === null
        ? { applied: 0, complete: true }
        : await readAppliedToDocument(input.store, input.tenantId, c.refField, documentId, {
            paymentEntity: c.paymentEntity,
            stateField: c.paymentStateField,
            completedState: c.paymentCompletedState,
            amountField: c.paymentAmountField,
            ceiling: c.maxPayments,
          });

    if (!read.complete) {
      // No remedy named, `unverifiable_journal_entry`'s reason: `maxPayments` is reachable by no CLI
      // flag, no manifest field and no environment variable, so "raise the cap" is an instruction
      // the operator meeting this cannot carry out.
      return {
        status: 422,
        error: "settlement_coverage_unverifiable",
        detail:
          `more than ${c.maxPayments.toString()} payments match this document, so what has been` +
          ` applied to it could not be totalled over the whole set`,
      };
    }
    if (settlementIsCovered(total, read.applied)) return null;

    const open = Math.round((total - read.applied) * 100) / 100;
    return {
      status: 422,
      error: "uncovered_settlement",
      detail:
        `cannot leave ${c.noun} ${c.settledState} while ${open.toFixed(2)} of ${total.toFixed(2)} is` +
        ` still owed: ${c.remedy ?? "record the remaining payment"}`,
    };
  };
}
