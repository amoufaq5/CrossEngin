import { listRecords, updateRecord } from "@/lib/api";

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
  readonly currency: string | null;
  readonly debit: number;
  readonly credit: number;
}

export interface RevaluationEntry {
  readonly id: string;
  readonly entryNumber: string;
  readonly entryDate: string | null;
  readonly memo: string | null;
  readonly lines: readonly JournalLineRow[];
  readonly totalDebit: number;
  readonly totalCredit: number;
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

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
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
  lines: readonly { readonly debit: number; readonly credit: number }[],
  complete: boolean,
): { totalDebit: number; totalCredit: number; balanced: boolean | null } {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalCredit = Math.round(totalCredit * 100) / 100;
  const balanced = complete ? Math.abs(totalDebit - totalCredit) < 0.005 : null;
  return { totalDebit, totalCredit, balanced };
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

export async function fetchPeriods(): Promise<readonly FiscalPeriodRow[]> {
  const res = await listRecords(PERIOD_SLUG, "?limit=200");
  return res.data
    .map(periodFromRecord)
    .filter((p) => p.id !== "")
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
}

export async function closePeriod(id: string): Promise<void> {
  await updateRecord(PERIOD_SLUG, id, { status: "closed" });
}

/**
 * Loads the period's posted FX revaluation entry (source=fx_revaluation) and its lines,
 * resolving ledger account ids to names best-effort. Returns null when none was posted
 * (e.g. no foreign-currency exposure at close).
 *
 * Only the lines are a bounded read. The entry itself is a single lookup wearing a list's clothes,
 * and the reason is the **effect's trigger** and not the column: `unrealizedFxRevaluationEffect`
 * fires on the transition *into* `closed` and nowhere else, so one close posts one entry. Both
 * filters are honoured — measured on resolved `erp-core`, `source` and `fiscal_period_id` are in
 * `JournalEntry`'s filterable set — so `?limit=50` carries slack it does not need.
 *
 * It deliberately does **not** rest on `entry_number` being a `unique` column, which was this
 * comment's first argument and is the one thing it may not say: a figure is not allowed to depend on
 * a declaration nothing checks, and ADR-0360 measures the shipped `--store pg` enforcing 0 of 32
 * unique declarations. The consequence of the honest argument is narrower and worth stating: a
 * period re-closed after being reopened posts a *second* entry, and this lookup then shows one of
 * them arbitrarily, because `sort: []` leaves the order to the id.
 */
export async function fetchRevaluationEntry(periodId: string): Promise<RevaluationEntry | null> {
  const entries = await listRecords(
    ENTRY_SLUG,
    `?limit=50&fiscal_period_id[eq]=${encodeURIComponent(periodId)}&source[eq]=fx_revaluation`,
  );
  const entryRec = entries.data.find((e) => str(e["source"]) === "fx_revaluation");
  if (entryRec === undefined) return null;
  const entryId = String(entryRec["id"] ?? "");
  if (entryId === "") return null;

  const [lineRead, accountsRes] = await Promise.all([
    drainRecords(
      LINE_SLUG,
      new URLSearchParams({ "journal_entry_id[eq]": entryId }),
      REVALUATION_LINE_MAX,
      REVALUATION_LINE_PAGE_SIZE,
    ),
    listRecords(ACCOUNT_SLUG, "?limit=500").catch(() => ({ data: [], nextCursor: null })),
  ]);
  const accountNames = new Map<string, string>();
  for (const a of accountsRes.data) {
    const id = String(a["id"] ?? "");
    const name = str(a["name"]);
    if (id !== "" && name !== null) accountNames.set(id, name);
  }

  const lines: JournalLineRow[] = lineRead.rows
    .filter((l) => String(l["journal_entry_id"] ?? "") === entryId)
    .map((l) => {
      const accId = str(l["ledger_account_id"]);
      return {
        id: String(l["id"] ?? ""),
        ledgerAccountId: accId,
        accountName: accId !== null ? (accountNames.get(accId) ?? null) : null,
        description: str(l["description"]),
        currency: str(l["currency"]),
        debit: num(l["debit"]),
        credit: num(l["credit"]),
      };
    });

  const { totalDebit, totalCredit, balanced } = summarizeLines(lines, lineRead.complete);
  return {
    id: entryId,
    entryNumber: str(entryRec["entry_number"]) ?? entryId,
    entryDate: str(entryRec["entry_date"]),
    memo: str(entryRec["memo"]),
    lines,
    totalDebit,
    totalCredit,
    balanced,
    linesTruncated: !lineRead.complete,
  };
}
