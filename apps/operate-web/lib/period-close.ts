import { listRecords, runTransition } from "@/lib/api";
import { moneyUnits, sumMoney, unitsText } from "@/lib/money";

// Entity slugs (naive pluralizer: <kebab> + "s").
const PERIOD_SLUG = "fiscal-periods";
const ENTRY_SLUG = "journal-entrys";
const LINE_SLUG = "journal-lines";
const ACCOUNT_SLUG = "ledger-accounts";

export const OPEN_PERIOD_STATES: readonly string[] = ["open", "closing"];

/**
 * The largest line set the FX revaluation panel reads in full. Reaching it is *declared* — the
 * panel says so, and the balance verdict is withheld — rather than truncated in silence, which is
 * the whole difference from the `?limit=200` it replaces: that one discarded the `nextCursor`
 * beside it, so past 200 lines the screen showed money totals over a prefix and asserted a
 * balance from them.
 *
 * The population is set by the posting effect rather than by trading volume.
 * `unrealizedFxRevaluationEffect` folds every open document into a map keyed `${currency}|${side}`
 * over two sides and writes exactly two lines per surviving key, so one entry carries at most
 * `4 × (distinct foreign currencies with open exposure)` lines — around 716 at every active
 * ISO 4217 code — and posted-entry immutability means nothing adds to it afterwards. 5000 is
 * comfortably past that, and ten round trips at {@link REVALUATION_LINE_PAGE_SIZE}.
 */
const REVALUATION_LINE_MAX = 5000;

/** The revaluation entries one period can hold — one per close, plus the prior period's reversals. */
const REVALUATION_ENTRY_MAX = 500;

/**
 * Rows per round trip. 500 because `MAX_PAGE_SIZE` is 500 server-side and `clampLimit` is
 * `Math.min(n, maxLimit)` — measured against the built runtime on resolved `erp-core`: `?limit=500`
 * is honoured, and `?limit=5000` comes back as 500 with nothing reported, so asking for more buys
 * nothing and hides the paging.
 */
const REVALUATION_LINE_PAGE_SIZE = 500;

export interface FiscalPeriodRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly periodNumber: number | null;
  readonly closedAt: string | null;
}

export interface JournalLineRow {
  readonly id: string;
  readonly ledgerAccountId: string | null;
  readonly accountName: string | null;
  readonly description: string | null;
  /** The currency revalued — not the currency `debit` and `credit` are in, which is the functional one. */
  readonly currency: string | null;
  /** Functional-currency amounts, as exact decimal text (`"0.00"` for the empty side). */
  readonly debit: string;
  readonly credit: string;
}

