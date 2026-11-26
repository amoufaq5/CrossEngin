import { drainList, ReadCeilingExceeded } from "./list-drain.js";
import { PostingRefused } from "./posting-period.js";
import type { EntityRecord, EntityStore } from "./store.js";

/**
 * Tax determination from the tenant's declared jurisdiction: which tax code a document line carries,
 * and at what rate, as the jurisdiction's `TaxRule`s state it on the document's date.
 *
 * It runs only when the tenant names a jurisdiction (`finance.defaultTaxJurisdiction`, a
 * `TaxJurisdiction.code`). That setting was read by nothing before this, so a deployment that never
 * set it posts exactly as it did: every line's code at face value, at the code's own rate. A tenant
 * that set it declared that its tax is the jurisdiction's, and from then on a posting that cannot be
 * reconciled with the jurisdiction's rules is refused rather than posted at face value — with one
 * exception that is a gap and not a decision: a document with no lines has no code to determine, and
 * its header split still posts at face value, whatever tax it states.
 *
 * What the declared fields express, and so what is implemented:
 * - a rule applies to a document when its jurisdiction is the tenant's, its `applies_to` is the
 *   document's side or `both`, and the document's date is within `effective_from`..`effective_to`
 *   (both inclusive; an absent `effective_to` is open);
 * - a line's explicit code must have an applicable rule, and the rule's `rate_pct` is the rate — the
 *   rule is the dated statement, so a back-dated document is taxed at the rate in force on its date;
 * - a line with no code and no flat rate takes the code of the one applicable `standard` rule whose
 *   code is not a withholding code (`TaxCode.kind`): an uncoded line is ordinary tax, and
 *   `rate_category` defaults to `standard`, so a withholding rule written with the defaults would
 *   otherwise read as a second standard rule;
 * - `reverse_charge` on the sales side means the seller charges nothing (rate 0); on the purchase side
 *   it means the buyer self-assesses: the tax is outside the document total and is posted as input
 *   tax against a matching output-tax credit, so the pair nets to zero.
 *
 * What they do not express, and so is not invented: `priority` declares precedence but not its
 * direction, so two applicable rules that disagree are refused as ambiguous rather than ranked;
 * `is_compound` needs a second tax on the same line to compound on, and a line carries one code, so
 * it is the simple rate here; `tax_regime` and `rate_category` other than `standard` describe a rule
 * for filing and choose nothing a line could not choose by naming its code.
 */
export const TAX_SIDES = ["sales", "purchase"] as const;
export type TaxSide = (typeof TAX_SIDES)[number];

export interface TaxDeterminationConfig {
  readonly side: TaxSide;
  /** The document field carrying the tax-point date (`issue_date`, `bill_date`). */
  readonly dateField: string;
  /** The tenant's declared jurisdiction code, or undefined when it declared none. */
  readonly resolveJurisdictionCode: (tenantId: string) => Promise<string | undefined>;
  /**
   * Purchase side: the account a self-assessed (reverse-charge) tax is credited to, and the tenant's
   * code for it. A sales-side rule never self-assesses, so a sales config needs neither.
   */
  readonly selfAssessedAccountRef?: string;
  readonly resolveSelfAssessedAccountCode?: (tenantId: string) => Promise<string | undefined>;
  readonly jurisdictionEntity?: string;
  readonly ruleEntity?: string;
  readonly codeEntity?: string;
  /** TaxCode field carrying its kind, and the value that marks a withholding code. */
  readonly codeKindField?: string;
  readonly withholdingKind?: string;
  /** The largest rule set read for one jurisdiction; reaching it refuses rather than deciding. */
  readonly maxRules?: number;
}

const DETERMINATION_FALLBACKS = {
  jurisdictionEntity: "TaxJurisdiction",
  ruleEntity: "TaxRule",
  codeEntity: "TaxCode",
  codeKindField: "kind",
  withholdingKind: "withholding",
  maxRules: 10_000,
} as const;

