import type { EntityRecord, EntityStore, ListQuery } from "./store.js";

/**
 * Reading a whole filtered set rather than its first page.
 *
 * Every money reader in this package used to issue one `listPage` with a hardcoded `limit` and
 * discard the `nextCursor` beside it, so each figure was computed from a prefix and said nothing
 * about the rest. The caps differ by three orders of magnitude (500, 1000, 5000) and the sets they
 * bound are not comparable — one document's children against a tenant's whole trading history —
 * but the defect is one defect, and the measurement that settles it is the one that looked like an
 * exception.
 *
 * `paymentApplicationEffect` was the site that reads safest: it sums completed payments against a
 * document and settles the document once they cover its total, so an under-reported sum can only
 * fail to settle, which loses a capability and misstates nothing. That argument rests on payments
 * being non-negative, which rests on `Payment.amount`'s declared `min: 0` — and nothing in the
 * workspace enforces a `min`. Measured on the built store: an invoice of 400 with three payments
 * of 200 and a correction of −300 (true applied 300) is written **`paid`, with a `paid_at` stamp**,
 * at a cap of 3, and correctly left `sent` at a cap of 99. The document then reads settled and
 * drops out of both the aging report and the FX revaluation's open set, so a live receivable
 * disappears from the books.
 *
 * So the rule here is deliberately blunt and admits no per-site exception: **a prefix is not the
 * set, whatever is in the tail.** Reasoning site by site about whether a dropped term could be
 * negative is exactly what produced the one wrong verdict in the survey, and a figure is not
 * allowed to depend on a declaration (`min`, `unique`) that nothing checks.
 */

/**
 * Pages read per round trip. 500 rather than a new figure: `TOMBSTONE_SCAN_MAX_LIMIT` is 500 for
 * the same reason (a page an operator's sweep reads per tick) and `MAX_PAGE_SIZE` clamps a client's
 * `?limit` to 500, so this is the size this workspace already treats as one page's worth of rows.
 */
export const DEFAULT_DRAIN_PAGE_SIZE = 500;

/**
 * Why a drain stopped before the set was exhausted, when it did.
 *
 * `ceiling_reached` is the only member that is not a fault: it means the deployment's declared
 * bound was hit with rows still to read, which is a fact about the data and is the caller's to
 * answer for (see {@link READ_CEILING_EFFECT}).
 */
export const DRAIN_HALT_REASONS = [
  "ceiling_reached",
  "cursor_did_not_advance",
  "page_budget_exhausted",
] as const;
export type DrainHaltReason = (typeof DRAIN_HALT_REASONS)[number];

/**
 * A store that returned the same cursor twice, or kept returning cursors past the point where the
 * row budget could still be live. Both mean the store is not advancing through its own keyspace,
 * which is a defect in the store rather than a set that is too large — so it is loud, and it is
 * deliberately NOT the same outcome as reaching the ceiling.
 *
 * It is not hypothetical. Until this module landed, `InMemoryEntityStore` ordered ids two ways: the
 * sort's tiebreaker went through `compareValues` (decimal-aware, then instant-aware, then
 * `localeCompare`) while the seek's last clause was a raw `String(row.id) > cursor.id`. Measured
 * with `sort: []` at `limit: 2`, ids `["Zebra","apple","Bravo","cherry"]` returned the **same
 * cursor twice** — a walk that never terminates — and `["9","10","11","8","100"]` silently visited
 * 2 of 5. Both are closed (`store.ts`'s `compareIds` is now the one comparator, matching the TEXT
 * collation both Postgres stores order and seek under), and this fence is what makes the next such
 * divergence an error rather than a hang.
 */
export class DrainDidNotTerminate extends Error {
  readonly reason: DrainHaltReason;
  readonly entity: string;
  readonly pages: number;

  constructor(entity: string, reason: DrainHaltReason, pages: number) {
    super(`draining '${entity}' did not terminate after ${pages.toString()} page(s): ${reason}`);
    this.name = "DrainDidNotTerminate";
    this.reason = reason;
    this.entity = entity;
    this.pages = pages;
  }
}

/** The declared bound on one drain: how many rows it may read before it stops and says so. */
export interface DrainBounds {
  /**
   * The largest set this reader will read in full. Reaching it is reported, never silently
   * truncated — which is the whole difference from the `limit` it replaces.
   */
  readonly ceiling: number;
  /** Rows per round trip; defaults to {@link DEFAULT_DRAIN_PAGE_SIZE}. Floored at 1. */
  readonly pageSize?: number;
}

/**
 * What a drain saw. `complete` is the claim the caller acts on, and it is derived from the store's
 * own cursor rather than from the row count: `nextCursor === null` is the one end-of-set signal
 * (`handlers.ts` states the rule for the list route, and a short page is a legal answer), so a
 * drain that stops for any other reason reports `complete: false` and names it.
 */
