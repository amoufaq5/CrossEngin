/**
 * Which of this manifest's settleable documents are refused a settlement nothing has paid for, and
 * which are not — with the reason, per document, for every one that is not.
 *
 * ## The defect this reports on
 *
 * Measured on resolved `erp-core`, the shipped `--pack` default, **three** lifecycle transitions
 * reach the settled state — `Invoice.mark_paid` (from `sent`/`overdue`), `Bill.mark_paid` (from
 * `approved`/`overdue`) and `TaxReturn.mark_paid` (from `filed`) — and **no** write effect
 * `compile.ts` wires triggers on it at all: every `triggerState` is `sent` or `approved`, and
 * `settleableStates` are the states a document is settled *from*. The two `slas` entries beside
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
 * Because one of the three cannot be guarded, and an operator told nothing would reasonably read
 * the guard as covering every document that can be marked settled. `TaxReturn` has no `total`
 * field, and `Payment` declares no reference to it — so both operands of `total − applied` are
 * missing and the predicate is inexpressible rather than unwritten. Inventing one would be worse
 * than leaving it: `totalField: "total"` makes `num(undefined)` zero, so every write passes and the
 * guard reads as a control that is checking nothing (ADR-0337's falsely-true direction).
 *
 * Both of those facts are **derived from the manifest** here rather than asserted, so a pack that
 * later gives `TaxReturn` a total and a payment reference stops being reported without this file
 * being edited — and an entity that loses one starts being reported.
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
  SETTLED_DOCUMENT_STATE,
  SETTLEMENT_COVERAGE_DOCUMENTS,
  type SettlementCoverageConfig,
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

/** One document whose lifecycle can reach the settled state, and what covers it. */
export interface SettleableDocument {
  readonly entity: string;
  /** The transitions that reach the settled state, by name — what an operator would click. */
  readonly transitions: readonly string[];
  /**
   * Every gap that holds, in {@link SETTLEMENT_COVERAGE_GAP_ORDER}. Empty means guarded.
   *
   * A **list** and deliberately not one ranked `reason` beside a `covered` boolean: `TaxReturn`
   * satisfies two of these at once, so picking one would discard a true fact about it, and a
   * `reason` plus a `covered` flag is two fields that must agree — the pair this repository has
   * spent several increments on. `covered` is read off `reasons.length === 0` and nowhere stored.
   */
  readonly gaps: readonly SettlementCoverageGap[];
}

export const SETTLEMENT_COVERAGE_VERDICTS = [
  /** No lifecycle transition reaches the settled state, so there is nothing to cover. */
  "no_settleable_documents",
  /** Every settleable document is guarded. */
  "all_covered",
  /** Some are guarded and at least one is not. */
  "partly_covered",
  /** Settleable documents exist and none of them is guarded. */
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
 * not have, and refusing to serve `erp-core` because `TaxReturn` has no total field would refuse
 * the shipped default over a remedy that is an edit to this repository (ADR-0334's rule, and
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

  const documents: SettleableDocument[] = [];
  for (const [entity, transitions] of settleableEntities(manifest)) {
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
    documents.push({ entity, transitions, gaps });
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
 * unguarded.
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
 * which is the point of carrying the list: `TaxReturn` is missing both operands and a reader who
 * fixed only one would still not get a guard.
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
  const counts = `${report.coveredCount.toString()} of ${report.documents.length.toString()} guarded`;
  if (report.verdict === "all_covered") {
    return (
      `[settlement] settleable documents: ${counts} — a write putting one into` +
      ` '${SETTLED_DOCUMENT_STATE}' is refused unless completed payments cover its ${TOTAL_FIELD}:` +
      ` ${nameDocuments(report.documents)}`
    );
  }

  const lines = [`[settlement] settleable documents: ${counts}`];
  const covered = report.documents.filter((d) => d.gaps.length === 0);
  if (covered.length > 0) lines.push(`  guarded: ${nameDocuments(covered)}`);
  for (const gap of SETTLEMENT_COVERAGE_GAP_ORDER) {
    const group = report.documents.filter((d) => d.gaps.includes(gap));
    if (group.length === 0) continue;
    lines.push(`  ${group.length.toString()} unguarded (${gap}): ${SETTLEMENT_COVERAGE_GAPS[gap].gap}`);
    lines.push(`    ${nameDocuments(group)}`);
    lines.push(`    remedy: ${SETTLEMENT_COVERAGE_GAPS[gap].remedy}`);
  }
  // Said once at the end rather than per group, because it is the consequence of being unguarded
  // whatever the reason, and it is the sentence that makes the finding actionable: the two surfaces
  // disagree and nothing in this repository reconciles them.
  lines.push(
    `  an unguarded document marked '${SETTLED_DOCUMENT_STATE}' while payments fall short leaves` +
      ` the aging report showing nothing open and the GL control account still carrying the` +
      ` residual, with nothing reconciling the two`,
  );
  return lines.join("\n");
}