export interface TaxRuleFacts {
  readonly id: string;
  readonly taxCodeId: string;
  readonly appliesTo: "sales" | "purchase" | "both";
  readonly rateCategory: string;
  readonly ratePct: number;
  readonly reverseCharge: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface DeterminationLine {
  readonly net: number;
  readonly taxCodeId: string | null;
  readonly flatRatePct: number | null;
}

export interface DeterminedCodeRate {
  readonly rate: number;
  /** Purchase-side reverse charge: outside the document total, posted as a balancing pair. */
  readonly selfAssessed: boolean;
}

export type DocumentTaxDetermination =
  | { readonly kind: "off" }
  | {
      readonly kind: "determined";
      readonly jurisdictionCode: string;
      readonly date: string;
      /** The input lines, with a code assigned where the standard rule supplied one. */
      readonly lines: readonly DeterminationLine[];
      readonly rates: ReadonlyMap<string, DeterminedCodeRate>;
    };

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function calendarDate(v: unknown): string | null {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  return v.slice(0, 10);
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Reads one stored rule, or null when it carries no usable code, side, rate or start date. */
export function taxRuleFacts(row: EntityRecord): TaxRuleFacts | null {
  const id = row["id"];
  const code = row["tax_code_id"];
  const appliesTo = row["applies_to"] ?? "sales";
  const rate = finiteNumber(row["rate_pct"] ?? 0);
  const from = calendarDate(row["effective_from"]);
  const toRaw = row["effective_to"];
  const to = toRaw === undefined || toRaw === null || toRaw === "" ? null : calendarDate(toRaw);
  if (typeof id !== "string" || typeof code !== "string" || code.length === 0) return null;
  if (appliesTo !== "sales" && appliesTo !== "purchase" && appliesTo !== "both") return null;
  // `rate_pct` is declared `min: 0, max: 100`, which nothing enforces on write; a rate outside it is
  // not a rate this rule can be taken to state.
  if (rate === null || rate < 0 || rate > 100 || from === null) return null;
  if (toRaw !== undefined && toRaw !== null && toRaw !== "" && to === null) return null;
  return {
    id,
    taxCodeId: code,
    appliesTo,
    rateCategory: typeof row["rate_category"] === "string" ? (row["rate_category"] as string) : "standard",
    ratePct: rate,
    reverseCharge: row["reverse_charge"] === true,
    effectiveFrom: from,
    effectiveTo: to,
  };
}

/** The rules in force for one side on one date. */
export function applicableTaxRules(
  rules: readonly TaxRuleFacts[],
  side: TaxSide,
  date: string,
): readonly TaxRuleFacts[] {
  return rules.filter(
    (r) =>
      (r.appliesTo === side || r.appliesTo === "both") &&
      r.effectiveFrom <= date &&
      (r.effectiveTo === null || date <= r.effectiveTo),
  );
}

function refused(status: number, error: string, detail: string): PostingRefused {
  return new PostingRefused(status, error, detail);
}

/**
 * Pure: assigns codes and rates to `lines` from the rules applicable on `date`, or throws the refusal.
 * `codeLabel` names a code id in a refusal (the tenant's own `TaxCode.code`); `mayDefault` says whether a
 * code may be given to a line that names none (absent: every code may).
 */
export function determineLines(input: {
  readonly lines: readonly DeterminationLine[];
  readonly applicable: readonly TaxRuleFacts[];
  readonly side: TaxSide;
  readonly jurisdictionCode: string;
  readonly date: string;
  readonly codeLabel: (codeId: string) => string;
  readonly mayDefault?: (codeId: string) => boolean;
  /**
   * Whether a code is a withholding code (`TaxCode.kind`). **Required**, because the one decision it
   * drives — refusing a reverse-charge rule over a withholding code — is the kind an optional input
   * defaulting to "not withholding" would silently skip.
   */
  readonly isWithholding: (codeId: string) => boolean;
}): { readonly lines: readonly DeterminationLine[]; readonly rates: ReadonlyMap<string, DeterminedCodeRate> } {
  const { applicable, side, jurisdictionCode, date } = input;
  const mayDefault = input.mayDefault ?? (() => true);
  const standardCodes = [
    ...new Set(applicable.filter((r) => r.rateCategory === "standard" && mayDefault(r.taxCodeId)).map((r) => r.taxCodeId)),
  ];
  const lines = input.lines.map((line): DeterminationLine => {
    if (line.taxCodeId !== null) return line;
    if (line.flatRatePct !== null && line.flatRatePct > 0) return line;
    if (standardCodes.length === 0) return line;
    if (standardCodes.length > 1) {
      throw refused(
        409,
        "tax_rule_ambiguous",
        `a line names no tax code, and jurisdiction '${jurisdictionCode}' has ${standardCodes.length.toString()} ` +
          `standard rules in force for ${side} on ${date} with different codes; name the line's code, or ` +
          `end-date all but one of them`,
      );
    }
    return { ...line, taxCodeId: standardCodes[0]! };
  });
  const rates = new Map<string, DeterminedCodeRate>();
  for (const line of lines) {
    const code = line.taxCodeId;
    if (code === null || rates.has(code)) continue;
    const forCode = applicable.filter((r) => r.taxCodeId === code);
    if (forCode.length === 0) {
      throw refused(
        422,
        "tax_code_not_applicable",
        `tax code '${input.codeLabel(code)}' has no rule in jurisdiction '${jurisdictionCode}' for ${side} ` +
          `in force on ${date}`,
      );
    }
    const outcomes = new Set(forCode.map((r) => `${r.ratePct.toString()}|${String(r.reverseCharge)}`));
    if (outcomes.size > 1) {
      throw refused(
        409,
        "tax_rule_ambiguous",
        `tax code '${input.codeLabel(code)}' has ${forCode.length.toString()} rules in jurisdiction ` +
          `'${jurisdictionCode}' in force for ${side} on ${date} that disagree on the rate or the reverse ` +
          `charge; end-date all but one of them`,
      );
    }
    const rule = forCode[0]!;
    // A reverse charge moves who accounts for a *consumption* tax: the seller charges none, the buyer
    // self-assesses. Withholding is not that — it is the payer keeping back part of the price for the
    // authority — so reading a withholding code's reverse-charge rule as rate 0 (sales) or
    // self-assessed (purchase) dropped the withholding with nothing saying so (ADR-0466 Q5). There is
    // no reading of the pair this module could post honestly, so it refuses before anything is
    // written: the effect throws inside the document's transaction and the write rolls back.
    if (rule.reverseCharge && input.isWithholding(code)) {
      throw refused(
        409,
        "tax_rule_reverse_charge_withholding",
        `tax code '${input.codeLabel(code)}' is a withholding code, and its rule in jurisdiction '${jurisdictionCode}' ` +
          `in force for ${side} on ${date} is marked reverse_charge; a reverse charge does not apply to withholding, ` +
          `so clear reverse_charge on that rule or give the line a non-withholding code`,
      );
    }
    if (rule.reverseCharge) {
      rates.set(code, side === "sales" ? { rate: 0, selfAssessed: false } : { rate: rule.ratePct, selfAssessed: true });
    } else {
      rates.set(code, { rate: rule.ratePct, selfAssessed: false });
    }
  }
  return { lines, rates };
}

/**
 * The one active jurisdiction carrying `code` in this tenant, or `null` when none, several, or only an
 * inactive one does. The single reading of `finance.defaultTaxJurisdiction`: the determination asks
 * it at posting time and the settings write asks it at save time (ADR-0480), so a value the save
 * admitted is one the posting resolves.
 */
export async function resolveTaxJurisdiction(
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  code: string,
  jurisdictionEntity: string = DETERMINATION_FALLBACKS.jurisdictionEntity,
): Promise<EntityRecord | null> {
  const page = await store.listPage(tenantId, jurisdictionEntity, {
    filters: [{ field: "code", op: "eq", value: code }],
    sort: [],
    limit: 2,
    cursor: null,
  });
  const matches = page.records.filter((r) => r["code"] === code);
  const jurisdiction = matches.length === 1 ? matches[0]! : null;
  if (jurisdiction === null || jurisdiction["is_active"] === false || typeof jurisdiction["id"] !== "string") return null;
  return jurisdiction;
}

/**
 * Reads the tenant's jurisdiction and its rules and determines `lines`. `off` when the tenant declared
 * no jurisdiction; a refusal (thrown) when it declared one this tenant does not have, or a line cannot
 * be determined. Reads only — nothing is written, so a refusal leaves the document as it was.
 */
export async function determineDocumentTax(input: {
  readonly store: Pick<EntityStore, "listPage" | "get">;
  readonly tenantId: string;
  readonly document: EntityRecord;
  readonly lines: readonly DeterminationLine[];
  readonly config: TaxDeterminationConfig;
  readonly today: string;
}): Promise<DocumentTaxDetermination> {
  const c = { ...DETERMINATION_FALLBACKS, ...input.config };
  const declared = (await c.resolveJurisdictionCode(input.tenantId))?.trim();
  if (declared === undefined || declared.length === 0) return { kind: "off" };

  const jurisdiction = await resolveTaxJurisdiction(input.store, input.tenantId, declared, c.jurisdictionEntity);
  if (jurisdiction === null) {
    throw refused(
      409,
      "tax_jurisdiction_unresolved",
      `the tenant's default tax jurisdiction '${declared}' names no single active ${c.jurisdictionEntity} in this tenant, ` +
        `so the tax on this document cannot be determined; create it, or correct or clear ` +
        `finance.defaultTaxJurisdiction (PUT /v1/admin/settings)`,
    );
  }
  const jurisdictionId = jurisdiction["id"] as string;

  const rules: TaxRuleFacts[] = [];
  let unreadable = 0;
  const outcome = await drainList(
    input.store,
    input.tenantId,
    c.ruleEntity,
    { sort: [], filters: [{ field: "jurisdiction_id", op: "eq", value: jurisdictionId }] },
    { ceiling: c.maxRules },
    (rows) => {
      for (const row of rows) {
        if (row["jurisdiction_id"] !== jurisdictionId) continue;
        const facts = taxRuleFacts(row);
        if (facts === null) unreadable += 1;
        else rules.push(facts);
      }
    },
  );
  if (!outcome.complete) throw new ReadCeilingExceeded(c.ruleEntity, c.maxRules, "a document's tax determination");
  if (unreadable > 0) {
    throw refused(
      409,
      "tax_rule_unreadable",
      `${unreadable.toString()} ${c.ruleEntity} row(s) of jurisdiction '${declared}' carry no usable code, side, ` +
        `rate or effective dates, and any of them could be the rule in force; correct them`,
    );
  }

  const date = calendarDate(input.document[c.dateField]) ?? input.today;
  const applicable = applicableTaxRules(rules, c.side, date);

  const codeRows = new Map<string, EntityRecord | null>();
  const codeLabel = (id: string): string => {
    const label = codeRows.get(id)?.["code"];
    return typeof label === "string" && label.length > 0 ? label : id;
  };
  for (const id of new Set([...input.lines.map((l) => l.taxCodeId), ...applicable.map((r) => r.taxCodeId)])) {
    if (id !== null) codeRows.set(id, await input.store.get(input.tenantId, c.codeEntity, id));
  }
  const determined = determineLines({
    lines: input.lines,
    applicable,
    side: c.side,
    jurisdictionCode: declared,
    date,
    codeLabel,
    mayDefault: (id) => codeRows.get(id)?.[c.codeKindField] !== c.withholdingKind,
    isWithholding: (id) => codeRows.get(id)?.[c.codeKindField] === c.withholdingKind,
  });
  for (const code of determined.rates.keys()) {
    const row = codeRows.get(code);
    if (row === null || row === undefined || row["is_active"] === false) {
      throw refused(
        422,
        "tax_code_not_applicable",
        `tax code '${codeLabel(code)}' is ${row === null || row === undefined ? "missing" : "inactive"}, so it ` +
          `cannot tax a document dated ${date}`,
      );
    }
  }
  return { kind: "determined", jurisdictionCode: declared, date, lines: determined.lines, rates: determined.rates };
}
