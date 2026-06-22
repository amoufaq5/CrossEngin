import { listRecords, updateRecord } from "@/lib/api";

// Entity slugs (naive pluralizer: <kebab> + "s").
const PERIOD_SLUG = "fiscal-periods";
const ENTRY_SLUG = "journal-entrys";
const LINE_SLUG = "journal-lines";
const ACCOUNT_SLUG = "ledger-accounts";

export const OPEN_PERIOD_STATES: readonly string[] = ["open", "closing"];

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
  readonly balanced: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Pure: total debits/credits across a set of lines, and whether they balance to the cent. */
export function summarizeLines(
  lines: readonly { readonly debit: number; readonly credit: number }[],
): { totalDebit: number; totalCredit: number; balanced: boolean } {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalCredit = Math.round(totalCredit * 100) / 100;
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.005 };
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

  const [linesRes, accountsRes] = await Promise.all([
    listRecords(LINE_SLUG, `?limit=200&journal_entry_id[eq]=${encodeURIComponent(entryId)}`),
    listRecords(ACCOUNT_SLUG, "?limit=500").catch(() => ({ data: [], nextCursor: null })),
  ]);
  const accountNames = new Map<string, string>();
  for (const a of accountsRes.data) {
    const id = String(a["id"] ?? "");
    const name = str(a["name"]);
    if (id !== "" && name !== null) accountNames.set(id, name);
  }

  const lines: JournalLineRow[] = linesRes.data
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

  const { totalDebit, totalCredit, balanced } = summarizeLines(lines);
  return {
    id: entryId,
    entryNumber: str(entryRec["entry_number"]) ?? entryId,
    entryDate: str(entryRec["entry_date"]),
    memo: str(entryRec["memo"]),
    lines,
    totalDebit,
    totalCredit,
    balanced,
  };
}
