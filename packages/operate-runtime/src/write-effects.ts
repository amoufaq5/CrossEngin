import { type ExactDecimal, parseDecimal, renderDecimal } from "./decimal.js";
import { drainList, ReadCeilingExceeded } from "./list-drain.js";
import {
  convertBalanced,
  convertUnits,
  moneyUnits,
  positiveRate,
  RATE_ONE,
  rateWire,
  renderMoney,
  unitsOf,
  unitsToNumber,
} from "./money.js";
import { postingPeriodFor, PostingRefused, type PostingPeriodConfig } from "./posting-period.js";
import { functionalCurrencyOf, taxRemittancePostingMode, type SettingsStore, type TenantSettings } from "./settings.js";
import { determineDocumentTax, type DocumentTaxDetermination, type TaxDeterminationConfig } from "./tax-determination.js";
import {
  isTaxRemittanceRefusal,
  planTaxRemittance,
  TAX_REMITTANCE_ACCOUNT_SETTINGS,
  TAX_REMITTANCE_REFUSALS,
  TAX_REMITTANCE_REVERSAL_SUFFIX,
  taxRemittanceAccountUnresolvedDetail,
  taxRemittanceEntryNumber,
  type TaxRemittancePlan,
  type TaxRemittanceRefusalCode,
  type TaxRemittanceRole,
  type TaxRemittanceShape,
  type TaxRemittanceWiring,
} from "./tax-remittance.js";
import type { EntityRecord, ListFilter } from "./store.js";
import {
  amountOwed,
  readAppliedPayments,
  readAppliedToDocument,
  settlementIsCovered,
  type WriteGuardInput,
} from "./write-guards.js";

/**
 * A side effect run after a write has been persisted (the after-commit sibling of WriteGuard).
 * `transitionTo` carries the lifecycle target state on a `transition` op (absent otherwise), so an
 * effect can name the event by the new state (e.g. `salesorder.placed`).
 */
export type WriteEffectInput = WriteGuardInput & { readonly transitionTo?: string };
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
  /**
   * The largest line set this reversal reads **in full**. Reaching it is reported rather than
   * silently truncated: the effect throws and the write rolls back, where a prefix would leave a
   * posted, unbalanced mirror entry that no balance check downstream can distinguish from a
   * correct one.
   */
  readonly maxLines?: number;
  /** The fiscal calendar a posting's period is resolved from; absent, no period is resolved. */
  readonly periods?: PostingPeriodConfig;
  /**
   * Postings that reverse **part** of another: an entry numbered `<base><sourceSuffix>` may have had
   * part of it reversed by `<base><reversalSuffix>`, which leaves it `posted` because the rest still
   * stands. Reversing it then reverses only what still stands.
   */
  readonly partialReversals?: readonly { readonly sourceSuffix: string; readonly reversalSuffix: string }[];
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
  // 50_000 rather than the 1000 this was, because 1000 is below an artifact the entity model has
  // already committed to: `JournalEntry.source` enumerates `payroll` and `depreciation` and both
  // jobs are declared, so a payroll run for 5,000 employees at five lines each is 25,000 lines.
  maxLines: 50_000,
} as const;

/**
 * Who a record an effect creates is attributed to: whoever performed the act that fired the effect,
 * which is the `updated_by` the handler stamped on the triggering record in this same request. Never
 * the people a copy would carry over from its source — a credit note copied field by field from an
 * invoice used to name the invoice's creator as its own. Empty when the source carries no stamp,
 * which on the column store is also how a null actor reads back, so an entity without the
 * `auditable` trait is not given a column it does not have.
 */
