import {
  FINANCE_ACCOUNT_CODE_KEYS,
  functionalCurrencyOf,
  type FinanceAccountCodeFill,
  type FinanceAccountCodeFiller,
  type FinanceAccountCodeKey,
  type FinanceSettingsFillRequest,
  type SettingsStore,
  type TenantSettings,
} from "./settings.js";
import type { TaxRemittanceWiring } from "./tax-remittance.js";
import type { EntityRecord } from "./store.js";
import type { SystemActor, SystemEntityAccess, SystemWriteResult } from "./system-writer.js";
import { ReadCeilingExceeded } from "./list-drain.js";

/**
 * A starter chart of accounts: the ledger accounts a new workspace needs before its first invoice,
 * bill or payment can post, and the finance settings pointed at them (ADR-0465).
 *
 * Without it every posting effect resolves its account code to nothing, writes a placeholder into a
 * required `LedgerAccount` reference, and is refused `409 server_reference_unresolved` (ADR-0423) —
 * so an approved workspace could not send an invoice until its admin had built a chart by hand.
 */

/** The `account_type` values `erp-core`'s `LedgerAccount` declares. */
export const STARTER_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type StarterAccountType = (typeof STARTER_ACCOUNT_TYPES)[number];

export interface StarterAccount {
  readonly code: string;
  readonly name: string;
  readonly accountType: StarterAccountType;
}

/** Recorded with each provisioning, so a later reader knows which chart a workspace was given. */
export const STARTER_CHART_VERSION = "2026-11";

export const STARTER_CHART_ENTITY = "LedgerAccount";

/**
 * One account per finance setting that names an account, as a **total** map: a new `*AccountCode`
 * setting is a compile error here until the chart says which account serves it, so a posting effect
 * cannot gain an account the starter chart leaves unresolved.
 *
 * The types follow what each posting does with the account, not a convention a posting reads:
 * nothing in the workspace reads `account_type` at posting time (only the list view shows it). Input
 * tax and output tax are separate so a tax return can read each side; realized and unrealized
 * foreign exchange are separate because the unrealized entry auto-reverses next period (ADR-0429)
 * and a reversal is easier to audit on an account of its own. Accumulated depreciation is a
 * contra-asset: `asset`, carrying a credit balance, since the type enum has no contra member.
 */
export const STARTER_ACCOUNTS_BY_SETTING: Readonly<Record<FinanceAccountCodeKey, StarterAccount>> = {
  cashAccountCode: { code: "1000", name: "Cash and bank", accountType: "asset" },
  arAccountCode: { code: "1100", name: "Accounts receivable", accountType: "asset" },
  inventoryAccountCode: { code: "1200", name: "Inventory", accountType: "asset" },
  taxInputAccountCode: { code: "1300", name: "Input tax recoverable", accountType: "asset" },
  whtReceivableAccountCode: { code: "1310", name: "Withholding tax receivable", accountType: "asset" },
  taxRecoverableAccountCode: { code: "1320", name: "Income tax recoverable", accountType: "asset" },
  accumulatedDepreciationAccountCode: { code: "1590", name: "Accumulated depreciation", accountType: "asset" },
  apAccountCode: { code: "2000", name: "Accounts payable", accountType: "liability" },
  grniAccountCode: { code: "2100", name: "Goods received not invoiced", accountType: "liability" },
  taxPayableAccountCode: { code: "2200", name: "Output tax payable", accountType: "liability" },
  whtPayableAccountCode: { code: "2210", name: "Withholding tax payable", accountType: "liability" },
  revenueAccountCode: { code: "4000", name: "Sales revenue", accountType: "revenue" },
  fxGainLossAccountCode: { code: "4900", name: "Realized foreign exchange gain/loss", accountType: "revenue" },
  unrealizedFxGainLossAccountCode: {
    code: "4910",
    name: "Unrealized foreign exchange gain/loss",
    accountType: "revenue",
  },
  cogsAccountCode: { code: "5000", name: "Cost of goods sold", accountType: "expense" },
  inventoryVarianceAccountCode: {
    code: "5100",
    name: "Inventory and purchase price variance",
    accountType: "expense",
  },
  expenseAccountCode: { code: "6000", name: "Operating expenses", accountType: "expense" },
  depreciationExpenseAccountCode: { code: "6500", name: "Depreciation expense", accountType: "expense" },
};

