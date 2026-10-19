/**
 * What a multi-row Postgres read does with a row its contract refuses.
 *
 * `result.rows.map(rowToX)` is the defect. `rowToX` ends in `XSchema.parse`, and a parse failure is a
 * **finding** — ADR-0289: a row edited into a state the contract forbids and a CHECK permits is only
 * ever caught on read — so throwing it out of the array converts one row's finding into the loss of
 * every other row's. A sweep whose own purpose is to find defective rows is the sharpest member:
 * the first unrepresentable row it meets ends the sweep, and the remaining pages are never examined.
 *
 * The fix is `readRows` / `readRowsWithUnreadable` in `packages/kernel-pg/src/read-rows.ts`, which
 * carries the rule and its two legitimate answers. This rule is the fence that keeps a new multi-row
 * read from being written the old way, and keeps the sites that are *deliberately* allowed to throw
 * saying so.
 *
 * **A single-row read that throws is correct and must not be reported.** The caller asked about that
 * one row, so there is no other row's finding to lose, and refusing loudly beats answering `null` for
 * a row that exists (`IdempotencyStore.get`'s rule, ADR-0336). That distinction carries most of this
 * rule's precision and it is **structural rather than heuristic**: the anchor is a conversion applied
 * to a row *array* — `rows.map(…)`, a `for…of` over rows, or the primitive — so `rowToX(result.rows[0])`
 * is not a candidate at all. Measured on the committed tree, anchoring instead on *every* invocation
 * of a mapper would have produced 114 sites of which 63 are single-row reads doing the right thing;
 * see `REFUSED_ROW_PAGE_ANCHORS`.
 *
 * Measured on the committed tree by calling this module over it: **110 conversions over 942 source
 * files** (927 of them production sources) — 73 written as `rows.map(…)`, 24 as a `for…of`, 13
 * through the primitive — of which **30 build no contract record at all** and are excluded from the
 * fence by measurement rather than by assumption, and **67 need a declaration**: 51 that throw, 11
 * that assert a record they never parse, 3 that guard themselves and 2 that drop the row in
 * silence.
 *
 * Every one of those figures moves with every slice that migrates a store, which is why the test
 * asserts one-sided floors and not one of them — and why this paragraph was wrong within its own
 * increment, by exactly the one `rows.map` site that was migrated after it was written. Re-derive
 * them by calling the module; do not carry them.
 *
 * **Why the declarations live here.** `pg-storeless-tables.ts` argues this once and it holds
 * unchanged: a list in `packages/testing` is only ADR-0288's `needsAuditEmitter` shape if nothing
 * compares it against reality. This one is compared in **both** directions on every run — a throwing
 * site with no declaration fails, a declaration for a site that has since been migrated to the
 * primitive fails, and a declaration naming a site that does not exist fails — so it cannot be out
 * of date without going red.
 *
 * It reads the workspace **from disk**, like its ten siblings: `packages/kernel` and `packages/kernel-pg`
 * both devDepend on `@crossengin/testing`, so importing either would make the build graph cyclic, and
 * reading their `dist` would make the rule green only after `pnpm -r build` and green against a stale
 * one. A rule that is green only after a build is not a rule.
 *
 * **Fail-closed in both of its two uncertainties**, because both of this rule's mistakes are not
 * symmetric. Over-reporting costs a declaration and is visible in a diff; under-reporting makes the
 * fence quietly stop fencing, which is the shape every rule in this directory exists to refuse. So a
 * conversion whose callee this scan cannot resolve is assumed to **throw** (`unresolved_callee`), and
 * a conversion whose record type it cannot read is **reported** (`conversion_unresolved`) rather than
 * skipped.
 */
import { z } from "zod";

import { stripComments } from "./pg-column-coverage.js";
import { blankStringBodies } from "./pg-record-reads.js";
import { isTestSite } from "./pg-unreachable-stores.js";
import type { WorkspaceSourceFile } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------- scope */

/**
 * The module that **is** the mechanism, and so cannot be a member of the population it fences.
 *
 * `readRows`' own `for (const row of rows)` is the try/catch this rule exists to see written, and
 * `read-rows.ts`' doc comment contains the defect's literal spelling. Naming it rather than letting
 * the scan report it keeps the exemption visible in a diff, and the test asserts the file exists so a
 * rename cannot silently turn the exemption into a hole (`typecheck-config.ts`' treatment of its own
 * two exemptions).
 */
export const PRIMITIVE_MODULE = "packages/kernel-pg/src/read-rows.ts";

/**
 * Test surfaces, which hold their own row pages and must not be declared.
 *
 * `isTestSite` is imported rather than restated and covers `*.test.ts` and `test-*.ts`; its own doc
 * comment names what it does not reach — `fixtures.ts` under two naming conventions — and that is
 * added here rather than there, because widening a predicate three other rules depend on to suit this
 * one would change their input. Measured: without the `fixtures.ts` arm,
 * `packages/crypto-pg/src/test-fakes.ts` was already caught by `isTestSite` and
 * `access-reviews-runtime/src/fixtures.ts` was not.
 */
export function isNonProductionSource(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return isTestSite(file) || base === "fixtures.ts" || base === "test-fixtures.ts";
}

/** Every source this rule reasons about: production modules, minus the primitive's own. */
export function productionSources(
  sources: readonly WorkspaceSourceFile[],
): readonly WorkspaceSourceFile[] {
  return sources.filter((s) => !isNonProductionSource(s.file) && s.file !== PRIMITIVE_MODULE);
}

/* ------------------------------------------------------------------- source */

/**
 * Comment-stripped and string-blanked, at identical offsets.
 *
 * Both are mandatory here and the first one is not a nicety: `read-rows.ts`' own doc comment contains
 * the literal `result.rows.map(rowToX)`, and `deletion-request-store.ts`' contains
 * `result.rows.map(…)` — so a scan that believed a raw match would report the primitive's own
 * documentation as a defect and the store that already uses it as unmigrated. This directory has been
 * bitten by exactly that (ADR-0337: a widened store scan read this module's prose as a construction
 * site), and `stripComments` keeps newlines so every line number still matches the original file.
 *
 * `blankStringBodies` is needed as well and for the opposite reason: the SQL lives in template
 * literals, and a `LIMIT` inside one is what bounds the read while a `.map(` inside one would be
 * prose. Blanking keeps offsets, so the `LIMIT` test runs on the comment-stripped text and everything
 * matched as *code* runs on the blanked text — the split `entity-field-aperture.ts` arrived at for
 * the same reason.
 */
export function codeViews(text: string): { readonly declared: string; readonly code: string } {
  const declared = stripComments(text);
  return { declared, code: blankStringBodies(declared) };
}

/* --------------------------------------------------------------- vocabulary */

/** How a page of rows is turned into values. */
export const ROW_CONVERSION_SHAPES = [
  /** `rows.map(f)` / `rows.map((r) => f(r))` — the shape the primitive replaces. */
  "array_map",
  /** `for (const row of rows) { … }` — the same question, written as a loop. */
  "row_loop",
  /** `readRows` / `readRowsWithUnreadable` — the primitive. */
  "primitive",
] as const;
export type RowConversionShape = (typeof ROW_CONVERSION_SHAPES)[number];

/**
 * Why a per-row conversion can throw, in terms a reader can check.
 *
 * Five members and the splits are the load-bearing part. `zod_parse` is the one ADR-0289 is about and
 * is the overwhelming majority; `json_parse` is kept apart from it because the remedy differs — a
 * malformed JSONB text column is not a contract refusal and no `UnreadableRow.detail` derived from a
 * `ZodError` describes it. `unresolved_callee` is not an absence of evidence: it is this scan saying
 * it could not establish totality, which under the fail-closed rule above *is* throw evidence, and
 * naming it separately is what keeps a coverage loss from reading as a defect.
 */
export const THROW_EVIDENCE_KINDS = [
  /** `XSchema.parse(` / `.parseAsync(` — the contract refusing the row (ADR-0289). */
  "zod_parse",
  /** `JSON.parse(` — a malformed JSONB or TEXT column, which is not a contract refusal. */
  "json_parse",
  /** A `throw` inside the conversion itself. */
  "explicit_throw",
  /** A callee this scan resolved, whose own body can throw. */
  "throwing_callee",
  /** A callee this scan could not resolve. Assumed throwing; see the fail-closed rule. */
  "unresolved_callee",
  /**
   * A callee that is wholly `try { … } catch { return null }`.
   *
   * **Not throw evidence — the opposite — and it is why this kind exists rather than the callee
   * simply reading as total.** Such a conversion keeps the page and destroys the finding: the
   * refused row is dropped, nothing is told, and the caller is handed a page that is short by an
   * amount nobody can name. `readRows`' two legitimate answers are *forward the reporter* and
   * *return the pair*; a bare `catch { return null }` is neither, and a shorter page presented as a
   * complete one is ADR-0372's class exactly — an absence reported as success. Recorded so that the
   * site reads `record_dropping` rather than `record_total`, because the two want different
   * declarations: one is a mapper that asserts, this one is a mapper that discards.
   */
  "swallowing_callee",
] as const;
export type ThrowEvidenceKind = (typeof THROW_EVIDENCE_KINDS)[number];

export const ThrowEvidenceSchema = z.object({
  kind: z.enum(THROW_EVIDENCE_KINDS),
  /** The symbol the evidence is about: a schema, a callee, or `<inline>` for a bare `throw`. */
  symbol: z.string().min(1),
});
export type ThrowEvidence = z.infer<typeof ThrowEvidenceSchema>;

/**
 * What one multi-row read is.
 *
 * A total map rather than an `if`-chain, so a fifth verdict is a compile error at the one place that
 * decides whether it needs a declaration — `pg-unreachable-stores.ts`' `SYMBOL_FINDING_FOR` shape.
 */
export const PAGE_READ_VERDICTS = [
  /** The conversion goes through `readRows` / `readRowsWithUnreadable`. Nothing to declare. */
  "guarded_by_primitive",
  /**
   * The conversion carries its **own** per-row `try`/`catch` and reports the refused row.
   *
   * The same guarantee as the primitive, reached by a second spelling of it — so it is not a defect
   * and it is not nothing: ADR-0334's rule is that eight copies of one rule is where two of them
   * eventually disagree, and `readRows` exists because this shape had been written twice already.
   * Separated from `guarded_by_primitive` so the convergence backlog is countable rather than
   * invisible, and separated from `record_dropping` because *reporting* is the whole difference.
   */
  "guarded_in_place",
  /** Builds a contract-typed record and can throw. **This is the fence.** */
  "record_throwing",
  /**
   * Builds a contract-typed record and provably cannot throw.
   *
   * Not a pass: this is ADR-0362's defect read from the other end — a mapper that returns a bare
   * object literal *typed as* the contract asserts conformance rather than establishing it, so no
   * clause of that contract has ever been checked on read. It needs a declaration naming what fences
   * it instead, or declaring the gap.
   */
  "record_total",
  /**
   * Builds a contract-typed record through a conversion that catches its own refusal and answers
   * `null`, which the page then filters out.
   *
   * The page survives and the finding does not. That is the *mirror* of the defect this rule is
   * named for rather than a fix for it, and it is ranked beside it rather than under it: one refused
   * row loses every other row's finding, and this loses its own. A declaration here states who is
   * served the shortened page.
   */
  "record_dropping",
  /**
   * Produces no contract record — a column, an id, an inline pair.
   *
   * Excluded from the fence rather than passed by it, and **counted**, because a silent exclusion is
   * how a population stops being examined: `res.rows.map((r) => r.document)` has no contract to
   * refuse a row, so there is no finding available to lose.
   */
  "projection",
] as const;
export type PageReadVerdict = (typeof PAGE_READ_VERDICTS)[number];

/** Which verdicts oblige a declaration. The one place that decides. */
export const VERDICT_NEEDS_DECLARATION: Record<PageReadVerdict, boolean> = Object.freeze({
  guarded_by_primitive: false,
  guarded_in_place: true,
  record_throwing: true,
  record_total: true,
  record_dropping: true,
  projection: false,
});

/** Human sentence per verdict, for the census line an operator reads. */
export const VERDICT_DESCRIPTIONS: Record<PageReadVerdict, string> = Object.freeze({
  guarded_by_primitive: "reports the refused row and keeps the rest of the page",
  guarded_in_place: "reports the refused row and keeps the page, through its own try/catch",
  record_throwing: "one refused row takes the whole page with it",
  record_total: "asserts the contract rather than parsing it, so no clause is checked on read",
  record_dropping: "drops the refused row and tells nobody, so the page is short by an unnamed amount",
  projection: "builds no contract record, so no row can be refused",
});

