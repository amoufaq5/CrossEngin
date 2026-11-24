/**
 * Which of this manifest's settleable documents are refused a settlement nothing has paid for, and
 * which are not — with the reason, per document, for every one that is not.
 *
 * ## The defect this reports on
 *
 * Measured on resolved `erp-core`, the shipped `--pack` default, **three** lifecycle transitions
 * reach the settled state — `Invoice.mark_paid` (from `sent`/`overdue`), `Bill.mark_paid` (from
 * `approved`/`overdue`) and `TaxReturn.mark_paid` (from `filed`) — and before ADR-0467 **no** write
 * effect `compile.ts` wired triggered on it at all: every `triggerState` was `sent` or `approved`,
 * and `settleableStates` are the states a document is settled *from*. The tax remittance posting is
 * now the one effect on that edge, and it is `TaxReturn`'s alone. The two `slas` entries beside
 * those transitions drive nothing (`slas` has one reader in the workspace, a validator). The other
 * six packs declare **none** of their own and inherit these three through `meta.extends`, which is
 * what bounds the whole subject to one pack.
 *
 * What goes wrong is **not** that the general ledger overstates the receivable. Marking an invoice
 * of 120 paid against 50 received is one of three business facts the edge cannot separate — a
 * write-off, a settlement received off-system, or operator error — which post to three different
 * accounts, so each posting that *did* happen is individually correct. What holds under all three
 * readings is the **divergence**: `computeAging` drops a document whose state is not in
 * `openStates`, so the aging subledger reports nothing open while the GL control account still
 * carries the residual, and nothing in this repository reconciles or reports the gap.
 *
 * ## Why a survey and not only a guard
 *
 * Because not every settleable document is settled by a payment, and an operator told nothing would
 * reasonably read the guard as covering every document that can be marked settled. A coverage guard
 * needs both operands of `total − applied` — a total on the document and a `Payment` reference to it
 * — and each is **derived from the manifest** here rather than asserted, so an entity that gains or
 * loses one changes its report without this file being edited.
 *
 * `TaxReturn` is the one document that has neither, and it is not reported for lacking them
 * (ADR-0467): a return is not settled by a payment at all but by its own remittance posting on
 * `mark_paid`, so naming the Payment-reference remedy for it would send an operator to build the
 * route ADR-0467 measured and refused (a `Payment` posts to accounts payable and clears no tax
 * account). Whether that posting is wired is `taxRemittanceWiring`, imported rather than restated,
 * so this report and the effect gate are two readers of one predicate.
 *
 * ## Reported, never refusing, and said either way
 *
 * `UNIQUE_ENFORCEMENT_MAY_SERVE`'s shape and `boot-erasure-report.ts`' rule: "we checked and found
 * nothing" cannot be claimed from the absence of a log line, so a manifest with no settleable
 * document says so rather than printing nothing — which in a boot log is indistinguishable from a
 * survey that did not run.
 */

import type { Manifest } from "@crossengin/kernel/manifest";
import { resolvedFields } from "@crossengin/kernel/ddl";
import {
  PAYMENT_DIRECTION,
  paymentAllocationShape,
  SETTLED_DOCUMENT_STATE,
  SETTLEMENT_COVERAGE_DOCUMENTS,
  TAX_REMITTANCE_POSTING_MODES,
  taxRemittanceUnwiredReasons,
  taxRemittanceWiring,
  type SettlementCoverageConfig,
  type TaxRemittancePostingMode,
  type TaxRemittanceWiring,
} from "@crossengin/operate-runtime";

type LifecycleWorkflow = Extract<
  NonNullable<NonNullable<Manifest["workflows"]>[string]>,
  { kind: "entityLifecycle" }
>;

/**
 * The flag that accepts an uncovered settlement knowingly.
 *
 * Declared in the module that owns the concept and read by `cli.ts`' parse arm, its help text and
 * this survey's remedy — `ALLOW_CURSOR_DISCLOSURE_FLAG`'s placement, for its reason: a flag spelled
 * at the parse site and again in a remedy is two spellings, and the remedy is the half that has to
 * be right, since it is what an operator types.
 */