/**
 * Accounts no setting names. Nothing posts to them automatically — there is no year-end close and no
 * opening-balance import — and they are in the chart because a workspace needs somewhere to post its
 * opening balances by manual journal entry, and a fixed-asset cost beside its accumulated
 * depreciation.
 */
export const STARTER_ACCOUNTS_WITHOUT_SETTING: readonly StarterAccount[] = [
  { code: "1500", name: "Property and equipment", accountType: "asset" },
  { code: "3000", name: "Owner's equity", accountType: "equity" },
  { code: "3100", name: "Retained earnings", accountType: "equity" },
];

/** The whole chart in code order. */
export const STARTER_CHART: readonly StarterAccount[] = [
  ...Object.values(STARTER_ACCOUNTS_BY_SETTING),
  ...STARTER_ACCOUNTS_WITHOUT_SETTING,
].sort((a, b) => a.code.localeCompare(b.code));

/** A starter account the write path refused, with the handler's own answer. */
export interface StarterAccountRefusal {
  readonly code: string;
  readonly status: number;
  readonly error: string;
}

/**
 * Why a setting was left unset. Mostly: its chart code has an account this run did not create, and
 * that account does not serve the setting (`absent` is the other case — the account was there and is
 * gone by the second read). A tenant that built its own chart may hold a
 * code under another numbering scheme — `4000` as an expense, `1100` as a bank account — and
 * pointing `revenueAccountCode` at it would post every invoice's revenue there, in entries that
 * balance, where leaving it unset keeps the honest refusal.
 */
export const STARTER_SETTING_SKIP_REASONS = [
  "type_mismatch",
  "archived",
  "not_postable",
  "duplicated",
  "absent",
] as const;
export type StarterSettingSkipReason = (typeof STARTER_SETTING_SKIP_REASONS)[number];

export interface StarterSettingSkip {
  readonly key: FinanceAccountCodeKey;
  readonly code: string;
  readonly reason: StarterSettingSkipReason;
}

/** A setting in effect whose code names no account, so a posting that reads it is refused. */
export interface StarterSettingDangling {
  readonly key: FinanceAccountCodeKey;
  readonly code: string;
}

/**
 * What a provisioning did.
 * - `complete`: every finance account setting is set and names an account that exists — and where
 *   this run chose it, exactly one active, postable account of the chart's type — so the first
 *   invoice, bill and payment post. A code an admin chose is checked for existence only.
 * - `partial`: some accounts or settings are in place and the rest are listed — refused creates,
 *   settings left unset (`settingsSkipped`), or settings naming no account (`settingsDangling`).
 * - `refused`: nothing existed and every create was refused, so running again gives the same answer
 *   until whatever refused it changes (a 403 names the role this deployment writes as).
 * - `not_served`: this deployment serves no `LedgerAccount` create, so nothing was attempted.
 * - `duplicates_present`: more accounts carry chart codes than a duplicate-free chart can hold, so
 *   nothing was written — the duplicates have to be resolved first, and running again does not help.
 * - `settings_unwritten`: the accounts are as listed and the settings could not be written
 *   (`settingsError` names why); a `SettingsRowUnreadable` needs the stored settings replaced first.
 *
 * `failed` is the caller's arm and never this function's: a throw out of a write.
 */
export const STARTER_CHART_OUTCOMES = [
  "complete",
  "partial",
  "refused",
  "not_served",
  "duplicates_present",
  "settings_unwritten",
] as const;
export type StarterChartOutcome = (typeof STARTER_CHART_OUTCOMES)[number];