/* -------------------------------------------------------------- declarations */

/**
 * Why a multi-row read is allowed to stay as it is.
 *
 * Four members, and the first split is the one that matters: three are **decisions** that should stay
 * true and `unmigrated` is the **backlog** with its cost written down — `pg-storeless-tables.ts`'
 * `static_catalog`-versus-`unbuilt_subsystem` distinction, for the same reason. Merging them would
 * hide the only one that should shrink to nothing.
 */
export const UNREADABLE_ROW_REASONS = [
  /**
   * The caller catches the throw and answers a named refusal, so the page's loss is reported rather
   * than escaping as an unclassified 500. Deliberate, documented, and the declaration must name the
   * code and the file that answers it.
   */
  "page_refusal_declared",
  /**
   * Throwing is the answer this read owes its caller, and it is not a page of records: a map keyed by
   * a business key, an invariant over the page, or a read whose single consumer cannot act on a
   * partial answer.
   */
  "page_is_indivisible",
  /**
   * The conversion cannot throw because it asserts the contract rather than parsing it — ADR-0362's
   * class. A declaration here is an admission, not an exemption, and must say what a wrong row costs.
   */
  "record_asserted_not_parsed",
  /**
   * The conversion catches its own refusal and answers `null`, and the page filters it out. The
   * declaration must name who is served the shortened page, because that is the party the silence is
   * about.
   */
  "row_dropped_deliberately",
  /**
   * **Backlog.** This read should go through the primitive and does not yet. The consequence states
   * what a refused row costs today, so the entry cannot be parked without saying what is lost.
   */
  "unmigrated",
] as const;
export type UnreadableRowReason = (typeof UNREADABLE_ROW_REASONS)[number];

/** Only a declared page refusal may name a refusal code, and it must name one, with its file. */
export const REFUSAL_BEARING_REASONS: readonly UnreadableRowReason[] = ["page_refusal_declared"];

/**
 * Only an indivisible page may name the consumer that cannot use a partial one, and it must.
 *
 * `pg-unreachable-stores.ts`' `substitutedBy` precedent: the field is what makes the reason cost
 * something a later reader can check, rather than prose nobody can refute.
 */
export const CONSUMER_BEARING_REASONS: readonly UnreadableRowReason[] = [
  "page_is_indivisible",
  "row_dropped_deliberately",
];

/**
 * Only an asserted record may name the fence that stands in for the parse, and it must name one.
 *
 * `null` is **not** permitted: a conversion that asserts a contract with nothing else checking it is
 * the defect itself, and the honest declaration then names the gap in `consequence` and writes
 * `fencedBy: "nothing"`, which this rule reports in its census rather than hiding.
 */
export const FENCE_BEARING_REASONS: readonly UnreadableRowReason[] = ["record_asserted_not_parsed"];

/**
 * Every gap must state what a deployment loses, and only a gap may.
 *
 * ADR-0317's rule — only a scope-bearing outcome may carry figures — read onto a reason set: a field
 * that may ride along on any member is a field that can be forgotten.
 */
export const COST_BEARING_REASONS: readonly UnreadableRowReason[] = [
  "record_asserted_not_parsed",
  "row_dropped_deliberately",
  "unmigrated",
];

const MEMBER_PATH = /^(?!.*\.\.)(?:packages|apps)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.tsx?$/;
const SYMBOL = /^[A-Za-z_$][\w$]*$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]*$/;

export const UnreadableRowDeclarationSchema = z
  .object({
    /** Workspace-relative, as the scan spells it. */
    file: z.string().regex(MEMBER_PATH),
    /**
     * The enclosing function or method, which is the site's stable handle.
     *
     * Deliberately **not** a line number: every slice that touches a store moves every line below it,
     * so a line-keyed declaration goes stale on an unrelated edit and the fence would be re-pointed
     * by whoever was closest. `<module>` for a conversion at module scope.
     */
    scope: z.string().min(1),
    /**
     * The conversion's own name — the mapper, or `<inline>` where the conversion is written out.
     *
     * Part of the key because a method may hold two reads of different tables, which
     * `read-state-store.ts` does: one page of read states and one of watermarks, in one method.
     *
     * **Two `<inline>` conversions in one scope therefore share a key**, which `delivery-store.ts`'
     * `claimQueued` really does — it maps its page once to ids and once to dispatches. That is safe
     * exactly while at most one of them needs a declaration, and it is safe here because the id map
     * is a `projection`; the workspace test asserts the property rather than trusting it, by
     * requiring every declaration-needing site to have a key of its own. The alternative was a line
     * number in the key, which goes stale on an edit anywhere above it.
     */
    conversion: z.string().min(1),
    reason: z.enum(UNREADABLE_ROW_REASONS),
    /** The code the caller answers with. `page_refusal_declared` only. */
    refusalCode: z.string().regex(REFUSAL_CODE).optional(),
    /** The file that answers it, asserted to contain the code. `page_refusal_declared` only. */
    refusedIn: z.string().regex(MEMBER_PATH).optional(),
    /** The consumer that cannot act on a partial page. `page_is_indivisible` only. */
    consumedBy: z.string().min(1).optional(),
    /**
     * The symbol that establishes conformance instead of the parse, or the literal `nothing`.
     * `record_asserted_not_parsed` only.
     */
    fencedBy: z.string().optional(),
    /** What a refused row costs today. The two gap reasons only. */
    consequence: z.string().min(1).optional(),
    /** The evidence: what the read is for, who reads it, why this answer is the right one. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly UnreadableRowReason[]): boolean => set.includes(value.reason);
    const pair = (
      field: "refusalCode" | "refusedIn" | "consumedBy" | "fencedBy" | "consequence",
      set: readonly UnreadableRowReason[],
      message: string,
    ): void => {
      if (wants(set) !== (value[field] !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${message} (${value.reason})` });
      }
    };
    pair("refusalCode", REFUSAL_BEARING_REASONS, "only a declared page refusal may name a refusal code, and it must name one");
    pair("refusedIn", REFUSAL_BEARING_REASONS, "a declared page refusal must name the file that answers it");
    pair("consumedBy", CONSUMER_BEARING_REASONS, "only an indivisible or row-dropping page may name its consumer, and it must name one");
    pair("fencedBy", FENCE_BEARING_REASONS, "only an asserted record may name the fence that stands in for the parse, and it must name one");
    pair("consequence", COST_BEARING_REASONS, "only a gap may state a consequence, and a gap must state one");
    if (value.fencedBy !== undefined && value.fencedBy !== "nothing" && !SYMBOL.test(value.fencedBy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fencedBy"],
        // A sentence here would be prose nobody can check; the whole point of the field is that the
        // rule looks the symbol up. `nothing` is the one admissible non-symbol, and it is an
        // admission that the census then counts.
        message: "fencedBy must be a symbol this rule can look up, or the literal 'nothing'",
      });
    }
  });
export type UnreadableRowDeclaration = z.infer<typeof UnreadableRowDeclarationSchema>;

/** `file::scope::conversion` — the site key, in one place so the two directions cannot disagree. */
export function siteKey(site: {
  readonly file: string;
  readonly scope: string;
  readonly conversion: string;
}): string {
  return `${site.file}::${site.scope}::${site.conversion}`;
}

/* -------------------------------------------------------------------- facts */

export const PageReadSiteSchema = z.object({
  file: z.string().regex(MEMBER_PATH),
  /** For a human reading the failure, never for the declaration key. */
  line: z.number().int().positive(),
  scope: z.string().min(1),
  conversion: z.string().min(1),
  shape: z.enum(ROW_CONVERSION_SHAPES),
  verdict: z.enum(PAGE_READ_VERDICTS),
  /** The contract type the conversion produces, where this scan could read it. */
  recordType: z.string().nullable(),
  evidence: z.array(ThrowEvidenceSchema),
  /**
   * Whether the statement this page comes from carries a `LIMIT`.
   *
   * Reported and deliberately **not** part of any verdict: an unbounded throwing read loses an
   * unbounded page, which is worse, but a bounded one still loses a page — so making the fence turn
   * on it would license the bounded half of the defect. It is in the census because the figure is the
   * one an operator weighing a backlog entry wants, and because a `LIMIT`-less sweep is where a
   * single refused row costs the most.
   */
  bounded: z.boolean(),
});
export type PageReadSite = z.infer<typeof PageReadSiteSchema>;

/* ----------------------------------------------------------------- findings */

export const UNREADABLE_ROW_FINDING_KINDS = [
  /** A multi-row read that can throw, with no declaration saying why. **This is the fence.** */
  "undeclared_throwing_map",
  /** A conversion asserting a contract rather than parsing it, with no declaration. */
  "undeclared_asserted_record",
  /** A conversion that drops a refused row and reports nothing, with no declaration. */
  "undeclared_dropped_row",
  /** A hand-rolled per-row guard with no declaration — the convergence backlog. */
  "unconverged_local_guard",
  /** Declared, and the site now goes through the primitive (or stopped building a record). */
  "overtaken",
  /** Declared for a site the scan cannot find — a stale key, or a renamed method. */
  "unknown_site",
  /** The same site declared twice, which would let two contradictory reasons both pass. */
  "duplicate",
  /** `page_refusal_declared` naming a file the workspace does not have. */
  "refusal_handler_missing",
  /** `page_refusal_declared` naming a code that file does not answer with. */
  "refusal_code_absent",
  /** `record_asserted_not_parsed` naming a fence symbol nothing in the workspace declares. */
  "fence_symbol_missing",
  /** A declaration whose reason contradicts the verdict the scan derived for that site. */
  "reason_contradicts_verdict",
  /**
   * A matched conversion whose record type this scan could not read.
   *
   * A finding and never a skip. The convention it depends on — a row conversion declares its return
   * type — is re-measured on every run precisely so that it cannot quietly stop holding and take the
   * population with it (`pg-binding-names.ts`' `derivation_ambiguous`, one rule across).
   */
  "conversion_unresolved",
] as const;
export type UnreadableRowFindingKind = (typeof UNREADABLE_ROW_FINDING_KINDS)[number];

export interface UnreadableRowFinding {
  readonly kind: UnreadableRowFindingKind;
  readonly site: string;
  readonly detail: string;
}

export interface UnreadableRowAuditInput {
  readonly sites: readonly PageReadSite[];
  readonly declarations: readonly UnreadableRowDeclaration[];
  /** Every workspace-relative source path, so a `refusedIn` can be checked for existence. */
  readonly files: readonly string[];
  /** `file -> text`, for the refusal-code and fence-symbol assertions. */
  readonly sources: ReadonlyMap<string, string>;
  /**
   * Named conversions over a row page whose declared return type this scan could not read.
   *
   * **Measured at zero on the committed tree, which is exactly why it is a finding rather than a
   * count in a report.** The convention it measures — a row conversion declares its return type — is
   * this repo's own (CLAUDE.md: explicit return types on exported functions) and it is what separates
   * a silent conversion that asserts a contract from one that reads a column. A convention measured
   * once goes stale in silence, so it is re-asked every run and reported when it stops holding
   * (`pg-binding-names.ts`' `derivation_ambiguous`, one rule across).
   */
  readonly unannotatedConversions: readonly string[];
}

/**
 * Which reasons may be given for which verdict.
 *
 * A total map over the verdicts, so the obligation is decided in one place and a fifth verdict is a
 * compile error here too. The content is the rule a declaration cannot talk its way around: a site
 * that provably cannot throw may not be declared a *refusal* (there is nothing to refuse) and a
 * throwing one may not be declared *asserted* — which is how a reason stops describing its site.
 */
export const REASONS_FOR_VERDICT: Record<PageReadVerdict, readonly UnreadableRowReason[]> =
  Object.freeze({
    guarded_by_primitive: [],
    guarded_in_place: ["unmigrated"],
    record_throwing: ["page_refusal_declared", "page_is_indivisible", "unmigrated"],
    record_total: ["record_asserted_not_parsed"],
    record_dropping: ["row_dropped_deliberately", "unmigrated"],
    projection: [],
  });

/** Which finding a verdict's missing declaration lands as. The one place that decides. */
const UNDECLARED_FINDING_FOR: Record<PageReadVerdict, UnreadableRowFindingKind | null> =
  Object.freeze({
    guarded_by_primitive: null,
    guarded_in_place: "unconverged_local_guard",
    record_throwing: "undeclared_throwing_map",
    record_total: "undeclared_asserted_record",
    record_dropping: "undeclared_dropped_row",
    projection: null,
  });

/** Why a verdict's missing declaration is a finding, in the sentence the failure prints. */
const UNDECLARED_BECAUSE: Record<PageReadVerdict, string> = Object.freeze({
  guarded_by_primitive: "",
  guarded_in_place:
    "it keeps the page and reports the row through its own try/catch, which is a second spelling of what readRows does",
  record_throwing: "it can throw",
  record_total: "it asserts its record type rather than parsing it, so no clause is checked on read",
  record_dropping:
    "it catches the contract's refusal and answers null, so the row is dropped and nothing is told",
  projection: "",
});

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * Phrased from the site's side for the two `undeclared_*` kinds and from the declaration's side for
 * the rest, so the list is pinned in both directions — `pg-record-retention.ts`' rule, and the
 * property that separates this from the hand-maintained list ADR-0288 found wrong three times. A
 * one-way comparison is what the original defect was made of.
 */
export function auditUnreadableRows(
  input: UnreadableRowAuditInput,
): readonly UnreadableRowFinding[] {
  const { sites, declarations, files, sources } = input;
  const bySite = new Map<string, PageReadSite>();
  for (const site of sites) bySite.set(siteKey(site), site);
  const known = new Set(files);

  const findings: UnreadableRowFinding[] = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const key = siteKey(declaration);
    if (seen.has(key)) {
      findings.push({
        kind: "duplicate",
        site: key,
        detail: `${key} is declared more than once, so two reasons would both pass`,
      });
      continue;
    }
    seen.add(key);

    const site = bySite.get(key);
    if (site === undefined) {
      findings.push({
        kind: "unknown_site",
        site: key,
        detail: `${key} is declared and the scan finds no such conversion — the method was renamed, the mapper changed, or the read is gone; re-point or delete the declaration`,
      });
      continue;
    }
    if (!VERDICT_NEEDS_DECLARATION[site.verdict]) {
      findings.push({
        kind: "overtaken",
        site: key,
        detail: `${key} is declared (${declaration.reason}) and now reads ${site.verdict} — ${VERDICT_DESCRIPTIONS[site.verdict]}; delete the declaration`,
      });
      continue;
    }
    if (!REASONS_FOR_VERDICT[site.verdict].includes(declaration.reason)) {
      findings.push({
        kind: "reason_contradicts_verdict",
        site: key,
        detail: `${key} is declared ${declaration.reason} and the scan derives ${site.verdict}; the admissible reasons there are ${REASONS_FOR_VERDICT[site.verdict].join(", ")}`,
      });
    }

    if (declaration.refusedIn !== undefined) {
      if (!known.has(declaration.refusedIn)) {
        findings.push({
          kind: "refusal_handler_missing",
          site: key,
          detail: `${key} says ${declaration.refusedIn} answers the refusal, and the workspace has no such file`,
        });
      } else if (
        declaration.refusalCode !== undefined &&
        !(sources.get(declaration.refusedIn) ?? "").includes(declaration.refusalCode)
      ) {
        findings.push({
          kind: "refusal_code_absent",
          site: key,
          // The whole cost of this reason: a page refusal is only declared if something answers it,
          // and a code nobody emits is a claim rather than a mechanism (ADR-0334's rule that a
          // remedy which cannot work is worse than none).
          detail: `${key} claims the refusal '${declaration.refusalCode}' and ${declaration.refusedIn} does not contain that string — the handler stopped answering it, or the code was renamed`,
        });
      }
    }

    if (declaration.fencedBy !== undefined && declaration.fencedBy !== "nothing") {
      const declaredAnywhere = [...sources.values()].some((text) =>
        new RegExp(`\\b${declaration.fencedBy ?? ""}\\b`).test(text),
      );
      if (!declaredAnywhere) {
        findings.push({
          kind: "fence_symbol_missing",
          site: key,
          detail: `${key} says ${declaration.fencedBy} fences the contract instead of a parse, and no workspace source names it`,
        });
      }
    }
  }

  for (const site of sites) {
    const key = siteKey(site);
    if (!VERDICT_NEEDS_DECLARATION[site.verdict] || seen.has(key)) continue;
    const kind = UNDECLARED_FINDING_FOR[site.verdict];
    if (kind === null) continue;
    const evidence =
      site.evidence.length === 0
        ? ""
        : ` (${site.evidence.map((e) => `${e.kind}:${e.symbol}`).join(", ")})`;
    findings.push({
      kind,
      site: key,
      detail: `${site.file}:${site.line} converts a page of rows through ${site.conversion} and ${UNDECLARED_BECAUSE[site.verdict]}${evidence}${
        site.bounded ? "" : ", over a read with no LIMIT"
      }. Use readRows/readRowsWithUnreadable, or add an UNREADABLE_ROW_SITES line with a reason.`,
    });
  }

  for (const conversion of [...new Set(input.unannotatedConversions)].sort()) {
    findings.push({
      kind: "conversion_unresolved",
      site: conversion,
      // The convention this rule leans on, re-asked rather than assumed. A silent conversion whose
      // record type cannot be read falls to `projection`, which excludes it from the fence — so the
      // exclusion would have been reached by a measurement that failed, and that must be louder than
      // the exclusion is quiet.
      detail: `${conversion} converts a page of rows and declares no return type this scan can read, so whether it builds a contract record was decided by failing to read it. Annotate the conversion's return type, which every one of its siblings carries.`,
    });
  }

  return findings;
}

export function formatUnreadableRowFindings(findings: readonly UnreadableRowFinding[]): string {
  return findings.map((f) => `[${f.kind}] ${f.detail}`).join("\n");
}

export function countSitesByVerdict(
  sites: readonly PageReadSite[],
): ReadonlyMap<PageReadVerdict, number> {
  const counts = new Map<PageReadVerdict, number>();
  for (const verdict of PAGE_READ_VERDICTS) counts.set(verdict, 0);
  for (const site of sites) counts.set(site.verdict, (counts.get(site.verdict) ?? 0) + 1);
  return counts;
}

export function countDeclarationsByReason(
  declarations: readonly UnreadableRowDeclaration[],
): ReadonlyMap<UnreadableRowReason, number> {
  const counts = new Map<UnreadableRowReason, number>();
  for (const reason of UNREADABLE_ROW_REASONS) counts.set(reason, 0);
  for (const d of declarations) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return counts;
}

/** The throwing sites with no `LIMIT` — where one refused row costs the most. */
export function unboundedThrowingSites(
  sites: readonly PageReadSite[],
): readonly PageReadSite[] {
  return sites.filter((s) => s.verdict === "record_throwing" && !s.bounded);
}

/* ------------------------------------------------------------------- scopes */

export interface DeclaredScope {
  readonly name: string;
  readonly start: number;
  readonly bodyStart: number;
  readonly end: number;
  /** The text between the parameter list and the body, where a return annotation lives. */
  readonly returnType: string | null;
}

const SCOPE_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "do",
  "else",
  "return",
  "typeof",
  "await",
  "new",
  "throw",
  "case",
  "delete",
  "void",
  "yield",
  "in",
  "of",
  "and",
  "constructor",
]);