export const ALLOW_UNCOVERED_SETTLEMENT_FLAG = "--allow-uncovered-settlement";

/** The entity whose rows carry what has been applied to a document. */
const PAYMENT_ENTITY = "Payment";

/** The field the coverage predicate reads as the amount owed, matching the guard's default. */
const TOTAL_FIELD = "total";

/**
 * The document settled by its own posting rather than by payments. Typed off the wiring's own
 * `entity`, so renaming it there is a compile error here rather than a survey that stops matching.
 */
const OWN_POSTING_ENTITY: TaxRemittanceWiring["entity"] = "TaxReturn";

/** The tenant setting that switches the posting on, and its two values, as the server spells them. */
const POSTING_SETTING = "finance.taxRemittancePosting";
const DEFAULT_POSTING_MODE: TaxRemittancePostingMode = TAX_REMITTANCE_POSTING_MODES[0];
const POSTING_ON_MODE: TaxRemittancePostingMode = TAX_REMITTANCE_POSTING_MODES[1];

/**
 * How many documents a group names before it summarises the rest.
 *
 * `unique-enforcement.ts`' `WITHHELD_FIELD_LIMIT` rule — the count stays exact even when the list
 * is truncated — but far smaller, because the population here is *documents with a lifecycle*
 * rather than fields: resolved `erp-core` has three, and a manifest with more than eight settleable
 * documents would be unlike anything in the packs.
 */
export const COVERAGE_DOCUMENT_LIMIT = 8;

/**
 * Why a settleable document is not guarded, with the sentence and the remedy for each.
 *
 * A total map, so a gap cannot be reported without a remedy beside it — and the remedy lives here
 * rather than where the line is formatted because "a remedy that cannot work is worse than none"
 * (ADR-0334), and a sentence written at the format site drifts from the condition it claims to fix.
 */