export interface RevaluationEntry {
  readonly id: string;
  readonly entryNumber: string;
  readonly entryDate: string | null;
  readonly memo: string | null;
  readonly lines: readonly JournalLineRow[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** Whether debits equal credits, or `null` when `linesTruncated` — see {@link summarizeLines}. */
  readonly balanced: boolean | null;
  /**
   * Whether the read stopped at {@link REVALUATION_LINE_MAX} with lines still behind it. It is the
   * reason the verdict is absent, where `balanced === null` is the absence itself: the panel needs
   * both, because "we did not determine this" and "here is why" send a reader to different places.
   */
  readonly linesTruncated: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A line's functional amount on one side. A revaluation line moves no transaction amount — its
 * `debit`/`credit` are 0 and only `functional_*` carry the figure — so reading `debit` showed a
 * revaluation entry as all zeros. An entry written before lines carried a functional amount has
 * only the transaction one, which for a functional-currency posting is the same figure.
 */
function functionalSide(l: Record<string, unknown>, functionalField: string, field: string): string {
  return unitsText(moneyUnits(l[functionalField]) ?? moneyUnits(l[field]) ?? 0n);
}

/**
 * Pure: total debits/credits across a set of lines, and whether they balance to the cent.
 *
 * `complete` says whether those lines are the whole entry, and it decides the verdict rather than
 * decorating it: `balanced` is `null` when they are not. A prefix balances or fails to balance for
 * reasons that have nothing to do with the entry — every GL posting effect writes its lines as a
 * balanced group, so a balancing prefix is the *ordinary* shape — and the answer is wrong in both
 * directions from one cap. The totals stay, because a figure that says how far it looked is still
 * the only view an operator has; the verdict does not, because "probably balanced" is not a
 * degraded verdict.
 *
 * Required rather than defaulted: `true` is the only default a caller would reach for and it is
 * the unsafe one, since it asserts the verdict. There is one caller.
 */
export function summarizeLines(
  lines: readonly { readonly debit: string; readonly credit: string }[],
  complete: boolean,
): { totalDebit: string; totalCredit: string; balanced: boolean | null } {
  const debit = sumMoney(lines.map((l) => l.debit));
  const credit = sumMoney(lines.map((l) => l.credit));
  return { totalDebit: unitsText(debit), totalCredit: unitsText(credit), balanced: complete ? debit === credit : null };
}

/**
 * Reads every record matching `params` in pages, stopping at `ceiling` rows and saying whether
 * that was the whole set.
 *
 * `limit` and `cursor` are `set` on a copy of `params` rather than appended, which is not a style
 * choice: the server reads a repeated key as an array and takes the **first** value, so a second
 * `limit` riding on an existing query string is silently ignored in favour of the one already
 * there. Bracketed filter keys survive the round trip — `URLSearchParams` percent-encodes them and
 * `splitTarget` decodes them back — verified against the server's own parser.
 *
 * Written here rather than shared because the honest home for it is `lib/api.ts` beside
 * `listRecords`, which this change does not own; `@crossengin/operate-runtime`'s `drainList` is the
 * server's answer to the same question and cannot be reached from a browser, since it takes an
 * `EntityStore` rather than a URL.
 */
async function drainRecords(
  slug: string,
  params: URLSearchParams,
  ceiling: number,
  pageSize: number,
): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; complete: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const p = new URLSearchParams(params);
    p.set("limit", pageSize.toString());
    if (cursor !== null) p.set("cursor", cursor);
    const page = await listRecords(slug, `?${p.toString()}`);
    rows.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null && rows.length < ceiling);
  // Termination is `nextCursor === null` and nothing else — a short page is a legal answer — so a
  // live cursor here is the one reading that separates "that was the whole set" from "that was the
  // first `ceiling` of it".
  return { rows, complete: cursor === null };
}

function periodFromRecord(r: Record<string, unknown>): FiscalPeriodRow {
  const pn = r["period_number"];
  return {
    id: String(r["id"] ?? ""),
    name: str(r["name"]) ?? String(r["id"] ?? ""),
    status: str(r["status"]) ?? "open",
    startDate: str(r["start_date"]),
    endDate: str(r["end_date"]),
    periodNumber: typeof pn === "number" ? pn : null,
    closedAt: str(r["closed_at"]),
  };
}

/**
 * The most fiscal periods the screen reads. Twelve a year plus an adjustment period is ~13, so this
 * is centuries of periods; reaching it is still *said* rather than truncated in silence, which is
 * what the `?limit=200` this replaces did — it discarded the cursor beside it.
 */
const PERIOD_MAX = 5000;
/** The chart of accounts read for line names; a chart past it shows ids for the rest. */
const ACCOUNT_MAX = 20000;
const PAGE_SIZE = 500;

export interface PeriodRead {
  readonly periods: readonly FiscalPeriodRow[];
  /** Whether every period was read; false when {@link PERIOD_MAX} stopped the read with more behind it. */
  readonly complete: boolean;
}

export async function fetchPeriods(): Promise<PeriodRead> {
  const read = await drainRecords(PERIOD_SLUG, new URLSearchParams(), PERIOD_MAX, PAGE_SIZE);
  return {
    periods: read.rows
      .map(periodFromRecord)
      .filter((p) => p.id !== "")
      .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "")),
    complete: read.complete,
  };
}

// A period's status moves only by transition since it has a lifecycle; a PATCH of it is refused.
export async function closePeriod(id: string): Promise<void> {
  await runTransition(PERIOD_SLUG, id, "close");
}

