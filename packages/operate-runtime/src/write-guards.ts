import {
  addDecimal,
  compareDecimal,
  DECIMAL_ZERO,
  type ExactDecimal,
  multiplyDecimal,
  parseDecimal,
  renderDecimal,
  withinOneUnitAtScale,
} from "./decimal.js";
import { drainList } from "./list-drain.js";
import { LEDGER_MONEY_SCALE, unitsOf, unitsToNumber } from "./money.js";
import {
  isAdjustmentPeriodCovering,
  periodLockedDetail,
  resolvePostingPeriod,
  type PostingPeriodConfig,
} from "./posting-period.js";
import type { EntityRecord, EntityStore, ListFilter } from "./store.js";

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

// ---- Currency precision guard --------------------------------------------------

export interface CurrencyPrecisionGuardConfig {
  readonly currencyEntity?: string;
  readonly decimalPlacesField?: string;
}

/**
 * Refuses a currency whose minor unit is finer than the ledger can hold.
 *
 * Every money column a posting writes is `decimal(_, 2)` (`LEDGER_MONEY_SCALE`), so a currency
 * declaring three decimal places — KWD, BHD, OMR, JOD, TND — would have every amount silently rounded
 * to the hundredth on write, and the GL, the aging report and the WHT certificate would all agree on a
 * figure the currency does not have. Holding it would take a schema change to every money column
 * (and their CHECKs), which is a decision rather than a guard. Until then the honest answer is to
 * refuse to declare the currency at all, by name, rather than let `decimal_places` be a number
 * nothing reads. Only a value that is new or changed is refused, so a row stored before this guard
 * can still be read and deleted.
 */
export function currencyPrecisionGuard(config: CurrencyPrecisionGuardConfig = {}): WriteGuard {
  const entity = config.currencyEntity ?? "Currency";
  const field = config.decimalPlacesField ?? "decimal_places";
  return async (input) => {
    if (input.entity !== entity) return null;
    if (input.operation !== "create" && input.operation !== "update") return null;
    // As a number whatever its spelling: an `integer` field admits the string `"3"`, which the
    // document store keeps as a string — a `typeof … === "number"` test let it through.
    const places = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const declared = places(input.after[field]);
    if (declared === null || declared <= LEDGER_MONEY_SCALE) return null;
    if (input.operation === "update" && places(input.before?.[field]) === declared) return null;
    return {
      status: 422,
      error: "currency_precision_unsupported",
      detail:
        `${field} is ${String(declared)}, and this deployment's ledger holds money to ` +
        `${String(LEDGER_MONEY_SCALE)} decimal places; every amount in this currency would be rounded ` +
        `on write. Currencies with a finer minor unit are not supported yet.`,
    };
  };
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
  /** The functional-currency (base) amounts, which must balance as well as the transaction ones. */
  readonly functionalDebitField?: string;
  readonly functionalCreditField?: string;
  /** The rate a line's functional amounts are its transaction amounts multiplied by. */
  readonly fxRateField?: string;
  /** The line's transaction currency; transaction amounts balance per currency. */
  readonly currencyField?: string;
  readonly periodRefField?: string;
  readonly entryDateField?: string;
  /** When set, the entry's date is resolved to a period and a locked one refuses the posting. */
  readonly postingPeriods?: PostingPeriodConfig;
  readonly periodEntity?: string;
  readonly periodStateField?: string;
  readonly lockedPeriodStates?: readonly string[];
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
  functionalDebitField: "functional_debit",
  functionalCreditField: "functional_credit",
  fxRateField: "fx_rate",
  currencyField: "currency",
  periodRefField: "fiscal_period_id",
  entryDateField: "entry_date",
  periodEntity: "FiscalPeriod",
  periodStateField: "status",
  lockedPeriodStates: ["closed", "locked"] as readonly string[],
  // 50_000 rather than 1000: `JournalEntry.source` enumerates `payroll` and `depreciation`, and
  // both jobs are declared (`erp-core-payroll-disbursement`, and `erp-core-depreciation-run`, whose
  // own description posts the period's entries to the GL), so a payroll run for 5,000 employees at
  // five lines each is 25,000 lines. A thousand-line cap sits *below* an artifact the entity model
  // has already committed to, which is how a bound stops being a safety margin and starts refusing
  // correct data.
  maxLines: 50_000,
} as const;


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
  // Summed in exact ledger units and handed back as numbers only at the end: a double running total
  // over a tenant's whole payment history drifts by the representation error of every addend.
  const units = refFields.map(() => new Map<string, bigint>());
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
          const bucket = units[i]!;
          bucket.set(ref, (bucket.get(ref) ?? 0n) + unitsOf(p[c.amountField]));
        }
      }
    },
  );
  const applied = units.map((bucket) => new Map([...bucket].map(([k, v]) => [k, unitsToNumber(v)] as const)));
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
 * a nil document, a field the entity does not declare (an absent amount reads as 0), and a negative
 * total. There is nothing owed, so there is nothing to refuse. The second cause is why an entity
 * with no total field is *declared uncoverable* rather than guarded — a guard over it would pass
 * every write and read as a control.
 */