export const SETTLEMENT_COVERAGE_GAPS = {
  /**
   * The operator passed `--allow-uncovered-settlement`, so no coverage guard was built for any
   * document. Reported rather than silent precisely *because* it was asked for: the whole defect
   * was that an uncovered settlement left no trace, and a deployment that accepts it knowingly
   * should still be able to read off its own boot log which documents it accepted that for.
   */
  coverage_disabled: {
    gap: `${ALLOW_UNCOVERED_SETTLEMENT_FLAG} was passed, so no coverage guard was built`,
    remedy:
      `drop ${ALLOW_UNCOVERED_SETTLEMENT_FLAG} to refuse a settlement completed payments do not` +
      " cover; an uncovered document is recoverable — record the payment and the two views reconcile",
  },
  /**
   * The manifest declares no `Payment` entity, so there is nothing anywhere that records money
   * arriving and the predicate's right operand has no source at all. Blocked by **shape**, not by
   * wiring — `pg-unreachable-stores.ts` keeps those apart on the stated grounds that calling both
   * "unwired" sends the next person to write the thing that cannot be written honestly.
   */
  no_payment_entity: {
    gap: `the manifest declares no '${PAYMENT_ENTITY}' entity, so nothing records what has been applied`,
    remedy:
      `declare a '${PAYMENT_ENTITY}' entity with a reference to each settleable document, which is` +
      " also what the settlement GL postings and the aging report read",
  },
  /**
   * The entity declares no `total` field, so the predicate's **left** operand is missing.
   *
   * Ranked first among the two operand gaps in the group ordering below, because this is the one
   * that fails in the *reassuring* direction: `num(undefined)` is 0, so a guard built anyway would
   * find every document covered and pass every write while reading as a control. A missing
   * reference fails the other way and refuses everything, which is wrong and loud.
   */
  no_total_field: {
    gap: `the entity declares no '${TOTAL_FIELD}' field, so there is no amount owed to compare against`,
    remedy:
      `declare the amount owed as '${TOTAL_FIELD}' on the entity — a guard built without it would` +
      " read every document as covered and pass every write, which is worse than being unguarded",
  },
  /**
   * No `Payment` reference field targets this entity, so the predicate's **right** operand is
   * unreachable: nothing can be applied to a document no payment can name.
   */
  no_payment_reference: {
    gap: `no '${PAYMENT_ENTITY}' reference field targets this entity, so no payment can be applied to it`,
    remedy:
      `add a reference field on '${PAYMENT_ENTITY}' targeting this entity, and settle it through a` +
      " payment the way the guarded documents are settled",
  },
  /**
   * Both operands are present and the entity is still not in `SETTLEMENT_COVERAGE_DOCUMENTS`.
   *
   * The residual, and it is named rather than folded into one of the four above because its remedy
   * is the only one that is not an act on a manifest: the declaration lives in this repository, so
   * this is the one gap an operator cannot clear and the sentence says so instead of sending them
   * to edit something they do not own.
   */
  not_declared: {
    gap:
      "the entity can be settled and carries both operands, but no entry in" +
      " SETTLEMENT_COVERAGE_DOCUMENTS names it",
    remedy:
      "an entry naming the entity and its payment reference field would cover it; that declaration" +
      " is in @crossengin/operate-runtime rather than in this deployment's manifest",
  },
  /**
   * `TaxReturn` settles through its own remittance posting (ADR-0467) and this manifest does not
   * carry everything that posting reads, so `mark_paid` posts nothing for every tenant whatever
   * their `finance.taxRemittancePosting` says. The reasons are per manifest and travel on the
   * document; the remedy here is the one sentence true of all of them.
   *
   * Last, because it is the only gap that belongs to a different mechanism: the four operand and
   * declaration gaps above are about payment coverage and are never reported for this document.
   */
  tax_remittance_unwired: {
    gap:
      "the return settles through its own remittance posting on mark_paid, and this manifest lacks" +
      " what that posting reads, so mark_paid posts nothing",
    remedy:
      "declare what the reasons name, or post each remittance as a manual journal entry beside" +
      " mark_paid — never as a Payment, which posts to accounts payable and clears no tax account",
  },
} as const;

export type SettlementCoverageGap = keyof typeof SETTLEMENT_COVERAGE_GAPS;

/**
 * The order groups are printed in, and the order a reader should take the gaps in.
 *
 * Derived from the map's own keys, so a sixth gap cannot be added without choosing where it sits —
 * and the declaration order encodes the ranking argued in each member's doc: the two
 * deployment-wide facts first, because they explain every document at once, then the operand that
 * fails toward a vacuous pass, then the operand that fails toward refusal, then the residual.
 */
export const SETTLEMENT_COVERAGE_GAP_ORDER: readonly SettlementCoverageGap[] = Object.keys(
  SETTLEMENT_COVERAGE_GAPS,
) as SettlementCoverageGap[];

/**
 * The mechanism that keeps a settleable document's status and the ledger in agreement. Fixed by the
 * entity, not by whether it is in force: an unguarded `Invoice` is still settled by payment
 * coverage, and `gaps` says why that coverage is absent.
 */
export const SETTLEMENT_MECHANISMS = ["payment_coverage", "own_posting"] as const;
export type SettlementMechanism = (typeof SETTLEMENT_MECHANISMS)[number];

/** One document whose lifecycle can reach the settled state, and what covers it. */
export interface SettleableDocument {
  readonly entity: string;
  /** The transitions that reach the settled state, by name — what an operator would click. */
  readonly transitions: readonly string[];
  readonly mechanism: SettlementMechanism;
  /**
   * For `own_posting`, why the posting is not wired — `taxRemittanceUnwiredReasons`, verbatim and
   * `[]` when it is. Always `[]` for `payment_coverage`, whose gaps are the vocabulary above.
   */
  readonly unwiredReasons: readonly string[];
  /**
   * Every gap that holds, in {@link SETTLEMENT_COVERAGE_GAP_ORDER}. Empty means covered.
   *
   * A **list** and deliberately not one ranked `reason` beside a `covered` boolean: a document can
   * satisfy two of these at once (no total *and* no payment reference), so picking one would discard a true fact about it, and a
   * `reason` plus a `covered` flag is two fields that must agree — the pair this repository has
   * spent several increments on. `covered` is read off `reasons.length === 0` and nowhere stored.
   */
  readonly gaps: readonly SettlementCoverageGap[];
}