/**
 * Loads the period's posted FX revaluation and its lines, resolving ledger account ids to names
 * best-effort. Returns null when none was posted (no foreign-currency exposure at close).
 *
 * A period can carry more than one `source = fx_revaluation` entry, and only some are its own
 * revaluation. `unrealizedFxRevaluationEffect` numbers the first close's entry `<label>-FXREVAL`
 * and a re-close's difference `-FXREVAL2`, `-FXREVAL3` (ADR-0429), and it reverses each one on the
 * first day of the **next** period as `<number>R` — so a period also holds the reversal of the
 * period before it, under the same source. Taking whichever entry the list returned first showed a
 * prior period's reversal as this period's revaluation, or a re-close's difference as the whole of
 * it. So the period's own entries are the ones numbered `-FXREVAL<n>` with no `R`, and they are
 * shown together: their lines sum to what the period's closes revalued in total.
 */
const OWN_REVALUATION_NUMBER = /-FXREVAL(\d*)$/;

export async function fetchRevaluationEntry(periodId: string): Promise<RevaluationEntry | null> {
  const entries = await drainRecords(
    ENTRY_SLUG,
    new URLSearchParams({ "fiscal_period_id[eq]": periodId, "source[eq]": "fx_revaluation" }),
    REVALUATION_ENTRY_MAX,
    REVALUATION_LINE_PAGE_SIZE,
  );
  const own = entries.rows
    .filter((e) => str(e["source"]) === "fx_revaluation" && String(e["fiscal_period_id"] ?? "") === periodId)
    .map((e) => ({ rec: e, match: OWN_REVALUATION_NUMBER.exec(str(e["entry_number"]) ?? "") }))
    .filter((e): e is { rec: Record<string, unknown>; match: RegExpExecArray } => e.match !== null)
    .map((e) => ({ rec: e.rec, ordinal: e.match[1] === "" ? 1 : Number(e.match[1]) }))
    .sort((a, b) => a.ordinal - b.ordinal);
  if (own.length === 0) return null;
  const entryRec = own[0]!.rec;
  const entryIds = own.map((e) => String(e.rec["id"] ?? "")).filter((id) => id !== "");
  if (entryIds.length === 0) return null;
  const entryId = entryIds[0]!;

  const [lineReads, accountsRes] = await Promise.all([
    Promise.all(
      entryIds.map((id) =>
        drainRecords(
          LINE_SLUG,
          new URLSearchParams({ "journal_entry_id[eq]": id }),
          REVALUATION_LINE_MAX,
          REVALUATION_LINE_PAGE_SIZE,
        ),
      ),
    ),
    // Names are best-effort — an unnamed line shows its account id — but they are read in full: the
    // `?limit=500` this replaces named the first 500 accounts and showed ids for every line past them.
    drainRecords(ACCOUNT_SLUG, new URLSearchParams(), ACCOUNT_MAX, PAGE_SIZE).catch(() => ({ rows: [], complete: false })),
  ]);
  const accountNames = new Map<string, string>();
  for (const a of accountsRes.rows) {
    const id = String(a["id"] ?? "");
    const name = str(a["name"]);
    if (id !== "" && name !== null) accountNames.set(id, name);
  }

  const ownIds = new Set(entryIds);
  const lineRead = {
    rows: lineReads.flatMap((r) => r.rows),
    complete: lineReads.every((r) => r.complete) && entries.complete,
  };
  const lines: JournalLineRow[] = lineRead.rows
    .filter((l) => ownIds.has(String(l["journal_entry_id"] ?? "")))
    .map((l) => {
      const accId = str(l["ledger_account_id"]);
      return {
        id: String(l["id"] ?? ""),
        ledgerAccountId: accId,
        accountName: accId !== null ? (accountNames.get(accId) ?? null) : null,
        description: str(l["description"]),
        currency: str(l["currency"]),
        debit: functionalSide(l, "functional_debit", "debit"),
        credit: functionalSide(l, "functional_credit", "credit"),
      };
    });

  const { totalDebit, totalCredit, balanced } = summarizeLines(lines, lineRead.complete);
  return {
    id: entryId,
    entryNumber: own.map((e) => str(e.rec["entry_number"]) ?? String(e.rec["id"] ?? "")).join(" + "),
    entryDate: str(entryRec["entry_date"]),
    memo: str(entryRec["memo"]),
    lines,
    totalDebit,
    totalCredit,
    balanced,
    linesTruncated: !lineRead.complete,
  };
}