export function settlementIsCovered(total: number, applied: number): boolean {
  return applied + APPLIED_PAYMENT_EPSILON >= total;
}

/**
 * What a payer owes on a document: its total less any tax withheld at source.
 *
 * Withholding is deducted by the payer and remitted to the authority, so a WHT invoice of 100 with
 * 5 withheld is settled in full by a payment of 95 — the recognition entry debits the control
 * account with 95, not 100. Coverage compared payments against the bare total, so measured on the
 * shipped pack a 95 payment cleared the receivable in the GL to zero while the invoice stayed
 * `sent`, `mark_paid` was refused `uncovered_settlement: 5.00 of 100.00`, and the aging report
 * carried 5 open for ever: three surfaces disagreeing about one document, with no act by which the
 * customer could ever finish paying it. `withholdingField` absent, or the field absent on the
 * record, owes the total.
 */
export function amountOwed(document: EntityRecord, totalField: string, withholdingField: string | undefined): number {
  const total = unitsOf(document[totalField]);
  if (withholdingField === undefined) return unitsToNumber(total);
  const withheld = unitsOf(document[withholdingField]);
  return unitsToNumber(withheld > 0n ? total - withheld : total);
}

/**
 * Enforces double-entry integrity when a journal entry is posted: the entry's fiscal period must be
 * open (not closed/locked), it must have at least two lines, and its debits must equal its credits
 * **exactly** — per transaction currency, and again over the functional-currency (base) amounts.
 * Fires on every write that leaves the entry `posted` from anything else, a create included.
 * Domain field/entity names are configurable so the guard isn't hard-wired to one manifest.
 *
 * The balance is totalled over **every** line, draining the set rather than reading one page of
 * `maxLines`, because a prefix cannot carry this verdict in either direction. Measured at the old
 * cap of 1000: a 1001-line entry unbalanced by 9999 whose first 1000 lines happen to balance was
 * **allowed to post**, and a genuinely balanced 1001-line entry was **refused** `422
 * unbalanced_journal_entry: debits (10000.00) must equal credits (0.00)` — a detail that is a lie
 * about the entry. A balancing prefix is the ordinary shape here rather than a contrivance, because
 * every GL posting effect writes its lines as a balanced group and the reversal mirrors them
 * pairwise. Past `maxLines` the guard refuses `unverifiable_journal_entry` instead of guessing.
 *
 * The totals are exact decimals and the comparison is `===`, with no tolerance. The tolerance this
 * replaced (0.005 over doubles) was too loose and too tight at once: a double cannot hold a
 * `NUMERIC(16, 2)` amount near its upper range, so `99999999999999.99` and `…98` read as the same
 * number and an entry out by a cent posted, while at scale 2 there is no real difference below a
 * cent for the slack to absorb. Per currency, because a sum of euros and dollars is not a quantity:
 * the old single total admitted `100 EUR Dr / 100 USD Cr`. The functional amounts are checked
 * because they are what a base-currency ledger is read from, and they were not checked at all —
 * an entry posted with functional `100 Dr / 7 Cr` (live L11). A line amount that is not a decimal
 * refuses the entry rather than reading as zero, which is what `Number("n/a") → 0` used to do.
 */