/**
 * What the run did about `finance.taxRemittancePosting` (ADR-0467). A new workspace gets
 * `on_mark_paid`, because it has no manually journalled remittances a posting would duplicate; the
 * skips are the cases where that reasoning does not hold or the posting could not serve the tenant.
 * - `filled`: this run set it to `on_mark_paid`.
 * - `already_set`: an admin (or an earlier run) chose a mode, which is never replaced.
 * - `skipped_existing_tenant`: the caller did not ask for the mode, because this run is not a new
 *   workspace's first provisioning (the console's starter-chart route on a tenant already serving).
 *   An existing tenant may be journalling its remittances by hand as ADR-0466 told it to, so only
 *   its admin may switch posting on.
 * - `skipped_returns_outstanding`: a return is already `filed` or `amended`, or `paid` with no
 *   remittance recorded here, so its remittance may have been journalled by hand; posting it again
 *   on `mark_paid` would count it twice.
 * - `skipped_functional_currency_undeclared`: no `defaults.currency`, so every remittance would be
 *   refused `functional_currency_undeclared` anyway.
 * - `skipped_unwired`: this deployment's manifest cannot post a remittance, so the mode would govern
 *   nothing.
 */
export const STARTER_REMITTANCE_POSTING_OUTCOMES = [
  "filled",
  "already_set",
  "skipped_existing_tenant",
  "skipped_returns_outstanding",
  "skipped_functional_currency_undeclared",
  "skipped_unwired",
] as const;
export type StarterRemittancePosting = (typeof STARTER_REMITTANCE_POSTING_OUTCOMES)[number];

export interface StarterChartReport {
  readonly outcome: StarterChartOutcome;
  readonly version: string;
  /** Codes this run created. */
  readonly created: readonly string[];
  /** Chart codes the tenant already had an account for, which were left as they are. */
  readonly existing: readonly string[];
  readonly refused: readonly StarterAccountRefusal[];
  /**
   * Finance settings this run pointed at a chart account. Only keys that were unset, and only at an
   * account that exists and serves the setting: a setting naming a code with no account would turn
   * the honest "set the finance account codes" refusal into one whose remedy reads as already done.
   */
  readonly settingsFilled: readonly FinanceAccountCodeKey[];
  /**
   * `null` when the run ended before the settings write, so nothing was decided about the mode — or
   * when a requested mode was not written and the read-back saying why failed.
   */
  readonly remittancePosting: StarterRemittancePosting | null;
  /** Unset settings this run left unset, with why. */
  readonly settingsSkipped: readonly StarterSettingSkip[];
  /**
   * Settings in effect — chosen by hand or filled — whose code names no account. `null` when the
   * check could not run, which is not the same as having found none.
   */
  readonly settingsDangling: readonly StarterSettingDangling[] | null;
  /** The error's name when the settings could not be written; absent otherwise. */
  readonly settingsError?: string;
}

export interface EnsureStarterChartInput {
  readonly access: SystemEntityAccess;
  readonly tenantId: string;
  readonly actor: SystemActor;
  /** `get` reads the currency and the mode the posting decision turns on; the fill is the one write. */
  readonly settings: FinanceAccountCodeFiller & Pick<SettingsStore, "get">;
  /** Recorded as the settings row's `updated_by`: the operator whose act caused this. */
  readonly updatedBy: string | null;
  /**
   * This deployment's remittance wiring (`taxRemittanceWiring(manifest)`); absent or `null` leaves
   * the mode unset and reports `skipped_unwired`, because the drain for outstanding returns needs the
   * lifecycle's state field and a mode on a manifest that cannot post governs nothing.
   */
  readonly taxRemittance?: TaxRemittanceWiring | null;
  /**
   * Whether this run may set `on_mark_paid`: true only for a new workspace's first provisioning (an
   * approved access request), false for a run on an existing tenant, which reports
   * `skipped_existing_tenant`. Required, because the safe answer depends on the caller and a default
   * either way would be wrong for one of the two.
   */
  readonly requestRemittancePosting: boolean;
}