const ACTOR_FIELDS = ["created_by", "updated_by"] as const;
export function attributedToTrigger(source: EntityRecord): EntityRecord {
  if (!Object.prototype.hasOwnProperty.call(source, "updated_by")) return {};
  const actor = source["updated_by"] ?? null;
  return { created_by: actor, updated_by: actor };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A field's value as a number when it holds one at all, else null — the distinction `num` cannot
 * make, because an absent amount and a zero amount are the same to it.
 *
 * It accepts a numeral string as well as a JS number, which is load-bearing rather than
 * defensive: a `decimal` field crosses the store as its canonical wire string, so the
 * `typeof v === "number"` guards this replaces answered **false** for every amount the typed
 * store served. A partial credit note silently became a full one, and a line's flat tax rate
 * silently became "no flat rate" — a wrong posting, not merely a wrong type.
 */
function optionalNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const parsed = parseDecimal(v);
  if (parsed === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Creates a posted journal entry an effect writes, with its fiscal period resolved from its own
 * `entry_date` and the lock enforced — the one door every effect's posting goes through.
 *
 * Effects write through the store and so pass no guard, which is how every system posting used to
 * land in a closed period: the handler's lock read only an entry that named its period, and no
 * effect named one. `periodOverride` is the single exception, for the revaluation a period's own
 * close posts into that period: the close is the act the lock exists for, so it cannot refuse it.
 * `null` there means the caller already resolved the period through `postingPeriodFor` — the lock
 * enforced — and found none, which is how an effect resolves before its first write.
 */
export async function createPostedEntry(
  input: WriteEffectInput,
  entryEntity: string,
  header: EntityRecord,
  periods: PostingPeriodConfig | undefined,
  periodOverride?: string | null,
): Promise<EntityRecord> {
  const record: EntityRecord = { ...header };
  if (periodOverride !== undefined) {
    if (periodOverride !== null) record["fiscal_period_id"] = periodOverride;
  } else {
    const date = typeof header["entry_date"] === "string" ? (header["entry_date"] as string) : "";
    const periodId = date === "" ? null : await postingPeriodFor(input.store, input.tenantId, date, periods);
    if (periodId !== null) record["fiscal_period_id"] = periodId;
  }
  return input.store.create(input.tenantId, entryEntity, record);
}

/** The one posted entry carrying `number`, or null; two is an integrity fault and refuses. */
async function findEntryByNumber(
  input: WriteEffectInput,
  entryEntity: string,
  number: string,
): Promise<EntityRecord | null> {
  const found: EntityRecord[] = [];
  const outcome = await drainList(
    input.store,
    input.tenantId,
    entryEntity,
    { sort: [], filters: [{ field: "entry_number", op: "eq", value: number }] },
    { ceiling: 10 },
    (rows) => {
      for (const r of rows) if (r["entry_number"] === number) found.push(r);
    },
  );
  if (!outcome.complete || found.length > 1) {
    throw new PostingRefused(
      409,
      "posting_ambiguous",
      "more than one journal entry carries the number of the posting this write reverses, so which one to reverse is not established",
    );
  }
  return found[0] ?? null;
}

interface EntryLineShape {
  readonly lineEntity: string;
  readonly lineEntryRefField: string;
  readonly maxLines: number;
}

/** Every line of one entry, read in full or refused — a reversal of a prefix balances and is wrong. */
async function readEntryLines(
  input: WriteEffectInput,
  entryId: string,
  c: EntryLineShape,
): Promise<EntityRecord[]> {
  const lines: EntityRecord[] = [];
  const outcome = await drainList(
    input.store,
    input.tenantId,
    c.lineEntity,
    { sort: [], filters: [{ field: c.lineEntryRefField, op: "eq", value: entryId }] },
    { ceiling: c.maxLines },
    (rows) => {
      for (const line of rows) if (String(line[c.lineEntryRefField] ?? "") === entryId) lines.push(line);
    },
  );
  if (!outcome.complete) throw new ReadCeilingExceeded(c.lineEntity, c.maxLines, "a journal entry's reversal");
  return lines;
}

const LINE_COPY_SKIP = new Set<string>([
  "id",
  "created_at",
  "updated_at",
  ...["created_by", "updated_by"],
  "journal_entry_id",
  "debit",
  "credit",
  "functional_debit",
  "functional_credit",
  "description",
]);

/** A stored rate in one spelling, so `1` and `1.0000000000` are one line dimension. */
function canonicalRate(value: unknown): string {
  const r = positiveRate(value ?? 1);
  if (r === null) return String(value);
  let units = r.units;
  let scale = r.scale;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return renderDecimal({ negative: false, units, scale });
}

/** A line's amounts in integer cents, both pairs. */
function lineCents(line: EntityRecord): { d: bigint; c: bigint; fd: bigint; fc: bigint } {
  return {
    d: unitsOf(line["debit"]),
    c: unitsOf(line["credit"]),
    fd: unitsOf(line["functional_debit"]),
    fc: unitsOf(line["functional_credit"]),
  };
}

/** `cents × num / den`, rounded half away from zero, exact for any magnitude a ledger holds. */
function scaleCents(cents: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (cents * numerator * 2n + denominator) / (2n * denominator);
}

/**
 * The one exchange rate every line of an entry carries, when every line moves a transaction amount
 * at the same rate; null when they differ or a line is functional-only.
 */
function sharedRate(lines: readonly EntityRecord[]): ExactDecimal | null {
  let rate: ExactDecimal | null = null;
  for (const line of lines) {
    const amounts = lineCents(line);
    if (amounts.d === 0n && amounts.c === 0n) return null;
    const r = positiveRate(line["fx_rate"] ?? 1);
    if (r === null) return null;
    if (rate !== null && renderDecimal(r) !== renderDecimal(rate)) {
      // Same value, different scale (`1.1` against `1.1000000000`), is the same rate.
      const scale = Math.max(r.scale, rate.scale);
      const widen = (x: ExactDecimal): bigint => x.units * 10n ** BigInt(scale - x.scale);
      if (widen(r) !== widen(rate)) return null;
    }
    rate = rate ?? r;
  }
  return rate;
}

/**
 * The mirror of a posted entry's lines — debit and credit swapped on both amount pairs, every other
 * dimension (account, currency, rate, cost centre) kept — optionally scaled to a part of the whole.
 *
 * Scaled, each amount is `round(amount × part / whole)` in exact integer cents, and the two sides
 * are then set to `part` exactly: the rounding residual of each side goes to the largest line on it. A
 * scaled reversal therefore balances under ADR-0422's exact rule and sums to the part asked for,
 * which a per-line rounding alone does not guarantee. The functional pair follows the transaction
 * pair line for line when the source carried them equal (every posting this module writes), and is
 * otherwise scaled and balanced on the credit anchor.
 */
function mirrorLines(
  source: readonly EntityRecord[],
  part: { readonly cents: bigint; readonly whole: bigint } | null,
  describe: (description: string) => string,
  stamp: EntityRecord,
): EntityRecord[] {
  const shaped = source.map((line) => {
    const amounts = lineCents(line);
    // Reversed: what was credited is now debited.
    let d = amounts.c;
    let c = amounts.d;
    let fd = amounts.fc;
    let fc = amounts.fd;
    if (part !== null) {
      d = scaleCents(d, part.cents, part.whole);
      c = scaleCents(c, part.cents, part.whole);
      fd = scaleCents(fd, part.cents, part.whole);
      fc = scaleCents(fc, part.cents, part.whole);
    }
    return { line, d, c, fd, fc, equalPairs: amounts.d === amounts.fd && amounts.c === amounts.fc };
  });
  const pick = (side: "d" | "c"): number => {
    let best = -1;
    shaped.forEach((s, i) => {
      if (s[side] > 0n && (best === -1 || s[side] > shaped[best]![side])) best = i;
    });
    return best;
  };
  const debitAnchor = pick("d");
  const creditAnchor = pick("c");
  if (part !== null) {
    const sum = (side: "d" | "c"): bigint => shaped.reduce((a, s) => a + s[side], 0n);
    if (debitAnchor !== -1) shaped[debitAnchor]!.d += part.cents - sum("d");
    if (creditAnchor !== -1) shaped[creditAnchor]!.c += part.cents - sum("c");
  }
  const allEqual = shaped.every((s) => s.equalPairs);
  const commonRate = part === null ? null : sharedRate(source);
  if (allEqual) {
    for (const s of shaped) {
      s.fd = s.d;
      s.fc = s.c;
    }
  } else if (commonRate !== null) {
    // One rate across every line (a foreign document's recognition): the scaled functional amounts
    // are re-derived from the scaled transaction amounts at that rate, balanced, so each stays a
    // rounding of its own product — scaling the source's functional legs and dumping the residual
    // on one line would leave that line further than a cent from `amount × rate`.
    const converted = convertBalanced(shaped.map((s) => ({ d: s.d, c: s.c })), commonRate);
    shaped.forEach((s, i) => {
      s.fd = converted[i]!.d;
      s.fc = converted[i]!.c;
    });
  } else if (part !== null && creditAnchor !== -1) {
    const fd = shaped.reduce((a, s) => a + s.fd, 0n);
    const fc = shaped.reduce((a, s) => a + s.fc, 0n);
    shaped[creditAnchor]!.fc += fd - fc;
  }
  const money = unitsToNumber;
  const kept = part === null ? shaped : shaped.filter((s) => s.d !== 0n || s.c !== 0n || s.fd !== 0n || s.fc !== 0n);
  return kept.map((s) => {
    const out: EntityRecord = {};
    for (const [k, v] of Object.entries(s.line)) if (!LINE_COPY_SKIP.has(k)) out[k] = v;
    out["debit"] = money(s.d);
    out["credit"] = money(s.c);
    out["functional_debit"] = money(s.fd);
    out["functional_credit"] = money(s.fc);
    const desc = typeof s.line["description"] === "string" ? (s.line["description"] as string) : "";
    out["description"] = describe(desc);
    return { ...out, ...stamp };
  });
}

/**
 * On the posted→reversed edge of a journal entry, auto-creates the mirror
 * reversing entry: a new posted entry (same book/period, dated today, numbered
 * `<original>-REV`) whose lines negate the original by swapping debit↔credit (and
 * the functional-currency pair), preserving every other line dimension. The new
 * records are written directly through the store, so they bypass the handler's
 * guards/effects (no recursion) and are balanced by construction.
 */
interface ReverseEntryOptions extends EntryLineShape {
  readonly entryEntity: string;
  readonly stateField: string;
  readonly postedState: string;
  readonly reversedState: string;
  /** The entry to reverse, already found and known posted. */
  readonly source: EntityRecord;
  readonly number: string;
  readonly sourceLabel: string;
  readonly memo: string;
  /** Reverse only this part of the source, in cents of its debit total; null reverses it whole. */
  readonly partCents: bigint | null;
  readonly periods: PostingPeriodConfig | undefined;
  readonly nowIso: string;
  readonly actor: EntityRecord;
}

/**
 * Posts the reversal of one of this module's own posted entries, dated today in today's period, and
 * marks the source `reversed` when it was reversed whole.
 *
 * Marking it is what keeps a later manual `reverse` of the same entry from reversing it a second
 * time: the journal lifecycle moves only `posted → reversed`, so a reversed source can no longer be
 * reached by the transition. A part-reversal leaves it `posted`, because the rest of it still
 * stands. Read in full before anything is written, so a ceiling refusal writes nothing.
 */
async function reverseEntry(input: WriteEffectInput, o: ReverseEntryOptions): Promise<void> {
  const sourceId = String(o.source["id"]);
  const lines = await readEntryLines(input, sourceId, o);
  const debitCents = lines.reduce((a, l) => a + lineCents(l).d, 0n);
  const part = o.partCents === null || o.partCents >= debitCents ? null : { cents: o.partCents, whole: debitCents };
  const mirrored = mirrorLines(lines, part, (d) => `Reversal: ${d}`.trim(), {
    created_at: o.nowIso,
    updated_at: o.nowIso,
    ...o.actor,
  });
  const header: EntityRecord = {
    entry_number: o.number,
    entry_date: o.nowIso.slice(0, 10),
    source: o.sourceLabel,
    [o.stateField]: o.postedState,
    memo: o.memo,
    posted_at: o.nowIso,
    created_at: o.nowIso,
    updated_at: o.nowIso,
    ...o.actor,
  };
  if (typeof o.source["book_id"] === "string") header["book_id"] = o.source["book_id"];
  const created = await createPostedEntry(input, o.entryEntity, header, o.periods);
  const newId = String(created["id"]);
  for (const line of mirrored) {
    await input.store.create(input.tenantId, o.lineEntity, { ...line, [o.lineEntryRefField]: newId });
  }
  if (part === null) {
    await input.store.update(input.tenantId, o.entryEntity, sourceId, {
      [o.stateField]: o.reversedState,
      updated_at: o.nowIso,
    });
  }
}

export interface PostingReversalConfig {
  /** The document whose own posting is reversed (e.g. "Bill", "Payment"). */
  readonly entity: string;
  readonly stateField?: string;
  /** The states the document must leave — the ones in which its posting stands. */
  readonly fromStates: readonly string[];
  readonly toState: string;
  readonly numberField: string;
  /** Suffix of the entry the document's posting effect wrote, e.g. "-GL" or "-SETTLE". */
  readonly sourceSuffix: string;
  /** Suffix of the reversing entry, e.g. "-VOID" or "-REFUND". */
  readonly reversalSuffix: string;
  /** `JournalEntry.source` of the reversing entry. */
  readonly sourceLabel: string;
  /**
   * The payment field naming this document. When set, leaving the state is **refused** while
   * completed payments are applied to it: reversing the posting puts the whole control balance back
   * while the settlement those payments posted stands, so a Bill of 200 with 50 paid, voided, left
   * accounts payable 50 in debit — a balance owed by a vendor for a bill that no longer exists.
   * Refunding the payment first reverses its settlement, and then the void is clean.
   */
  readonly refuseWhileSettledBy?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly periods?: PostingPeriodConfig;
  readonly maxLines?: number;
  readonly clock?: { now(): Date };
}

/**
 * When a document leaves the state its posting stands in — a Bill voided after approval, a Payment
 * refunded after completion — posts the reversal of the entry its own posting effect wrote.
 *
 * Measured before this existed, on the shipped pack: a Bill of 200 approved and then voided left
 * `AP −200 / expense 200` in the GL with the Bill reading `void`, and a Payment of 50 completed and
 * then refunded left the receivable cleared with the Payment reading `refunded`. Both documents had
 * been locked from the state that posted them so that a plain write could not change what the GL
 * held — and the transition out of that state changed it anyway, because nothing undid the posting.
 *
 * The entry is found by the number its posting effect gave it, which is the one key both effects
 * agree on and is declared `unique`. No entry, or one already `reversed`, posts nothing: a Bill
 * voided before it was approved never posted, and reversing a posting twice is what the lifecycle
 * exists to prevent. A prior-state trigger and not `entersState`, for `journalReversalEffect`'s
 * reason: a document created already `void` was never in the state that posted.
 */
export function postingReversalEffect(config: PostingReversalConfig): WriteEffect {
  const c = {
    stateField: "state",
    entryEntity: DEFAULTS.entryEntity,
    lineEntity: DEFAULTS.lineEntity,
    maxLines: DEFAULTS.maxLines,
    ...config,
  };
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const before = input.before?.[c.stateField];
    if (typeof before !== "string" || !c.fromStates.includes(before)) return;
    if (input.after[c.stateField] !== c.toState) return;
    const docId = input.id;
    if (docId === null) return;
    const docNumber = typeof input.after[c.numberField] === "string" ? (input.after[c.numberField] as string) : docId;
    if (c.refuseWhileSettledBy !== undefined) {
      // One document's instalments, `paymentApplicationEffect`'s ceiling for the same read.
      const settled = await readAppliedToDocument(input.store, input.tenantId, c.refuseWhileSettledBy, docId, {
        ceiling: 10_000,
      });
      if (!settled.complete) {
        throw new ReadCeilingExceeded("Payment", 10_000, "the payments applied to a document being voided");
      }
      if (settled.applied !== 0) {
        throw new PostingRefused(
          409,
          "document_partly_settled",
          `completed payments are applied to this ${c.entity}, so moving it to '${c.toState}' would reverse its ` +
            `posting while their settlement stands; refund them first, then retry`,
        );
      }
    }
    const source = await findEntryByNumber(input, c.entryEntity, `${docNumber}${c.sourceSuffix}`);
    if (source === null || source[DEFAULTS.stateField] !== DEFAULTS.postedState) return;
    await reverseEntry(input, {
      entryEntity: c.entryEntity,
      lineEntity: c.lineEntity,
      lineEntryRefField: DEFAULTS.lineEntryRefField,
      maxLines: c.maxLines,
      stateField: DEFAULTS.stateField,
      postedState: DEFAULTS.postedState,
      reversedState: DEFAULTS.reversedState,
      source,
      number: `${docNumber}${c.reversalSuffix}`,
      sourceLabel: c.sourceLabel,
      memo: `Reversal of ${docNumber}${c.sourceSuffix} (${c.toState})`,
      partCents: null,
      periods: c.periods,
      nowIso: (c.clock?.now() ?? new Date()).toISOString(),
      actor: attributedToTrigger(input.after),
    });
  };
}

export function journalReversalEffect(config: JournalReversalConfig = {}): WriteEffect {
  const c = { ...DEFAULTS, ...config };
  return async (input) => {
    if (input.entity !== c.entryEntity) return;
    // NOT `entersState`: this trigger needs a *specific prior state*, and a create has none.
    // A record created already in the target state was never in the prior one, so ignoring it is
    // the right answer rather than a missed edge — see `entersState` for the arrival/prior-state
    // split and why that makes the sweep six sites and not nine.
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

    // A part-reversal whose source is itself reversed has nothing left to undo: the source was
    // either reversed whole by this entry (a full credit marks it `reversed`) or reversed net of it
    // (below), so reversing this one would put back what that reversal already took out. Measured
    // before: an invoice of 110 credited 50, its recognition reversed, then the credit's posting
    // reversed, left a receivable of 50 on a void invoice.
    for (const pair of config.partialReversals ?? []) {
      if (!origNumber.endsWith(pair.reversalSuffix)) continue;
      const base = origNumber.slice(0, origNumber.length - pair.reversalSuffix.length);
      const source = await findEntryByNumber(input, c.entryEntity, `${base}${pair.sourceSuffix}`);
      if (source !== null && source[c.stateField] === c.reversedState) {
        throw new PostingRefused(
          409,
          "reversal_source_already_reversed",
          `${origNumber} reverses part or all of ${base}${pair.sourceSuffix}, which is already reversed, by this entry ` +
            `or net of it; ` +
            `reversing it too would reinstate an amount nothing owes`,
        );
      }
    }

    const reversalEntry: EntityRecord = {
      [c.numberField]: `${origNumber}-REV`,
      [c.entryDateField]: today,
      [c.sourceField]: c.reversalSource,
      [c.stateField]: c.postedState,
      [c.memoField]: `Reversal of ${origNumber}`,
      [c.postedAtField]: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
      ...attributedToTrigger(original),
    };
    // The book carries; the period does not. A reversal is dated today, so it belongs to today's
    // period — copying the original's put an entry dated June into a period that ended in March, and
    // into a closed one with nothing checking, since nothing checked an effect's posting at all.
    if (typeof original["book_id"] === "string") reversalEntry["book_id"] = original["book_id"];

    const skip = new Set<string>([
      "id",
      "created_at",
      "updated_at",
      ...ACTOR_FIELDS,
      c.lineEntryRefField,
      c.debitField,
      c.creditField,
      c.functionalDebitField,
      c.functionalCreditField,
      c.descriptionField,
    ]);
    // **Nothing is written until the read is known complete** — not the lines, and not the entry
    // header either, which is why the header's `create` moved below this drain. Holding the
    // mirrored payloads costs the same bound as holding the rows (one entry's children) and buys
    // the ordering, and the ordering is the whole point rather than tidiness: `writeTxn` falls
    // through to `body(ctx.store)` on a store that is not transactional, so a ceiling refusal there
    // rolls nothing back. Measured before the move: driven over a 5-line entry outside a
    // transaction with `maxLines: 3`, the throw left a second posted `JE-1-REV` entry behind with
    // no lines — and on a retry a third, `JE-1-REV-REV`. A refusal that leaves a posted entry is
    // the defect this effect is being fixed for, arriving by a different door.
    //
    // The payloads carry no entry reference while they are being built, because there is no entry
    // to reference yet; it is stamped on each of them after the header commits. Reading the
    // original's id while writing the new entry's is also why interleaving would have been safe —
    // the drain's filter can never match a row this effect creates — but safe is not the same as
    // ordered, and the ordering is what makes the refusal clean.
    //
    // Netted per line dimension (account, currency, rate, cost centre — everything but the amounts
    // and the bookkeeping fields) against any part of this entry already reversed: a partial credit
    // note posts the mirror of part of an invoice's recognition and leaves it `posted`, because the
    // rest still stands — so a manual reverse of it afterwards used to reverse the whole of it again,
    // and the credited part twice. Measured: an invoice of 110 credited 50, then reversed, left the
    // receivable at −50.
    const sourceLines: EntityRecord[] = [];
    const outcome = await drainList(
      input.store,
      input.tenantId,
      c.lineEntity,
      { sort: [], filters: [{ field: c.lineEntryRefField, op: "eq", value: originalId }] },
      { ceiling: c.maxLines },
      (rows) => {
        for (const line of rows) if (String(line[c.lineEntryRefField] ?? "") === originalId) sourceLines.push(line);
      },
    );
    if (!outcome.complete) {
      throw new ReadCeilingExceeded(c.lineEntity, c.maxLines, "a journal reversal");
    }
    const partialLines: EntityRecord[] = [];
    for (const pair of config.partialReversals ?? []) {
      if (!origNumber.endsWith(pair.sourceSuffix)) continue;
      const base = origNumber.slice(0, origNumber.length - pair.sourceSuffix.length);
      const partial = await findEntryByNumber(input, c.entryEntity, `${base}${pair.reversalSuffix}`);
      if (partial === null || partial[c.stateField] !== c.postedState) continue;
      partialLines.push(
        ...(await readEntryLines(input, String(partial["id"]), {
          lineEntity: c.lineEntity,
          lineEntryRefField: c.lineEntryRefField,
          maxLines: c.maxLines,
        })),
      );
    }
    const amountFields = [c.debitField, c.creditField, c.functionalDebitField, c.functionalCreditField];
    const dimensionKey = (line: EntityRecord): string =>
      JSON.stringify(
        Object.keys(line)
          .filter((k) => !skip.has(k) && !amountFields.includes(k))
          .sort()
          .map((k) => [k, k === "fx_rate" ? canonicalRate(line[k]) : line[k]]),
      );
    // What still stands, per dimension: the source's lines less what the partial reversals mirrored.
    const standing = new Map<string, { line: EntityRecord; tx: bigint; fn: bigint }>();
    const fold = (line: EntityRecord, sign: bigint): void => {
      const k = dimensionKey(line);
      const tx = unitsOf(line[c.debitField]) - unitsOf(line[c.creditField]);
      const fn = unitsOf(line[c.functionalDebitField]) - unitsOf(line[c.functionalCreditField]);
      const was = standing.get(k);
      standing.set(k, { line: was?.line ?? line, tx: (was?.tx ?? 0n) + sign * tx, fn: (was?.fn ?? 0n) + sign * fn });
    };
    // With nothing partly reversed, every line is mirrored as it stands, one for one — two lines on
    // one account are two lines of the reversal, as they were of the entry. Only a partial reversal
    // is netted per dimension, because only there is "what still stands" a difference of two sets.
    const standingLines: { line: EntityRecord; tx: bigint; fn: bigint }[] = [];
    if (partialLines.length === 0) {
      for (const line of sourceLines) {
        standingLines.push({
          line,
          tx: unitsOf(line[c.debitField]) - unitsOf(line[c.creditField]),
          fn: unitsOf(line[c.functionalDebitField]) - unitsOf(line[c.functionalCreditField]),
        });
      }
    } else {
      for (const line of sourceLines) fold(line, 1n);
      for (const line of partialLines) fold(line, 1n);
      standingLines.push(...standing.values());
    }
    const reversals: EntityRecord[] = [];
    for (const { line, tx, fn } of standingLines) {
      if (partialLines.length > 0 && tx === 0n && fn === 0n) continue;
      const reversed: EntityRecord = {};
      for (const [k, v] of Object.entries(line)) {
        if (!skip.has(k)) reversed[k] = v;
      }
      // The mirror of what stands: a net debit is reversed by a credit.
      reversed[c.debitField] = unitsToNumber(tx < 0n ? -tx : 0n);
      reversed[c.creditField] = unitsToNumber(tx > 0n ? tx : 0n);
      // A line that stated no functional pair gets none: the guard reads an absent pair as "the
      // transaction amount is the functional one", and a stated zero would say otherwise.
      if (line[c.functionalDebitField] !== undefined || line[c.functionalCreditField] !== undefined || fn !== 0n) {
        reversed[c.functionalDebitField] = unitsToNumber(fn < 0n ? -fn : 0n);
        reversed[c.functionalCreditField] = unitsToNumber(fn > 0n ? fn : 0n);
      }
      const desc = typeof line[c.descriptionField] === "string" ? (line[c.descriptionField] as string) : "";
      reversed[c.descriptionField] = `Reversal: ${desc}`.trim();
      reversed.created_at = nowIso;
      reversed.updated_at = nowIso;
      Object.assign(reversed, attributedToTrigger(original));
      reversals.push(reversed);
    }
    if (reversals.length === 0 && partialLines.length > 0) return; // the partial reversals left nothing standing

    const created = await createPostedEntry(input, c.entryEntity, reversalEntry, config.periods);
    const newId = String(created["id"]);
    for (const reversed of reversals) {
      reversed[c.lineEntryRefField] = newId;
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
  /** Tax withheld at source, scaled onto a partial credit note in proportion. */
  readonly withholdingField?: string;
  readonly linePositionField?: string;
  readonly lineQuantityField?: string;
  readonly lineUnitPriceField?: string;
  readonly lineTaxRateField?: string;
  readonly lineTotalField?: string;
  /**
   * The largest line set this credit note copies **in full**. Reaching it is reported rather than
   * silently truncated: the header is created carrying the original's total, so a prefix of the
   * lines leaves `total != sum(lines)` on a document the customer is sent, with nothing
   * reconciling the two.
   */
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
  // 50_000, the journal-line figure: these two caps were 1000 and 500 over ONE population — a
  // document's lines — and that they were two different numbers at all was itself the finding.
  maxLines: 50_000,
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
    // NOT `entersState`: this trigger needs a *specific prior state*, and a create has none.
    // A record created already in the target state was never in the prior one, so ignoring it is
    // the right answer rather than a missed edge — see `entersState` for the arrival/prior-state
    // split and why that makes the sweep six sites and not nine.
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
      ...ACTOR_FIELDS,
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
    const totalUnits = unitsOf(original[c.totalField]);
    const requestedUnits = moneyUnits(original[c.creditAmountField]);
    const isPartial = requestedUnits !== null && requestedUnits > 0n && requestedUnits < totalUnits;
    const amountUnits = isPartial ? requestedUnits : totalUnits;
    // A partial credit carries the original's tax in proportion, rather than none: a credit of 55
    // against a 100 + 10 VAT invoice credits 50 of revenue and 5 of tax. Writing the whole amount as
    // net with zero tax told the customer their VAT was unchanged, while the GL — which reverses
    // the recognition entry in the same proportion — reduced it. Scaled in exact integer cents,
    // `creditNoteGlPostingEffect`'s own arithmetic, so the document and its posting agree.
    let partialSubtotal = amountUnits;
    if (isPartial) {
      const scaled = (units: bigint): bigint => scaleCents(units, amountUnits, totalUnits);
      const originalSubtotal = moneyUnits(original[c.subtotalField]);
      partialSubtotal = originalSubtotal === null ? amountUnits : scaled(originalSubtotal);
      creditNote[c.totalField] = unitsToNumber(amountUnits);
      creditNote[c.subtotalField] = unitsToNumber(partialSubtotal);
      creditNote[c.taxTotalField] = unitsToNumber(amountUnits - partialSubtotal);
      if (config.withholdingField !== undefined && moneyUnits(original[config.withholdingField]) !== null) {
        creditNote[config.withholdingField] = unitsToNumber(scaled(unitsOf(original[config.withholdingField])));
      }
      creditNote[c.notesField] = `Partial credit note for ${origNumber}`;
    } else {
      creditNote[c.notesField] = `Credit note for ${origNumber}`;
    }
    creditNote.created_at = nowIso;
    creditNote.updated_at = nowIso;
    Object.assign(creditNote, attributedToTrigger(original));

    // One spelling of the header write, deferred so each arm can order it against its own read.
    // The full-copy arm below writes it only after the line read is known complete, because a
    // header carries the original's `total` whole while its lines are a copy: written first, a
    // ceiling refusal mid-copy leaves a credit note the customer is sent whose lines do not add up
    // to its own total, and on a store `writeTxn` finds non-transactional nothing rolls that back.
    // The two arms that copy nothing have nothing to order against and write it straight away.
    const writeHeader = async (): Promise<string> => {
      const created = await input.store.create(input.tenantId, c.invoiceEntity, creditNote);
      return String(created["id"]);
    };

    if (config.lineEntity === undefined) {
      await writeHeader();
      return;
    }
    const lineEntity = config.lineEntity;

    if (isPartial) {
      const partialId = await writeHeader();
      await input.store.create(input.tenantId, lineEntity, {
        [c.lineInvoiceRefField]: partialId,
        [c.linePositionField]: 1,
        [c.descriptionField]: "Partial credit",
        [c.lineQuantityField]: 1,
        [c.lineUnitPriceField]: unitsToNumber(partialSubtotal),
        [c.lineTaxRateField]: 0,
        [c.lineTotalField]: unitsToNumber(partialSubtotal),
        created_at: nowIso,
        updated_at: nowIso,
        ...attributedToTrigger(original),
      });
      return;
    }

    const lineSkip = new Set<string>([
      "id",
      c.lineInvoiceRefField,
      c.descriptionField,
      "created_at",
      "updated_at",
      ...ACTOR_FIELDS,
    ]);
    // Derived per page and written only once the read is known complete, header included — the
    // reversal effect's ordering and for its reason, stated at `writeHeader` above. The payloads
    // carry no invoice reference while they are being built; it is stamped on after the header
    // commits.
    const cnLines: EntityRecord[] = [];
    const outcome = await drainList(
      input.store,
      input.tenantId,
      lineEntity,
      { sort: [], filters: [{ field: c.lineInvoiceRefField, op: "eq", value: originalId }] },
      { ceiling: c.maxLines },
      (rows) => {
        for (const line of rows) {
          if (String(line[c.lineInvoiceRefField] ?? "") !== originalId) continue;
          const cnLine: EntityRecord = {};
          for (const [k, v] of Object.entries(line)) {
            if (!lineSkip.has(k)) cnLine[k] = v;
          }
          const desc = typeof line[c.descriptionField] === "string" ? (line[c.descriptionField] as string) : "";
          cnLine[c.descriptionField] = `Credit: ${desc}`.trim();
          cnLine.created_at = nowIso;
          cnLine.updated_at = nowIso;
          Object.assign(cnLine, attributedToTrigger(original));
          cnLines.push(cnLine);
        }
      },
    );
    if (!outcome.complete) {
      throw new ReadCeilingExceeded(lineEntity, c.maxLines, "a credit note's line copy");
    }
    const newId = await writeHeader();
    for (const cnLine of cnLines) {
      cnLine[c.lineInvoiceRefField] = newId;
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
  /**
   * Suffix of the invoice's recognition entry (e.g. "-AR"). When set, the credit note posts the
   * mirror of that entry — every line, tax and withholding included — instead of the two-line
   * revenue/AR pair; when the invoice has no posted recognition entry, it posts nothing.
   */
  readonly recognitionEntrySuffix?: string;
  readonly periods?: PostingPeriodConfig;
  readonly maxLines?: number;
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
    // NOT `entersState`: this trigger needs a *specific prior state*, and a create has none.
    // A record created already in the target state was never in the prior one, so ignoring it is
    // the right answer rather than a missed edge — see `entersState` for the arrival/prior-state
    // split and why that makes the sweep six sites and not nine.
    if (input.operation !== "update" && input.operation !== "transition") return;
    const beforeState = input.before?.[c.stateField];
    const wasIssued = typeof beforeState === "string" && c.issuedStates.includes(beforeState);
    const nowVoid = input.after[c.stateField] === c.voidState;
    if (!wasIssued || !nowVoid) return;
    if (input.before?.[c.documentTypeField] === c.creditNoteType) {
      if (config.recognitionEntrySuffix !== undefined) {
        await voidCreditNote(input, { ...c, recognitionEntrySuffix: config.recognitionEntrySuffix, periods: config.periods, maxLines: config.maxLines });
      }
      return;
    }

    const original = input.after;
    const originalId = input.id;
    if (originalId === null) return;
    const totalUnits = unitsOf(original[c.totalField]);
    const requestedUnits = moneyUnits(original[c.creditAmountField]);
    const amountUnits =
      requestedUnits !== null && requestedUnits > 0n && requestedUnits < totalUnits ? requestedUnits : totalUnits;
    if (amountUnits <= 0n) return;
    const amount = unitsToNumber(amountUnits);

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const origNumber = typeof original[c.numberField] === "string" ? (original[c.numberField] as string) : originalId;
    const currency = typeof original[c.currencyField] === "string" ? (original[c.currencyField] as string) : "USD";

    // The credit reverses what recognition posted, line for line: revenue, each tax code's line,
    // withholding and the control account, in the proportion credited. The two-line pair below
    // reversed only revenue and AR, for the gross amount — so measured on the shipped pack a VAT 10%
    // invoice of 100 + 10, sent and voided, left revenue over-reversed by 10 and tax payable never
    // reversed at all: `{AR 0, revenue +10, tax_payable −10}`, an entry that balanced. Mirroring the
    // posted entry reuses recognition's own split rather than re-deriving it, so the two cannot
    // disagree about a rate, a code's account or a rounding.
    if (config.recognitionEntrySuffix !== undefined) {
      const recognition = await findEntryByNumber(input, c.entryEntity, `${origNumber}${config.recognitionEntrySuffix}`);
      if (recognition === null || recognition[DEFAULTS.stateField] !== DEFAULTS.postedState) return;
      await reverseEntry(input, {
        entryEntity: c.entryEntity,
        lineEntity: c.lineEntity,
        lineEntryRefField: DEFAULTS.lineEntryRefField,
        maxLines: config.maxLines ?? DEFAULTS.maxLines,
        stateField: DEFAULTS.stateField,
        postedState: DEFAULTS.postedState,
        reversedState: DEFAULTS.reversedState,
        source: recognition,
        number: `${origNumber}-CN-GL`,
        sourceLabel: "invoice",
        memo: `Credit note GL posting for ${origNumber}`,
        partCents: amountUnits < totalUnits ? amountUnits : null,
        periods: config.periods,
        nowIso,
        actor: attributedToTrigger(original),
      });
      return;
    }

    // Resolve configured account codes to real LedgerAccount ids; fall back to placeholders.
    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const arAccount = (await resolveAccountId(input, c, codes.ar)) ?? c.arAccountRef;
    const revenueAccount = (await resolveAccountId(input, c, codes.revenue)) ?? c.revenueAccountRef;

    const entry = await createPostedEntry(
      input,
      c.entryEntity,
      {
        entry_number: `${origNumber}-CN-GL`,
        entry_date: today,
        source: "system",
        state: "posted",
        memo: `Credit note GL posting for ${origNumber}`,
        posted_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      },
      config.periods,
    );
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

/**
 * Voiding a credit note.
 *
 * One sent through the API posted its own recognition — the mirror of a sale — so voiding it
 * reverses that posting and the receivable it reduced is owed again. Measured before: the void
 * moved the document and nothing else, so the GL kept the credit while the credit note read `void`.
 *
 * One a void **issued** (numbered from its invoice, posted as `<invoice>-CN-GL`) is refused:
 * reversing its posting would put the receivable back on an invoice that still reads `void`, and
 * leaving the posting would keep a credit for a document that says it was withdrawn. Its invoice
 * cannot be un-voided, so there is no state in which voiding it is coherent. Measured before, the
 * void answered 200 and changed nothing in the GL.
 */
async function voidCreditNote(
  input: WriteEffectInput,
  c: {
    readonly entryEntity: string;
    readonly lineEntity: string;
    readonly invoiceEntity: string;
    readonly numberField: string;
    readonly recognitionEntrySuffix: string;
    readonly periods: PostingPeriodConfig | undefined;
    readonly maxLines: number | undefined;
    readonly clock?: { now(): Date };
  },
): Promise<void> {
  const cn = input.after;
  const cnId = input.id;
  if (cnId === null) return;
  const cnNumber = typeof cn[c.numberField] === "string" ? (cn[c.numberField] as string) : cnId;
  const own = await findEntryByNumber(input, c.entryEntity, `${cnNumber}${c.recognitionEntrySuffix}`);
  if (own !== null) {
    if (own[DEFAULTS.stateField] !== DEFAULTS.postedState) return;
    const nowIso = (c.clock?.now() ?? new Date()).toISOString();
    await reverseEntry(input, {
      entryEntity: c.entryEntity,
      lineEntity: c.lineEntity,
      lineEntryRefField: DEFAULTS.lineEntryRefField,
      maxLines: c.maxLines ?? DEFAULTS.maxLines,
      stateField: DEFAULTS.stateField,
      postedState: DEFAULTS.postedState,
      reversedState: DEFAULTS.reversedState,
      source: own,
      number: `${cnNumber}-VOID`,
      sourceLabel: "invoice",
      memo: `Reversal of credit note ${cnNumber}${c.recognitionEntrySuffix} (void)`,
      partCents: null,
      periods: c.periods,
      nowIso,
      actor: attributedToTrigger(cn),
    });
    return;
  }
  const of = cn["credit_note_of"];
  if (typeof of !== "string" || of.length === 0) return;
  const invoice = await input.store.get(input.tenantId, c.invoiceEntity, of);
  const invoiceNumber = typeof invoice?.[c.numberField] === "string" ? (invoice[c.numberField] as string) : of;
  if ((await findEntryByNumber(input, c.entryEntity, `${invoiceNumber}-CN-GL`)) !== null) {
    throw new PostingRefused(
      409,
      "credit_note_issued_by_void",
      `this credit note was issued by voiding invoice ${invoiceNumber}, which cannot be un-voided; voiding it would ` +
        `either put the receivable back on a void invoice or keep a credit for a withdrawn document — issue a new ` +
        `invoice for the amount instead`,
    );
  }
}

/**
 * Resolves a LedgerAccount `account_code` to its record id within the tenant, or null.
 *
 * `.find` with **no positional fallback**, converging on `resolveCurrencyId`, which made the
 * opposite and correct choice: a row that does not carry the code asked for is not that account,
 * and returning it posts money to an arbitrary ledger account. It is not merely latent — the
 * document store enforces 0 of 32 declared `unique` fields and `--store pg` is the compose
 * default, so two LedgerAccount rows can share an `account_code` there and `limit: 1` under
 * `sort: []` returns an arbitrary one of them. Null makes the caller fall back to its configured
 * placeholder ref, which is a wrong-but-named account rather than a wrong-and-unnamed one.
 */
export async function resolveAccountId(
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
  const rec = page.records.find((r) => String(r[c.accountCodeField] ?? "") === code);
  return rec !== undefined ? String(rec["id"]) : null;
}

type GlSide = "debit" | "credit";

/** A line an effect means to post: its account, its side, and its transaction amount in ledger units. */
interface PlannedLine {
  readonly account: string;
  readonly description: string;
  readonly side: GlSide;
  readonly units: bigint;
}

/**
 * Planned lines in one currency, at one rate, as the records a posting writes: the transaction
 * amounts as planned and the functional amounts converted **and balanced** at the rate
 * ({@link convertBalanced}), with the rate written beside them. Zero-amount lines are dropped.
 *
 * This replaces the `fx_rate: 1, functional = amount` every posting effect wrote, which for a
 * document in a foreign currency put its foreign amounts into the base-currency ledger unconverted:
 * an invoice of EUR 100 booked at 1.1 read USD 100 of revenue.
 */
function convertedLines(
  base: Record<string, unknown>,
  planned: readonly PlannedLine[],
  rate: ExactDecimal,
): Record<string, unknown>[] {
  const kept = planned.filter((p) => p.units !== 0n);
  const pairs = kept.map((p) => (p.side === "debit" ? { d: p.units, c: 0n } : { d: 0n, c: p.units }));
  const functional = convertBalanced(pairs, rate);
  return kept.map((p, i) => ({
    ...base,
    fx_rate: rateWire(rate),
    ledger_account_id: p.account,
    description: p.description,
    debit: unitsToNumber(pairs[i]!.d),
    credit: unitsToNumber(pairs[i]!.c),
    functional_debit: unitsToNumber(functional[i]!.d),
    functional_credit: unitsToNumber(functional[i]!.c),
  }));
}

/**
 * A line that moves the base currency only — a realized or unrealized exchange difference, which has
 * no transaction amount for a rate to multiply. `units` positive debits, negative credits.
 */
function functionalOnlyLine(
  base: Record<string, unknown>,
  account: string,
  description: string,
  units: bigint,
): Record<string, unknown> {
  return {
    ...base,
    ledger_account_id: account,
    description,
    debit: 0,
    credit: 0,
    functional_debit: unitsToNumber(units > 0n ? units : 0n),
    functional_credit: unitsToNumber(units < 0n ? -units : 0n),
  };
}

const FX_LOOKUP_DEFAULTS = {
  functionalCurrency: "USD",
  currencyEntity: "Currency",
  currencyCodeField: "code",
  exchangeRateEntity: "ExchangeRate",
  rateFromField: "from_currency_id",
  rateToField: "to_currency_id",
  rateField: "rate",
  rateDateField: "rate_date",
} as const;

/**
 * How a posting effect finds the rate a document is booked at. Absent on an effect, every posting is
 * at rate 1, which is the right answer only for a manifest that declares no exchange-rate tables.
 */
export interface PostingFxConfig {
  /** The document's own date field the rate is taken on; absent or empty on the record, today. */
  readonly dateField?: string;
  /** The field the booking rate is stamped on, read first so a later posting uses the same rate. */
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
}

/**
 * The rate a document in `currency` posts into the functional currency at, on `date`.
 *
 * Its own currency is rate 1. Otherwise the stamped booking rate if there is one, else the latest
 * `ExchangeRate` on or before the date. With none, it **refuses** — `exchange_rate_unresolved` —
 * when the tenant has declared its functional currency, because posting EUR amounts as USD is a wrong
 * figure that balances (ADR-0378); and posts at rate 1 when it has not, because a tenant that has not
 * said what its base currency is may well be booking in the currency it invoices in, and refusing
 * that would refuse a correct posting. Before this, every case posted at rate 1.
 */
async function resolvePostingRate(
  input: WriteEffectInput,
  fx: PostingFxConfig | undefined,
  record: EntityRecord,
  currency: string | null,
  today: string,
  noun: string,
): Promise<ExactDecimal> {
  if (fx === undefined) return RATE_ONE;
  const c = { ...FX_LOOKUP_DEFAULTS, ...fx };
  const declared = fx.resolveFunctionalCurrency ? await fx.resolveFunctionalCurrency(input.tenantId) : undefined;
  const functional = (declared ?? c.functionalCurrency).toUpperCase();
  const own = (currency ?? functional).toUpperCase();
  if (own === functional) return RATE_ONE;
  if (fx.bookingRateField !== undefined) {
    const stamped = positiveRate(record[fx.bookingRateField]);
    if (stamped !== null) return stamped;
  }
  const dateRaw = fx.dateField !== undefined ? record[fx.dateField] : undefined;
  const date = typeof dateRaw === "string" && dateRaw.length >= 10 ? dateRaw.slice(0, 10) : today;
  const functionalId = await resolveCurrencyId(input, c, functional);
  const rate = functionalId === null ? null : await lookupPeriodEndRate(input, c, own, functionalId, date);
  if (rate !== null) return rate;
  if (declared === undefined) return RATE_ONE;
  throw new PostingRefused(
    409,
    "exchange_rate_unresolved",
    `${noun} is in ${own} and this tenant's functional currency is ${functional}, but no ExchangeRate from ` +
      `${own} to ${functional} is dated on or before ${date}; record one and retry — posting it without one ` +
      `would carry ${own} amounts in the ledger as ${functional}`,
  );
}

export interface RecognitionGlConfig {
  readonly entity: string;
  readonly periods?: PostingPeriodConfig;
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
  /**
   * A document of this type is the contra of the one this effect recognises — a credit note against
   * an invoice — and posts the same split with every side reversed: what recognition debits it
   * credits. Checked before `skipDocumentType`.
   */
  readonly contraDocumentType?: { readonly field: string; readonly value: string };
  /** How the document's booking rate is found; absent, it posts at rate 1. */
  readonly fx?: PostingFxConfig;
  readonly resolveAccountCodes?: (
    tenantId: string,
  ) => Promise<{ control?: string; net?: string; tax?: string; withholding?: string }>;
  /**
   * When set, the tax split is derived from the document's *lines* — each line's
   * `TaxCode` (or flat rate) drives a per-code tax line in the GL, instead of one
   * aggregate tax line from the document's `tax_total`. Falls back to the
   * document-level split when the line-derived net+tax doesn't reconcile to total.
   */
  readonly taxLines?: RecognitionTaxLinesConfig;
  /**
   * The document field recognition records its withholding on. The control line is posted net of
   * withholding, and every reader of what is owed (settlement, refund-reopen, FX revaluation, the
   * coverage guard, aging) subtracts this field from the total — so it is not informational. Unset
   * while a line carries withholding, recognition refuses `withholding_unrecorded`.
   */
  readonly stampWithholdingField?: string;
  /** Resolves the tenant's per-jurisdiction default tax accounts (jurisdiction → account_code). */
  readonly resolveJurisdictionAccounts?: (tenantId: string) => Promise<Record<string, string>>;
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
  /** TaxCode field carrying its jurisdiction (drives the per-jurisdiction default account). */
  readonly codeJurisdictionField?: string;
  /** TaxCode field carrying its kind + the value that marks a withholding code. */
  readonly codeKindField?: string;
  readonly withholdingKind?: string;
  /**
   * Where a withholding code's tax posts when the code names no `gl_account_code` of its own and
   * `resolveAccountCodes` answers no `withholding` code: a receivable from the authority on a sale, a
   * payable to it on a purchase. Required, because the only other account in reach is the document's
   * tax account — output or input tax — and posting withholding there is the defect this replaced.
   */
  readonly withholdingAccountRef: string;
  /**
   * When set, each line's code and rate are determined from the tenant's declared jurisdiction and
   * its `TaxRule`s on the document's date (`tax-determination.ts`), and a document whose total does
   * not reconcile with the determined tax is refused instead of falling back to one untaxed line.
   */
  readonly determination?: TaxDeterminationConfig;
  /**
   * The largest line set the tax breakdown reads **in full**. Reaching it is reported rather than
   * silently truncated, and the reconciliation gate below is not a substitute for that: it covers
   * `netTotal + taxTotal` and **not** `withholdingTotal`, so a dropped tail that nets to ~0 passes
   * the gate and applies a truncated withholding to the control line, the WHT line and the
   * document stamp — all of which balance.
   */
  readonly maxRows?: number;
}

const TAX_LINES_FALLBACKS = {
  taxCodeField: "tax_code_id",
  flatRateField: "tax_rate_pct",
  codeEntity: "TaxCode",
  codeRateField: "rate_pct",
  codeLabelField: "code",
  codeAccountField: "gl_account_code",
  codeJurisdictionField: "jurisdiction",
  codeKindField: "kind",
  withholdingKind: "withholding",
  // 50_000, the journal- and invoice-line figure. These are a document's lines, the same
  // population `CN_DEFAULTS.maxLines` bounds, so they take the same number.
  maxRows: 50_000,
} as const;

export interface TaxBreakdownLine {
  readonly net: number;
  readonly taxCodeId: string | null;
  readonly flatRatePct: number | null;
}

export interface TaxBreakdown {
  readonly netTotal: number;
  /** Sum of regular (non-withholding) tax — the part included in the document total. */
  readonly taxTotal: number;
  /** Sum of withholding tax — a contra to the control account, NOT part of the total. */
  readonly withholdingTotal: number;
  /**
   * Sum of self-assessed (reverse-charge) tax — outside the total and outside the control account,
   * posted as a balancing pair. Zero unless a jurisdiction's rule marks a purchase reverse charge.
   */
  readonly selfAssessedTotal: number;
  /** One entry per distinct tax label with non-zero tax, in first-seen order. */
  readonly groups: readonly {
    readonly label: string;
    readonly tax: number;
    readonly accountCode: string | null;
    readonly jurisdiction: string | null;
    readonly withholding: boolean;
    readonly selfAssessed: boolean;
  }[];
}

/** Scale a declared rate reaches this function at: `decimal(6,3)` is the widest (TaxCode.rate_pct). */
const RATE_SCALE = 1000;

/**
 * One line's tax, in integer minor units — `packages/billing/src/tax.ts`'s idiom (which already
 * computes `Math.round((subtotalCents * ratePercent) / 100)`) with the *rate* scaled to an integer
 * too, so the product is exact rather than a double.
 *
 * The double form this replaced (`Math.round(net * (rate / 100) * 100) / 100`) is wrong on exactly
 * one class and always in one direction: when the true tax is an exact half-cent, half-away-from-zero
 * owes the cent up, and the double sometimes lands a hair below the midpoint, so `Math.round` takes it
 * down. Never up — measured `under=N over=0` on every sweep. The *frequency* is a property of the
 * rate/net population and not of this code (it swings ~450x between a real-rate rectangle and the full
 * declared rate domain), so it is deliberately not recorded here; the mechanism is what is durable.
 *
 * Both rate fields that reach here are representable at `RATE_SCALE`: `TaxCode.rate_pct` is
 * `decimal(6,3)` and `InvoiceLine.tax_rate_pct` is `decimal(5,2)`, and scaling every one of their
 * 100,001 + 10,001 declared values deviates from an integer by at most 7.3e-12 — six orders inside the
 * guard below. A rate carrying a *fourth* decimal cannot be scaled losslessly, and truncating it is
 * **not** the conservative failure: `1234.56 @ 0.0625%` truncates to `0.063%` and answers `0.78` where
 * the exact figure is `0.77` — wrong, and in the over direction this function exists to stop. So an
 * unrepresentable rate falls back to the faithful-but-imprecise cents form, which keeps the rate the
 * caller stated. Exact while `netCents * rateScaled` stays inside 2^53, i.e. to ~900.7e6 major units at
 * the declared maximum rate of 100%; past that it degrades to measured-good rather than proved.
 */
function lineTaxCents(netCents: number, rate: number): number {
  const scaled = rate * RATE_SCALE;
  const rateScaled = Math.round(scaled);
  if (Math.abs(scaled - rateScaled) >= 1e-6) return Math.round((netCents * rate) / 100);
  return Math.round((netCents * rateScaled) / (100 * RATE_SCALE));
}

/**
 * Pure: given document lines + a resolved `taxCodeId → {rate, label, accountCode?,
 * jurisdiction?, withholding?}` map, sums the net, computes each line's tax (`net × rate%`,
 * rounded to the cent), and groups the tax by label (the TaxCode's label, or `<rate>%` for
 * an unlabeled flat-rate line). `taxTotal` sums regular tax (added on top of net, part of
 * the document total); `withholdingTotal` sums withholding tax (a contra to the control
 * account, deducted from what's paid — not part of the total). Each group carries the
 * first-seen account code, jurisdiction, and withholding flag for its label.
 */
export function computeLineTaxBreakdown(
  lines: readonly TaxBreakdownLine[],
  rateByCode: ReadonlyMap<
    string,
    {
      readonly rate: number;
      readonly label: string;
      readonly accountCode?: string | null;
      readonly jurisdiction?: string | null;
      readonly withholding?: boolean;
      readonly selfAssessed?: boolean;
    }
  >,
): TaxBreakdown {
  let netTotalCents = 0;
  const order: string[] = [];
  const taxCentsByLabel = new Map<string, number>();
  const accountByLabel = new Map<string, string | null>();
  const jurisdictionByLabel = new Map<string, string | null>();
  const withholdingByLabel = new Map<string, boolean>();
  const selfAssessedByLabel = new Map<string, boolean>();
  for (const line of lines) {
    const netCents = Math.round(line.net * 100);
    netTotalCents += netCents;
    let rate = 0;
    let label: string | null = null;
    let accountCode: string | null = null;
    let jurisdiction: string | null = null;
    let withholding = false;
    let selfAssessed = false;
    if (line.taxCodeId !== null && rateByCode.has(line.taxCodeId)) {
      const resolved = rateByCode.get(line.taxCodeId)!;
      rate = resolved.rate;
      label = resolved.label;
      accountCode = resolved.accountCode ?? null;
      jurisdiction = resolved.jurisdiction ?? null;
      withholding = resolved.withholding ?? false;
      selfAssessed = resolved.selfAssessed ?? false;
    } else if (line.flatRatePct !== null) {
      rate = line.flatRatePct;
    }
    if (rate <= 0) continue;
    const taxCents = lineTaxCents(netCents, rate);
    if (taxCents <= 0) continue;
    // A self-assessed code keys its own group, so it never shares a label's total with the same code
    // charged normally on another document line.
    const base = label !== null && label.length > 0 ? label : `${rate}%`;
    const key = selfAssessed ? `${base} (reverse charge)` : base;
    if (!taxCentsByLabel.has(key)) {
      order.push(key);
      accountByLabel.set(key, accountCode);
      jurisdictionByLabel.set(key, jurisdiction);
      withholdingByLabel.set(key, withholding);
      selfAssessedByLabel.set(key, selfAssessed);
    }
    taxCentsByLabel.set(key, (taxCentsByLabel.get(key) ?? 0) + taxCents);
  }
  let taxTotalCents = 0;
  let withholdingTotalCents = 0;
  let selfAssessedTotalCents = 0;
  const groups = order.map((label) => {
    const taxCents = taxCentsByLabel.get(label) ?? 0;
    const withholding = withholdingByLabel.get(label) ?? false;
    const selfAssessed = selfAssessedByLabel.get(label) ?? false;
    if (selfAssessed) selfAssessedTotalCents += taxCents;
    else if (withholding) withholdingTotalCents += taxCents;
    else taxTotalCents += taxCents;
    return {
      label,
      tax: taxCents / 100,
      accountCode: accountByLabel.get(label) ?? null,
      jurisdiction: jurisdictionByLabel.get(label) ?? null,
      withholding,
      selfAssessed,
    };
  });
  return {
    netTotal: netTotalCents / 100,
    taxTotal: taxTotalCents / 100,
    withholdingTotal: withholdingTotalCents / 100,
    selfAssessedTotal: selfAssessedTotalCents / 100,
    groups,
  };
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
  const flip = (side: GlSide): GlSide => (side === "debit" ? "credit" : "debit");
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (!entersState(input, c.stateField, c.triggerState)) return;
    const contra =
      c.contraDocumentType !== undefined && input.after[c.contraDocumentType.field] === c.contraDocumentType.value;
    if (!contra && c.skipDocumentType !== undefined && input.after[c.skipDocumentType.field] === c.skipDocumentType.value) return;
    // A contra document posts the mirror: the control account on the other side, and everything
    // that sits opposite it on recognition's control side.
    const controlSide: GlSide = contra ? flip(c.controlSide) : c.controlSide;
    const opposite: GlSide = flip(controlSide);

    const doc = input.after;
    const docId = input.id;
    if (docId === null) return;
    // In exact ledger units throughout. The split was compared within half a cent over doubles,
    // which at scale 2 is the same verdict as equality — so the comparison is now equality, and
    // no amount on its way to the ledger passes through a double sum.
    const totalUnits = moneyUnits(doc[c.totalField]) ?? 0n;
    if (totalUnits <= 0n) return;
    let subtotalUnits = unitsOf(doc[c.subtotalField]);
    let taxUnits = unitsOf(doc[c.taxField]);
    // Reconcile: fall back to a single net line at total when the split doesn't add up.
    if (subtotalUnits <= 0n || subtotalUnits + taxUnits !== totalUnits) {
      subtotalUnits = totalUnits;
      taxUnits = 0n;
    }
    const docNumber = typeof doc[c.numberField] === "string" ? (doc[c.numberField] as string) : docId;

    // Line-level tax codes: when configured and the line-derived split reconciles to
    // the document total, post one tax line per TaxCode instead of one aggregate line.
    // Withholding codes are a contra to the control account (deducted from what's paid),
    // so they reduce the control line rather than adding an opposite-side tax line.
    let taxGroups: TaxBreakdown["groups"] | null = null;
    let withholdingUnits = 0n;
    let determination: DocumentTaxDetermination = { kind: "off" };
    if (config.taxLines !== undefined) {
      const tc = { ...TAX_LINES_FALLBACKS, ...config.taxLines };
      // One pass collects the breakdown's own input and the distinct TaxCode ids it needs
      // resolved, so the line rows themselves are never retained — and the drain is read in full
      // before the first code lookup, because which codes to resolve is a property of the whole
      // set. Nothing is written yet at this point, so a refusal here writes nothing at all.
      const breakdownLines: TaxBreakdownLine[] = [];
      const codeIds = new Set<string>();
      const outcome = await drainList(
        input.store,
        input.tenantId,
        tc.entity,
        { sort: [], filters: [{ field: tc.refField, op: "eq", value: docId }] },
        { ceiling: tc.maxRows },
        (rows) => {
          for (const r of rows) {
            if (String(r[tc.refField] ?? "") !== docId) continue;
            const codeId = r[tc.taxCodeField];
            const taxCodeId = typeof codeId === "string" && codeId.length > 0 ? codeId : null;
            if (taxCodeId !== null) codeIds.add(taxCodeId);
            breakdownLines.push({
              net: num(r[tc.netField]),
              taxCodeId,
              flatRatePct: optionalNum(r[tc.flatRateField]),
            });
          }
        },
      );
      if (!outcome.complete) {
        throw new ReadCeilingExceeded(tc.entity, tc.maxRows, "a document's tax breakdown");
      }
      if (tc.determination !== undefined && breakdownLines.length > 0) {
        determination = await determineDocumentTax({
          store: input.store,
          tenantId: input.tenantId,
          document: doc,
          lines: breakdownLines,
          config: tc.determination,
          today: (c.clock?.now() ?? new Date()).toISOString().slice(0, 10),
        });
        if (determination.kind === "determined") {
          breakdownLines.splice(0, breakdownLines.length, ...determination.lines);
          for (const line of determination.lines) if (line.taxCodeId !== null) codeIds.add(line.taxCodeId);
        }
      }
      if (breakdownLines.length > 0) {
        // Resolve each distinct TaxCode once.
        const rateByCode = new Map<
          string,
          {
            rate: number;
            label: string;
            accountCode: string | null;
            jurisdiction: string | null;
            withholding: boolean;
            selfAssessed: boolean;
          }
        >();
        for (const id of codeIds) {
          const code = await input.store.get(input.tenantId, tc.codeEntity, id);
          if (code !== null) {
            const label = typeof code[tc.codeLabelField] === "string" ? (code[tc.codeLabelField] as string) : id;
            const acct = code[tc.codeAccountField];
            const juris = code[tc.codeJurisdictionField];
            // A determined rate is the jurisdiction's rule in force on the document's date, which is
            // the dated statement; the code's own rate is used only when nothing was determined.
            const determined = determination.kind === "determined" ? determination.rates.get(id) : undefined;
            rateByCode.set(id, {
              rate: determined !== undefined ? determined.rate : num(code[tc.codeRateField]),
              label,
              accountCode: typeof acct === "string" && acct.length > 0 ? acct : null,
              jurisdiction: typeof juris === "string" && juris.length > 0 ? juris : null,
              withholding: code[tc.codeKindField] === tc.withholdingKind,
              selfAssessed: determined?.selfAssessed ?? false,
            });
          }
        }
        const breakdown = computeLineTaxBreakdown(breakdownLines, rateByCode);
        // Accept the line-derived split only when its regular (non-withholding) tax
        // reconciles to the document total — withholding is a contra, not part of total.
        const netUnits = moneyUnits(breakdown.netTotal) ?? 0n;
        const breakdownTaxUnits = moneyUnits(breakdown.taxTotal) ?? 0n;
        if (netUnits > 0n && netUnits + breakdownTaxUnits === totalUnits) {
          subtotalUnits = netUnits;
          taxUnits = breakdownTaxUnits;
          withholdingUnits = moneyUnits(breakdown.withholdingTotal) ?? 0n;
          taxGroups = breakdown.groups;
          // Before anything is written: a self-assessed pair credited to the same account it debits
          // would post nothing a reader could see, so a config that names no liability account for it
          // refuses here rather than after the entry exists.
          if (breakdown.selfAssessedTotal > 0 && tc.determination?.selfAssessedAccountRef === undefined) {
            throw new PostingRefused(
              409,
              "tax_reverse_charge_unposted",
              `a ${c.entity} line carries reverse-charge tax and this posting has no account to self-assess it to`,
            );
          }
          // The control line below is posted net of withholding, while every reader of what is owed
          // takes the document's total less the stamped field — so with nowhere to stamp it, the
          // readers would treat a net balance as gross and the document could never settle.
          if (withholdingUnits > 0n && config.stampWithholdingField === undefined) {
            throw new PostingRefused(
              409,
              "withholding_unrecorded",
              `a ${c.entity} line carries withholding and this deployment records it on no field of ${c.entity};` +
                ` declare withholding_total on ${c.entity}`,
            );
          }
        } else if (determination.kind === "determined") {
          // Without a jurisdiction the document total is authoritative and a split that does not
          // reconcile degrades to one untaxed net line. With one, the platform has determined the
          // tax, and posting that line would put a figure in the GL it knows is not the document's.
          throw new PostingRefused(
            422,
            "tax_total_disagrees",
            `the document total ${renderMoney(totalUnits)} is not its lines' net ${renderMoney(netUnits)} plus the ` +
              `tax ${renderMoney(breakdownTaxUnits)} determined for jurisdiction '${determination.jurisdictionCode}' ` +
              `on ${determination.date}; correct the total or the lines' tax codes`,
          );
        }
      }
    }

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const currency = typeof doc[c.currencyField] === "string" ? (doc[c.currencyField] as string) : "USD";
    // Before anything is written: a refusal for a missing rate must leave nothing behind.
    const rate = await resolvePostingRate(input, config.fx, doc, currency, today, `this ${c.entity}`);

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const controlAccount = (await resolveAccountId(input, c, codes.control)) ?? c.controlAccountRef;
    const netAccount = (await resolveAccountId(input, c, codes.net)) ?? c.netAccountRef;
    const taxAccount = (await resolveAccountId(input, c, codes.tax)) ?? c.taxAccountRef;

    // Withholding is deducted from the control account (the customer pays / vendor is paid
    // less), so the control line is the total net of withholding; the withheld amount goes
    // to the WHT account on the *same* side as the control.
    const planned: PlannedLine[] = [
      { account: controlAccount, description: c.controlDescription, side: controlSide, units: totalUnits - withholdingUnits },
      { account: netAccount, description: c.netDescription, side: opposite, units: subtotalUnits },
    ];
    const taxLinesConfig = config.taxLines;
    if (taxGroups !== null && taxGroups.length > 0 && taxLinesConfig !== undefined) {
      // Regular tax resolves most specific first: the code's own `gl_account_code`, else the
      // tenant's per-jurisdiction default (by the code's jurisdiction), else the document default
      // tax account, and sits opposite the control (adds to it). Withholding sits on the control
      // side (a contra that reduced the control line above) and resolves on its own path below.
      const jurisdictionAccounts = config.resolveJurisdictionAccounts
        ? await config.resolveJurisdictionAccounts(input.tenantId)
        : {};
      const acctCache = new Map<string, string | null>();
      const resolveCode = async (code: string): Promise<string | null> => {
        if (acctCache.has(code)) return acctCache.get(code) ?? null;
        const resolved = await resolveAccountId(input, c, code);
        acctCache.set(code, resolved);
        return resolved;
      };
      const determinationConfig = taxLinesConfig.determination;
      let selfAssessedAccount: string | null = null;
      let withholdingAccount: string | null = null;
      for (const group of taxGroups) {
        const groupUnits = moneyUnits(group.tax) ?? 0n;
        if (groupUnits <= 0n) continue;
        if (group.withholding && !group.selfAssessed) {
          // Withholding is owed by or to the tax authority, not output or input tax, so neither the
          // per-jurisdiction map (it names output/input tax accounts) nor the document's tax account
          // is consulted: the code's own account, else the withholding default.
          withholdingAccount ??=
            (await resolveAccountId(input, c, codes.withholding)) ?? taxLinesConfig.withholdingAccountRef;
          const own = group.accountCode !== null && group.accountCode.length > 0 ? await resolveCode(group.accountCode) : null;
          planned.push({
            account: own ?? withholdingAccount,
            description: withholdingLineDescription(group.label),
            side: controlSide,
            units: groupUnits,
          });
          continue;
        }
        const accountCode =
          group.accountCode ?? (group.jurisdiction !== null ? jurisdictionAccounts[group.jurisdiction] : undefined);
        const account =
          accountCode !== undefined && accountCode.length > 0 ? ((await resolveCode(accountCode)) ?? taxAccount) : taxAccount;
        if (group.selfAssessed) {
          // Reverse charge: the buyer accounts for the tax the seller did not charge, as input tax on
          // the expense side and an equal output-tax liability on the control side. The pair nets to
          // zero, so the entry still balances on the document total.
          if (selfAssessedAccount === null) {
            const code = determinationConfig?.resolveSelfAssessedAccountCode
              ? await determinationConfig.resolveSelfAssessedAccountCode(input.tenantId)
              : undefined;
            selfAssessedAccount =
              (await resolveAccountId(input, c, code)) ?? determinationConfig?.selfAssessedAccountRef ?? taxAccount;
          }
          planned.push({ account, description: `${c.taxDescription} (${group.label})`, side: opposite, units: groupUnits });
          planned.push({
            account: selfAssessedAccount,
            description: `Self-assessed tax payable (${group.label})`,
            side: controlSide,
            units: groupUnits,
          });
          continue;
        }
        planned.push({ account, description: `${c.taxDescription} (${group.label})`, side: opposite, units: groupUnits });
      }
    } else if (taxUnits > 0n) {
      planned.push({ account: taxAccount, description: c.taxDescription, side: opposite, units: taxUnits });
    }

    const entry = await createPostedEntry(input, c.entryEntity, {
      entry_number: `${docNumber}${c.entrySuffix}`,
      entry_date: today,
      source: c.sourceValue,
      state: "posted",
      memo: contra ? `Credit note GL posting for ${docNumber}` : `GL posting for ${docNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    }, config.periods);
    const base = { journal_entry_id: String(entry["id"]), currency, created_at: nowIso, updated_at: nowIso };
    for (const line of convertedLines(base, planned, rate)) {
      await input.store.create(input.tenantId, c.lineEntity, line);
    }

    // Stamp the withholding this entry netted out of the control line: it is the figure every
    // reader of what is owed subtracts from the total. Authoritative, so a value already on the
    // document that disagrees — a key a client could write before ADR-0421 — is overwritten,
    // with 0 if need be; an absent field already reads as 0 and gains no write. Direct store
    // write — bypasses guards/effects, no recursion.
    const stampField = config.stampWithholdingField;
    const storedStamp = stampField === undefined ? undefined : doc[stampField];
    if (
      stampField !== undefined &&
      (withholdingUnits > 0n ||
        (storedStamp !== undefined && storedStamp !== null && moneyUnits(storedStamp) !== withholdingUnits))
    ) {
      await input.store.update(input.tenantId, c.entity, docId, {
        [stampField]: unitsToNumber(withholdingUnits),
        updated_at: nowIso,
      });
    }
  };
}

/**
 * What a recognition entry's withholding line is labelled with. Exported, with its prefix, because a
 * maintenance reader finding those lines in a stored entry must use the spelling this effect wrote.
 */
export const WITHHOLDING_LINE_DESCRIPTION_PREFIX = "Withholding (";

export function withholdingLineDescription(codeLabel: string): string {
  return `${WITHHOLDING_LINE_DESCRIPTION_PREFIX}${codeLabel})`;
}

export interface PaymentSettlementGlConfig {
  readonly paymentEntity?: string;
  readonly periods?: PostingPeriodConfig;
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
  /**
   * How the payment's rate is found. With it, the control account is cleared at the rate the
   * settled document was booked at and the cash at the rate the money moved at, and the difference is
   * the realized exchange gain or loss, posted in the base currency only. Absent, everything is rate 1.
   */
  readonly fx?: PostingFxConfig;
  /** The documents a payment settles, `[refField, entity]`, read for the rate they were booked at. */
  readonly settledDocuments?: readonly { readonly refField: string; readonly entity: string }[];
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
 * A record *enters* a state, whichever way it got there — the one trigger every effect keyed on an
 * arrival reads, and the thing six of them used to get wrong.
 *
 * All six opened with `operation !== "update" && operation !== "transition"`, which reads as *a
 * document reaches this state by being transitioned* and is false: a lifecycle state is an ordinary
 * `enum` field with a **literal** default, carries no field-level permissions in any shipped pack,
 * and `lockedDocumentGuard` answers `null` first when the *before* state is unlocked — so a caller
 * may POST the state directly and no transition is involved (for an entity with a lifecycle this is
 * refused by `lifecycleStateGuard` now; the edge keying stays for a state that is not a lifecycle
 * field and for a deployment passing its own `writeGuards`). Measured live on the shipped pack and
 * store (`--store pg`, `erp-core`), as `erp_admin`, two ordinary POSTs:
 *
 * - `POST /v1/invoices {…,"state":"sent"}` → **201**, and **no journal entry at all**: revenue was
 *   never recognised, AR was never debited, `sent_at` was never stamped and `booking_rate` was never
 *   stamped either. The AR aging report counted the invoice all the same, so the subledger read
 *   **277 open** against a general ledger carrying **250** — the divergence being the whole invoice.
 * - `POST /v1/payments {…,"amount":"50.00","state":"completed"}` → **201**, and neither
 *   payment-driven effect fired: the GL still carried the receivable, the invoice still read
 *   `state: "sent"` with `paid_at` null, and the aging report **dropped it as settled**, because it
 *   derives `applied` from the Payment rows directly rather than from either. Three surfaces, three
 *   answers, and the divergence was exactly the payment.
 *
 * Each figure balances on its own, so `journalPostingGuard`'s double-entry invariant is satisfied
 * and nothing in the detection stack can see it — ADR-0378's *a wrong figure that balances*.
 *
 * So the trigger is keyed on the **state edge** and not on the operation, which is ADR-0391's rule
 * for exactly this reason, one layer in. The edge's two halves do different jobs: `after` must be
 * the state, and `before` must not be — the second is what keeps a create and a later transition
 * from both firing, and it was already present at every site. Only the operation test was narrower
 * than the edge.
 *
 * **Three sibling effects are deliberately NOT converted**, because their trigger is not an arrival:
 * `journalReversalEffect` (`!wasPosted || !nowReversed`), `invoiceVoidCreditNoteEffect` and
 * `creditNoteGlPostingEffect` (both `!wasIssued || !nowVoid`) each require a *specific prior state*,
 * and a create has no prior state — so a document created already `reversed` or `void` was never
 * posted and never issued, and ignoring it is the right answer rather than a missed edge. Widening
 * those would reverse an entry that was never posted and credit-note an invoice that was never
 * sent. The split is *arrival* versus *prior state*, and it is the whole of why this is six sites
 * and not nine.
 *
 * `delete` is excluded explicitly rather than left to fall out. A delete passes `after = before`
 * (`WriteGuardInput`'s own contract), so the `before` clause already refuses every delete of a
 * record in the state and the `after` clause every delete of one outside it — but that is a property
 * of *another* module's contract, and an effect that fires or not depending on it is the implicit
 * coupling this repo keeps finding. Note also that `id` is **non-null on create here**: the create
 * handler passes `created["id"]` (`handlers.ts:460`), so a `payId === null` guard downstream is
 * about a store that returned no id, not about the operation — `WriteGuardInput.id`'s "null on
 * create" is true of the *guard* input and not of the effect's.
 */
export function entersState(input: WriteEffectInput, stateField: string, state: string): boolean {
  if (input.operation === "delete") return false;
  if (input.before?.[stateField] === state) return false;
  return input.after[stateField] === state;
}

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
    if (!entersState(input, c.stateField, c.completedState)) return;

    const pay = input.after;
    const payId = input.id;
    if (payId === null) return;
    const amountUnits = moneyUnits(pay[c.amountField]) ?? 0n;
    if (amountUnits <= 0n) return;
    const inbound = pay[c.directionField] === c.inboundValue;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const payNumber = typeof pay[c.numberField] === "string" ? (pay[c.numberField] as string) : payId;
    const currency = typeof pay[c.currencyField] === "string" ? (pay[c.currencyField] as string) : "USD";

    // Two rates, both resolved before anything is written. The control account is cleared at the
    // rate its document was **booked** at, because that is what the ledger carries it at — clearing
    // EUR 100 booked at 1.1 at today's 1.2 would leave 10 of receivable behind that no document
    // owes. The cash is valued at what actually moved: `cash_amount`, the base-currency cash, when
    // the payment states it, else today's rate. The two differ by exactly the realized gain or loss.
    const cashUnitsStated = moneyUnits(pay[c.cashAmountField]);
    const cashRate = cashUnitsStated === null
      ? await resolvePostingRate(input, config.fx, pay, currency, today, "this payment")
      : null;
    let controlRate = cashRate ?? RATE_ONE;
    let settled: Awaited<ReturnType<typeof settledDocumentRate>> = null;
    if (config.fx !== undefined) {
      settled = await settledDocumentRate(input, config, pay, currency);
      if (settled !== null) controlRate = settled.rate;
      else if (cashRate === null) {
        controlRate = await resolvePostingRate(input, config.fx, pay, currency, today, "this payment");
      }
    }
    const cashFunctional = cashUnitsStated ?? convertUnits(amountUnits, cashRate ?? RATE_ONE);
    const controlFunctional =
      settled !== null ? await clearedAtBookingRate(input, settled, amountUnits) : convertUnits(amountUnits, controlRate);

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const cashAccount = (await resolveAccountId(input, c, codes.cash)) ?? c.cashAccountRef;
    const arAccount = (await resolveAccountId(input, c, codes.ar)) ?? c.arAccountRef;
    const apAccount = (await resolveAccountId(input, c, codes.ap)) ?? c.apAccountRef;
    const fxAccount = (await resolveAccountId(input, c, codes.fx)) ?? c.fxAccountRef;

    const entry = await createPostedEntry(input, c.entryEntity, {
      entry_number: `${payNumber}${c.entrySuffix}`,
      entry_date: today,
      source: "payment",
      state: "posted",
      memo: `Settlement GL posting for ${payNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    }, config.periods);
    const base = { journal_entry_id: String(entry["id"]), currency, created_at: nowIso, updated_at: nowIso };
    const money = unitsToNumber;
    // One line of `amount` in the payment's currency, its functional value stated and its rate the
    // exact quotient — so `functional = amount × rate` holds for it by construction.
    const line = (account: string, description: string, side: GlSide, functional: bigint): Record<string, unknown> => ({
      ...base,
      ledger_account_id: account,
      description,
      fx_rate: functional === amountUnits ? 1 : quotientRate(functional, amountUnits),
      debit: side === "debit" ? money(amountUnits) : 0,
      credit: side === "credit" ? money(amountUnits) : 0,
      functional_debit: side === "debit" ? money(functional) : 0,
      functional_credit: side === "credit" ? money(functional) : 0,
    });
    const lines: Record<string, unknown>[] = [];
    // Positive when more base currency moved than the control account carried the balance at.
    const fxDiff = cashFunctional - controlFunctional;
    if (inbound) {
      lines.push(line(cashAccount, "Settlement — cash", "debit", cashFunctional));
      lines.push(line(arAccount, "Settlement — accounts receivable", "credit", controlFunctional));
      // more received than AR carried → FX gain (credit); less → FX loss (debit)
      if (fxDiff !== 0n) lines.push(functionalOnlyLine(base, fxAccount, "Realized FX gain/loss", -fxDiff));
    } else {
      lines.push(line(apAccount, "Settlement — accounts payable", "debit", controlFunctional));
      lines.push(line(cashAccount, "Settlement — cash", "credit", cashFunctional));
      // more paid than AP carried → FX loss (debit); less → FX gain (credit)
      if (fxDiff !== 0n) lines.push(functionalOnlyLine(base, fxAccount, "Realized FX gain/loss", fxDiff));
    }
    for (const l of lines) await input.store.create(input.tenantId, c.lineEntity, l);
  };
}

/** `functional / amount` as a rate, to the ten places an `fx_rate` column holds. */
function quotientRate(functional: bigint, amount: bigint): string {
  const scale = 10n ** 10n;
  const scaled = (functional * scale * 2n + amount) / (2n * amount);
  return renderDecimal({ negative: false, units: scaled, scale: 10 });
}

/**
 * The rate the document a payment settles was booked at, when the payment names one in the same
 * currency and it carries a stamped rate; else null.
 */
async function settledDocumentRate(
  input: WriteEffectInput,
  config: PaymentSettlementGlConfig,
  pay: EntityRecord,
  currency: string,
): Promise<{ readonly rate: ExactDecimal; readonly refField: string; readonly documentId: string } | null> {
  const bookingField = config.fx?.bookingRateField;
  if (bookingField === undefined) return null;
  for (const doc of config.settledDocuments ?? []) {
    const ref = pay[doc.refField];
    if (typeof ref !== "string" || ref.length === 0) continue;
    const settled = await input.store.get(input.tenantId, doc.entity, ref);
    if (settled === null) continue;
    const docCurrency = typeof settled["currency"] === "string" ? (settled["currency"] as string) : null;
    if (docCurrency !== null && docCurrency.toUpperCase() !== currency.toUpperCase()) continue;
    const stamped = positiveRate(settled[bookingField]);
    if (stamped !== null) return { rate: stamped, refField: doc.refField, documentId: ref };
  }
  return null;
}

/**
 * The functional amount one payment clears from a document booked at `rate`: the conversion of
 * everything applied so far less the conversion of everything applied before it. Converting each
 * instalment on its own rounds each one, so three payments of EUR 33.33 + 33.33 + 33.35 against
 * EUR 100.01 booked at 1.0731 cleared 107.33 from a receivable carried at 107.32 and left a cent
 * on a paid invoice for ever; converting the running total clears exactly what was booked.
 */
async function clearedAtBookingRate(
  input: WriteEffectInput,
  settled: { readonly rate: ExactDecimal; readonly refField: string; readonly documentId: string },
  amountUnits: bigint,
): Promise<bigint> {
  const read = await readAppliedToDocument(input.store, input.tenantId, settled.refField, settled.documentId, {
    ceiling: 10_000,
  });
  if (!read.complete) {
    throw new ReadCeilingExceeded("Payment", 10_000, "the payments applied to a document being settled");
  }
  // This payment is already `completed` in the store, so the read includes it.
  const through = moneyUnits(read.applied) ?? 0n;
  const before = through - amountUnits;
  if (before < 0n) return convertUnits(amountUnits, settled.rate);
  return convertUnits(through, settled.rate) - convertUnits(before, settled.rate);
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
  /**
   * The largest payment set the applied total is summed over **in full**. Reaching it is reported
   * rather than silently truncated, and the direction of the error is not bounded: nothing
   * enforces `Payment.amount`'s declared `min: 0`, so a dropped negative correction over-reports
   * the applied total and settles a document that is still owed.
   */
  readonly maxPayments?: number;
  /** Tax withheld at source; the payer owes the total less it (see `amountOwed`). */
  readonly withholdingField?: string;
  /**
   * The payment state that undoes a payment (e.g. "refunded"). Entering it re-opens a document this
   * effect settled when what remains applied no longer covers it, into `reopenState`.
   */
  readonly refundedState?: string;
  readonly reopenState?: string;
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
  // 10_000 rather than 1000: the population is one document's payments, which is smaller than a
  // document's lines (a 50,000-instalment invoice is not a thing) but is not bounded by anything
  // in the model either — a subscription billed daily and corrected accumulates rows for years.
  maxPayments: 10_000,
} as const;

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
    if (c.refundedState !== undefined && c.reopenState !== undefined) {
      if (input.before?.[c.stateField] === c.completedState && input.after[c.stateField] === c.refundedState) {
        await reopenUncovered(input, c, c.reopenState);
        return;
      }
    }
    if (!entersState(input, c.stateField, c.completedState)) return;

    const docId = input.after[c.refField];
    if (typeof docId !== "string" || docId.length === 0) return;
    const doc = await input.store.get(input.tenantId, c.documentEntity, docId);
    if (doc === null) return;
    const docState = doc[c.documentStateField];
    if (docState === c.paidState) return; // already settled
    if (c.settleableStates !== undefined && (typeof docState !== "string" || !c.settleableStates.includes(docState))) {
      return;
    }
    const total = amountOwed(doc, c.documentTotalField, c.withholdingField);
    if (total <= 0) return;

    // Every completed payment, not the first page of them, and with no stop once the running total
    // crosses `total` — both rules live in `readAppliedToDocument` now, with the measured defect
    // that produced them (an invoice of 400 with three payments of 200 and a correction of −300,
    // written `paid` at a cap of 3 and correctly left `sent` at 99). The `eq` filter on the
    // reference is the shape that keeps this one index lookup rather than a tenant-wide drain.
    const read = await readAppliedToDocument(input.store, input.tenantId, c.refField, docId, {
      paymentEntity: c.paymentEntity,
      stateField: c.stateField,
      completedState: c.completedState,
      amountField: c.amountField,
      ceiling: c.maxPayments,
    });
    if (!read.complete) {
      throw new ReadCeilingExceeded(c.paymentEntity, c.maxPayments, "the amount applied to a document");
    }
    // `settlementIsCovered` rather than the comparison written out, so this effect and
    // `settlementCoverageGuard` cannot come to disagree about whether a document is covered —
    // which would make one simultaneously unmarkable by hand and auto-marked here.
    if (!settlementIsCovered(total, read.applied)) return; // not yet fully covered

    const nowIso = (c.clock?.now() ?? new Date()).toISOString();
    await input.store.update(input.tenantId, c.documentEntity, docId, {
      [c.documentStateField]: c.paidState,
      [c.paidAtField]: nowIso,
      updated_at: nowIso,
    });
  };
}

/**
 * A refund takes back a payment, so a document it settled may be owed again: re-opened into
 * `reopenState` (with `paid_at` cleared) when the payments still completed against it no longer
 * cover it. Measured before: a Payment of 50 settling an invoice of 50, then refunded, left the
 * invoice `paid` while the refund reversal put the 50 back on the receivable — the GL owed, the
 * document said settled, and the aging report dropped it. That is ADR-0391's divergence entered from
 * the other side. A document another payment still covers stays settled; one never settled is left
 * alone. A direct store write, as the settlement is, so the issued-document lock does not refuse it.
 */
async function reopenUncovered(
  input: WriteEffectInput,
  c: {
    paymentEntity: string;
    documentEntity: string;
    refField: string;
    stateField: string;
    completedState: string;
    amountField: string;
    documentTotalField: string;
    documentStateField: string;
    paidState: string;
    paidAtField: string;
    maxPayments: number;
    withholdingField?: string;
    clock?: { now(): Date };
  },
  reopenState: string,
): Promise<void> {
  const docId = input.after[c.refField];
  if (typeof docId !== "string" || docId.length === 0) return;
  const doc = await input.store.get(input.tenantId, c.documentEntity, docId);
  if (doc === null || doc[c.documentStateField] !== c.paidState) return;
  const owed = amountOwed(doc, c.documentTotalField, c.withholdingField);
  const read = await readAppliedToDocument(input.store, input.tenantId, c.refField, docId, {
    paymentEntity: c.paymentEntity,
    stateField: c.stateField,
    completedState: c.completedState,
    amountField: c.amountField,
    ceiling: c.maxPayments,
  });
  if (!read.complete) {
    throw new ReadCeilingExceeded(c.paymentEntity, c.maxPayments, "the amount applied to a document");
  }
  if (settlementIsCovered(owed, read.applied)) return;
  const nowIso = (c.clock?.now() ?? new Date()).toISOString();
  await input.store.update(input.tenantId, c.documentEntity, docId, {
    [c.documentStateField]: reopenState,
    [c.paidAtField]: null,
    updated_at: nowIso,
  });
}

/** One open foreign-currency document side (receivable or payable) for revaluation. */
interface FxRevalDocSpec {
  readonly entity: string;
  readonly openStates: readonly string[];
  readonly paymentRefField: string;
  /** "ar" → control is AR (asset); "ap" → control is AP (liability). */
  readonly side: "ar" | "ap";
  /**
   * Tax withheld at source on this document, never owed by the payer and so never open. Name it
   * only where the field is a server stamp: a caller-written figure here would shrink an open
   * balance by whatever the caller typed.
   */
  readonly withholdingField?: string;
  /**
   * A document of this type reduces the balance it is recorded against rather than adding to it, and
   * is revalued with the document it credits — `computeAging`'s grouping. Its original is fetched by
   * reference when it sits in one of `creditedStates` (a void issued the note, so the original is not
   * open): a full void then nets to nothing, as its ledger does. Without this a sent credit note was
   * revalued as one more receivable — measured, an invoice of EUR 100 at 1.1 sent and voided left a
   * receivable of 0 in the ledger and the close revalued it by +10 at 1.2.
   */
  readonly creditNote?: {
    readonly typeField: string;
    readonly typeValue: string;
    readonly refField: string;
    readonly creditedStates: readonly string[];
  };
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
  /**
   * The largest set either tenant-wide read here reads **in full** — the completed payments and,
   * per document side, the open documents. Reaching it is reported rather than silently
   * truncated: a dropped payment makes the open balance too large and a document whose payments
   * were all dropped is revalued as if entirely unpaid, and the resulting entry **balances by
   * construction**, so nothing downstream can see that the figure is wrong.
   */
  readonly maxRows?: number;
  /** The fiscal calendar the auto-reversal's period is resolved from. */
  readonly periods?: PostingPeriodConfig;
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
  // 100_000 rather than 5000, because these two populations are lifetime-cumulative: there is no
  // purge or archive job for Payment anywhere in the packs, so a tenant's completed payments only
  // ever grow and 5000 is reached by ordinary trading history rather than by anything unusual.
  maxRows: 100_000,
} as const;

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
 *  - The open balance is carried at the rate recognition booked it at — the document's stamped
 *    booking rate, or 1 when none was stamped — so the unrealized delta is
 *    `open × periodEndRate − open × bookingRate`, in exact ledger units, net of what an earlier
 *    close already revalued. The delta is a **functional-currency** amount: a revaluation line
 *    moves no transaction amount (its debit and credit are 0) and states only its functional
 *    figure, because a currency's open balance does not change when its rate does.
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
    if (!entersState(input, c.periodStateField, c.closedState)) return; // fire once, on the →closed edge

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

    const periodLabel = typeof period[c.periodNumberField] === "string" ? (period[c.periodNumberField] as string) : periodId;

    // Every document side's applied-payment map is filled in ONE pass over the payment pages,
    // before the document loop — the one-pass property and the per-side keying both live in
    // `readAppliedPayments` now, with the reason a shared map keyed by document id would merge an
    // invoice's payments with a same-id bill's.
    //
    // Zipped back onto the specs by **position**, which is what `AppliedPaymentsRead` guarantees:
    // index *i* answers for `refFields[i]`, so the side a map belongs to is the index it was asked
    // for and never a key a reader could mistype.
    const refFields = c.documents.map((spec) => spec.paymentRefField);
    const paymentRead = await readAppliedPayments(input.store, input.tenantId, refFields, {
      paymentEntity: c.paymentEntity,
      stateField: c.paymentStateField,
      completedState: c.paymentCompletedState,
      amountField: c.paymentAmountField,
      ceiling: c.maxRows,
    });
    if (!paymentRead.complete) {
      throw new ReadCeilingExceeded(c.paymentEntity, c.maxRows, "an unrealized FX revaluation");
    }
    const sides = c.documents.map((spec, i) => ({
      spec,
      // `!` and not `?? new Map()`: `foldCompletedPayments` builds one bucket per ref field with
      // `refFields.map(() => new Map())`, so index `i` exists for every `i` a caller can ask about
      // — the `??` arm was unreachable, and ADR-0361's reason for deleting an unreachable check is
      // that a dead arm reads as a handled case. Same spelling the fold itself uses one scope in.
      applied: paymentRead.applied[i]!,
    }));

    // Accumulate the open foreign balance per (currency, side), and what the ledger carries it at:
    // each document's open balance at the rate it was booked at, which is the functional amount its
    // recognition posted. All in exact ledger units — the doubles this replaced summed `open ×
    // booking_rate` across every open document and rounded once at the end.
    const openByCurrencySide = new Map<string, bigint>(); // key `${currency}|${side}`
    const bookedByCurrencySide = new Map<string, bigint>(); // functional, as booked
    const rateCache = new Map<string, ExactDecimal | null>();

    for (const { spec: doc, applied } of sides) {
      // One document's signed contribution: what it leaves open, at the rate it was booked at — a
      // credit note's with its sign reversed.
      const fold = (record: EntityRecord, sign: bigint): void => {
        const docId = String(record["id"] ?? "");
        if (docId === "") return;
        const currency = typeof record[c.currencyField] === "string" ? (record[c.currencyField] as string).toUpperCase() : functional;
        if (currency === functional) return; // only foreign-currency documents are revalued
        const owed = moneyUnits(amountOwed(record, c.totalField, doc.withholdingField)) ?? 0n;
        const open = owed - (moneyUnits(applied.get(docId) ?? 0) ?? 0n);
        if (open <= 0n) return; // fully paid → nothing to revalue
        // The rate the document was booked at; absent, 1 — which is what its recognition posted
        // at before a booking rate was resolved, so the comparison is still against the ledger.
        const bookingRate = positiveRate(record[c.bookingRateField]) ?? RATE_ONE;
        const key = `${currency}|${doc.side}`;
        openByCurrencySide.set(key, (openByCurrencySide.get(key) ?? 0n) + sign * open);
        bookedByCurrencySide.set(key, (bookedByCurrencySide.get(key) ?? 0n) + sign * convertUnits(open, bookingRate));
      };
      const cn = doc.creditNote;
      const isCreditNote = (record: EntityRecord): boolean => cn !== undefined && record[cn.typeField] === cn.typeValue;
      // Only the references of open credit notes are held, never the open set itself.
      const creditedRefs = new Set<string>();
      // The documents fold straight into the two per-(currency, side) maps, so this read needs no
      // array either — it is O(currencies) however many open documents there are.
      const docOutcome = await drainList(
        input.store,
        input.tenantId,
        doc.entity,
        { sort: [], filters: [{ field: "state", op: "in", value: [...doc.openStates] }] },
        { ceiling: c.maxRows },
        (rows) => {
          for (const record of rows) {
            if (!doc.openStates.includes(String(record["state"] ?? ""))) continue;
            if (isCreditNote(record)) {
              fold(record, -1n);
              const ref = record[cn!.refField];
              if (typeof ref === "string" && ref.length > 0) creditedRefs.add(ref);
            } else {
              fold(record, 1n);
            }
          }
        },
      );
      if (!docOutcome.complete) {
        throw new ReadCeilingExceeded(doc.entity, c.maxRows, "an unrealized FX revaluation");
      }
      // An original in an open state was folded above; one a void issued the note from was not, and
      // is folded once here so the pair nets as the ledger does.
      for (const ref of creditedRefs) {
        const original = await input.store.get(input.tenantId, doc.entity, ref);
        if (original === null || isCreditNote(original)) continue;
        const state = String(original["state"] ?? "");
        if (!cn!.creditedStates.includes(state) || doc.openStates.includes(state)) continue;
        fold(original, 1n);
      }
    }

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();

    // Each revalued (currency, side) moves functional amounts only: the foreign balance is unchanged
    // — what changed is what it is worth in the base currency — so the adjustment has no transaction
    // amount. It used to be posted as one, `amount = functional` at the period-end rate, which broke
    // `functional = amount × fx_rate` on every revaluation line and put base-currency figures into the
    // foreign currency's own balance (ADR-0429's open question).
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

      const booked = bookedByCurrencySide.get(key) ?? open;
      const delta = convertUnits(open, rate) - booked;
      if (delta === 0n) continue;

      const controlAccount = side === "ar" ? arAccount : apAccount;
      const controlDesc = side === "ar"
        ? `Unrealized FX revaluation — AR ${currency}`
        : `Unrealized FX revaluation — AP ${currency}`;
      const fxDesc = `Unrealized FX gain/loss — ${currency}`;
      const base = { journal_entry_id: "", currency, fx_rate: rateWire(rate), created_at: nowIso, updated_at: nowIso };
      // A higher rate raises a foreign asset (AR: debit it, credit the unrealized account) and a
      // foreign liability alike (AP: credit it, debit the unrealized account).
      const controlUnits = side === "ar" ? delta : -delta;
      lines.push(functionalOnlyLine(base, controlAccount, controlDesc, controlUnits));
      lines.push(functionalOnlyLine(base, fxAccount, fxDesc, -controlUnits));
    }

    // **Idempotent across a reopen and a re-close.** The period's own revaluation entries already
    // posted are read back and only the difference is posted, so closing a period twice revalues it
    // once. Measured before: close → open → close posted two `2026-06-FXREVAL` entries of 10 each,
    // doubling the unrealized loss — and on `--store pg`, where `entry_number` is enforced unique,
    // the second close was a 500 instead. A later revaluation is numbered `-FXREVAL2`, `-FXREVAL3`.
    // Netted on the functional amounts, which is what a revaluation moves; a revaluation posted
    // before this change carried them equal to its transaction amounts, so it nets the same.
    const prior = await readPriorRevaluations(input, c, periodId, periodLabel);
    const net = new Map<string, { line: Record<string, unknown>; cents: bigint }>();
    const keyOf = (l: Record<string, unknown>): string => `${String(l["ledger_account_id"])}|${String(l["currency"])}`;
    for (const l of lines) {
      const k = keyOf(l);
      const cents = unitsOf(l["functional_debit"]) - unitsOf(l["functional_credit"]);
      net.set(k, { line: l, cents: (net.get(k)?.cents ?? 0n) + cents });
    }
    for (const [k, p] of prior.byKey) {
      const entry = net.get(k) ?? {
        line: { ledger_account_id: p.account, currency: p.currency, fx_rate: p.fxRate, description: p.description },
        cents: 0n,
      };
      net.set(k, { line: entry.line, cents: entry.cents - p.cents });
    }
    const posting: Record<string, unknown>[] = [];
    for (const { line, cents } of net.values()) {
      if (cents === 0n) continue;
      posting.push(
        functionalOnlyLine(
          { ...line, created_at: nowIso, updated_at: nowIso },
          String(line["ledger_account_id"]),
          String(line["description"] ?? ""),
          cents,
        ),
      );
    }
    if (posting.length === 0) return; // nothing to revalue, or already revalued as it stands

    const number = `${periodLabel}-FXREVAL${prior.count === 0 ? "" : String(prior.count + 1)}`;
    // The reversal's period is resolved — and a locked one refused — before anything is written, so
    // "nothing was written" stays a property of this effect rather than a promise about the caller's
    // store (ADR-0367): resolved after, a refusal left the revaluation itself behind on any store
    // that does not roll the close back.
    const reversalDate = addDays(endDate, 1);
    const reversalPeriodId = await postingPeriodFor(input.store, input.tenantId, reversalDate, config.periods);
    // Into the period being closed, which is `closed` by now: the close is the act the lock exists
    // for, so it is the one posting that cannot be refused for it.
    const entry = await createPostedEntry(
      input,
      c.entryEntity,
      {
        entry_number: number,
        entry_date: endDate,
        source: "fx_revaluation",
        state: "posted",
        memo: `Unrealized FX revaluation for period ${periodLabel}`,
        posted_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      },
      undefined,
      periodId,
    );
    const entryId = String(entry["id"]);
    for (const line of posting) {
      await input.store.create(input.tenantId, c.lineEntity, { ...line, journal_entry_id: entryId });
    }

    // **And it reverses itself on the first day of the next period** — the standard treatment for
    // an unrealized revaluation, and the reason it is not optional here: the next close revalues
    // every open document from its *booking* rate again, so an unreversed entry is counted twice,
    // once in each period. Dated the day after the period's end and checked against the lock like
    // any posting (resolved above): a next period already closed refuses this close by name rather
    // than posting a reversal into it.
    const reversal = await createPostedEntry(
      input,
      c.entryEntity,
      {
        entry_number: `${number}R`,
        entry_date: reversalDate,
        source: "fx_revaluation",
        state: "posted",
        memo: `Reversal of the unrealized FX revaluation for period ${periodLabel}`,
        posted_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      },
      undefined,
      reversalPeriodId,
    );
    const reversalId = String(reversal["id"]);
    const mirrored = mirrorLines(posting, null, (d) => `Reversal: ${d}`.trim(), { created_at: nowIso, updated_at: nowIso });
    for (const line of mirrored) {
      await input.store.create(input.tenantId, c.lineEntity, { ...line, journal_entry_id: reversalId });
    }
  };
}