export function journalPostingGuard(config: JournalPostingGuardConfig = {}): WriteGuard {
  const c = { ...DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.entryEntity) return null;
    const becomingPosted =
      input.after[c.stateField] === c.postedState && input.before?.[c.stateField] !== c.postedState;
    if (!becomingPosted) return null;

    // Period lock, by the posting date: an entry dated into a closed period is refused whether or
    // not it names that period. Naming one used to be the only way to be checked, so an entry that
    // left `fiscal_period_id` empty — which every manual entry and every effect posting did — went
    // into a closed book unchecked.
    //
    // The one exception is an entry that names an **adjustment** period covering its own date: that
    // period shares its dates with the last ordinary one, and posting year-end adjustments into it
    // after the ordinary period is closed is what an adjustment period is for — so there the named
    // period's own status decides, read just below.
    const periodId = input.after[c.periodRefField];
    const named =
      typeof periodId === "string" && periodId.length > 0
        ? await input.store.get(input.tenantId, c.periodEntity, periodId)
        : null;
    if (config.postingPeriods !== undefined) {
      const date = input.after[c.entryDateField];
      if (
        typeof date === "string" &&
        date.length >= 10 &&
        !(named !== null && isAdjustmentPeriodCovering(named, date, config.postingPeriods))
      ) {
        const period = await resolvePostingPeriod(input.store, input.tenantId, date, config.postingPeriods);
        if (period.kind === "locked") {
          return { status: 422, error: "period_locked", detail: periodLockedDetail(period.status, date) };
        }
      }
    }
    // And by the named period, which may differ from the one the date falls in.
    if (named !== null) {
      const status = named[c.periodStateField];
      if (typeof status === "string" && c.lockedPeriodStates.includes(status)) {
        return {
          status: 422,
          error: "period_locked",
          detail: `cannot post into fiscal period in '${status}' state`,
        };
      }
    }

    // An entry with no id yet — a create that names none — can have no line referencing it, so it
    // is the empty entry. This arm used to return `null`, which let `POST {state: "posted"}` with
    // no lines through (live L12).
    const entryId = input.id ?? (typeof input.after["id"] === "string" ? (input.after["id"] as string) : null);
    if (entryId === null) return EMPTY_ENTRY;
    const filter: ListFilter = { field: c.lineEntryRefField, op: "eq", value: entryId };
    const totals = new JournalTotals();
    // Folded page by page, so the guard holds running totals rather than the entry's rows: a
    // depreciation or payroll entry costs O(currencies) here whatever its size.
    const read = await drainList(
      input.store,
      input.tenantId,
      c.lineEntity,
      { sort: [], filters: [filter] },
      { ceiling: c.maxLines },
      (records) => {
        for (const line of records) {
          if (String(line[c.lineEntryRefField] ?? "") !== entryId) continue;
          totals.add(
            line[c.currencyField],
            line[c.debitField],
            line[c.creditField],
            line[c.functionalDebitField],
            line[c.functionalCreditField],
            line[c.fxRateField],
          );
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
    if (totals.lines === 0 && read.complete) return EMPTY_ENTRY;
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
    // One line cannot be a double entry: it either moves nothing (debit equals credit on itself)
    // or is unbalanced, so neither reading is a posting.
    if (totals.lines === 1) {
      return {
        status: 422,
        error: "single_line_journal_entry",
        detail: "a posted journal entry must have at least two lines",
      };
    }
    if (totals.unreadable > 0) {
      return {
        status: 422,
        error: "unverifiable_journal_entry",
        detail:
          `${totals.unreadable.toString()} line amount(s) or rate(s) are not decimals, so the balance of ` +
          `this entry's debits and credits could not be established`,
      };
    }
    return totals.imbalance() ?? totals.misconverted();
  };
}

const EMPTY_ENTRY: WriteGuardBlock = {
  status: 422,
  error: "empty_journal_entry",
  detail: "a posted journal entry must have at least two lines",
};

/** A debit total and a credit total, both exact. */
interface DebitCredit {
  debit: ExactDecimal;
  credit: ExactDecimal;
}

/**
 * The running exact totals of one entry's lines: transaction amounts keyed by currency, functional
 * amounts over the whole entry. An absent or null amount is zero — the column defaults to 0 and a
 * line naming only its debit is a line whose credit is zero — while a present value that is not a
 * decimal is counted as unreadable and decides nothing.
 */
class JournalTotals {
  lines = 0;
  unreadable = 0;
  private readonly byCurrency = new Map<string, DebitCredit>();
  private readonly functional: DebitCredit = { debit: DECIMAL_ZERO, credit: DECIMAL_ZERO };
  private misconversion: { amount: ExactDecimal; rate: ExactDecimal; functional: ExactDecimal; count: number } | null =
    null;

  add(currency: unknown, debit: unknown, credit: unknown, fDebit: unknown, fCredit: unknown, fxRate: unknown): void {
    this.lines += 1;
    this.checkConversion(debit, credit, fDebit, fCredit, fxRate);
    const key = typeof currency === "string" ? currency : "";
    const bucket = this.byCurrency.get(key) ?? { debit: DECIMAL_ZERO, credit: DECIMAL_ZERO };
    bucket.debit = this.plus(bucket.debit, debit);
    bucket.credit = this.plus(bucket.credit, credit);
    this.byCurrency.set(key, bucket);
    this.functional.debit = this.plus(this.functional.debit, fDebit);
    this.functional.credit = this.plus(this.functional.credit, fCredit);
  }

  /**
   * A line's functional amounts are its transaction amounts at its own rate, to the column's two
   * places: either rounding of the exact product, so a preparer can move the last cent of one line
   * to make the rounded legs balance (`withinOneUnitAtScale`). Nothing checked this, so a line
   * stating `debit 100 @ 3.6725` with `functional_debit 7` posted as long as the functional legs
   * balanced among themselves.
   *
   * A line stating **no** functional amount — both legs absent or zero beside a non-zero transaction
   * amount — is exempt, and that is the deliberate half of the rule rather than a gap in it. The
   * columns default to 0, so this is every line whose writer never set them, and the live producer
   * of such lines is the depreciation job (`erp-job-handlers.ts`, which creates lines with `debit` and
   * `credit` alone and then fires `post`): refusing them would refuse every depreciation posting a
   * deployment makes today, which ADR-0338's rule forbids. A stated figure must be the right one; an
   * unstated one is reported as unstated by nothing here, and the base ledger carries zero for it.
   */
  private checkConversion(debit: unknown, credit: unknown, fDebit: unknown, fCredit: unknown, fxRate: unknown): void {
    const stated = (v: unknown): boolean => {
      if (v === undefined || v === null) return false;
      const parsed = parseDecimal(v);
      return parsed === null || parsed.units !== 0n;
    };
    if (!stated(fDebit) && !stated(fCredit)) return;
    // The other half of the same rule: a line moving **no** transaction amount and a stated
    // functional one is a functional-only adjustment — a realized or unrealized FX difference, which
    // exists only in the base currency and so has no transaction amount for a rate to multiply. Its
    // currency bucket nets to nothing and the functional legs must still balance, so admitting it
    // cannot let an entry move value it does not account for; refusing it made realized and
    // unrealized FX inexpressible except by stating the difference as a transaction amount, which is
    // the `amount = functional` lie the revaluation posted (ADR-0429's open question).
    if (!stated(debit) && !stated(credit)) return;
    const rate = fxRate === undefined || fxRate === null ? { negative: false, units: 1n, scale: 0 } : parseDecimal(fxRate);
    if (rate === null) {
      // A stated functional amount beside a rate that is not a decimal cannot be shown right or
      // wrong, so the entry is refused as unverifiable rather than passed.
      this.unreadable += 1;
      return;
    }
    for (const [amount, functional] of [
      [debit, fDebit],
      [credit, fCredit],
    ] as const) {
      const a = amount === undefined || amount === null ? DECIMAL_ZERO : parseDecimal(amount);
      const f = functional === undefined || functional === null ? DECIMAL_ZERO : parseDecimal(functional);
      if (a === null || f === null) continue; // `plus` counts these as unreadable and the entry is refused
      if (withinOneUnitAtScale(f, multiplyDecimal(a, rate), 2)) continue;
      if (this.misconversion === null) this.misconversion = { amount: a, rate, functional: f, count: 0 };
      this.misconversion.count += 1;
    }
  }

  misconverted(): WriteGuardBlock | null {
    const m = this.misconversion;
    if (m === null) return null;
    const product = multiplyDecimal(m.amount, m.rate);
    const others = m.count > 1 ? ` (and ${(m.count - 1).toString()} more line amount(s) like it)` : "";
    return {
      status: 422,
      error: "functional_amount_mismatch",
      detail:
        `a line's functional amount ${cents(m.functional)} is not its amount ${cents(m.amount)} at its ` +
        `fx_rate ${renderDecimal(m.rate)} (${renderDecimal(product)}, to two places)${others}`,
    };
  }

  private plus(total: ExactDecimal, value: unknown): ExactDecimal {
    if (value === undefined || value === null) return total;
    const parsed = parseDecimal(value);
    if (parsed === null) {
      this.unreadable += 1;
      return total;
    }
    return addDecimal(total, parsed);
  }

  imbalance(): WriteGuardBlock | null {
    const several = this.byCurrency.size > 1;
    for (const [currency, { debit, credit }] of [...this.byCurrency].sort(([a], [b]) => a.localeCompare(b))) {
      if (compareDecimal(debit, credit) !== 0) {
        const where = several ? `in ${currency === "" ? "lines with no currency" : currency}: ` : "";
        return {
          status: 422,
          error: "unbalanced_journal_entry",
          detail: `${where}debits (${cents(debit)}) must equal credits (${cents(credit)})`,
        };
      }
    }
    if (compareDecimal(this.functional.debit, this.functional.credit) !== 0) {
      return {
        status: 422,
        error: "unbalanced_journal_entry",
        detail:
          `functional-currency debits (${cents(this.functional.debit)}) must equal ` +
          `functional-currency credits (${cents(this.functional.credit)})`,
      };
    }
    return null;
  }
}

/** Renders a total with at least two fraction digits, never fewer than it carries. */
function cents(d: ExactDecimal): string {
  return renderDecimal(addDecimal(d, { negative: false, units: 0n, scale: 2 }));
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
export function postedEntryImmutabilityGuard(
  config: JournalPostingGuardConfig = {},
  hintByState?: Readonly<Record<string, string>>,
): WriteGuard {
  const c = { ...DEFAULTS, ...config };
  return lockedDocumentGuard({
    entity: c.entryEntity,
    stateField: c.stateField,
    // `reversed` too: a reversal leaves the original's lines in the ledger beside a mirror entry that
    // negates exactly those lines, so editing, moving or deleting one afterwards — or deleting the
    // original — unbalances the pair as surely as doing it while the entry was `posted`.
    lockedStates: [c.postedState, c.reversedState],
    allowedUpdateTransitions: { [c.postedState]: [c.reversedState] },
    ignoredFields: ["posted_at"],
    childEntity: c.lineEntity,
    childParentField: c.lineEntryRefField,
    lockedError: "posted_entry_immutable",
    childLockedError: "posted_entry_locked_lines",
    noun: "journal entry",
    // The noun follows the state, and so does the remedy. A single `posted journal entry` /
    // `reverse it instead` pair was false of a `reversed` entry in both halves — it is not posted any
    // more, and it cannot be reversed a second time — so a reversed entry's refusal named an
    // impossible fix. `reversed` carries no hint: no declared transition leaves it, and naming none
    // is better than naming one that cannot work (ADR-0334).
    nounByState: {
      [c.postedState]: "posted journal entry",
      [c.reversedState]: "reversed journal entry",
    },
    hintByState: hintByState ?? { [c.postedState]: "reverse it instead" },
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
  /** A noun per locked state, where one noun would be false of some of them (a `reversed` entry is not posted). */
  readonly nounByState?: Readonly<Record<string, string>>;
  /** Suffix appended to the "cannot be edited" detail (e.g. "reverse it instead"). */
  readonly reverseHint?: string;
  /**
   * The remedy per locked state, which **replaces** `reverseHint` when given: a state absent from it
   * gets no remedy at all. A remedy is a declared transition out of the state the document is in,
   * and one sentence for every locked state named transitions that cannot fire from some of them —
   * `void it instead` to a paid invoice, `amend it instead` to a paid tax return.
   */
  readonly hintByState?: Readonly<Record<string, string>>;
}

/**
 * `a` or `an` before a noun, by its first letter. The two lifecycle refusals interpolate a noun the
 * manifest or a config supplies, and a hardcoded `a` read "a Invoice", "a issued invoice", "a
 * approved purchase order". By letter rather than by sound, so "an uuid" is possible and nothing
 * here spells one; every noun these guards build starts with its entity or state name.
 */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * The distinct parent ids a child write touches: the stored record's parent, then the written one.
 * The one place a child arm reads its parent reference, so the before-parent cannot be checked on
 * one child entity and forgotten on another — every child config `defaultWriteGuards` builds reads this.
 */
export function childParentRefs(input: WriteGuardInput, parentField: string): readonly string[] {
  const refs: string[] = [];
  for (const v of [input.before?.[parentField], input.after[parentField]]) {
    if (typeof v === "string" && v.length > 0 && !refs.includes(v)) refs.push(v);
  }
  return refs;
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
  const nounFor = (state: string): string => withArticle(config.nounByState?.[state] ?? noun);
  const hintFor = (state: string): string => {
    const hint = config.hintByState !== undefined ? config.hintByState[state] : config.reverseHint;
    return hint !== undefined ? `; ${hint}` : "";
  };

  return async (input) => {
    if (config.childEntity !== undefined && config.childParentField !== undefined && input.entity === config.childEntity) {
      // Every parent the write touches, not only the one the line ends up under. `after` is the
      // merged record on an update, so reading it alone checked only the *new* parent and a line
      // could be moved out of a posted entry by re-pointing its reference — the entry it left then
      // read 500 debit / 0 credit with nothing refusing it.
      for (const ref of childParentRefs(input, config.childParentField)) {
        // Read under a share lock held to the end of the line's transaction, which conflicts with
        // the exclusive lock a transition takes on the parent: so the parent cannot move from the
        // state read here until this line has committed, and a transition that already holds it is
        // waited for and its new state read. A plain read let a line decided on a draft entry commit
        // after `post` had summed the lines without it.
        const parent = await input.store.getLocked(input.tenantId, config.entity, ref, "share");
        const parentState = parent?.[stateField];
        if (typeof parentState === "string" && lockedStates.has(parentState)) {
          const leaving = ref === input.before?.[config.childParentField] && ref !== input.after[config.childParentField];
          return {
            status: 422,
            error: childLockedError,
            detail: leaving
              ? `cannot move a line out of ${nounFor(parentState)}`
              : `cannot modify the lines of ${nounFor(parentState)}`,
          };
        }
      }
      return null;
    }

    if (input.entity !== config.entity) return null;
    const beforeState = input.before?.[stateField];
    if (typeof beforeState !== "string" || !lockedStates.has(beforeState)) return null;

    // Declared lifecycle transitions advance a locked document (RBAC + from-state enforce validity).
    if (input.operation === "transition") return null;

    if (input.operation === "delete") {
      return { status: 422, error: lockedError, detail: `${nounFor(beforeState)} cannot be deleted${hintFor(beforeState)}` };
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
      return { status: 422, error: lockedError, detail: `${nounFor(beforeState)} cannot be edited${hintFor(beforeState)}` };
    }

    return null;
  };
}

// ---- Lifecycle state guard --------------------------------------------------

export interface LifecycleTransitionShape {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: string;
}

export interface LifecycleStateConfig {
  readonly entity: string;
  readonly stateField: string;
  readonly initialState: string;
  readonly transitions: readonly LifecycleTransitionShape[];
}

/** The two refusals, one per operation that can carry a state value. */
export const LIFECYCLE_STATE_ERRORS = {
  create: "lifecycle_state_not_initial",
  update: "lifecycle_state_not_writable",
} as const;

/** Shortest chain of declared transitions from `from` to `to`, or null when none exists. */
function transitionRoute(
  transitions: readonly LifecycleTransitionShape[],
  from: string,
  to: string,
): readonly string[] | null {
  const seen = new Set([from]);
  let frontier: { readonly state: string; readonly path: readonly string[] }[] = [{ state: from, path: [] }];
  while (frontier.length > 0) {
    const next: { readonly state: string; readonly path: readonly string[] }[] = [];
    for (const { state, path } of frontier) {
      for (const t of transitions) {
        if (!t.from.includes(state) || seen.has(t.to)) continue;
        const route = [...path, t.name];
        if (t.to === to) return route;
        seen.add(t.to);
        next.push({ state: t.to, path: route });
      }
    }
    frontier = next;
  }
  return null;
}

function routeSentence(config: LifecycleStateConfig, from: string, to: string): string {
  const route = transitionRoute(config.transitions, from, to);
  return route === null
    ? `no declared transition leads from '${from}' to '${to}'`
    : `from '${from}' fire ${route.map((n) => `'${n}'`).join(" then ")}`;
}

/**
 * A lifecycle state field is moved only by the lifecycle's declared transitions.
 *
 * The field is an ordinary `enum` on the entity, so without this a `PATCH {"state":"approved"}`
 * skipped the `approve` transition's own grant and from-state check, and a Bill PATCHed
 * draft → approved → draft → approved posted to the general ledger once per arrival, because the
 * recognition effect fires on entering the state whatever the operation. A guard per document
 * (ADR-0391's `paid` edge) closed one edge of one graph; the field is what has to be read-only.
 *
 * A create may land only in the workflow's `initialState` (or leave the field unset), and an update
 * may not change the field at all — a value equal to the stored one is not a change, which is what
 * a client re-sending a whole record does. A `transition` is the declared path and is not looked at;
 * a `delete` carries no new state. Keyed on the stored value, so an update that cannot see `before`
 * refuses any state it is handed rather than assuming it matches.
 *
 * The detail names the transitions that would make the move, or says that none does, because the
 * remedy for this refusal is a route the manifest defines and the caller may not know.
 */
export function lifecycleStateGuard(config: LifecycleStateConfig): WriteGuard {
  const { entity, stateField, initialState } = config;
  return async (input) => {
    if (input.entity !== entity) return null;
    if (input.operation === "create") {
      const v = input.after[stateField];
      if (v === undefined || v === null || v === initialState) return null;
      return {
        status: 422,
        error: LIFECYCLE_STATE_ERRORS.create,
        detail:
          `${withArticle(entity)} is created in '${initialState}', and '${stateField}' moves only through its` +
          ` lifecycle transitions: ${routeSentence(config, initialState, String(v))}`,
      };
    }
    if (input.operation !== "update") return null;
    // A stored record with no state is in `initialState`, because a create may leave the field unset
    // and that is what the create arm above admits it as — the transition handler reads it the same
    // way. With no `before` at all nothing is known, so the stored value stays `undefined` and any
    // state handed in is refused rather than assumed to match.
    //
    // Both sides are read that way, not only `before`: the handler passes `after` as `{...before,
    // ...patch}`, so an edit that does not name the state leaves it unset on both sides, and reading
    // only the stored side as `initialState` compared 'draft' against `undefined` and refused every
    // ordinary edit of a stateless record.
    const loaded = input.before !== null && input.before !== undefined;
    const asState = (v: unknown): unknown => (loaded && (v === undefined || v === null) ? initialState : v);
    const from = asState(input.before?.[stateField]);
    const to = asState(input.after[stateField]);
    if (to === from) return null;
    const fromText = typeof from === "string" ? from : "(unset)";
    return {
      status: 422,
      error: LIFECYCLE_STATE_ERRORS.update,
      detail:
        `'${stateField}' on ${entity} cannot be changed by an update; it moves only through its` +
        ` lifecycle transitions: ${routeSentence(config, fromText, String(to))}`,
    };
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
  /** Document field carrying tax withheld at source, which the payer never pays to the issuer. */
  readonly withholdingField?: string;
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
    withholdingField: "withholding_total",
    noun: "an invoice",
    remedy:
      "record the remaining payment and complete it, which settles the invoice automatically; or" +
      " issue a credit note for the balance if it is being written off",
  },
  {
    entity: "Bill",
    refField: "bill_id",
    withholdingField: "withholding_total",
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
 * through the `mark_paid` transition this would otherwise be read as guarding. (That was the state
 * when this was written. Both state PATCHes are refused upstream by `lifecycleStateGuard` now, and
 * `Bill` has had a locked-document guard since the one that refused its delete-and-recreate — so
 * on the shipped pack this guard is reached by `mark_paid` and by a `create`; the paragraph stays
 * because a manifest whose documents carry no lifecycle reaches it exactly as described.) A `create` carrying
 * `state: "paid"` is the same lie told at insert time, and `before` is `null` there, so the
 * `!==` arm admits it by construction rather than by a third clause.
 *
 * Since `lifecycleStateGuard`, both plain-write routes into `paid` are refused upstream for any
 * document with a lifecycle, so on the shipped packs this guard is reached by the transition and by
 * a write raising a settled document's total. The state-keyed arms stay: a document whose state is
 * not a lifecycle field, or a deployment passing its own `writeGuards`, still writes it directly.
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
    // close, on the one entity nothing else protected when this was written: `Invoice` was
    // incidentally covered because `paid` is one of its `lockedStates`, and `Bill` had no
    // locked-document guard. It has one now, so on the shipped pack that PATCH answers `bill_locked`
    // first; the raising arm stays for a manifest whose settled document carries no lock.
    //
    // So the predicate is *a write that leaves the document settled and owing more than it did*.
    // A write of an already-settled document that does not raise the total still answers `null` —
    // that is a stamp, a note, a correction downward — which is why `owesMore` is a comparison
    // rather than a presence test.
    const settledAfter = input.after[c.stateField] === c.settledState;
    const settledBefore = input.before?.[c.stateField] === c.settledState;
    // Compared as what is owed, so a write lowering the withholding raises it exactly as raising
    // the total does.
    const owesMore =
      settledBefore &&
      input.before !== null &&
      amountOwed(input.after, c.totalField, c.withholdingField) >
        amountOwed(input.before, c.totalField, c.withholdingField);
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
    const total = amountOwed(input.after, c.totalField, c.withholdingField);
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