/**
 * Returns past this are read as outstanding rather than counted: a tenant that has paid this many
 * is not a new workspace. Paid returns are read too, since one paid with no remittance stamped here
 * was remitted by a manual journal.
 */
const OUTSTANDING_RETURN_READ_CEILING = 1000;
const OUTSTANDING_RETURN_STATES = ["filed", "amended", "paid"] as const;

/** More rows than this for the chart's codes means duplicates on a store that does not enforce uniqueness. */
const EXISTING_READ_CEILING = 1000;

/**
 * Creates the chart accounts this tenant lacks and points its unset finance settings at them.
 * Idempotent: an account whose code exists is left alone (whatever its name, since the tenant may
 * have renamed it), and a setting already chosen is never replaced, so a second run after a partial
 * first one finishes the job and a run on a configured tenant changes nothing.
 *
 * Every account is written **through the create handler** as a system actor, so it meets the same
 * validation, defaults (an omitted `currency` takes the tenant's default currency), grants and audit
 * row a person's create does. That is why this cannot share the approval's transaction: the handler
 * opens its own.
 *
 * The codes are read **twice**. Before the writes, so a code the tenant has is not recreated — on the
 * document store uniqueness depends on an index a one-shot step builds (ADR-0423), so a 409 cannot be
 * relied on. And after, so what the settings point at is what exists then, not what the writes
 * implied: a 409 on another unique field, or an account removed between the two, would otherwise
 * point a setting at a code with no account.
 */