export const SETTLEMENT_COVERAGE_VERDICTS = [
  /** No lifecycle transition reaches the settled state, so there is nothing to cover. */
  "no_settleable_documents",
  /** Every settleable document is guarded, or settled by its own wired posting. */
  "all_covered",
  /** Some are covered and at least one is not. */
  "partly_covered",
  /** Settleable documents exist and none of them is covered. */
  "none_covered",
] as const;
export type SettlementCoverageVerdict = (typeof SETTLEMENT_COVERAGE_VERDICTS)[number];

/**
 * Whether each verdict permits a boot. `UNIQUE_ENFORCEMENT_MAY_SERVE`'s shape, and **every member
 * is `true`**: this survey reports and never refuses.
 *
 * The refusal is in the **guard**, where it belongs: a write that would create the divergence is
 * refused at the moment it is attempted, so there is nothing left for a boot refusal to prevent. A
 * document that *cannot* be guarded is a different thing — it is a capability this deployment does
 * not have, and refusing to serve a manifest because a document lacks a total field would refuse
 * a deployment that works over a remedy that is an edit to this repository (ADR-0334's rule, and
 * `list-surface-survey.ts`' reason for reporting where ADR-0338 refuses).
 *
 * `coverage_disabled` is `true` for the reason the flag exists at all: an uncovered settlement is
 * degraded-but-**recoverable** — record the payment and the two views reconcile — so it is a state
 * an operator may knowingly accept, unlike an unevaluated ABAC obligation, which is the opposite of
 * what the manifest declares and which nothing a tenant does repairs.
 */
export const SETTLEMENT_COVERAGE_MAY_SERVE: Readonly<Record<SettlementCoverageVerdict, true>> = {
  no_settleable_documents: true,
  all_covered: true,
  partly_covered: true,
  none_covered: true,
};

export interface SettlementCoverageReport {
  readonly verdict: SettlementCoverageVerdict;
  /** Every document whose lifecycle reaches the settled state, in manifest workflow order. */
  readonly documents: readonly SettleableDocument[];
  /** Documents with no gap: guarded by payment coverage, or settled by their own wired posting. */
  readonly coveredCount: number;
  readonly mayServe: boolean;
}

/** Whether `--allow-uncovered-settlement` was passed; the survey's only non-manifest input. */
export interface SettlementCoverageInput {
  readonly allowUncoveredSettlement: boolean;
}

/** The documents the runtime builds a guard for, by entity name. */
function declaredCoverage(): ReadonlyMap<string, SettlementCoverageConfig> {
  return new Map(SETTLEMENT_COVERAGE_DOCUMENTS.map((doc) => [doc.entity, doc]));
}

/**
 * Every entity whose lifecycle has a transition targeting the settled state, with those
 * transitions' names.
 *
 * Transitions and **not** `states`: a state nothing transitions to cannot be reached through a
 * lifecycle, which is `producibleEntityEventNames`' measured rule one domain across (reading states
 * there reports 18 names no write can emit). It is also the honest denominator for this survey —
 * what is surveyed is *the ways a document can be marked settled*, and an unreachable state is not
 * one. `slas` are deliberately not read: an SLA carries no trigger, no guard and no effect, and its
 * only reader in the workspace checks that its `from`/`to` name declared states, so it cannot move
 * a document anywhere.
 *
 * It deliberately does **not** read the lifecycle's `stateField`, and there is no
 * `state_field_unreadable` gap, because `defaultWriteGuards` now keys each guard on that same
 * lifecycle's `stateField` rather than on the `state` fallback. Before that it had to: the guard
 * read `after["state"]` by name, so a manifest driving `status` got an inert guard while this
 * survey went on naming the entity as guarded — ADR-0337's falsely-true direction on the surface
 * built to make the gap legible. With the wiring one level up, survey-says-guarded and
 * guard-can-fire are the same fact, so a gap for the difference would be a verdict with no producer
 * (ADR-0336's class) — and a `stateField` naming a field the entity does not resolve is refused by
 * `validateWorkflows` (ADR-0359), so the remaining case cannot reach here either.
 */