export interface DrainOutcome {
  readonly complete: boolean;
  readonly records: number;
  readonly pages: number;
  /** Absent when `complete`; otherwise why the drain stopped. */
  readonly haltedBy?: DrainHaltReason;
}

/**
 * Reads every record matching `query` in pages, handing each page to `onPage`, and stops at
 * `bounds.ceiling` rows rather than truncating in silence.
 *
 * `onPage` rather than a returned array, because the caller decides what it needs to hold: the
 * balance guard folds a page into two running sums (O(1) memory over an entry of any size), the
 * aging report folds payments into a per-document map (O(documents)), and only the two
 * mirror-the-rows effects genuinely need the records themselves — and those are bounded by one
 * document's children. A `collect`-shaped helper would have made the 5000-row tenant-wide sites
 * hold 5000 records to produce two numbers.
 *
 * There is deliberately **no early stop**. A caller summing toward a threshold cannot stop when it
 * crosses it, because a later page may carry a negative term that takes it back under — which is
 * not a hypothetical: it is the measured `paymentApplicationEffect` defect in this module's own
 * header. An `onPage` that could halt the loop would hand every caller that trap back.
 *
 * Termination is `nextCursor === null` and nothing else. The three stores all derive `hasMore` from
 * reading `limit + 1` rows, so at the store level a short page does imply a null cursor — but that
 * is an implementation detail of three expressions rather than the contract, and a wrapper that
 * filtered rows would break it, so the loop does not read the row count as an end signal.
 */
export async function drainList(
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  entity: string,
  query: Omit<ListQuery, "cursor" | "limit">,
  bounds: DrainBounds,
  onPage: (records: readonly EntityRecord[]) => void,
): Promise<DrainOutcome> {
  // The floor on `pageSize` is load-bearing for exactly one thing, and it is not the `limit` below:
  // `pageBudget` divides by it, so an unfloored `0` makes the budget `Infinity` and silently
  // disables the only fence against a store that never advances. (A `0` also reads nothing — every
  // store answers a `limit: 0` page with a null cursor — so the drain would report `complete: true`
  // over an empty read.) The ceiling takes `Math.trunc` and no floor: a negative one is already
  // halted by `records >= ceiling` on the first pass, and a guard that provably cannot fire reads as
  // coverage it does not provide.
  const pageSize = Math.max(1, Math.trunc(bounds.pageSize ?? DEFAULT_DRAIN_PAGE_SIZE));
  const ceiling = Math.trunc(bounds.ceiling);
  // The `+ 9` is one slack for one reason: a store handing back **short or empty** pages makes
  // progress through its keyspace without spending row budget, so a set it reads in full can take
  // more than `ceil(ceiling / pageSize)` round trips, and without the slack the budget would refuse
  // a healthy drain. A handful of such pages is ordinary and an unbounded run of them is the store
  // failing to advance, which is what this bounds.
  //
  // It is deliberately NOT what separates "exactly `ceiling` rows, and that is all of them" from
  // "`ceiling` rows with more behind them" — an earlier version of this comment claimed that and
  // the measurement refuted it. With the budget cut to a bare `ceil(ceiling / pageSize)` both of
  // those cases answer exactly as they do now, because `records >= ceiling` is tested at the top of
  // the loop *before* the page budget, and because both read the same rows in the same number of
  // pages: the distinction lives in the `nextCursor` of the page that exhausts the ceiling and in
  // no count at all. What the cut does break is the short-page case, which is the slack's real job.
  const pageBudget = Math.ceil(ceiling / pageSize) + 9;

  let cursor: string | null = null;
  let previous: string | null = null;
  let records = 0;
  let pages = 0;

  for (;;) {
    if (records >= ceiling) return { complete: false, records, pages, haltedBy: "ceiling_reached" };
    if (pages >= pageBudget) throw new DrainDidNotTerminate(entity, "page_budget_exhausted", pages);
    const page = await store.listPage(tenantId, entity, {
      ...query,
      cursor,
      // Never read past the ceiling: the stop is a claim about the set, so it must not depend on how
      // the ceiling happens to divide by the page size. No floor needed — `pageSize` is at least 1
      // and the loop has already returned whenever `records >= ceiling`, so this is ≥ 1 by
      // construction.
      limit: Math.min(pageSize, ceiling - records),
    });
    pages += 1;
    records += page.records.length;
    onPage(page.records);
    if (page.nextCursor === null) return { complete: true, records, pages };
    if (page.nextCursor === previous) {
      throw new DrainDidNotTerminate(entity, "cursor_did_not_advance", pages);
    }
    previous = cursor;
    cursor = page.nextCursor;
  }
}