export async function ensureStarterChart(input: EnsureStarterChartInput): Promise<StarterChartReport> {
  const empty = {
    version: STARTER_CHART_VERSION,
    created: [],
    existing: [],
    refused: [],
    settingsFilled: [],
    remittancePosting: null,
    settingsSkipped: [],
    settingsDangling: null,
  };
  if (!input.access.serves(STARTER_CHART_ENTITY, "create")) return { outcome: "not_served", ...empty };
  const access = input.access.forTenant(input.tenantId, input.actor);
  const chartCodes = STARTER_CHART.map((a) => a.code);

  const before = await readByCode(access, chartCodes);
  if (before === "duplicates_present") return { outcome: "duplicates_present", ...empty };

  const created: string[] = [];
  const attempted: { code: string; result: SystemWriteResult }[] = [];
  for (const account of STARTER_CHART) {
    if (before.has(account.code)) continue;
    const result = await access.create(STARTER_CHART_ENTITY, {
      account_code: account.code,
      name: account.name,
      account_type: account.accountType,
    });
    if (result.kind === "written") created.push(account.code);
    else attempted.push({ code: account.code, result });
  }

  const after = await readByCode(access, chartCodes);
  const existing = chartCodes.filter((code) => before.has(code));
  const refused: StarterAccountRefusal[] = [];
  for (const { code, result } of attempted) {
    if (result.kind === "written") continue;
    // Another writer created the code after the first read: it exists, which is what this run
    // wanted. Decided by the second read and not by the 409's error, which does not say which
    // unique field conflicted — so with no second read to ask, it stays a refusal.
    if (result.status === 409 && result.error === "unique_violation" && after !== "duplicates_present" && after.has(code)) {
      existing.push(code);
    } else refused.push({ code, status: result.status, error: result.error });
  }
  if (after === "duplicates_present") {
    return { ...empty, outcome: "duplicates_present", created, existing: sortCodes(existing), refused };
  }

  const createdSet = new Set(created);
  const refusedSet = new Set(refused.map((r) => r.code));
  const codes: Partial<Record<FinanceAccountCodeKey, string>> = {};
  const skipped: StarterSettingSkip[] = [];
  for (const [key, account] of Object.entries(STARTER_ACCOUNTS_BY_SETTING) as [FinanceAccountCodeKey, StarterAccount][]) {
    const rows = after.get(account.code) ?? [];
    if (rows.length === 0) {
      // A refusal is already reported; a code that was there (read first, or created here) and is
      // gone by the second read was removed in between, and leaving its setting out silently would
      // let the run read as complete with the setting unset.
      if (!refusedSet.has(account.code)) skipped.push({ key, code: account.code, reason: "absent" });
      continue;
    }
    const reason = rows.length > 1 ? "duplicated" : createdSet.has(account.code) ? null : unusable(rows[0]!, account);
    if (reason === null) codes[key] = account.code;
    else skipped.push({ key, code: account.code, reason });
  }

  const settingsUnwritten = (err: unknown): StarterChartReport => ({
    ...empty,
    outcome: "settings_unwritten",
    created,
    existing: sortCodes(existing),
    refused,
    settingsError: err instanceof Error ? err.name : "unknown",
  });

  // The settings read and the fill are the settings arm; the read of outstanding returns sits
  // between them and outside it, so a failing entity read is not reported as a settings failure.
  const wiring = input.taxRemittance ?? null;
  let decision: StarterRemittancePosting | "requested" = "skipped_unwired";
  if (wiring !== null && input.access.serves(wiring.entity, "create")) {
    try {
      decision = remittancePostingFromSettings(await input.settings.get(input.tenantId));
    } catch (err) {
      return settingsUnwritten(err);
    }
    if (decision === "requested" && !input.requestRemittancePosting) decision = "skipped_existing_tenant";
    if (decision === "requested" && (await returnsOutstanding(access, wiring))) {
      decision = "skipped_returns_outstanding";
    }
  }

  let fill: FinanceAccountCodeFill;
  try {
    const request: FinanceSettingsFillRequest =
      decision === "requested" ? { ...codes, taxRemittancePosting: "on_mark_paid" } : codes;
    fill = await input.settings.fillUnsetFinanceAccountCodes(input.tenantId, request, input.updatedBy);
  } catch (err) {
    return settingsUnwritten(err);
  }
  let remittancePosting: StarterRemittancePosting | null =
    decision !== "requested" ? decision : fill.filled.includes("taxRemittancePosting") ? "filled" : null;
  if (decision === "requested" && remittancePosting === null) {
    // The fill committed, so a failure to read back why it left the mode is not a settings failure:
    // the mode stays undecided in the report rather than the whole write reading as lost.
    try {
      remittancePosting = remittancePostingRefusedAtLock(await input.settings.get(input.tenantId));
    } catch {
      remittancePosting = null;
    }
  }
  // A skipped key an admin has since set is no longer this run's to report.
  const settingsSkipped = skipped.filter((s) => fill.inEffect[s.key] === undefined);
  const settingsDangling = await danglingSettings(access, fill.inEffect, after);

  const nothingInPlace = created.length === 0 && existing.length === 0;
  const everySettingSet = FINANCE_ACCOUNT_CODE_KEYS.every((key) => fill.inEffect[key] !== undefined);
  const outcome: StarterChartOutcome =
    nothingInPlace && refused.length > 0
      ? "refused"
      : refused.length === 0 &&
          settingsSkipped.length === 0 &&
          everySettingSet &&
          settingsDangling !== null &&
          settingsDangling.length === 0
        ? "complete"
        : "partial";
  return {
    outcome,
    version: STARTER_CHART_VERSION,
    created,
    existing: sortCodes(existing),
    refused,
    settingsFilled: fill.filled.filter((key): key is FinanceAccountCodeKey => key !== "taxRemittancePosting"),
    remittancePosting,
    settingsSkipped,
    settingsDangling,
  };
}

type TenantAccess = ReturnType<SystemEntityAccess["forTenant"]>;

/**
 * Whether to ask the fill for `on_mark_paid`, as far as the settings say. Read before the fill so a
 * tenant whose mode is chosen, or that has no currency, is answered without reading its returns; the
 * fill re-checks both under the store's lock, since an admin may change either in between.
 */