const SCOPE_DECL =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^(){};]*>)?\s*\(/g;

const ARROW_DECL =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=\n]+?))?\s*=\s*(?:async\s*)?(?:function\s*\*?\s*)?[(<]/g;

function skipString(code: string, from: number): number {
  const quote = code[from];
  let i = from + 1;
  while (i < code.length) {
    const ch = code[i];
    i += 1;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) break;
  }
  return i;
}

/** The index just past the `}` closing the body that opens at `openBrace`. */
export function bodyEnd(code: string, openBrace: number): number {
  let depth = 0;
  let i = openBrace;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return code.length;
}

/** The index just past the `;` that closes the single statement starting at `from`. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if ((ch === ";" || ch === "\n") && depth <= 0) return i + 1;
    i += 1;
  }
  return code.length;
}

/** The index just past the `)` closing the parameter list that opens at `openParen`. */
function parenEnd(code: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * Every named function **and class method** in a module, with its return annotation.
 *
 * `entity-field-aperture.ts` exports `functionSpans`, which was tried first and refused on a
 * measurement rather than on taste: its `DECLARATION` matches a module-level `function` or
 * `const … = (` and a class method is neither, so of the conversions this rule finds, the great
 * majority sit in a store's `async listRecent(…)` and would be attributed to `<module>` — which is
 * not a key a declaration can be written against, since a file holding four such methods would
 * collapse to one. The two scans answer different questions about the same text, so this one is
 * separate rather than a widening of that one (which a sibling slice must stay free to change).
 *
 * A nested arrow callback is deliberately not its own scope: the conversion inside
 * `withTenantContext(conn, id, async (tx) => …)` belongs to the method that opened the transaction,
 * which is the unit a declaration names.
 */
export function declaredScopes(code: string): readonly DeclaredScope[] {
  const out: DeclaredScope[] = [];
  for (const match of code.matchAll(SCOPE_DECL)) {
    const name = match[1] ?? "";
    if (name === "" || SCOPE_KEYWORDS.has(name)) continue;
    const openParen = match.index + match[0].length - 1;
    const afterParams = parenEnd(code, openParen);
    if (afterParams < 0) continue;
    // Only a `{` may follow: an overload signature ends in `;` and a call expression in anything
    // else, and taking either would hand this rule a scope with somebody else's body.
    let i = afterParams;
    while (i < code.length && code[i] !== "{" && code[i] !== ";" && code[i] !== "=") i += 1;
    if (code[i] !== "{") continue;
    const annotation = code.slice(afterParams, i).trim();
    out.push({
      name,
      start: match.index,
      bodyStart: i,
      end: bodyEnd(code, i),
      returnType: annotation.startsWith(":") ? annotation.slice(1).trim() : null,
    });
  }
  for (const match of code.matchAll(ARROW_DECL)) {
    const name = match[1] ?? "";
    if (name === "") continue;
    const openParen = match.index + match[0].length - 1;
    if (code[openParen] !== "(") continue;
    const afterParams = parenEnd(code, openParen);
    if (afterParams < 0) continue;
    let i = afterParams;
    while (i < code.length && code[i] !== "{" && code[i] !== ";") i += 1;
    if (code[i] !== "{") continue;
    const inline = match[2]?.trim() ?? "";
    const annotation = code.slice(afterParams, i).trim();
    out.push({
      name,
      start: match.index,
      bodyStart: i,
      end: bodyEnd(code, i),
      // An arrow's annotation sits between `)` and `=>`, so the trailing arrow is dropped; without
      // that, `(a: string): boolean => {` answers the return type `boolean =>`.
      returnType: annotation.startsWith(":")
        ? annotation.slice(1).replace(/=>\s*$/, "").trim()
        : inline === ""
          ? null
          : inline,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The innermost scope holding `at`, or `null` for module scope. */
export function scopeAt(
  scopes: readonly DeclaredScope[],
  at: number,
): DeclaredScope | null {
  let best: DeclaredScope | null = null;
  for (const scope of scopes) {
    if (at < scope.bodyStart || at >= scope.end) continue;
    if (best === null || scope.end - scope.bodyStart < best.end - best.bodyStart) best = scope;
  }
  return best;
}

/* ------------------------------------------------------- throw-capability */

/**
 * Calls that cannot throw for any input a Postgres row can hold.
 *
 * Deliberately short, and every member is here because leaving it out would make a *projection* read
 * as a throwing conversion. `JSON.parse` is **not** on it and must never be: it throws on a malformed
 * JSONB or TEXT column, which is the one non-contract row refusal this rule has a vocabulary member
 * for. `toISOString` is on it with its caveat stated — it throws on an Invalid Date, which no
 * `TIMESTAMPTZ` node-postgres parses can produce (ADR-0331 measured what that driver returns), and
 * treating it as throwing would classify every claim store's inline projection as a record map.
 */
export const TOTAL_CALLS: ReadonlySet<string> = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "isNaN",
  "isFinite",
  // `safeParse` is the non-throwing form of the very thing this rule is about, so leaving it out is
  // not a coverage gap but a wrong answer — and a measured one: resolved as a bare name it matched a
  // *workspace* function called `safeParse` and two sites read `throwing_callee:safeParse`, which is
  // ADR-0354's bare-name-map defect reproduced inside this rule.
  "safeParse",
  "safeParseAsync",
  "stringify",
  "keys",
  "values",
  "entries",
  "freeze",
  "isArray",
  "from",
  "of",
  "toISOString",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "slice",
  "split",
  "join",
  "includes",
  "startsWith",
  "endsWith",
  "test",
  "match",
  "replace",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "push",
  "add",
  "get",
  "set",
  "has",
  "sort",
  "concat",
  "length",
  "isInteger",
  "parseInt",
  "parseFloat",
  "floor",
  "ceil",
  "round",
  "max",
  "min",
  "abs",
  "now",
  "toFixed",
  "padStart",
  "repeat",
  "flatMap",
  "reduce",
  "indexOf",
  "charCodeAt",
  "localeCompare",
  "at",
  "flat",
  "reverse",
  "pop",
  "shift",
  "unshift",
  "delete",
  "clear",
  "getTime",
  "toString",
  "valueOf",
  "fill",
  "trimStart",
  "trimEnd",
]);

/**
 * Global constructors a conversion may call without being able to refuse a row.
 *
 * Deliberately **not** `RegExp` or `Intl.DateTimeFormat`: `new RegExp(pattern)` throws on a malformed
 * pattern, which is reachable from a stored route pattern, and an unresolvable IANA zone makes
 * `Intl.DateTimeFormat` throw (ADR-0335 measured that one). Both stay unresolved, which under the
 * fail-closed rule is throw evidence.
 */
export const TOTAL_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Date",
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "Array",
  "Object",
  "Error",
  "TypeError",
  "RangeError",
  "Promise",
  "Symbol",
  "Math",
]);

/**
 * `z.*` — schema *construction*, which cannot refuse a row.
 *
 * Only `.parse` can, and that is matched separately and before this. Without it, `z.enum([…])` inside
 * a conversion resolved the bare name `enum` against the workspace and read as a throwing callee.
 */
const ZOD_NAMESPACE = "z";

/** `name(` and `recv.name(`, the two spellings a call is written in. */
const CALL = /\b([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)\s*)?\(/g;

export interface ResolvedFunction {
  readonly file: string;
  readonly body: string;
  readonly returnType: string | null;
}

/**
 * Every named function in the workspace, with the per-file and per-package views a lookup needs.
 *
 * Three indexes rather than one bare name map, which is not an optimisation: ADR-0354's single
 * sharpest self-inflicted finding was a bare-name map holding whichever `SeveritySchema` was scanned
 * last, and ADR-0356 reproduced it with four stores all naming their row interface `Row`. So a name
 * is resolved **same file, then same package, then workspace-unique**, and a name that is none of
 * those stays unresolved — which under this rule's fail-closed reading is throw evidence rather than
 * a pass.
 */
export interface FunctionIndex {
  readonly byFile: ReadonlyMap<string, ReadonlyMap<string, ResolvedFunction>>;
  readonly byPackage: ReadonlyMap<string, ReadonlyMap<string, readonly ResolvedFunction[]>>;
  readonly byName: ReadonlyMap<string, readonly ResolvedFunction[]>;
}

const packageOf = (file: string): string => file.split("/").slice(0, 2).join("/");

export function buildFunctionIndex(
  sources: readonly WorkspaceSourceFile[],
): FunctionIndex {
  const byFile = new Map<string, Map<string, ResolvedFunction>>();
  const byPackage = new Map<string, Map<string, ResolvedFunction[]>>();
  const byName = new Map<string, ResolvedFunction[]>();
  for (const source of sources) {
    const { code } = codeViews(source.text);
    const perFile = new Map<string, ResolvedFunction>();
    for (const scope of declaredScopes(code)) {
      const resolved: ResolvedFunction = {
        file: source.file,
        body: code.slice(scope.bodyStart, scope.end),
        returnType: scope.returnType,
      };
      // First declaration wins within a file: a class method and a module helper of one name is
      // rare, and preferring the later would silently re-point every call in the file.
      if (!perFile.has(scope.name)) perFile.set(scope.name, resolved);
      const pkg = packageOf(source.file);
      const perPackage = byPackage.get(pkg) ?? new Map<string, ResolvedFunction[]>();
      perPackage.set(scope.name, [...(perPackage.get(scope.name) ?? []), resolved]);
      byPackage.set(pkg, perPackage);
      byName.set(scope.name, [...(byName.get(scope.name) ?? []), resolved]);
    }
    byFile.set(source.file, perFile);
  }
  return { byFile, byPackage, byName };
}

export function resolveFunction(
  index: FunctionIndex,
  file: string,
  name: string,
): ResolvedFunction | null {
  const sameFile = index.byFile.get(file)?.get(name);
  if (sameFile !== undefined) return sameFile;
  const samePackage = index.byPackage.get(packageOf(file))?.get(name) ?? [];
  if (samePackage.length === 1) return samePackage[0] ?? null;
  if (samePackage.length > 1) return null;
  const anywhere = index.byName.get(name) ?? [];
  return anywhere.length === 1 ? (anywhere[0] ?? null) : null;
}

/**
 * Why evaluating `expression` can throw, following resolved calls to a bounded depth.
 *
 * Depth-bounded at three and cycle-guarded, because a mutual recursion would otherwise not
 * terminate and because the answer stops being legible past that: `rowToX` → `requireIsoInstant` →
 * `isoInstant` is the real chain this exists for and is two.
 */
export function throwEvidence(
  expression: string,
  file: string,
  index: FunctionIndex,
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): readonly ThrowEvidence[] {
  const out: ThrowEvidence[] = [];
  if (/\bthrow\b/.test(expression)) out.push({ kind: "explicit_throw", symbol: "<inline>" });

  for (const match of expression.matchAll(CALL)) {
    const head = match[1] ?? "";
    const member = match[2];
    if (member !== undefined) {
      if (member === "parse" || member === "parseAsync") {
        out.push({
          kind: head === "JSON" ? "json_parse" : "zod_parse",
          symbol: `${head}.${member}`,
        });
        continue;
      }
      if (TOTAL_CALLS.has(member) || head === ZOD_NAMESPACE) continue;
      // A method on a value this scan cannot type. Resolved as a bare name, which is what a class
      // method reads as — `this.rowToRecord(r)` is the common case and resolves in the same file.
      const resolved = resolveFunction(index, file, member);
      if (resolved === null) {
        out.push({ kind: "unresolved_callee", symbol: `${head}.${member}` });
        continue;
      }
      out.push(...calleeEvidence(resolved, member, index, depth, visited));
      continue;
    }
    if (TOTAL_CALLS.has(head) || TOTAL_CONSTRUCTORS.has(head) || SCOPE_KEYWORDS.has(head)) continue;
    const resolved = resolveFunction(index, file, head);
    if (resolved === null) {
      out.push({ kind: "unresolved_callee", symbol: head });
      continue;
    }
    out.push(...calleeEvidence(resolved, head, index, depth, visited));
  }

  // De-duplicated so one callee named twice reads as one piece of evidence, and sorted so the detail
  // of a finding is the same between two runs — a message that varies cannot be compared.
  const unique = new Map<string, ThrowEvidence>();
  for (const e of out) unique.set(`${e.kind}:${e.symbol}`, e);
  return [...unique.values()].sort((a, b) =>
    a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind.localeCompare(b.kind),
  );
}

/**
 * Whether a function body is **wholly** `try { … } catch { … }` with no `throw` in the catch.
 *
 * Wholly, and that is the conservative half: a function with a try/catch around *part* of its body
 * keeps its throw evidence, because suppressing it would under-report on the strength of a guard that
 * does not cover the throw. Measured, both live members are exactly this shape —
 * `tryDigestFromRow` and `tryAuditEntryFromRow` are four lines each — so the strict form costs
 * nothing and the loose one would have been a guess.
 */
export function swallowsItsOwnRefusal(body: string): boolean {
  const inner = body.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!inner.startsWith("try")) return false;
  return inlineGuard(body) === "drops";
}

/** What a conversion's own `try`/`catch` does with the row the contract refused. */
export const INLINE_GUARDS = ["none", "reports", "drops"] as const;
export type InlineGuard = (typeof INLINE_GUARDS)[number];

/**
 * Whether a conversion guards itself per row, and whether it tells anyone.
 *
 * **The distinction is the whole point and both arms have live members**, measured: of 106
 * conversions in the workspace exactly **two** contain a `catch` at all, and both *report* —
 * `incident-response-runtime-pg`' replayer pushes a `drift` finding and continues, and
 * `deletion-request-store`' `readRequestRows` calls `onUnreadable`. Without this, both read
 * `record_throwing`, which would have put a backlog entry on the two sites in the repository that
 * already do the right thing. The two **callee**-level members (`tryDigestFromRow`,
 * `tryTemplateFromRow`) are the other arm: four lines each, `catch { return null }`, nothing told.
 *
 * `reports` is tested as *the catch block calls something*, which is the weakest honest reading — a
 * block that only `return null`s or `continue`s calls nothing, and every way of telling somebody is
 * a call. A `throw` in the catch is not a guard at all and answers `none`, so re-throwing after
 * logging still reads as throwing.
 *
 * **Its one fail-open is deliberate and is not silent.** A conversion holding a try/catch for some
 * *other* purpose, with a throwing conversion outside it, would read `reports` — and the thing that
 * makes that acceptable is where it lands: `guarded_in_place` still **needs a declaration**, so the
 * mistake surfaces as `unconverged_local_guard` demanding a human sentence about a site that does
 * not have a guard, rather than as a site quietly leaving the fence. Measured at 3 of 109
 * conversions containing a `catch` at all, every one of them a per-row guard.
 */
export function inlineGuard(body: string): InlineGuard {
  const at = body.indexOf("catch");
  if (at < 0) return "none";
  const open = body.indexOf("{", at);
  if (open < 0) return "none";
  const block = body.slice(open, bodyEnd(body, open));
  if (/\bthrow\b/.test(block)) return "none";
  const bare = block.replace(/[\s;]/g, "");
  if (bare === "{}" || /^\{(?:returnnull|returnundefined|continue)\}$/.test(bare)) return "drops";
  return /\(/.test(block) ? "reports" : "drops";
}

function calleeEvidence(
  resolved: ResolvedFunction,
  name: string,
  index: FunctionIndex,
  depth: number,
  visited: ReadonlySet<string>,
): readonly ThrowEvidence[] {
  const id = `${resolved.file}#${name}`;
  if (visited.has(id)) return [];
  if (depth >= 3) {
    // The depth limit is itself an unestablished totality, so it reads as throw evidence rather than
    // as a pass — the fail-closed rule this module opens with, applied to its own bound.
    return [{ kind: "unresolved_callee", symbol: `${name} (depth)` }];
  }
  // Asked before the body is walked: a swallowing conversion's *inner* mapper really does parse, so
  // walking it would report `zod_parse` for a call that cannot propagate it.
  if (swallowsItsOwnRefusal(resolved.body)) return [{ kind: "swallowing_callee", symbol: name }];
  const nested = throwEvidence(resolved.body, resolved.file, index, depth + 1, new Set([...visited, id]));
  if (nested.length === 0) return [];
  if (nested.every((e) => e.kind === "swallowing_callee")) return nested;
  return [{ kind: "throwing_callee", symbol: name }];
}

/* -------------------------------------------------------------- record type */

const PASCAL = /^[A-Z][A-Za-z0-9_]*$/;

/**
 * The contract type a conversion produces, or `null` where it produces none.
 *
 * `Promise<readonly X[]>`, `X | null`, `readonly X[]` and `X` all answer `X`; `string`, `number`, an
 * inline object type and an inline union answer `null`. The test is **PascalCase after the wrappers
 * are peeled**, which is this repo's own convention for a declared record and the one
 * `pg-record-reads.ts` leans on for a row interface.
 *
 * It is a *convention*, so its coverage is re-measured on every run and reported through
 * `conversion_unresolved` when it stops holding, rather than being allowed to narrow the population
 * in silence (`pg-binding-names.ts`' `derivation_ambiguous`, one rule across).
 */
export function recordTypeOf(
  annotation: string | null,
  options: { readonly requireArray?: boolean } = {},
): string | null {
  if (annotation === null) return null;
  let type = annotation.trim();
  let sawArray = false;
  for (let i = 0; i < 6; i += 1) {
    const before = type;
    type = type.replace(/^Promise\s*<([\s\S]*)>$/, "$1").trim();
    type = type.replace(/^readonly\s+/, "").trim();
    if (/^(?:Array|ReadonlyArray)\s*<[\s\S]*>$/.test(type) || /\[\]$/.test(type)) sawArray = true;
    type = type.replace(/^Array\s*<([\s\S]*)>$/, "$1").trim();
    type = type.replace(/^ReadonlyArray\s*<([\s\S]*)>$/, "$1").trim();
    type = type.replace(/\[\]$/, "").trim();
    // A nullable record is still a record: `rowToRecipient` answers `ResolvedRecipient | null`, and
    // the `null` is how it reports a row it declined rather than a different kind of answer.
    type = type.replace(/\s*\|\s*(?:null|undefined)$/, "").trim();
    if (type === before) break;
  }
  if (options.requireArray === true && !sawArray) return null;
  return PASCAL.test(type) ? type : null;
}

/* --------------------------------------------------------------- the scan */

/** `rows.map(`, `result.rows.map(`, `rows\n  .map(` — the receiver and the call, over code. */
const ARRAY_MAP = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*map\s*\(/g;

/**
 * `for (const row of <expr>)`, with or without a braced body.
 *
 * The brace is deliberately **not** required: `for (const r of rows) out.push(f(r));` is a spelling
 * 251 files in this workspace use somewhere, so requiring one would be a silent hole exactly where a
 * one-line loop is the terse way to write the defect. The body is taken to the closing brace when
 * there is one and to the statement's `;` when there is not.
 */
const ROW_LOOP = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]*?)\s*\)\s*/g;