interface PriorRevaluation {
  readonly account: string;
  readonly currency: string;
  readonly fxRate: unknown;
  readonly description: string;
  readonly cents: bigint;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The revaluation entries a period already carries — `<label>-FXREVAL` and its numbered successors,
 * never their `R` reversals, which sit in the next period — summed per (account, currency).
 */
async function readPriorRevaluations(
  input: WriteEffectInput,
  c: { entryEntity: string; lineEntity: string; maxRows: number },
  periodId: string,
  label: string,
): Promise<{ count: number; byKey: Map<string, PriorRevaluation> }> {
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-FXREVAL(\\d*)$`);
  const entries: EntityRecord[] = [];
  const outcome = await drainList(
    input.store,
    input.tenantId,
    c.entryEntity,
    // `source` pushed down too: every posting is stamped with its period now, so a period-only
    // filter drains the whole month's journal to find its one or two revaluations — and refuses the
    // close once a busy tenant's month passes the ceiling.
    {
      sort: [],
      filters: [
        { field: "fiscal_period_id", op: "eq", value: periodId },
        { field: "source", op: "eq", value: "fx_revaluation" },
      ],
    },
    { ceiling: c.maxRows },
    (rows) => {
      for (const e of rows) {
        if (e["fiscal_period_id"] === periodId && e["source"] === "fx_revaluation" && pattern.test(String(e["entry_number"] ?? ""))) {
          entries.push(e);
        }
      }
    },
  );
  if (!outcome.complete) throw new ReadCeilingExceeded(c.entryEntity, c.maxRows, "an unrealized FX revaluation");
  const byKey = new Map<string, PriorRevaluation>();
  for (const e of entries) {
    const lines = await readEntryLines(
      input,
      String(e["id"]),
      { lineEntity: c.lineEntity, lineEntryRefField: DEFAULTS.lineEntryRefField, maxLines: DEFAULTS.maxLines },
    );
    for (const l of lines) {
      const k = `${String(l["ledger_account_id"])}|${String(l["currency"])}`;
      const amounts = lineCents(l);
      const was = byKey.get(k);
      byKey.set(k, {
        account: String(l["ledger_account_id"]),
        currency: String(l["currency"]),
        fxRate: l["fx_rate"] ?? 1,
        description: typeof l["description"] === "string" ? (l["description"] as string) : "Unrealized FX revaluation",
        cents: (was?.cents ?? 0n) + amounts.fd - amounts.fc,
      });
    }
  }
  return { count: entries.length, byKey };
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
    if (!entersState(input, c.stateField, c.triggerState)) return;

    const doc = input.after;
    const docId = input.id;
    if (docId === null) return;
    if (positiveRate(doc[c.bookingRateField]) !== null) return; // already stamped

    const resolved = config.resolveFunctionalCurrency ? await config.resolveFunctionalCurrency(input.tenantId) : undefined;
    const functional = (resolved ?? c.functionalCurrency).toUpperCase();
    const currency = typeof doc[c.currencyField] === "string" ? (doc[c.currencyField] as string).toUpperCase() : functional;
    if (currency === functional) return; // functional-currency document → rate 1, nothing to stamp

    const nowIso = (c.clock?.now() ?? new Date()).toISOString();
    // Today when the document carries no date, which is the day `resolvePostingRate` takes the
    // recognition's rate on too: the stamp and the posting must name one rate, or a later
    // revaluation measures the difference from a rate the ledger was never booked at.
    const dateRaw = doc[c.dateField];
    const date = typeof dateRaw === "string" && dateRaw.length >= 10 ? dateRaw.slice(0, 10) : nowIso.slice(0, 10);

    const functionalCurrencyId = await resolveCurrencyId(input, c, functional);
    if (functionalCurrencyId === null) return;
    const rate = await lookupPeriodEndRate(input, c, currency, functionalCurrencyId, date);
    if (rate === null) return;

    await input.store.update(input.tenantId, c.entity, docId, {
      [c.bookingRateField]: renderDecimal(rate),
      updated_at: nowIso,
    });
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
 *
 * It **asks** for that row rather than reading a page and picking in JS, which is why this is not
 * one of the drained reads: it never wanted a set. Under `sort: []` the ordering is `ORDER BY id`
 * and house ids are time-ordered, so a capped page kept the OLDEST rates and dropped exactly the
 * ones nearest the period end — past the cap it returned a stale rate and multiplied the whole
 * revaluation by it. Pushing the date bound and the ordering into the query makes `limit: 1`
 * sufficient, so there is no ceiling to exceed and nothing to report. `rate_date` is a `date`
 * field, whose canonical spelling is fixed-width and zero-padded, so text order IS chronological
 * on the JSONB store and the column store compares a real `DATE`.
 *
 * The JS re-check of from/to/date stays as the belt, for the stores' own
 * `UNSERVEABLE_SURFACE_REFUSES` reason: a surface that is dropped rather than refused answers
 * with rows the caller asked to exclude, and here the excluded rows are future rates.
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
  },
  docCurrency: string,
  functionalCurrencyId: string,
  endDate: string,
): Promise<ExactDecimal | null> {
  const fromId = await resolveCurrencyId(input, c, docCurrency);
  if (fromId === null) return null;
  const page = await input.store.listPage(input.tenantId, c.exchangeRateEntity, {
    limit: 1,
    cursor: null,
    sort: [{ field: c.rateDateField, direction: "desc" }],
    filters: [
      { field: c.rateFromField, op: "eq", value: fromId },
      { field: c.rateToField, op: "eq", value: functionalCurrencyId },
      { field: c.rateDateField, op: "lte", value: endDate },
    ],
  });
  for (const r of page.records) {
    if (String(r[c.rateFromField] ?? "") !== fromId) continue;
    if (String(r[c.rateToField] ?? "") !== functionalCurrencyId) continue;
    const dateRaw = r[c.rateDateField];
    const date = typeof dateRaw === "string" && dateRaw.length > 0 ? dateRaw.slice(0, 10) : null;
    if (date === null || date > endDate) continue; // rate must be on/before the period end
    // Exact, and only a positive one: a zero or negative stored rate is no rate, not a rate of zero
    // that would convert every amount it touches to nothing.
    return positiveRate(r[c.rateField]);
  }
  return null;
}

export interface WhtCertificateClearingConfig {
  readonly entity?: string;
  readonly entryEntity?: string;
  readonly lineEntity?: string;
  readonly stateField?: string;
  readonly confirmedState?: string;
  readonly numberField?: string;
  readonly amountField?: string;
  readonly currencyField?: string;
  readonly ledgerAccountEntity?: string;
  readonly accountCodeField?: string;
  /** Resolves the WHT-receivable (credit) + tax-recoverable (debit) account codes. */
  readonly resolveAccountCodes?: (tenantId: string) => Promise<{ whtReceivable?: string; taxRecoverable?: string }>;
  readonly whtReceivableAccountRef?: string;
  readonly taxRecoverableAccountRef?: string;
  /**
   * How the certificate's rate is found: the rate of the invoice it names when that invoice carries
   * one in the same currency (the rate the withholding was booked at), else the rate on its own date.
   */
  readonly fx?: PostingFxConfig;
  /** The certificate's reference to the invoice the tax was withheld on, and that entity. */
  readonly invoiceRefField?: string;
  readonly invoiceEntity?: string;
  readonly periods?: PostingPeriodConfig;
  readonly clock?: { now(): Date };
}

const WHT_CLEARING_FALLBACKS = {
  entity: "WhtCertificate",
  entryEntity: "JournalEntry",
  lineEntity: "JournalLine",
  stateField: "state",
  confirmedState: "confirmed",
  numberField: "certificate_number",
  amountField: "amount",
  currencyField: "currency",
  ledgerAccountEntity: "LedgerAccount",
  accountCodeField: "account_code",
  whtReceivableAccountRef: "wht_receivable",
  taxRecoverableAccountRef: "income_tax_recoverable",
} as const;

/**
 * WHT certificate clearing: when a `WhtCertificate` is confirmed (→confirmed edge), the
 * tax withheld at recognition (a WHT receivable from the customer) becomes a formal tax
 * credit claimable from the authority. Posts ONE balanced `JournalEntry` (`<cert>-WHT`,
 * posted, source `system`) reclassing the withheld amount: debit income-tax-recoverable,
 * credit WHT-receivable — both assets, no P&L impact. Accounts resolve from the tenant's
 * configured codes (else placeholder refs). Fires once on the edge, written through the
 * store inside the confirming transaction (atomic, balanced by construction).
 */
export function whtCertificateClearingEffect(config: WhtCertificateClearingConfig = {}): WriteEffect {
  const c = { ...WHT_CLEARING_FALLBACKS, ...config };
  return async (input) => {
    if (input.entity !== c.entity) return;
    if (!entersState(input, c.stateField, c.confirmedState)) return; // fire once, on the →confirmed edge

    const cert = input.after;
    const certId = input.id;
    if (certId === null) return;
    const amountUnits = moneyUnits(cert[c.amountField]) ?? 0n;
    if (amountUnits <= 0n) return;

    const now = c.clock?.now() ?? new Date();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const certNumber = typeof cert[c.numberField] === "string" ? (cert[c.numberField] as string) : certId;
    const currency = typeof cert[c.currencyField] === "string" ? (cert[c.currencyField] as string) : "USD";
    // The withholding was booked at the invoice's rate, so that is the rate it is reclassed at —
    // reclassing it at today's would leave a residue in the receivable the recognition debited.
    let rate: ExactDecimal | null = null;
    const invoiceRef = cert[c.invoiceRefField ?? "invoice_id"];
    if (config.fx?.bookingRateField !== undefined && typeof invoiceRef === "string" && invoiceRef.length > 0) {
      const invoice = await input.store.get(input.tenantId, c.invoiceEntity ?? "Invoice", invoiceRef);
      const invoiceCurrency = typeof invoice?.["currency"] === "string" ? (invoice["currency"] as string) : null;
      if (invoice !== null && invoiceCurrency !== null && invoiceCurrency.toUpperCase() === currency.toUpperCase()) {
        rate = positiveRate(invoice[config.fx.bookingRateField]);
      }
    }
    rate ??= await resolvePostingRate(input, config.fx, cert, currency, today, "this WHT certificate");

    const codes = config.resolveAccountCodes ? await config.resolveAccountCodes(input.tenantId) : {};
    const recoverableAccount = (await resolveAccountId(input, c, codes.taxRecoverable)) ?? c.taxRecoverableAccountRef;
    const whtAccount = (await resolveAccountId(input, c, codes.whtReceivable)) ?? c.whtReceivableAccountRef;

    const entry = await createPostedEntry(input, c.entryEntity, {
      entry_number: `${certNumber}-WHT`,
      entry_date: today,
      source: "system",
      state: "posted",
      memo: `WHT certificate clearing for ${certNumber}`,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    }, config.periods);
    const base = { journal_entry_id: String(entry["id"]), currency, created_at: nowIso, updated_at: nowIso };
    // Reclass the withheld tax: debit income-tax-recoverable, credit WHT-receivable.
    const planned: PlannedLine[] = [
      { account: recoverableAccount, description: "WHT — income tax recoverable", side: "debit", units: amountUnits },
      { account: whtAccount, description: "WHT — receivable cleared", side: "credit", units: amountUnits },
    ];
    for (const line of convertedLines(base, planned, rate)) {
      await input.store.create(input.tenantId, c.lineEntity, line);
    }
  };
}

// ---- Tax remittance on `TaxReturn → paid` (ADR-0467) ------------------------------------------

export interface TaxRemittanceEffectConfig {
  readonly wiring: TaxRemittanceWiring;
  /**
   * The tenant's settings, which must be the write's snapshot resolver (`settingsScope.store`) and
   * never a pooled store: a settings read inside the write transaction deadlocked the pool
   * (ADR-0422). Absent, every tenant reads as `manual_journal`, so nothing posts and nothing new
   * refuses.
   */
  readonly settingsStore?: Pick<SettingsStore, "get">;
  /** Whether the manifest declares `TaxCode`, whose per-code accounts a remittance cannot clear. */
  readonly taxCodes?: boolean;
  readonly periods?: PostingPeriodConfig;
  readonly clock?: { now(): Date };
}

const TAX_RETURN = "TaxReturn";
const TAX_RETURN_FILED = "filed";
const TAX_RETURN_PAID = "paid";
/** The states a return holds a period in: a draft or ready return has declared nothing yet. */
const TAX_RETURN_PERIOD_HOLDING_STATES = ["filed", "amended", "paid"] as const;
export const TAX_RETURN_OVERLAP_CEILING = 1_000;
export const TAX_CODE_ROUTING_CEILING = 10_000;
/** One tax account's whole history; past it the balance cannot be read and posting mode is refused. */
export const TAX_REMITTANCE_BALANCE_LINE_CEILING = 200_000;
const ENTRY_ID_CHUNK = 500;
const LEDGER_ACCOUNT_LOOKUP = { ledgerAccountEntity: "LedgerAccount", accountCodeField: "account_code" } as const;

const TAX_REMITTANCE_LINE_DESCRIPTIONS: Readonly<Record<TaxRemittanceRole, string>> = {
  output: "Tax remittance — output tax",
  input: "Tax remittance — input tax",
  withholding: "Tax remittance — tax withheld",
  cash: "Tax remittance — cash",
};

function refuseRemittance(code: TaxRemittanceRefusalCode, detail?: string): never {
  const r = TAX_REMITTANCE_REFUSALS[code];
  throw new PostingRefused(r.status, code, detail ?? r.detail);
}

/** The tenant's settings, or null when posting mode is not `on_mark_paid` — the only gate a tenant has. */
async function remittingSettings(c: TaxRemittanceEffectConfig, tenantId: string): Promise<TenantSettings | null> {
  if (c.settingsStore === undefined) return null;
  const settings = await c.settingsStore.get(tenantId);
  return taxRemittancePostingMode(settings.finance) === "on_mark_paid" ? settings : null;
}

/** The state edge between two states, by prior state; a create has none and so is never one. */
function movesBetween(input: WriteEffectInput, stateField: string, from: string, to: string): boolean {
  if (input.operation !== "update" && input.operation !== "transition") return false;
  return input.before?.[stateField] === from && input.after[stateField] === to;
}

/**
 * Refuses a return whose `[period_start, period_end]` overlaps another of the same type for the same
 * jurisdiction that has already declared its period, so one stretch of tax is never remitted twice.
 *
 * The jurisdiction row is locked first (`FOR NO KEY UPDATE`, which a referencing write's
 * `FOR KEY SHARE` does not conflict with), always after the return's own row, so two overlapping
 * returns filed at once serialise here and the second reads the first's committed state.
 */
async function refuseOverlappingReturn(
  input: WriteEffectInput,
  stateField: string,
  record: EntityRecord,
  start: string,
  end: string,
): Promise<void> {
  const jurisdiction = record["jurisdiction_id"];
  const returnType = record["return_type"];
  if (typeof jurisdiction === "string" && jurisdiction.length > 0) {
    await input.store.getLocked(input.tenantId, "TaxJurisdiction", jurisdiction, "exclusive");
  }
  const filters: ListFilter[] = [
    { field: "return_type", op: "eq", value: String(returnType) },
    { field: stateField, op: "in", value: [...TAX_RETURN_PERIOD_HOLDING_STATES] },
  ];
  if (typeof jurisdiction === "string" && jurisdiction.length > 0) {
    filters.push({ field: "jurisdiction_id", op: "eq", value: jurisdiction });
  }
  let overlaps = false;
  const outcome = await drainList(
    input.store,
    input.tenantId,
    TAX_RETURN,
    { sort: [], filters },
    { ceiling: TAX_RETURN_OVERLAP_CEILING },
    (rows) => {
      for (const other of rows) {
        if (String(other["id"]) === input.id) continue;
        if (other["jurisdiction_id"] !== jurisdiction || other["return_type"] !== returnType) continue;
        const state = other[stateField];
        if (typeof state !== "string" || !(TAX_RETURN_PERIOD_HOLDING_STATES as readonly string[]).includes(state)) {
          continue;
        }
        const s = typeof other["period_start"] === "string" ? (other["period_start"] as string).slice(0, 10) : null;
        const e = typeof other["period_end"] === "string" ? (other["period_end"] as string).slice(0, 10) : null;
        // A period that cannot be read is taken to overlap: it may cover anything.
        if (s === null || e === null || (s <= end && start <= e)) overlaps = true;
      }
    },
  );
  if (!outcome.complete) {
    throw new ReadCeilingExceeded(TAX_RETURN, TAX_RETURN_OVERLAP_CEILING, "whether this return overlaps another");
  }
  if (overlaps) refuseRemittance("tax_return_period_overlaps");
}

/**
 * The checks a return's own declaration must pass before it can post: its figures, its period, its
 * currency against the tenant's functional one, and no other return covering the same period. Run
 * when the return is filed and again when it is marked paid, since the mode, the settings and other
 * returns can all have changed in between.
 */
async function checkRemittableReturn(
  input: WriteEffectInput,
  stateField: string,
  settings: TenantSettings,
): Promise<{ readonly plan: TaxRemittancePlan; readonly functional: string }> {
  const record = input.after;
  const planned = planTaxRemittance(record);
  if (isTaxRemittanceRefusal(planned)) refuseRemittance(planned.refusal);
  const functional = functionalCurrencyOf(settings);
  if (functional === null) refuseRemittance("functional_currency_undeclared");
  const currency = typeof record["currency"] === "string" ? (record["currency"] as string).trim().toUpperCase() : "";
  if (currency !== functional) refuseRemittance("tax_return_currency_not_functional");
  // The planner has already refused a period that is not two real dates in order.
  const start = String(record["period_start"]).slice(0, 10);
  const end = String(record["period_end"]).slice(0, 10);
  await refuseOverlappingReturn(input, stateField, record, start, end);
  return { plan: planned, functional };
}

/**
 * Refuses a tenant whose tax reaches accounts other than the settings' defaults, because the return
 * declares one figure per role and could not say how much of it sits in each account. Checked
 * against the configuration as it is now; tax routed by a mapping since removed is not visible here.
 */
async function refuseRoutedTax(
  input: WriteEffectInput,
  c: TaxRemittanceEffectConfig,
  shape: TaxRemittanceShape,
  settings: TenantSettings,
): Promise<void> {
  const finance = settings.finance ?? {};
  if (Object.keys(finance.taxAccountsByJurisdiction ?? {}).length > 0) {
    refuseRemittance("tax_remittance_routing_unsupported");
  }
  if (c.taxCodes !== true) return;
  const wht = (finance.whtPayableAccountCode ?? "").trim();
  let routed = false;
  const outcome = await drainList(
    input.store,
    input.tenantId,
    "TaxCode",
    { sort: [], filters: [] },
    { ceiling: TAX_CODE_ROUTING_CEILING },
    (rows) => {
      for (const code of rows) {
        const gl = typeof code["gl_account_code"] === "string" ? (code["gl_account_code"] as string).trim() : "";
        if (gl === "") continue;
        const withholding = code["kind"] === "withholding";
        if (shape === "withholding" ? withholding && gl !== wht : !withholding) routed = true;
      }
    },
  );
  if (!outcome.complete) {
    throw new ReadCeilingExceeded("TaxCode", TAX_CODE_ROUTING_CEILING, "whether this tenant routes tax by code");
  }
  if (routed) refuseRemittance("tax_remittance_routing_unsupported");
}

/**
 * One ledger account's balance, debits less credits in functional units, over its posted and
 * reversed entries (a reversed entry stands, beside the reversal that answers it). A line in the
 * functional currency is read at its transaction amounts and any other line at its functional ones;
 * a foreign line moving an amount with no functional amount cannot be read and refuses.
 */
async function ledgerAccountBalance(input: WriteEffectInput, accountId: string, functional: string): Promise<bigint> {
  const lines: { readonly entryId: string; readonly units: bigint; readonly unconverted: boolean }[] = [];
  const read = await drainList(
    input.store,
    input.tenantId,
    "JournalLine",
    { sort: [], filters: [{ field: "ledger_account_id", op: "eq", value: accountId }] },
    { ceiling: TAX_REMITTANCE_BALANCE_LINE_CEILING },
    (rows) => {
      for (const line of rows) {
        if (String(line["ledger_account_id"] ?? "") !== accountId) continue;
        const raw = typeof line["currency"] === "string" ? (line["currency"] as string).trim().toUpperCase() : "";
        const own = raw === "" || raw === functional;
        const amounts = lineCents(line);
        const units = own ? amounts.d - amounts.c : amounts.fd - amounts.fc;
        const unconverted = !own && (amounts.d !== 0n || amounts.c !== 0n) && amounts.fd === 0n && amounts.fc === 0n;
        lines.push({ entryId: String(line["journal_entry_id"] ?? ""), units, unconverted });
      }
    },
  );
  if (!read.complete) {
    throw new ReadCeilingExceeded("JournalLine", TAX_REMITTANCE_BALANCE_LINE_CEILING, "a tax account's balance");
  }
  const entryIds = [...new Set(lines.map((l) => l.entryId))];
  const standing = new Set<string>();
  for (let i = 0; i < entryIds.length; i += ENTRY_ID_CHUNK) {
    const chunk = entryIds.slice(i, i + ENTRY_ID_CHUNK);
    const entries = await drainList(
      input.store,
      input.tenantId,
      DEFAULTS.entryEntity,
      {
        sort: [],
        filters: [
          { field: "id", op: "in", value: chunk },
          { field: DEFAULTS.stateField, op: "in", value: [DEFAULTS.postedState, DEFAULTS.reversedState] },
        ],
      },
      { ceiling: ENTRY_ID_CHUNK },
      (rows) => {
        for (const entry of rows) {
          const state = entry[DEFAULTS.stateField];
          if (state === DEFAULTS.postedState || state === DEFAULTS.reversedState) standing.add(String(entry["id"]));
        }
      },
    );
    if (!entries.complete) {
      throw new ReadCeilingExceeded(DEFAULTS.entryEntity, ENTRY_ID_CHUNK, "a tax account's balance");
    }
  }
  let balance = 0n;
  for (const line of lines) {
    if (!standing.has(line.entryId)) continue;
    if (line.unconverted) refuseRemittance("tax_ledger_unconverted");
    balance += line.units;
  }
  return balance;
}

/**
 * Refuses a return that clears more from a tax account than the account holds on its normal side.
 * Netted per account, so two roles a tenant pointed at one account are bounded together; the cash
 * leg is the money that moved and has no bound.
 *
 * Each bounded account is locked (`FOR NO KEY UPDATE`) before any balance is read, in id order and
 * after the return and its jurisdiction, so two remittances clearing one account serialise and the
 * second reads the first's committed lines. Without it two returns for different jurisdictions —
 * which share the default accounts, since routed tax is refused — both pass against one balance and
 * together clear more than it holds. An ordinary posting's `FOR KEY SHARE` on the account does not
 * conflict, and a concurrent manual journal is not serialised by this.
 */
async function refuseBeyondLedger(
  input: WriteEffectInput,
  plan: TaxRemittancePlan,
  accounts: ReadonlyMap<TaxRemittanceRole, string>,
  functional: string,
): Promise<void> {
  const movement = new Map<string, bigint>();
  for (const leg of plan.legs) {
    if (leg.role === "cash") continue;
    const account = accounts.get(leg.role)!;
    movement.set(account, (movement.get(account) ?? 0n) + (leg.side === "debit" ? leg.units : -leg.units));
  }
  const bounded = [...movement].filter(([, moved]) => moved !== 0n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [account] of bounded) {
    await input.store.getLocked(input.tenantId, LEDGER_ACCOUNT_LOOKUP.ledgerAccountEntity, account, "exclusive");
  }
  for (const [account, moved] of bounded) {
    const balance = await ledgerAccountBalance(input, account, functional);
    // A debit clears a credit balance and a credit clears a debit one.
    const held = moved > 0n ? -balance : balance;
    const cleared = moved > 0n ? moved : -moved;
    if (cleared > held) refuseRemittance("tax_remittance_exceeds_ledger");
  }
}

/** The stored remittance count: absent is none yet; anything but a non-negative integer is a fault. */
function remittanceCountOf(record: EntityRecord): number {
  const raw = record["remittance_count"];
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("a tax return's remittance_count is not a count, so its next entry number cannot be chosen");
  }
  return n;
}

/**
 * When a tax return is filed (`file`, `refile`) in a tenant posting remittances, refuses one whose
 * declaration could never post — so the 422 arrives while the return can still be amended, not at
 * payment. Writes nothing. A return coming back to `filed` by `reverse_payment` is not refiled, and
 * the checks are not asked of it: an undo must not be refused by what the redo would need.
 */
export function taxReturnFilingCheckEffect(config: TaxRemittanceEffectConfig): WriteEffect {
  const stateField = config.wiring.stateField;
  return async (input) => {
    if (input.entity !== TAX_RETURN) return;
    if (!entersState(input, stateField, TAX_RETURN_FILED)) return;
    if (input.before?.[stateField] === TAX_RETURN_PAID) return;
    const settings = await remittingSettings(config, input.tenantId);
    if (settings === null) return;
    await checkRemittableReturn(input, stateField, settings);
  };
}

/**
 * On `TaxReturn → paid`, in a tenant whose `finance.taxRemittancePosting` is `on_mark_paid`, posts
 * the return's declared remittance as one entry and stamps the return with it. The figures are the
 * caller's, so the rule is to post exactly the declaration, bounded by the books, and to refuse what
 * cannot be cleared correctly; every read and every refusal comes before the first write.
 *
 * In `manual_journal` mode — the default, and what every tenant upgraded from ADR-0466 is in — it
 * does nothing: those tenants were told to post the remittance as a journal and then mark the return
 * paid, so posting here as well would remit it twice.
 */
export function taxRemittanceGlPostingEffect(config: TaxRemittanceEffectConfig): WriteEffect {
  const stateField = config.wiring.stateField;
  return async (input) => {
    if (input.entity !== TAX_RETURN) return;
    if (!entersState(input, stateField, TAX_RETURN_PAID)) return;
    const returnId = input.id;
    if (returnId === null) return;
    const settings = await remittingSettings(config, input.tenantId);
    if (settings === null) return;
    const { plan, functional } = await checkRemittableReturn(input, stateField, settings);
    const record = input.after;
    const nowIso = (config.clock?.now() ?? new Date()).toISOString();
    const today = nowIso.slice(0, 10);

    // A nil return remits nothing, so there is no entry to number or to reverse later — and the
    // stamp says so, so no earlier payment's number can be read as this one's.
    if (plan.legs.length === 0) {
      await input.store.update(input.tenantId, TAX_RETURN, returnId, {
        remitted_at: nowIso,
        remittance_entry_number: null,
        updated_at: nowIso,
      });
      return;
    }

    const finance = settings.finance ?? {};
    const accounts = new Map<TaxRemittanceRole, string>();
    for (const leg of plan.legs) {
      if (accounts.has(leg.role)) continue;
      const code = finance[TAX_REMITTANCE_ACCOUNT_SETTINGS[leg.role]];
      const id = await resolveAccountId(input, LEDGER_ACCOUNT_LOOKUP, typeof code === "string" ? code : undefined);
      if (id === null) refuseRemittance("tax_remittance_account_unresolved", taxRemittanceAccountUnresolvedDetail(leg.role));
      accounts.set(leg.role, id);
    }
    await refuseRoutedTax(input, config, plan.shape, settings);
    await refuseBeyondLedger(input, plan, accounts, functional);

    const returnNumber = typeof record["return_number"] === "string" ? (record["return_number"] as string) : returnId;
    const priorCount = remittanceCountOf(record);
    const number = taxRemittanceEntryNumber(returnNumber, priorCount);
    if ((await findEntryByNumber(input, DEFAULTS.entryEntity, number)) !== null) {
      refuseRemittance("tax_remittance_number_taken");
    }

    // No `currency` on the header: `JournalEntry` declares none, and an undeclared key is kept by
    // the document store and dropped by the column store. The lines carry it.
    const entry = await createPostedEntry(
      input,
      DEFAULTS.entryEntity,
      {
        entry_number: number,
        entry_date: today,
        source: "system",
        state: DEFAULTS.postedState,
        memo: `Tax remittance for ${returnNumber}`,
        posted_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
        ...attributedToTrigger(record),
      },
      config.periods,
    );
    const base = { journal_entry_id: String(entry["id"]), currency: functional, created_at: nowIso, updated_at: nowIso };
    const planned: PlannedLine[] = plan.legs.map((leg) => ({
      account: accounts.get(leg.role)!,
      description: TAX_REMITTANCE_LINE_DESCRIPTIONS[leg.role],
      side: leg.side,
      units: leg.units,
    }));
    for (const line of convertedLines(base, planned, RATE_ONE)) {
      await input.store.create(input.tenantId, DEFAULTS.lineEntity, line);
    }
    await input.store.update(input.tenantId, TAX_RETURN, returnId, {
      remitted_at: nowIso,
      remittance_entry_number: number,
      remittance_count: priorCount + 1,
      updated_at: nowIso,
    });
  };
}

/**
 * On `reverse_payment`, refuses two returns the reversal would get wrong.
 *
 * One whose remittance entry was already reversed, which `postingReversalEffect` would otherwise
 * skip in silence — leaving the return `filed` with nothing having said its posting was undone
 * elsewhere. Not gated on the mode: a payment posted while the tenant was in `on_mark_paid` is
 * reversed by its return whatever the setting says now. Only the current payment's entry is read:
 * the stamp clear empties the number on every reversal, so a stale one cannot reach here.
 *
 * And, in `on_mark_paid` mode, one marked paid with nothing posted here and no nil-return stamp —
 * paid before the upgrade or in `manual_journal` mode, so a manual journal remitted it. Reversing
 * it here would undo nothing, and its next `mark_paid` would post the same period a second time;
 * the remedy is to reverse it in `manual_journal` mode, beside reversing that journal by hand.
 */
export function taxRemittanceReversalCheckEffect(config: TaxRemittanceEffectConfig): WriteEffect {
  const stateField = config.wiring.stateField;
  return async (input) => {
    if (input.entity !== TAX_RETURN) return;
    if (!movesBetween(input, stateField, TAX_RETURN_PAID, TAX_RETURN_FILED)) return;
    const number = input.after["remittance_entry_number"];
    if (typeof number === "string" && number.length > 0) {
      const entry = await findEntryByNumber(input, DEFAULTS.entryEntity, number);
      if (entry !== null && entry[DEFAULTS.stateField] === DEFAULTS.reversedState) {
        refuseRemittance("tax_remittance_already_reversed");
      }
      return;
    }
    const stamped = input.after["remitted_at"];
    if (stamped !== undefined && stamped !== null) return;
    if ((await remittingSettings(config, input.tenantId)) !== null) refuseRemittance("tax_remittance_paid_outside_posting");
  };
}

/** The reversal of a return's remittance entry, which is numbered `<entry>-REV`. */
export function taxRemittanceReversalEffect(config: Omit<TaxRemittanceEffectConfig, "settingsStore" | "taxCodes">): WriteEffect {
  return postingReversalEffect({
    entity: TAX_RETURN,
    stateField: config.wiring.stateField,
    fromStates: [TAX_RETURN_PAID],
    toState: TAX_RETURN_FILED,
    numberField: "remittance_entry_number",
    sourceSuffix: "",
    reversalSuffix: TAX_REMITTANCE_REVERSAL_SUFFIX,
    sourceLabel: "system",
    ...(config.periods !== undefined ? { periods: config.periods } : {}),
    ...(config.clock !== undefined ? { clock: config.clock } : {}),
  });
}

/**
 * After `reverse_payment`, clears `remitted_at` and `remittance_entry_number`, on every return that
 * leaves `paid` and not only a stamped one. The number names the current payment's entry, so it must
 * not survive that payment: a later `mark_paid` that posts nothing (a nil return, or `manual_journal`
 * mode) writes no new one, and a stale number would make the next `reverse_payment` find the
 * reversed entry and refuse for ever. The count stays — it alone chooses the next `-REMIT-(n+1)`.
 * Runs last, after the reversal has read the number from `after`.
 */
export function taxRemittanceStampClearEffect(config: {
  readonly wiring: TaxRemittanceWiring;
  readonly clock?: { now(): Date };
}): WriteEffect {
  const stateField = config.wiring.stateField;
  return async (input) => {
    if (input.entity !== TAX_RETURN) return;
    if (!movesBetween(input, stateField, TAX_RETURN_PAID, TAX_RETURN_FILED)) return;
    const id = input.id;
    if (id === null) return;
    const nowIso = (config.clock?.now() ?? new Date()).toISOString();
    await input.store.update(input.tenantId, TAX_RETURN, id, {
      remitted_at: null,
      remittance_entry_number: null,
      updated_at: nowIso,
    });
  };
}