function remittancePostingFromSettings(settings: TenantSettings): StarterRemittancePosting | "requested" {
  if (settings.finance?.taxRemittancePosting !== undefined) return "already_set";
  if (functionalCurrencyOf(settings) === null) return "skipped_functional_currency_undeclared";
  return "requested";
}

async function returnsOutstanding(access: TenantAccess, wiring: TaxRemittanceWiring): Promise<boolean> {
  try {
    const rows = await access.readAll(
      wiring.entity,
      { filters: [{ field: wiring.stateField, op: "in", value: [...OUTSTANDING_RETURN_STATES] }] },
      { ceiling: OUTSTANDING_RETURN_READ_CEILING, computing: "the tax returns already filed" },
    );
    return rows.some((r) => {
      if (r[wiring.stateField] !== "paid") return true;
      const stamped = r["remitted_at"];
      return stamped === undefined || stamped === null || stamped === "";
    });
  } catch (err) {
    // More rows than the ceiling is more outstanding returns, which is the same answer.
    if (err instanceof ReadCeilingExceeded) return true;
    throw err;
  }
}

/**
 * Why a requested mode was not written: the lock saw it set, or saw no currency. Read back rather
 * than inferred, so the report names the cause the tenant can act on. Both clear between the lock
 * and this read only if an admin set and then removed them; that reads as `already_set`, the answer
 * that claims nothing about the tenant's books.
 */
function remittancePostingRefusedAtLock(settings: TenantSettings): StarterRemittancePosting {
  if (settings.finance?.taxRemittancePosting !== undefined) return "already_set";
  return functionalCurrencyOf(settings) === null ? "skipped_functional_currency_undeclared" : "already_set";
}

/** The tenant's accounts carrying these codes, grouped by code. */
async function readByCode(
  access: TenantAccess,
  codes: readonly string[],
): Promise<Map<string, EntityRecord[]> | "duplicates_present"> {
  let rows: readonly EntityRecord[];
  try {
    rows = await access.readAll(
      STARTER_CHART_ENTITY,
      { filters: [{ field: "account_code", op: "in", value: [...codes] }] },
      { ceiling: EXISTING_READ_CEILING, computing: "the starter chart's existing accounts" },
    );
  } catch (err) {
    if (err instanceof ReadCeilingExceeded) return "duplicates_present";
    throw err;
  }
  const byCode = new Map<string, EntityRecord[]>();
  for (const row of rows) {
    const code = String(row["account_code"] ?? "");
    byCode.set(code, [...(byCode.get(code) ?? []), row]);
  }
  return byCode;
}

/** Why an existing account does not serve the setting its code would fill, or `null` if it does. */
function unusable(row: EntityRecord, account: StarterAccount): StarterSettingSkipReason | null {
  if (row["account_type"] !== account.accountType) return "type_mismatch";
  if (row["status"] !== undefined && row["status"] !== "active") return "archived";
  if (row["is_postable"] === false) return "not_postable";
  return null;
}

/**
 * The settings in effect whose code names no account. Codes outside the chart — an admin's own
 * scheme — are read once more; a failure to read them answers `null` rather than "none", since a
 * check that did not run must not read as a clean one.
 */
async function danglingSettings(
  access: TenantAccess,
  inEffect: Readonly<Partial<Record<FinanceAccountCodeKey, string>>>,
  chart: ReadonlyMap<string, readonly EntityRecord[]>,
): Promise<readonly StarterSettingDangling[] | null> {
  const entries = Object.entries(inEffect) as [FinanceAccountCodeKey, string][];
  const others = [...new Set(entries.map(([, code]) => code).filter((code) => !chart.has(code)))];
  let present: ReadonlySet<string> = new Set(chart.keys());
  if (others.length > 0) {
    try {
      const more = await readByCode(access, others);
      if (more === "duplicates_present") return null;
      present = new Set([...present, ...more.keys()]);
    } catch {
      return null;
    }
  }
  return entries
    .filter(([, code]) => !present.has(code))
    .map(([key, code]) => ({ key, code }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function sortCodes(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => a.localeCompare(b));
}