function settleableEntities(manifest: Manifest): ReadonlyMap<string, string[]> {
  const found = new Map<string, string[]>();
  for (const workflow of Object.values(manifest.workflows ?? {})) {
    if (workflow.kind !== "entityLifecycle") continue;
    const lifecycle: LifecycleWorkflow = workflow;
    for (const transition of lifecycle.transitions) {
      if (transition.to !== SETTLED_DOCUMENT_STATE) continue;
      const names = found.get(lifecycle.entity) ?? [];
      names.push(transition.name);
      found.set(lifecycle.entity, names);
    }
  }
  return found;
}

/**
 * Surveys every settleable document against the coverage the runtime will build for it.
 *
 * Through `resolvedFields` and **not** `entity.fields`, because the total field can arrive from a
 * trait and would then be a real column the guard reads and this survey never saw — one surface
 * resolving traits while another reads the raw list is a live defect class in this repo
 * (ADR-0361). No builtin trait declares a `total` today, which is exactly when reading it costs
 * nothing.
 */
export function surveySettlementCoverage(
  manifest: Manifest,
  input: SettlementCoverageInput,
): SettlementCoverageReport {
  const traits = manifest.traits ?? [];
  const entities = new Map((manifest.entities ?? []).map((e) => [e.name, e]));
  const payment = entities.get(PAYMENT_ENTITY);
  // The documents `Payment` can name. Read off each reference field's own `target`, which is where
  // a reference's destination lives — the `relations` section is a separate declaration and does
  // not carry these three (measured on `erp-core`: one `Payment` relation, for `account_id`).
  const paymentTargets = new Set<string>();
  if (payment !== undefined) {
    for (const field of resolvedFields(payment, traits)) {
      if (field.type.kind === "reference") paymentTargets.add(field.type.target);
    }
  }
  const declared = declaredCoverage();
  // Asked once: the reasons are a property of the manifest, and `[]` exactly when the wiring the
  // effects gate on is non-null — so this report and the posting cannot disagree.
  const unwired = taxRemittanceUnwiredReasons(manifest);

  const documents: SettleableDocument[] = [];
  for (const [entity, transitions] of settleableEntities(manifest)) {
    if (entity === OWN_POSTING_ENTITY) {
      // No coverage gap of any kind, the flag's included: `--allow-uncovered-settlement` disables a
      // coverage guard, and this document never had one to disable.
      documents.push({
        entity,
        transitions,
        mechanism: "own_posting",
        unwiredReasons: unwired,
        gaps: unwired.length > 0 ? ["tax_remittance_unwired"] : [],
      });
      continue;
    }
    const gaps: SettlementCoverageGap[] = [];
    if (input.allowUncoveredSettlement) gaps.push("coverage_disabled");
    if (payment === undefined) gaps.push("no_payment_entity");
    const fields = entities.get(entity);
    const hasTotal =
      fields !== undefined && resolvedFields(fields, traits).some((f) => f.name === TOTAL_FIELD);
    if (!hasTotal) gaps.push("no_total_field");
    // Suppressed when there is no `Payment` entity at all, where it is vacuously true and its
    // remedy — add a reference field *on Payment* — presupposes the entity the gap above says is
    // missing. ADR-0334's rule, and `no_payment_entity`'s own remedy already asks for the
    // references, so nothing is lost by saying it once.
    if (payment !== undefined && !paymentTargets.has(entity)) gaps.push("no_payment_reference");
    // Last, and only when nothing else explains it: a declaration gap reported beside a missing
    // operand would send a reader to add an entry that could not work.
    if (gaps.length === 0 && !declared.has(entity)) gaps.push("not_declared");
    documents.push({ entity, transitions, mechanism: "payment_coverage", unwiredReasons: [], gaps });
  }

  const coveredCount = documents.filter((d) => d.gaps.length === 0).length;
  const verdict = decideVerdict(documents.length, coveredCount);
  return {
    verdict,
    documents,
    coveredCount,
    mayServe: SETTLEMENT_COVERAGE_MAY_SERVE[verdict],
  };
}