/** `readRows(` / `readRowsWithUnreadable(` — the primitive. */
const PRIMITIVE = /\b(readRows|readRowsWithUnreadable)\s*\(/g;

export interface RowPageBindings {
  /** Identifiers holding a `PgQueryResult`, so `<it>.rows` is a page. */
  readonly results: ReadonlySet<string>;
  /** Identifiers holding the row array itself. */
  readonly arrays: ReadonlySet<string>;
}

/**
 * Whether a `.map` receiver or a `for…of` subject is a page of **Postgres** rows.
 *
 * **`.rows` alone is not the anchor, and that was measured rather than assumed.** Taking any
 * `<x>.rows` produced three false members whose rows never came from a database:
 * `packages/migration/src/previews.ts` loops `run.rows` of a *preview run* in a package with no
 * Postgres at all, and `operate-runtime/src/write-effects.ts` loops the rows of a drained entity
 * list twice. A rule that reports a domain loop as a Postgres read sends the next reader to the
 * wrong layer, so the receiver has to be traceable to a `.query(` call or to a row-array parameter.
 *
 * Measured on the committed tree: **zero** sources destructure (`const { rows } = await …`), so that
 * spelling is not matched; `conventionCoverage` re-measures it on every run, so if one appears the
 * rule says so rather than the population silently shrinking.
 */
export function isRowPage(receiver: string, bindings: RowPageBindings): boolean {
  const flat = receiver.replace(/\s+/g, "");
  if (flat.endsWith(".rows")) {
    return bindings.results.has(flat.slice(0, -".rows".length));
  }
  return bindings.arrays.has(flat);
}

/**
 * Identifiers in this file that hold a query result, and ones that hold a page of its rows.
 *
 * Four bindings, each measured against a live member: assigned from an expression naming `.query(`
 * (`const result = await tx.query(…)` — the overwhelming majority); assigned from an expression that
 * both names `.query(` and ends in `.rows` (`certification.ts`' ternary, where the two arms are a
 * direct query and a `withTenantContext` closure returning its rows); a parameter typed
 * `Record<string, unknown>[]`, which is how `digest-store.ts`' `parseRows(rows)` and
 * `definition-store.ts`' `firstDefinition(rows)` receive a page; and `(await …query(…)).rows` written
 * inline, which needs no binding at all and is matched by the expression itself.
 */
export function rowPageBindingsIn(code: string): RowPageBindings {
  const results = new Set<string>();
  const arrays = new Set<string>();
  for (const match of code.matchAll(
    /\b(?:const|let|var)\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=/g,
  )) {
    const value = statementValueAfter(code, match.index + match[0].length);
    if (!/\.\s*query\s*(?:<[\s\S]*?>)?\s*\(/.test(value)) continue;
    // A destructured pair holds both halves of one `Promise.all`, so each name is a result.
    // `check-admission.ts` writes `const [checks, columns] = await Promise.all([…query…])`, and
    // without this arm its four row pages read as untraced — which is a coverage loss in the module
    // that surveys the catalog, not a hypothetical.
    const bound = (match[1] ?? "").startsWith("[")
      ? (match[1] ?? "").slice(1, -1).split(",").map((n) => n.trim())
      : [match[1] ?? ""];
    const holdsTheArray = /\.\s*rows\s*$/.test(value.trim()) || /\.\s*rows\b[^;]*$/.test(value);
    for (const name of bound) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (holdsTheArray) arrays.add(name);
      else results.add(name);
    }
  }
  // **Gated on the module issuing a query at all**, which is measured rather than cautious: in a
  // package with no Postgres, a `Record<string, unknown>[]` is a list of documents, and without the
  // gate `operate-runtime/src/write-effects.ts` — the pure accounting layer, which names `.query(`
  // nowhere — contributed two sites looping a *drained entity list*. Reporting a domain loop as a
  // Postgres read sends the next reader to the wrong layer.
  if (/\.\s*query\s*(?:<[\s\S]*?>)?\s*\(/.test(code)) {
    for (const match of code.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*:\s*(?:readonly\s+)?Record\s*<\s*string\s*,\s*unknown\s*>\s*\[\]/g,
    )) {
      arrays.add(match[1] ?? "");
    }
  }
  results.delete("");
  arrays.delete("");
  return { results, arrays };
}

/**
 * The initialiser of a declaration whose `=` ends at `from`, to the `;` that closes the statement.
 *
 * Depth-aware over `()[]{}<>` rather than "up to the first `;`", and that is measured rather than
 * careful: `signal-store.ts` writes `conn.query<{ signal_id: string; instance_id: string | null }>(…)`,
 * whose **type argument contains two semicolons**, so the naive read stopped inside the generic and
 * the binding went untraced — losing the one page in that file.
 */
function statementValueAfter(code: string, from: number): string {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "=" && code[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth -= 1;
    else if (ch === ";" && depth <= 0) break;
    i += 1;
  }
  return code.slice(from, i);
}

export interface ConventionCoverage {
  /** `<x>.rows` receivers whose `<x>` could not be traced to a query — the excluded set. */
  readonly untracedRowReceivers: readonly string[];
  /** `const { rows } = …` — the destructuring spelling this scan does not match. */
  readonly destructured: readonly string[];
  /** Conversions matched over a page whose record type could not be read. */
  readonly unannotated: readonly string[];
}

/** The argument text of a call whose `(` is at `openParen`. */
function callArgument(code: string, openParen: number): string {
  const end = parenEnd(code, openParen);
  return end < 0 ? "" : code.slice(openParen + 1, end - 1);
}

/**
 * The conversion as an expression that **applies** it to a row.
 *
 * `rows.map(rowToRecord)` passes the mapper by reference, so the argument text contains no call at
 * all — and `throwEvidence` is a scan over calls, so every such site came back with no evidence and
 * read `record_total`. Measured when it was found: **12 of 20** apparent `record_total` sites were
 * really throwing, among them `invoice-store`' `rowToInvoice` (which ends in `InvoiceSchema.parse`
 * *and* calls `JSON.parse`) and `version-store`' `rowToRecord`. That is this module's own
 * under-reporting direction — the fence quietly not fencing — inside the module that opens by
 * naming it, and it is why the fixture tests assert the *bare-reference* shape explicitly rather
 * than only the arrow one every real store happens also to use.
 */
export function conversionExpression(argument: string): string {
  const trimmed = argument.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return `${trimmed}(row)`;
  if (/^this\s*\.\s*[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return `${trimmed.replace(/^this\s*\.\s*/, "")}(row)`;
  }
  return trimmed;
}

/**
 * Whether the expression starting at `at` is what its scope returns.
 *
 * `return` immediately before it, allowing the `(` of a wrapping call — `return new Set(rows.map(…))`
 * is *not* returned as a page of records, and that is the case the parenthesis test is for rather
 * than against: a wrapped map's element type is not the scope's element type.
 */
export function isReturned(code: string, at: number): boolean {
  const before = code.slice(Math.max(0, at - 24), at).trimEnd();
  return /\breturn$/.test(before);
}

/**
 * The conversion's own name.
 *
 * A bare identifier argument is the mapper; an arrow is named by the first call in its body that is
 * not a total builtin, which is what `(row) => rowToX(row)` and
 * `(row) => summarizeDefinition(rowToWorkflowDefinition(row))` both reduce to — and in the second the
 * *outer* call is the right name, because the declaration is about this conversion and either half
 * throwing loses the page. An arrow with no such call is `<inline>`.
 */
export function conversionName(argument: string, rowVariable?: string): string {
  const trimmed = argument.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  if (/^this\s*\.\s*[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed.replace(/^this\s*\.\s*/, "");
  const arrow = trimmed.indexOf("=>");
  const parameter =
    rowVariable ??
    (arrow < 0
      ? undefined
      : (/([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)?\s*$/.exec(trimmed.slice(0, arrow))?.[1] ?? undefined));
  const body = arrow < 0 ? trimmed : trimmed.slice(arrow + 2);
  // An arrow whose body **is** an object literal is `<inline>` whatever it calls inside, because the
  // conversion is the literal and not the first helper it reaches for. Without this,
  // `claimDueTimers`' `(r) => ({timerId: str(r.timer_id), …})` was named `str` — a shared
  // three-line coercion helper, which is neither the thing a declaration is about nor a name a
  // reader could act on.
  if (/^\s*(?:\(\s*\{|\{)/.test(body)) return "<inline>";
  // A schema parse written out at the call site names itself, and that is the one case where the
  // name also carries the record type: `certification.ts` maps a chain page straight through
  // `ChainedLogEntrySchema.parse({…})` with no mapper function to resolve.
  const parse = /\b([A-Za-z_$][\w$]*Schema)\s*\.\s*(parse|parseAsync)\s*\(/.exec(body);
  if (parse !== null) return `${parse[1] ?? ""}.${parse[2] ?? "parse"}`;
  /**
   * The conversion is **the call this row is handed to**, and nothing else.
   *
   * "The first call that is not a total builtin" was tried first and named nine sites after a
   * coercion helper: `design-review-store`' counts loop read `intOf`, `integrity-verdict-store`'
   * read `enum` (out of `z.enum`), and three of `tenant-schema-erase`' probes read `toText`. None of
   * those is the row conversion, and a declaration keyed on one would be re-pointed by whoever next
   * changed a cast. Requiring the row itself as the first argument picks exactly the mapper —
   * `rowToIncident(row)`, `tryDigestFromRow(row)`, `rowToWorkflowDefinition(row)` — and answers
   * `<inline>` where the row is taken apart at the call site, which is the honest name for it.
   */
  if (parameter !== undefined && parameter !== "") {
    const direct = new RegExp(
      `\\b([A-Za-z_$][\\w$]*)\\s*\\(\\s*${parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,)]`,
    ).exec(body);
    const name = direct?.[1] ?? "";
    if (name !== "" && !TOTAL_CALLS.has(name) && !SCOPE_KEYWORDS.has(name)) return name;
  }
  return "<inline>";
}

/**
 * The record type a conversion produces, by the two routes a site can carry one.
 *
 * The named callee's own return annotation is the primary route and the one the eight
 * `record_total` members are found by. The enclosing scope's element type is the fallback, and it is
 * what reaches an *inline* conversion: `claimDueTimers` returns `Promise<readonly ClaimedTimer[]>`
 * and builds that record from an object literal, so the contract is declared one level out and the
 * literal is the assertion. Without the fallback, every inline record build reads as a projection,
 * which is the permissive direction.
 */
function recordTypeForSite(
  conversion: string,
  file: string,
  index: FunctionIndex,
  enclosing: DeclaredScope | null,
  returned: boolean,
): string | null {
  if (conversion.endsWith(".parse") || conversion.endsWith(".parseAsync")) {
    const schema = conversion.split(".")[0] ?? "";
    // `XSchema.parse` produces `X`, and the schema's own name is the only declaration of it at the
    // call site. A schema named without the suffix answers null rather than a guess.
    return schema.endsWith("Schema") && schema.length > 6 ? schema.slice(0, -6) : null;
  }
  const resolved = conversion === "<inline>" ? null : resolveFunction(index, file, conversion);
  const own = recordTypeOf(resolved?.returnType ?? null);
  if (own !== null) return own;
  // **The fallback is restricted twice, and both restrictions were measured.**
  //
  // *Array-shaped*, because a record is built per row, so only `Promise<readonly X[]>` says the
  // thing this conversion produces is an `X`. Without it the fallback claimed `CheckAdmissionSurvey`
  // for a loop building a `Set<string>`, `TenantStatusCounts` for a loop tallying integers and
  // `LiveSchema` for an introspection fold — 17 sites whose conversion produces nothing of the named
  // type, every one of which would then have needed a declaration asserting something false.
  //
  // *Directly returned*, because a method may hold several row pages and only one of them is its
  // answer: `delivery-store.ts`' `claimQueued(): Promise<readonly ClaimedDispatch[]>` first maps a
  // page to a list of **ids** and then maps it to the dispatches, so the fallback gave the id
  // projection the dispatch's record type — and, both sites being inline, they collided on one
  // declaration key.
  if (!returned) return null;
  return recordTypeOf(enclosing?.returnType ?? null, { requireArray: true });
}

export interface ModuleScanResult {
  readonly sites: readonly PageReadSite[];
  /** What the conventions this scan leans on cover in this module, re-measured every run. */
  readonly coverage: ConventionCoverage;
}

/**
 * One module's sites. Pure over the text, so the negative controls can be fixtures.
 *
 * Split from the walk for `typecheck-config.ts`' reason — the shape is decided by a function that
 * reads nothing, and the disk is touched in one place — and because a rule whose liveness can only be
 * shown against the workspace it asserts on can never demonstrate that it would *report* a defect
 * (ADR-0362's own retired test is the cautionary case: an exhaustive truth table compared against a
 * derivation of itself).
 */
export function scanModuleForPageReads(
  source: WorkspaceSourceFile,
  index: FunctionIndex,
): ModuleScanResult {
  const { declared, code } = codeViews(source.text);
  const sites: PageReadSite[] = [];
  const unannotated: string[] = [];
  const untracedRowReceivers: string[] = [];
  const scopes = declaredScopes(code);
  const bindings = rowPageBindingsIn(code);
  const lineOf = (at: number): number => code.slice(0, at).split("\n").length;
  const destructured = [...code.matchAll(/\b(?:const|let|var)\s*\{[^}]*\brows\b[^}]*\}\s*=/g)].map(
    (m) => `${source.file}:${code.slice(0, m.index).split("\n").length}`,
  );

  const push = (
    at: number,
    shape: RowConversionShape,
    conversion: string,
    expression: string,
    returned: boolean,
  ): void => {
    const enclosing = scopeAt(scopes, at);
    const scope = enclosing?.name ?? "<module>";
    const scopeText = declared.slice(enclosing?.bodyStart ?? 0, enclosing?.end ?? declared.length);
    const evidence =
      shape === "primitive" ? [] : throwEvidence(expression, source.file, index);
    const recordType = recordTypeForSite(conversion, source.file, index, enclosing, returned);
    if (shape !== "primitive" && recordType === null && conversion !== "<inline>") {
      unannotated.push(`${source.file}::${scope}::${conversion}`);
    }
    /**
     * **Throw evidence decides the fence; the record type only decides what a *silent* conversion
     * is.**
     *
     * That ordering is the single most load-bearing line in this module, and the first draft had it
     * the other way round — record type first, evidence second — which made the fence depend on
     * reading an annotation, so a conversion that demonstrably applies a contract (it reaches
     * `XSchema.parse`) was excluded from it whenever its type could not be read. Evidence of a
     * possible refusal *is* proof that a contract is being applied to the row, so it needs no second
     * opinion; a conversion with no evidence is where the annotation is the only thing that separates
     * "asserts a record" from "reads a column".
     */
    const own = shape === "primitive" ? "none" : inlineGuard(expression);
    const verdict: PageReadVerdict =
      shape === "primitive"
        ? "guarded_by_primitive"
        : own === "reports"
          ? "guarded_in_place"
          : own === "drops"
            ? "record_dropping"
            : evidence.length === 0
              ? recordType === null
                ? "projection"
                : "record_total"
              : evidence.every((e) => e.kind === "swallowing_callee")
                ? "record_dropping"
                : "record_throwing";
    sites.push(
      PageReadSiteSchema.parse({
        file: source.file,
        line: lineOf(at),
        scope,
        conversion,
        shape,
        verdict,
        recordType,
        evidence,
        // Asked of the comment-stripped text, where the SQL is still present: the statement that
        // produced this page is in the same scope, and a `LIMIT` in it is the bound. Module-scope
        // conversions fall back to the file, which is the liberal direction for a reported field.
        bounded: /\bLIMIT\b/i.test(scopeText),
      }),
    );
  };

  /**
   * An inline `(await …query(…)).rows` needs no binding: the expression carries its own evidence.
   *
   * Kept beside the binding test rather than folded into it, because the binding test answers about
   * an *identifier* and this answers about an expression — and `chain-log-store.ts` writes both forms
   * in one file.
   */
  const carriesItsOwnQuery = (receiver: string): boolean =>
    /\.\s*query\s*(?:<[^(]*>)?\s*\(/.test(receiver);

  for (const match of code.matchAll(ARRAY_MAP)) {
    const receiver = match[1] ?? "";
    const openParen = match.index + match[0].length - 1;
    if (!isRowPage(receiver, bindings)) {
      if (receiver.replace(/\s+/g, "").endsWith(".rows")) {
        untracedRowReceivers.push(`${source.file}:${lineOf(match.index)} ${receiver}`);
      }
      continue;
    }
    const argument = callArgument(code, openParen);
    push(
      match.index,
      "array_map",
      conversionName(argument),
      conversionExpression(argument),
      isReturned(code, match.index),
    );
  }

  // `(await conn.query(sql)).rows.map(f)` — the receiver is an expression, so `ARRAY_MAP`'s
  // identifier-chain pattern cannot reach it. Matched separately and anchored on the parenthesised
  // query itself, which is the whole of the evidence.
  for (const match of code.matchAll(/\)\s*\.\s*rows\s*\.\s*map\s*\(/g)) {
    const before = code.slice(Math.max(0, match.index - 400), match.index + 1);
    if (!carriesItsOwnQuery(before)) continue;
    const openParen = match.index + match[0].length - 1;
    const argument = callArgument(code, openParen);
    push(match.index, "array_map", conversionName(argument), conversionExpression(argument), false);
  }

  for (const match of code.matchAll(ROW_LOOP)) {
    const subject = match[2] ?? "";
    if (!isRowPage(subject, bindings) && !carriesItsOwnQuery(subject)) {
      if (subject.replace(/\s+/g, "").endsWith(".rows")) {
        untracedRowReceivers.push(`${source.file}:${lineOf(match.index)} ${subject}`);
      }
      continue;
    }
    const after = match.index + match[0].length;
    const body =
      code[after] === "{"
        ? code.slice(after, bodyEnd(code, after))
        : code.slice(after, statementEnd(code, after));
    // The braces are stripped before the body is named, because a braced loop body opens with `{`
    // and the object-literal rule in `conversionName` would otherwise read every loop as `<inline>`
    // — which it did, taking the names of all nine loop sites with it.
    const inner = body.replace(/^\{/, "").replace(/\}$/, "");
    push(match.index, "row_loop", conversionName(inner, match[1] ?? "row"), body, false);
  }

  for (const match of code.matchAll(PRIMITIVE)) {
    const openParen = match.index + match[0].length - 1;
    const argument = callArgument(code, openParen);
    // The primitive takes `(rows, map, identify, …)`, so the conversion is its second argument —
    // which is the same handle an `array_map` site carries, so a migrated site keeps its key and a
    // declaration for it reads `overtaken` rather than `unknown_site`. That is the difference between
    // "delete this line" and "find out what happened".
    const parts = splitArguments(argument);
    const conversion = conversionName(parts[1] ?? "");
    push(match.index, "primitive", conversion, conversionExpression(parts[1] ?? ""), isReturned(code, match.index));
  }

  return { sites, coverage: { untracedRowReceivers, destructured, unannotated } };
}

/** Top-level comma split of an argument list, respecting brackets and strings. */
export function splitArguments(argument: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < argument.length) {
    const ch = argument[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(argument, i);
      continue;
    }
    // `=>` is skipped as a unit, because otherwise its `>` closes a bracket that never opened and
    // every later comma reads as top-level: measured, `(r) => id(r, 1)` split into two arguments.
    if (ch === "=" && argument[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(argument.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(argument.slice(start));
  return parts.map((p) => p.trim());
}

/* ------------------------------------------------------------ the workspace */

export interface PageReadScan {
  readonly files: number;
  readonly sites: readonly PageReadSite[];
  readonly coverage: ConventionCoverage;
  /** Workspace-relative paths of every source read, for the declaration's existence checks. */
  readonly scanned: readonly string[];
  /** `file -> text`, comment-stripped and string-blanked, for the refusal-code assertions. */
  readonly sources: ReadonlyMap<string, string>;
  readonly unhandledGlobs: readonly string[];
}

/**
 * Every multi-row read in the workspace, in one pass.
 *
 * The impure half, in one place, following `typecheck-config.ts`' split: the shape is decided by
 * functions that read nothing and the disk is touched here. `readWorkspaceSources` is reused rather
 * than walked again, which keeps the SQL rules and this one agreeing about what the workspace *is* —
 * and its exclusion of `*.test.ts` is wanted here, unlike in `pg-unreachable-stores.ts`, whose whole
 * question is whether a construction site is a test.
 *
 * `packages/testing` is exempt for `entity-field-aperture.ts`' reason: this member holds the rule, so
 * its own fixtures and prose are the very shape the scan looks for. String blanking already stops the
 * prose matching; the exemption is what stops the fixtures being a population nobody declared.
 */
export function scanWorkspacePageReads(
  sources: readonly WorkspaceSourceFile[],
  unhandledGlobs: readonly string[] = [],
): PageReadScan {
  const production = productionSources(sources).filter(
    (s) => !s.file.startsWith("packages/testing/"),
  );
  const index = buildFunctionIndex(production);
  const sites: PageReadSite[] = [];
  const untracedRowReceivers: string[] = [];
  const destructured: string[] = [];
  const unannotated: string[] = [];
  const texts = new Map<string, string>();
  for (const source of production) {
    const result = scanModuleForPageReads(source, index);
    sites.push(...result.sites);
    untracedRowReceivers.push(...result.coverage.untracedRowReceivers);
    destructured.push(...result.coverage.destructured);
    unannotated.push(...result.coverage.unannotated);
    // Comment-stripped and **string-intact**, which is load-bearing for the one thing this map is
    // for: a refusal code lives inside a string literal (`{error: "audit_page_unreadable"}`), so the
    // string-blanked view would answer "the handler does not contain that code" for every one of
    // them — the fail-open direction, since the check would then never fire.
    texts.set(source.file, codeViews(source.text).declared);
  }
  return {
    files: production.length,
    sites,
    coverage: { untracedRowReceivers, destructured, unannotated },
    // Every source, not only the production ones: a `refusedIn` names a route module, and a route
    // module is production — but the existence check must not fail because a path was filtered out
    // of the scan for being a fixture, which would read as a missing file.
    scanned: sources.map((s) => s.file),
    sources: texts,
    unhandledGlobs,
  };
}

/* ---------------------------------------------------------- the declaration */

/**
 * Every multi-row read that is allowed to lose a page, with the reason it is allowed to.
 *
 * Ordered by reason: the decisions first, the backlog last, so a reader sees what should stay true
 * before what should shrink. The count assertion in the test is against the **scan**, not against
 * this array's length, so a member deleted on its own is a failure rather than a smaller number.
 */
export const UNREADABLE_ROW_SITES: readonly UnreadableRowDeclaration[] = Object.freeze([
  /* --------------------------------- the caller catches and names it (5) */
  {
    file: "apps/operate-server/src/audit-read-store.ts",
    scope: "list",
    conversion: "rowToEntry",
    reason: "page_refusal_declared",
    refusalCode: "audit_page_unreadable",
    refusedIn: "apps/operate-server/src/audit-read-routes.ts",
    note:
      "ADR-0313's audit trail: the route catches the throw and answers 500 audit_page_unreadable rather than letting it escape unclassified, because a trail page that silently lost a row would be read as the tenant having done less than it did.",
  },
  {
    file: "apps/operate-server/src/integrity-verdict-store.ts",
    scope: "list",
    conversion: "rowToRecord",
    reason: "page_refusal_declared",
    refusalCode: "stored_verdict_invalid",
    refusedIn: "apps/operate-server/src/integrity-verdict-routes.ts",
    note:
      "A stored verdict that no longer parses is the one row an integrity reader must not be served silently; the route answers 500 stored_verdict_invalid and names it (ADR-0303).",
  },
  {
    file: "apps/operate-server/src/notification-template-store.ts",
    scope: "list",
    conversion: "templateFromRow",
    reason: "page_refusal_declared",
    refusalCode: "template_page_unreadable",
    refusedIn: "apps/operate-server/src/notification-template-routes.ts",
    note:
      "ADR-0313 refuses unsafe authored content rather than storing it, so a template row the contract refuses is an authoring defect the author must see: the route answers 400 template_page_unreadable, the only one of the five that is a 4xx.",
  },
  {
    file: "apps/operate-server/src/read-state-store.ts",
    scope: "indexFor",
    conversion: "rowToReadState",
    reason: "page_refusal_declared",
    refusalCode: "read_state_unavailable",
    refusedIn: "apps/operate-server/src/read-state-routes.ts",
    note:
      "ADR-0309's inbox: the store's own comment argues that an inbox which fails loudly beats one that hides a notice, and the route turns the throw into 503 read_state_unavailable so the nav badge degrades rather than lying.",
  },
  {
    file: "apps/operate-server/src/read-state-store.ts",
    scope: "indexFor",
    conversion: "rowToWatermark",
    reason: "page_refusal_declared",
    refusalCode: "read_state_unavailable",
    refusedIn: "apps/operate-server/src/read-state-routes.ts",
    note:
      "The watermark half of the same method and the same refusal: a watermark read as absent would re-show every notice below it, which is the one answer worse than a 503.",
  },
  /* --------------------------- throwing is the answer this read owes (5) */
  {
    file: "apps/operate-server/src/design-review-store.ts",
    scope: "counts",
    conversion: "<inline>",
    reason: "page_is_indivisible",
    consumedBy: "designReviewCounts",
    note:
      "An aggregate, not a page of records: a count computed over rows that silently skipped one is a wrong number presented as a count, which is the class ADR-0372 exists to end, and readRows has no per-row record here to hand back.",
  },
  {
    file: "apps/operate-server/src/integrity-verdict-store.ts",
    scope: "counts",
    conversion: "<inline>",
    reason: "page_is_indivisible",
    consumedBy: "integrityVerdictCounts",
    note:
      "The same aggregate shape one store over, and sharper because the figure is about audit-chain integrity: a verdict tally that under-counts compromised rows reads as a healthier chain than the database holds.",
  },
  {
    file: "apps/operate-server/src/recipient-resolver.ts",
    scope: "activeSuppressions",
    conversion: "<inline>",
    reason: "page_is_indivisible",
    consumedBy: "drainAllTenants",
    note:
      "ADR-0302 made both suppression readers fail closed on purpose: a suppression list short by one row mails the address that row exists to protect. The throw is bounded by design, because the drain catches per tenant and retries.",
  },
  {
    file: "apps/operate-server/src/suppression-store.ts",
    scope: "activeSuppressions",
    conversion: "suppressionFromRow",
    reason: "page_is_indivisible",
    consumedBy: "drainAllTenants",
    note:
      "The second of ADR-0302's two suppression readers, under the same rule: a partial safety list is worse than no answer, so this page may not be served short.",
  },
  {
    file: "packages/operate-runtime-pg/src/tenant-schema-erase.ts",
    scope: "surveyTenantSchema",
    conversion: "<inline>",
    reason: "page_is_indivisible",
    consumedBy: "eraseTenantSchema",
    note:
      "The survey a human approves a DROP SCHEMA from (ADR-0316), and the figures a tombstone commits to: a survey short by one table under-reports what is about to be destroyed, so refusing is the only answer that cannot license a false proof.",
  },
  /* ----------------------- ADR-0362's class: asserted, never parsed (11) */
  {
    file: "apps/operate-server/src/digest-store.ts",
    scope: "itemsFor",
    conversion: "digestItemFromRow",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a digest item whose category or priority is outside its enum is dispatched rather than reported",
    note:
      "digestItemFromRow is nine String() coercions in an object literal typed DigestItemRecord: category and priority reach a sender as whatever the column holds, and no clause of the contract is checked on read.",
  },
  {
    file: "apps/operate-server/src/recipient-resolver.ts",
    scope: "resolveAudience",
    conversion: "rowToRecipient",
    reason: "record_asserted_not_parsed",
    fencedBy: "UUID_RE",
    consequence:
      "displayName and primaryRole are asserted, so a malformed one reaches a dispatch unexamined",
    note:
      "rowToRecipient checks the two fields a delivery cannot proceed without and asserts the rest: a row failing those answers null and is dropped by the loop, which for an audience is a filter rather than a refusal.",
  },
  {
    file: "apps/operate-server/src/user-fk-readiness.ts",
    scope: "loadReferences",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a catalog shape this binary does not expect is reported as a reference rather than as a survey that could not be read",
    note:
      "A pg_catalog introspection row rather than a tenant record: UserReference is this module's own shape over columns Postgres itself produced, so there is no stored contract for a parse to check.",
  },
  {
    file: "packages/ai-architect-pg/src/message-store.ts",
    scope: "listForSession",
    conversion: "rowToRecord",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a transcript row outside its contract is served to the design-review surface unexamined",
    note:
      "ADR-0362's class, in the Architect transcript: rowToRecord returns a bare object literal typed as the record, so no clause of the contract has ever been checked on read and a row edited into a shape the contract forbids is served as if it were valid.",
  },
  {
    file: "packages/ai-architect-pg/src/proposal-store.ts",
    scope: "listForSession",
    conversion: "rowToRecord",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a transcript row outside its contract is served to the design-review surface unexamined",
    note:
      "ADR-0362's class, in the Architect transcript: rowToRecord returns a bare object literal typed as the record, so no clause of the contract has ever been checked on read and a row edited into a shape the contract forbids is served as if it were valid.",
  },
  {
    file: "packages/ai-architect-pg/src/session-store.ts",
    scope: "listForTenant",
    conversion: "rowToRecord",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a transcript row outside its contract is served to the design-review surface unexamined",
    note:
      "ADR-0362's class, in the Architect transcript: rowToRecord returns a bare object literal typed as the record, so no clause of the contract has ever been checked on read and a row edited into a shape the contract forbids is served as if it were valid.",
  },
  {
    file: "packages/operate-runtime-pg/src/entity-ops.ts",
    scope: "listOp",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "validateBody",
    consequence:
      "a document that no longer matches the entity it is served as reaches the gateway unexamined",
    note:
      "The JSONB document store hands the stored document straight back as an EntityRecord. The shape is fenced on the write path by the manifest's validation plan, not on read, so a document written by an earlier manifest is served against the current one.",
  },
  {
    file: "packages/workflow-runtime-pg/src/activity-claim.ts",
    scope: "claimDueActivities",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence: "an activity row outside its contract is handed to a worker rather than reported",
    note:
      "The activity half of the same claim shape, asserted the same way from its own RETURNING row.",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-cancellation.ts",
    scope: "reapCancelledJobRuns",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence:
      "a reaped run id that is not the shape the caller expects is logged rather than reported",
    note:
      "Two ids out of the reaper's own RETURNING clause, asserted as ReapedJobRun. There is no contract clause to check beyond the columns' own types.",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-claim.ts",
    scope: "claimDueJobs",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "JOB_KINDS",
    consequence:
      "attempts and the lease timestamps are asserted, so a hand-edited row is executed rather than reported",
    note:
      "The claim builds ClaimedJob from the row it just locked with no parse. The one field with a domain is job_kind, whose column CHECK pg-value-set-domains asserts mirrors the contract enum, so the database is the fence here rather than a read-side parse.",
  },
  {
    file: "packages/workflow-runtime-pg/src/timer-claim.ts",
    scope: "claimDueTimers",
    conversion: "<inline>",
    reason: "record_asserted_not_parsed",
    fencedBy: "nothing",
    consequence: "a timer row edited into a shape the contract forbids is fired rather than reported",
    note:
      "ClaimedTimer is built inline from the RETURNING row of the claim's own UPDATE, so every field is asserted from the column type. A worker acts on it immediately, which is why nothing between the two would be read.",
  },
  /* --------------------------- the row is dropped and nobody is told (2) */
  {
    file: "apps/operate-server/src/digest-store.ts",
    scope: "parseRows",
    conversion: "tryDigestFromRow",
    reason: "row_dropped_deliberately",
    consumedBy: "deliveryDrain",
    consequence:
      "a refused digest batch is never sent and never reported, so its recipients are silently skipped",
    note:
      "tryDigestFromRow is four lines of try/catch returning null, and parseRows filters it out: the page survives and the finding does not, so a digest batch the contract refuses leaves no trace at all.",
  },
  {
    file: "apps/operate-server/src/template-store.ts",
    scope: "parseRows",
    conversion: "tryTemplateFromRow",
    reason: "row_dropped_deliberately",
    consumedBy: "templateResolution",
    consequence:
      "a refused template is treated as absent, which is indistinguishable from one that was never authored",
    note:
      "The same shape one store over: a template row the contract refuses disappears from the page, so the notification that needed it falls back or fails with nothing naming the row.",
  },
  /* ------------------ the backlog: these should go through the primitive */
  {
    file: "apps/operate-server/src/delivery-store.ts",
    scope: "claimQueued",
    conversion: "<inline>",
    reason: "unmigrated",
    consequence:
      "a refused dispatch row costs every other recipient in the same claimed batch its delivery for that tick",
    note:
      "The notification drain's claim: one dispatch row the contract refuses ends the whole claimed batch, so the drain makes no progress on the other recipients it had just locked.",
  },
  {
    file: "apps/operate-server/src/delivery-store.ts",
    scope: "dueRetries",
    conversion: "<inline>",
    reason: "unmigrated",
    consequence: "a refused dispatch row stops every other due retry in the batch",
    note:
      "The retry half of the same drain, under the same cost: the batch is already claimed when the conversion runs.",
  },
  {
    file: "apps/operate-server/src/design-review-store.ts",
    scope: "list",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence:
      "a refused review row makes the whole review queue unreadable, so no design can be approved",
    note:
      "The reviewer's queue (ADR-0368's approval gate): one unreadable proposal hides every other tenant's pending design from the console.",
  },
  {
    file: "apps/operate-server/src/notification-store.ts",
    scope: "listForTenant",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused notification row empties the inbox rather than hiding one notice",
    note: "The tenant's own inbox page.",
  },
  {
    file: "apps/operate-server/src/platform-admin.ts",
    scope: "list",
    conversion: "rowToTenant",
    reason: "unmigrated",
    consequence:
      "a refused tenant row makes the tenant list unreadable, so no tenant can be administered from the console",
    note:
      "The platform console's tenant list, which is the surface an operator reaches every other platform act from.",
  },
  {
    file: "apps/operate-server/src/platform-users.ts",
    scope: "list",
    conversion: "rowToUser",
    reason: "unmigrated",
    consequence:
      "a refused user row makes the user list unreadable, so no credential can be set from the console",
    note: "ADR-0364's user registry page: the surface the first password is set from.",
  },
  {
    file: "apps/operate-server/src/platform-users.ts",
    scope: "membershipsForTenant",
    conversion: "rowToMembership",
    reason: "unmigrated",
    consequence: "a refused membership row hides every other member of that tenant",
    note: "The membership half of the same registry, which ADR-0365's role fence reads.",
  },
  {
    file: "apps/operate-server/src/tenant-manifests.ts",
    scope: "list",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused manifest row makes the design list unreadable for that tenant",
    note: "The activated-manifest list a tenant's own designs are read from (ADR-0314).",
  },
  {
    file: "packages/access-reviews-runtime-pg/src/evidence-store.ts",
    scope: "listByTenant",
    conversion: "rowToEvidence",
    reason: "unmigrated",
    consequence: "a refused evidence row makes a tenant's whole sealed-evidence history unreadable",
    note: "ADR-0335's evidence store, which is what makes a certification report certifiable at all.",
  },
  {
    file: "packages/ai-architect-pg/src/tool-invocation-store.ts",
    scope: "listForSession",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused invocation row makes a session's transcript unreadable",
    note: "The Architect's tool-invocation transcript, which is what makes a proposal auditable.",
  },
  {
    file: "packages/api-gateway-pg/src/route-registry.ts",
    scope: "loadCompiled",
    conversion: "rowToRoute",
    reason: "unmigrated",
    consequence:
      "latent while the store has no caller; if one lands, a refused route row un-serves every route in the registry",
    note:
      "PostgresRouteRegistry is declared callerless in pg-unreachable-stores.ts: ADR-0336 records it as a different serving model rather than a queue position, so the cost is latent.",
  },
  {
    file: "packages/billing-runtime-pg/src/invoice-store.ts",
    scope: "listByTenant",
    conversion: "rowToInvoice",
    reason: "unmigrated",
    consequence: "a refused invoice row makes a tenant's whole billing history unreadable",
    note:
      "The platform's own invoices to the tenant, which STATUTORY_RETENTION_TABLES keeps for seven years. rowToInvoice also calls JSON.parse on line_items, so a malformed JSONB column throws here as well as a contract refusal.",
  },
  {
    file: "packages/billing-runtime-pg/src/usage-store.ts",
    scope: "listBySubscription",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence:
      "a refused usage row makes a subscription's usage unreadable, so a period cannot be rated",
    note: "Metered usage for one subscription, which is what a rating run reads.",
  },
  {
    file: "packages/billing-runtime-pg/src/usage-store.ts",
    scope: "listUnsynced",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused usage row stops every other unsynced record reaching Stripe",
    note: "The unsynced read the Stripe usage sync drains.",
  },
  {
    file: "packages/certification-runtime-pg/src/report-store.ts",
    scope: "listRecent",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused report row makes the whole certification history unreadable",
    note: "The certification report history an auditor is shown.",
  },
  {
    file: "packages/certification-runtime-pg/src/report-store.ts",
    scope: "listByFramework",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence:
      "a refused report row makes a framework's history unreadable, and that is the read a certification claim is built from",
    note: "The per-framework read behind a SOC 2 or HIPAA answer.",
  },
  {
    file: "packages/crypto-pg/src/key-registry.ts",
    scope: "listKeys",
    conversion: "rowToKeyRegistryRecord",
    reason: "unmigrated",
    consequence:
      "a refused key row makes every other registered key unreadable, so a chain signature cannot be resolved at all",
    note:
      "The public-key directory a chain entry's signingKeyFingerprint resolves against (ADR-0332 gave it its own write grant for that reason).",
  },
  {
    file: "packages/feature-flags-pg/src/flag-store.ts",
    scope: "listWhere",
    conversion: "rowToFeatureFlag",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused flag row hides every other flag",
    note:
      "PostgresFeatureFlagStore is declared callerless (ADR-0336: nothing in the workspace evaluates a flag), so the cost is latent.",
  },
  {
    file: "packages/feature-flags-pg/src/kill-switch-store.ts",
    scope: "listActiveForFlag",
    conversion: "rowToKillSwitch",
    reason: "unmigrated",
    consequence:
      "a refused switch row makes an active kill switch unreadable, so a rolled-back flag reads as live",
    note: "The switch the SLO loop reads back when a restart adopts an incident (ADR-0296).",
  },
  {
    file: "packages/feature-flags-pg/src/targeting-rule-store.ts",
    scope: "read",
    conversion: "rowToTargetingRule",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused rule row makes a flag unresolvable against its own targeting",
    note:
      "PostgresTargetingRuleStore is declared callerless (ADR-0335 moved the defect rather than closing it), so the cost is latent.",
  },
  {
    file: "packages/forensics-pg/src/checkpoint-store.ts",
    scope: "listRecent",
    conversion: "rowToCheckpoint",
    reason: "unmigrated",
    consequence:
      "a refused checkpoint row makes the checkpoint history unreadable, which is the history a truncation check is witnessed by",
    note: "The anchors a bounded chain verification trusts its prefix on (ADR-0371).",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    scope: "listForIncident",
    conversion: "rowToComms",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused comms row hides every other notification for that incident",
    note:
      "PostgresCustomerCommsStore is declared callerless, and the table additionally cannot hold a late GDPR notification at all (register P2.13), so the cost is latent.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    scope: "listPublishedForIncident",
    conversion: "rowToComms",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused row hides every published notification",
    note: "The published-only read of the same callerless store.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    scope: "listBreachNotifications",
    conversion: "rowToComms",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused row hides every other breach notification",
    note: "The breach-notification read, which is the one a regulator asks for.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    scope: "listOpen",
    conversion: "rowToIncident",
    reason: "unmigrated",
    consequence:
      "a refused incident row hides every other open incident, so a restart re-declares rather than adopting",
    note: "The open-incident read the SLO and integrity escalators adopt an episode from (ADR-0294).",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    scope: "listForTenant",
    conversion: "rowToIncident",
    reason: "unmigrated",
    consequence: "a refused incident row makes a tenant's incident history unreadable",
    note: "The per-tenant incident read.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    scope: "listRecent",
    conversion: "rowToIncident",
    reason: "unmigrated",
    consequence: "a refused incident row makes the recent-incident view unreadable",
    note: "The recent-incident read.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/postmortem-store.ts",
    scope: "listForIncident",
    conversion: "rowToPostmortem",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused postmortem row hides every other one for that incident",
    note: "PostgresPostmortemStore is declared callerless (ADR-0296, ADR-0336), so the cost is latent.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/postmortem-store.ts",
    scope: "listUnpublished",
    conversion: "rowToPostmortem",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused row hides every unpublished postmortem",
    note: "The unpublished read of the same callerless store.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/replayer.ts",
    scope: "replayIncidents",
    conversion: "rowToIncident",
    reason: "unmigrated",
    consequence:
      "nothing is lost; the cost is a second spelling of one rule, which ADR-0334 records as where two copies eventually disagree",
    note:
      "The replayer already does the right thing in its own words — a parse failure is pushed as a drift finding and the sweep continues (ADR-0289) — through a per-row try/catch of its own rather than through readRows.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/runbook-store.ts",
    scope: "listForIncident",
    conversion: "rowToRunbookExecution",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused execution row hides every other step of that incident's runbook",
    note:
      "PostgresRunbookExecutionStore is declared callerless, and ADR-0336 records that there is no Runbook contract at all, so the cost is latent.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/runbook-store.ts",
    scope: "listUnfinished",
    conversion: "rowToRunbookExecution",
    reason: "unmigrated",
    consequence:
      "latent while nothing constructs the store; if one lands, a refused row hides every unfinished execution",
    note: "The unfinished read of the same callerless store.",
  },
  {
    file: "packages/marketplace-runtime-pg/src/installation-store.ts",
    scope: "listForTenant",
    conversion: "rowToInstallation",
    reason: "unmigrated",
    consequence: "a refused installation row makes every other installation for that tenant unreadable",
    note: "A tenant's installed packs.",
  },
  {
    file: "packages/marketplace-runtime-pg/src/installation-store.ts",
    scope: "activeForPack",
    conversion: "rowToInstallation",
    reason: "unmigrated",
    consequence:
      "a refused installation row hides every other active install, so a pack can be retired under tenants still using it",
    note: "The active installations of one pack, read before a retire decision.",
  },
  {
    file: "packages/marketplace-runtime-pg/src/version-store.ts",
    scope: "listByPack",
    conversion: "rowToRecord",
    reason: "unmigrated",
    consequence: "a refused version row makes a pack's version history unreadable",
    note: "A pack's published versions, which a compatibility answer is built from.",
  },
  {
    file: "packages/operate-runtime-pg/src/column-store.ts",
    scope: "listPageOn",
    conversion: "<inline>",
    reason: "unmigrated",
    consequence:
      "a refused record makes the whole page a 500, so one row written by an earlier manifest empties a collection for every caller",
    note:
      "Every list request a tenant makes against the typed column store, so this is the most-travelled conversion in the product.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/lifecycle-event-store.ts",
    scope: "listForTenant",
    conversion: "rowToLifecycleEvent",
    reason: "unmigrated",
    consequence: "a refused trail row makes the whole trail for that tenant unreadable",
    note:
      "ADR-0335's lifecycle trail: without it nothing in the database distinguishes a tenant that was deleted from one that never existed.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/lifecycle-event-store.ts",
    scope: "readTrailAsPlatform",
    conversion: "rowToLifecycleEvent",
    reason: "unmigrated",
    consequence: "a refused trail row makes the platform's own view of the trail unreadable",
    note:
      "The platform-elevated read of the same trail, which is the one an operator uses after the tenant is gone.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/lifecycle-event-store.ts",
    scope: "deletedTenants",
    conversion: "rowToLifecycleEvent",
    reason: "unmigrated",
    consequence:
      "a refused trail row makes the deleted-tenant list unreadable, so a deletion cannot be evidenced",
    note:
      "The read that answers which tenants were deleted, over a trail whose rows outlive their tenant.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/tombstone-store.ts",
    scope: "listForTenant",
    conversion: "rowToStoredTombstone",
    reason: "unmigrated",
    consequence: "a refused tombstone row makes every other proof for that tenant unreadable",
    note: "A tenant's Article 17 proofs.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/tombstone-store.ts",
    scope: "findForRequest",
    conversion: "rowToStoredTombstone",
    reason: "unmigrated",
    consequence:
      "a refused tombstone row makes the evidence for a stranded request unreadable, which the reconciler cannot tell from absent",
    note:
      "ADR-0322's one conclusive question — does a tombstone name this request — which the reconciler's whole asymmetry rests on.",
  },
  {
    file: "packages/workflow-runtime-pg/src/definition-store.ts",
    scope: "loadEngineDefinitions",
    conversion: "rowToWorkflowDefinition",
    reason: "unmigrated",
    consequence:
      "nothing is lost; the cost is that the reporting half is spelled here rather than shared",
    note:
      "Reports through the primitive's own textIdentity and unreadableDetail helpers and keeps the loop, because the loop also enforces one definition id per page, which readRows has no place to put.",
  },
  {
    file: "packages/workflow-runtime-pg/src/definition-store.ts",
    scope: "summariesForKey",
    conversion: "rowToWorkflowDefinition",
    reason: "unmigrated",
    consequence:
      "a refused definition row makes a key's version history unreadable, so a publication is decided against less than the table holds",
    note:
      "The published-version summaries for one workflow key, read before a publication decision (ADR-0331).",
  },
]);

/* ------------------------------------------------------------ refused anchors */

export interface RefusedRowPageAnchor {
  readonly anchor: string;
  readonly measurement: string;
}

/**
 * Anchors that were built, measured and refused, with the figure that refused each.
 *
 * Kept with their counts because every sibling does, and for the reason `pg-binding-names.ts` states:
 * a generalisation deleted rather than recorded is one the next person re-derives and re-abandons.
 * Every figure here was taken on the committed tree with the rule in this file.
 */
export const REFUSED_ROW_PAGE_ANCHORS: readonly RefusedRowPageAnchor[] = Object.freeze([
  {
    anchor: "every invocation of a row mapper, rather than a conversion applied to a row array",
    measurement:
      "114 call sites, of which 63 are single-row reads — `rowToX(result.rows[0])` and its `?? null` siblings — where throwing is correct because the caller asked about that one row and there is no other row's finding to lose. The array anchor excludes all 63 structurally rather than by a predicate anybody has to remember.",
  },
  {
    anchor: "any `<x>.rows` receiver, without tracing `<x>` to a `.query(` call",
    measurement:
      "3 false members whose rows never came from a database: `packages/migration/src/previews.ts` loops `run.rows` of a preview run in a package with no Postgres at all, and `audit-log-store.ts` maps `anchored.rows` where `anchored` is this store's own `{rows}` return shape. A rule that reports a domain loop as a Postgres read sends the next reader to the wrong layer.",
  },
  {
    anchor: "a `Record<string, unknown>[]` parameter as a row page in any module",
    measurement:
      "2 false members in `operate-runtime/src/write-effects.ts` — the pure accounting layer, which names `.query(` nowhere — looping a drained entity list. Gated on the module issuing a query, which keeps `digest-store.ts`' and `template-store.ts`' `parseRows(rows)` and costs nothing else.",
  },
  {
    anchor: "the enclosing scope's element type as the record type, unconditionally",
    measurement:
      "17 sites whose conversion produces nothing of the named type: `CheckAdmissionSurvey` for a loop building a `Set<string>`, `TenantStatusCounts` for a loop tallying integers, `LiveSchema` for an introspection fold. Restricted to an array-shaped annotation on a directly returned map, which also resolved the one declaration-key collision (`claimQueued` maps its page twice, to ids and to dispatches).",
  },
  {
    anchor: "the first call in the conversion that is not a total builtin, as its name",
    measurement:
      "9 sites named after a coercion helper rather than a mapper — `intOf`, `enum` (out of `z.enum`), `str`, `toText`, `isoOf` — each of which would have keyed a declaration on whatever cast somebody next changed. Requiring the row itself as the call's first argument names the mapper and answers `<inline>` where the row is taken apart at the call site.",
  },
  {
    anchor: "`functionSpans` from `entity-field-aperture.ts` as the scope index",
    measurement:
      "Its `DECLARATION` matches a module-level `function` or `const … = (`, and a class method is neither — so of the declaration-needing conversions, 57 of 68 would be attributed to `<module>` and 15 files would collapse 34 distinct sites onto one key apiece. The two scans answer different questions about the same text, so this one is separate rather than a widening of a module a sibling slice must stay free to change.",
  },
  {
    anchor: "treating a callee that catches as total, rather than as its own verdict",
    measurement:
      "4 members split two ways and the split is the finding: 2 conversions catch and **report** (`incident-response-runtime-pg`' replayer pushes a drift finding, `deletion-request-store`' `readRequestRows` calls its reporter) and 2 callees catch and **drop** (`tryDigestFromRow`, `tryTemplateFromRow`, four lines each). Collapsing them would have put a backlog entry on the two sites that already do the right thing, and a pass on the two that destroy the finding.",
  },
]);