/**
 * The positions a bounded read is answered from, and what each does when the set exceeded its
 * ceiling. A total map rather than a per-site `if`, so a fourth position has to say what it does
 * instead of inheriting whichever branch the chain ended on.
 *
 * The split is not about severity — it is about whether a bounded answer is a *usable* answer:
 *
 * - a **guard** decides, and a decision from a prefix is not a decision. `journalPostingGuard`
 *   summed at most 1000 lines and then declared the entry balanced or not, which fails in **both**
 *   directions from one cap: measured on the built tree, a 1001-line entry unbalanced by 9999 whose
 *   first 1000 lines happen to balance is **allowed** to post, and a genuinely balanced 1001-line
 *   entry is **refused** `422 unbalanced_journal_entry: debits (10000.00) must equal credits
 *   (0.00)` — a detail that is a lie about the entry. A balancing prefix is the ordinary shape,
 *   because every GL posting effect writes its lines as a balanced group;
 * - an **effect** writes, and a row written from a prefix is a wrong row that balances. Nothing
 *   downstream can see it: the reversal's lines, the FX revaluation's two lines and the recognition
 *   posting's control/net/tax lines are each a matched pair or a reconciled set by construction, so
 *   no balance check, no reconciliation and no CHECK constraint distinguishes a truncated posting
 *   from a correct one;
 * - a **report** reads, and a bounded reading that says how far it looked is honest where silence
 *   is not. That is this repo's existing shape rather than a new one — `usage-handler.ts` emits
 *   `overflow: len > probeCeiling` beside `used`, and `read-state-routes.ts` sets
 *   `truncated = page.nextCursor !== null` — and it is the better answer here because an aging
 *   report over the first 5000 of 60,000 open documents is still the only view an operator has,
 *   where a "probably balanced" verdict and a "probably right" GL row are not degraded versions of
 *   the real thing.
 */
export const READ_CEILING_EFFECT = {
  guard: "refuses",
  effect: "aborts",
  report: "declares",
} as const satisfies Readonly<Record<string, string>>;

export type ReadCeilingPosition = keyof typeof READ_CEILING_EFFECT;
export type ReadCeilingEffect = (typeof READ_CEILING_EFFECT)[ReadCeilingPosition];

/**
 * What a `report`-position answer carries about its own reach, for a response body to extend.
 *
 * It lives beside {@link DrainOutcome} rather than in either report handler because this is the type
 * that *produces* the fact, and two handlers declaring it separately is how two spellings of one
 * claim begin — the shape this workspace keeps finding. `complete` is **required**, so a response
 * type extending this cannot omit it on the happy path: an absent field reads as *nobody looked*,
 * which is the one thing a bounded report must not be mistaken for.
 *
 * `complete` should be derived from `bounded.length === 0` rather than accumulated beside it, so the
 * claim and the names it is made of cannot disagree.
 */
export interface BoundedReadDeclaration {
  /** True when every read behind this answer was exhausted. */
  readonly complete: boolean;
  /** The reads that stopped at their ceiling, empty when `complete`. */
  readonly bounded: readonly string[];
}

/**
 * A write effect that could not read the whole set it had to compute from. Thrown rather than
 * returned, because an effect's only refusal channel is a throw.
 *
 * **The transaction is not what makes that safe, and leaning on it would have been wrong.** The
 * tempting argument is that effects run inside the handler's transaction, so a throw rolls
 * everything back — but `writeTxn` falls through to `body(ctx.store)` on a store that is not
 * transactional, and two effects used to write their document header *before* their own line read.
 * Measured on that shape: a 5-line reversal at `maxLines: 3` outside a transaction threw and left a
 * second posted entry behind with no lines, and a retry left a third. So every effect now does its
 * whole read before its first write, the two mirror effects deriving their line payloads and
 * stamping the new parent's id on afterwards — which makes "nothing was written" a property of each
 * effect rather than a promise about the caller's store.
 *
 * `computing` is a short literal naming the figure, never a value read from a record. That is what
 * `writeTxn`'s catch relies on to put it in a response body at all: the reason the fixed 500 names
 * nothing is that a database error carries entities, columns and tenant ids nobody chose to
 * disclose, and this refusal is only outside that rule while it carries nothing of the kind.
 *
 * The cost is diagnosis, and it is stated rather than hidden: the message reaches no recorder, so
 * `writeTxn` discriminates this class by name — the way it already does for `UniqueViolation` — and
 * that name is all an operator gets until the recorder seam exists.
 */
export class ReadCeilingExceeded extends Error {
  readonly entity: string;
  readonly ceiling: number;
  readonly computing: string;

  constructor(entity: string, ceiling: number, computing: string) {
    super(
      `'${entity}' has more than ${ceiling.toString()} rows matching this read, so ${computing} ` +
        `cannot be computed from the whole set`,
    );
    this.name = "ReadCeilingExceeded";
    this.entity = entity;
    this.ceiling = ceiling;
    this.computing = computing;
  }
}

/** Whether an unknown error is a {@link ReadCeilingExceeded}, by shape, for `writeTxn`'s catch. */
export function isReadCeilingExceeded(err: unknown): err is ReadCeilingExceeded {
  return err instanceof ReadCeilingExceeded;
}