/**
 * The verdict is the **worst** fact in hand, so `none_covered` is tested before `partly_covered`: a
 * deployment covering nothing and one covering most of its documents want different first
 * sentences, and reporting the milder when both could be read would understate the headline.
 */
function decideVerdict(total: number, covered: number): SettlementCoverageVerdict {
  if (total === 0) return "no_settleable_documents";
  if (covered === total) return "all_covered";
  if (covered === 0) return "none_covered";
  return "partly_covered";
}

/**
 * True when this report deserves a `warn` rather than an `info`: any settleable document is
 * uncovered — an unguarded payment-settled one, or a return whose own posting is unwired.
 *
 * Reads the same list the verdict is computed from, so the level an operator sees and the verdict
 * they read cannot disagree about one deployment — `uniqueEnforcementIsSuspect`' stated reason for
 * sharing its predicate with the arm above it.
 */
export function settlementCoverageIsSuspect(report: SettlementCoverageReport): boolean {
  return report.documents.some((d) => d.gaps.length > 0);
}

/** `Invoice (mark_paid), Bill (mark_paid) (+N more)` — names only, bounded, count always exact. */
function nameDocuments(documents: readonly SettleableDocument[]): string {
  const shown = documents
    .slice(0, COVERAGE_DOCUMENT_LIMIT)
    .map((d) => `${d.entity} (${d.transitions.join(", ")})`);
  const hidden = documents.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? ` (+${hidden.toString()} more)` : ""}`;
}

/**
 * The boot line, affirmative in both directions.
 *
 * Grouped by gap in `SETTLEMENT_COVERAGE_GAP_ORDER` so the output is stable across boots and
 * diffable between two manifests, and so each remedy is printed once beside the documents it
 * applies to rather than once per document. A document satisfying two gaps appears under both,
 * which is the point of carrying the list: a document missing both operands is reported under both,
 * and a reader who fixed only one would still not get a guard.
 *
 * Entity and transition **names** come from the manifest and are not a disclosure; no record value
 * reaches this module, which has nowhere to put one.
 */
export function formatSettlementCoverageReport(report: SettlementCoverageReport): string {
  if (report.verdict === "no_settleable_documents") {
    return (
      `[settlement] settleable documents: none — no lifecycle transition in this manifest reaches` +
      ` '${SETTLED_DOCUMENT_STATE}', so no document can be marked settled and there is no coverage` +
      ` to guarantee or to withhold`
    );
  }
  const covered = report.documents.filter((d) => d.gaps.length === 0);
  const guarded = covered.filter((d) => d.mechanism === "payment_coverage");
  const posting = covered.filter((d) => d.mechanism === "own_posting");
  // Counted per mechanism, never summed: a return settled by its own posting posts nothing for a
  // tenant left on the default mode, so adding it to the guarded documents would read "3 of 3
  // covered" on a deployment whose only guarantee is the two payment guards.
  const paymentDocs = report.documents.filter((d) => d.mechanism === "payment_coverage");
  const postingDocs = report.documents.filter((d) => d.mechanism === "own_posting");
  const counts = [
    ...(paymentDocs.length > 0
      ? [`${guarded.length.toString()} of ${paymentDocs.length.toString()} payment-settled guarded`]
      : []),
    ...(postingDocs.length > 0
      ? [`${posting.length.toString()} of ${postingDocs.length.toString()} settled by its own posting wired (per tenant)`]
      : []),
  ].join("; ");
  const lines = [`[settlement] settleable documents: ${counts}`];
  if (guarded.length > 0) {
    lines.push(
      `  guarded: ${nameDocuments(guarded)} — a write putting one into '${SETTLED_DOCUMENT_STATE}'` +
        ` is refused unless completed payments cover its ${TOTAL_FIELD}`,
    );
  }
  if (posting.length > 0) {
    // The per-tenant condition is said here because a boot cannot see it: every tenant that has not
    // opted in is in the default mode, where nothing posts and a manual journal must accompany the
    // status change.
    lines.push(
      `  settled by its own posting: ${nameDocuments(posting)} — ${OWN_POSTING_ENTITY}.mark_paid` +
        ` posts the remittance when a tenant sets ${POSTING_SETTING}=${POSTING_ON_MODE}; in the` +
        ` default ${DEFAULT_POSTING_MODE} mode it posts nothing and a manual journal must accompany it`,
    );
  }
  for (const gap of SETTLEMENT_COVERAGE_GAP_ORDER) {
    const group = report.documents.filter((d) => d.gaps.includes(gap));
    if (group.length === 0) continue;
    lines.push(`  ${group.length.toString()} uncovered (${gap}): ${SETTLEMENT_COVERAGE_GAPS[gap].gap}`);
    lines.push(`    ${nameDocuments(group)}`);
    const reasons = [...new Set(group.flatMap((d) => d.unwiredReasons))];
    if (reasons.length > 0) lines.push(`    reasons: ${reasons.join("; ")}`);
    lines.push(`    remedy: ${SETTLEMENT_COVERAGE_GAPS[gap].remedy}`);
  }
  // Said once rather than per group, because it is the consequence of an unguarded *payment-settled*
  // document whatever the reason, and it is the sentence that makes the finding actionable: the two
  // surfaces disagree and nothing in this repository reconciles them. Not said for an unwired
  // posting alone, whose consequence is a different one and is in its own gap sentence.
  if (report.documents.some((d) => d.mechanism === "payment_coverage" && d.gaps.length > 0)) {
    lines.push(
      `  an unguarded document marked '${SETTLED_DOCUMENT_STATE}' while payments fall short leaves` +
        ` the aging report showing nothing open and the GL control account still carrying the` +
        ` residual, with nothing reconciling the two`,
    );
  }
  return lines.join("\n");
}

/**
 * The `[tax-remittance]` boot line, said either way: whether this manifest can post a return's
 * remittance on `mark_paid`, and, when it can, that it does so only for a tenant that opts in.
 *
 * The same predicate as the survey and the effect gate, so the three cannot disagree about one
 * manifest — and the reasons are `taxRemittanceUnwiredReasons`' own sentences rather than a
 * paraphrase, which is the half that would otherwise drift.
 */
export function formatTaxRemittanceWiring(manifest: Manifest): string {
  if (taxRemittanceWiring(manifest) !== null) {
    return (
      `[tax-remittance] wired: ${OWN_POSTING_ENTITY}.mark_paid posts when a tenant sets` +
      ` ${POSTING_SETTING}=${POSTING_ON_MODE} (default ${DEFAULT_POSTING_MODE})`
    );
  }
  return `[tax-remittance] unwired: ${taxRemittanceUnwiredReasons(manifest).join("; ")}`;
}

/**
 * Whether the line deserves a `warn`: the manifest declares a `TaxReturn` and the posting is
 * unwired, so marking one paid posts nothing for every tenant whatever their setting says. A manifest
 * with no `TaxReturn` at all has nothing to warn about, and its line is informational.
 */
export function taxRemittanceWiringIsSuspect(manifest: Manifest): boolean {
  return (
    (manifest.entities ?? []).some((e) => e.name === OWN_POSTING_ENTITY) &&
    taxRemittanceWiring(manifest) === null
  );
}

/**
 * The per-tenant line, or `null` when there is nothing to say: only a tenant's own activated
 * manifest that declares a `TaxReturn` and cannot post its remittance. Silent otherwise, which is
 * `formatTenantManifestSurvey`'s rule — the fact that the check ran is said once, at boot, and a
 * clean line per tenant per activation is the noise that gets filtered out with the findings.
 */
export function formatTenantTaxRemittanceWiring(tenantId: string, manifest: Manifest): string | null {
  if (!taxRemittanceWiringIsSuspect(manifest)) return null;
  return formatTaxRemittanceWiring(manifest).replace(
    "[tax-remittance] ",
    `[tax-remittance] tenant ${tenantId}: `,
  );
}

/**
 * The `[payment-allocation]` boot line, said either way (ADR-0468): whether the guard that keeps a
 * payment naming at most one document, only one its direction settles and in that document's
 * currency, and no negative amount is
 * mounted for this manifest, and over which references.
 *
 * Read from `paymentAllocationShape` — the function `defaultWriteGuards` builds the guard from — so
 * the line and the guard cannot describe two different checks. Not gated on
 * `--allow-uncovered-settlement`, and neither is the guard: that flag waives coverage of a document's
 * total, which is a different defect.
 */
export function formatPaymentAllocationCheck(manifest: Manifest): string {
  const shape = paymentAllocationShape(manifest);
  if (shape === null) {
    const hasPayment = (manifest.entities ?? []).some((e) => e.name === PAYMENT_ENTITY);
    return hasPayment
      ? `[payment-allocation] not mounted: no document a payment settles (${SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.entity).join(", ")}) is declared`
      : `[payment-allocation] not mounted: the manifest declares no ${PAYMENT_ENTITY}`;
  }
  if (shape.references.length === 0) {
    // The references of the documents this manifest declares — not every entry of the declaration,
    // which would say `Payment` lacks a field it may well declare for a document that is absent.
    return (
      `[payment-allocation] mounted: ${PAYMENT_ENTITY} declares no reference to a declared document (` +
      shape.documents.map((d) => d.refField).join(", ") +
      "), so only a negative amount is refused"
    );
  }
  const refs = shape.references.map((d) => `${d.refField} (${d.settledBy})`).join(", ");
  const base = `[payment-allocation] mounted: a payment names at most one of ${refs}, only one its direction settles and in that document's currency, and no negative amount`;
  if (paymentAllocationCheckIsSuspect(manifest)) {
    return (
      `${base}; ${PAYMENT_ENTITY} cannot record an '${PAYMENT_DIRECTION.inboundValue}' ${PAYMENT_DIRECTION.field}, so every` +
      " payment reads as outbound and a payment naming an invoice is refused"
    );
  }
  return base;
}

/**
 * Whether the line deserves a `warn`: a document settled by inbound money is a reference here while
 * `Payment`'s direction field cannot hold the inbound value (the write validator's answer, through
 * `paymentAllocationShape`), so every payment reads as outbound and naming it is refused. Where the
 * ledger is wired the posting would clear the payable for such a payment; the guard does not depend
 * on that, so neither does this sentence.
 */
export function paymentAllocationCheckIsSuspect(manifest: Manifest): boolean {
  const shape = paymentAllocationShape(manifest);
  return shape !== null && !shape.directionExpressible && shape.references.some((d) => d.settledBy === "inbound");
}

/**
 * The per-tenant line, or `null` when there is nothing to say — `formatTenantTaxRemittanceWiring`'s
 * rule: the fact that the check ran is said once at boot, and only a tenant's own manifest in the
 * suspect shape is worth a line per activation.
 */
export function formatTenantPaymentAllocationCheck(tenantId: string, manifest: Manifest): string | null {
  if (!paymentAllocationCheckIsSuspect(manifest)) return null;
  return formatPaymentAllocationCheck(manifest).replace("[payment-allocation] ", `[payment-allocation] tenant ${tenantId}: `);
}
