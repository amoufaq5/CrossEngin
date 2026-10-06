import {
  EVALUATION_REASONS,
  flagEvaluationIsImplemented,
  unproducibleEvaluationReasons,
} from "@crossengin/feature-flags";

import { PostgresFeatureFlagStore } from "./flag-store.js";
import { PostgresKillSwitchStore } from "./kill-switch-store.js";
import { PostgresTargetingRuleStore } from "./targeting-rule-store.js";

/**
 * Why a store in this package exists and has no caller.
 *
 * This is `packages/testing/src/strategy/pg-storeless-tables.ts`' shape turned the other way round.
 * That rule asks *which catalogued table has no store*; nothing asks *which store has no caller*,
 * and the two are different questions — ADR-0335 demonstrated it by **moving** a defect rather than
 * closing one: `meta.feature_flag_targeting_rules` left the writerless census the moment
 * `PostgresTargetingRuleStore` was written, so the table went from a place a rule watches to a place
 * nothing watches, and the fence read greener for it.
 *
 * The inverse rule wants its own increment and belongs over the dependency graph rather than over
 * SQL. This list is what it should read for this package when it lands. It is declared here, beside
 * the stores, for `kernel-pg`'s reason for keeping `scopeFilter`'s rationale local: the *local*
 * argument — why this particular store has no caller, and whether that is a defect or a decision —
 * stays where a reader of the package looks.
 */
export const CALLERLESS_STORE_REASONS = [
  /**
   * The store is correct and the thing that would call it does not exist. Not "unwired" — there is
   * no wire to run, because no component in the workspace consumes what the store returns.
   */
  "no_consumer_exists",
  /**
   * A consumer could exist but the write is privileged enough that shipping the route is a product
   * decision, not a wiring step. ADR-0313's grade: a write that changes what the deployment serves
   * is at least `config`-grade and wants the author/approver/four-eyes apparatus.
   */
  "awaiting_authoring_grant",
] as const;
export type CallerlessStoreReason = (typeof CALLERLESS_STORE_REASONS)[number];

export interface CallerlessStoreDeclaration {
  /** The exported class, exactly as `index.ts` re-exports it. */
  readonly symbol: string;
  /** The module inside `src/` that declares it. */
  readonly module: string;
  readonly reason: CallerlessStoreReason;
  /** What the deployment does not get because nothing constructs this. */
  readonly consequence: string;
  /** The evidence, and the decision if there is one. */
  readonly note: string;
}

/**
 * The two stores in this package that nothing outside their own tests constructs, and why each is
 * left that way.
 *
 * The third, `PostgresKillSwitchStore`, is **not** here: `observability-runtime-pg`'s
 * `buildPersistentEngine` and `buildPersistentLatencyEngine` both construct it, so the SLO loop
 * writes a kill switch when it rolls a flag back. That contrast is what makes the question sharp
 * and it is also sharper than it looks — see `KILL_SWITCH_ENFORCEMENT_GAP`. One store in this
 * package is constructed; none of the three has a reader that acts on what it stores.
 */
export const CALLERLESS_FLAG_STORES: readonly CallerlessStoreDeclaration[] = Object.freeze([
  Object.freeze({
    symbol: "PostgresFeatureFlagStore",
    module: "flag-store.ts",
    reason: "no_consumer_exists",
    consequence:
      "meta.feature_flags holds no rows in any deployment, so every id a KillSwitch's flag_id names " +
      "resolves to nothing, and the flag_id foreign key ADR-0300 made addable stays unaddable for " +
      "ADR-0291's reason — it cannot be proven against rows that do not exist.",
    note:
      "ADR-0300 built this store and never claimed to wire it: its Decision reads 'packages/" +
      "feature-flags-pg gains PostgresFeatureFlagStore alongside the kill-switch store', and its " +
      "rejection of Option B (reconcile, add no store) argues that 'the store is what makes the next " +
      "drift fail loudly'. ADR-0332 disproved that argument rather than the decision: " +
      "FEATURE_FLAG_COLUMN_NAMES said default_value where the catalog said default_value_json, the " +
      "store could not round-trip a single flag against any real database, and no offline test saw " +
      "it — a fake connection asserts SQL shape and cannot know a column does not exist. What makes " +
      "drift fail loudly is the assertion against META_TABLES, not the store.",
  }),
  Object.freeze({
    symbol: "PostgresTargetingRuleStore",
    module: "targeting-rule-store.ts",
    reason: "awaiting_authoring_grant",
    consequence:
      "A flag's targeting_rule_ids can be resolved but no rule can be authored, so the three " +
      "TARGETING_RULE_SET_DEFECTS are unreachable in practice: with no flag row there is no list to " +
      "disagree with, and rule_missing — the fail-open-on-an-exclusion case the refusal exists for — " +
      "cannot arise.",
    note:
      "ADR-0335 shipped this store and said in its own open questions that nothing constructs it, " +
      "and that shipping no authoring route was deliberate. That reasoning stands and survives this " +
      "declaration naming it: a targeting rule changes what the deployment serves, so a route for it " +
      "is config-grade and wants --notification-template-routes' author/approver split (ADR-0313). " +
      "The reason is 'awaiting_authoring_grant' and not 'no_consumer_exists' only in the sense that " +
      "the grant is the nearer blocker; the evaluator is missing too.",
  }),
]);

/**
 * The one gap on the *reachable* store, which is where this question stops being tidy-up.
 *
 * `observability-runtime`'s enforcement planner turns an SLO breach into three things: a declared
 * incident, an on-call page, and a kill-switch flag rollback. The first two reach reality — the
 * incident is persisted and the page leaves the process over real transports (ADR-0325, ADR-0326).
 * The third writes a row and stops there.
 *
 * `KillSwitchLookup`, the only seam between the engine and this package, has exactly one method:
 * `findForIncident`, which answers *which incident did this switch open* so a restart adopts the
 * episode rather than declaring a second (ADR-0294, ADR-0296). It does not answer *is this flag
 * killed*, and nothing else does either — `listActiveForFlag` is called only by its own test file,
 * as are `findActiveKillSwitch`, `isKillSwitchActive` and `parseKilledValue`.
 *
 * So the rollback is a record of an intent. This is ADR-0333's class — built, tested, never
 * connected — on the store that *is* constructed, which is why the usual signal would not find it:
 * a census of callerless stores clears `PostgresKillSwitchStore` on the first question.
 */
export const KILL_SWITCH_ENFORCEMENT_GAP = Object.freeze({
  recorded: true,
  enforced: false,
  recordedBy: "observability-runtime-pg: buildPersistentEngine, buildPersistentLatencyEngine",
  enforcedBy: null,
  detail:
    "An SLO breach writes a KillSwitch naming a flagId. Nothing reads it back to withhold a flag, " +
    "because nothing evaluates a flag; the lookup the engine holds answers only which incident the " +
    "switch belongs to.",
});

export const FLAG_SUBSYSTEM_DEFECTS = [
  /** No component produces a `FlagEvaluation`. The disease; the other two follow from it. */
  "no_evaluator",
  /** A flag cannot be authored into the database, and cannot be declared by the deployment either. */
  "no_flag_source",
  /** The SLO loop's kill-switch rollback is recorded and never applied. */
  "kill_switch_unenforced",
] as const;
export type FlagSubsystemDefect = (typeof FLAG_SUBSYSTEM_DEFECTS)[number];

export interface FlagSubsystemFinding {
  readonly defect: FlagSubsystemDefect;
  readonly detail: string;
}

export interface FlagSubsystemSurvey {
  readonly findings: readonly FlagSubsystemFinding[];
  /** The callerless stores, so a caller holding the survey holds the declaration too. */
  readonly callerless: readonly CallerlessStoreDeclaration[];
  /** True when a flag is evaluated somewhere, i.e. when this survey stops being interesting. */
  readonly evaluable: boolean;
}

/**
 * What a deployment's feature-flag subsystem does and does not do, derived rather than asserted.
 *
 * `no_evaluator` is read from `FLAG_EVALUATION_REASON_PRODUCERS` in the contracts package, not
 * restated here, so building an evaluator retires this finding by updating the map it was built
 * against — one fact, one home. The other two are declarations with the evidence beside them.
 *
 * Deliberately **not** wired to a boot line. ADR-0334 warned at boot about an unserved job queue
 * because the deployment was already filling it; nothing here is filling anything, so a line on
 * every boot of every deployment saying a subsystem nobody asked for is absent would be noise where
 * that one was signal. The survey exists so the absence is a value a caller can hold the day one
 * wants it — an admin route, a readiness report, or the dependency-graph rule this package's
 * `CALLERLESS_FLAG_STORES` is written for.
 */
export const surveyFlagSubsystem = (): FlagSubsystemSurvey => {
  const findings: FlagSubsystemFinding[] = [];

  if (!flagEvaluationIsImplemented()) {
    findings.push({
      defect: "no_evaluator",
      detail:
        `all ${String(unproducibleEvaluationReasons().length)} of ` +
        `${String(EVALUATION_REASONS.length)} evaluation reasons have no producer: ` +
        "nothing in the workspace evaluates a feature flag",
    });
  }

  findings.push({
    defect: "no_flag_source",
    detail:
      "meta.feature_flags has no caller writing it and no manifest field, CLI flag or environment " +
      "variable declares a flag, so a flag is neither a database record nor a deployment declaration",
  });

  if (!KILL_SWITCH_ENFORCEMENT_GAP.enforced) {
    findings.push({ defect: "kill_switch_unenforced", detail: KILL_SWITCH_ENFORCEMENT_GAP.detail });
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    callerless: CALLERLESS_FLAG_STORES,
    evaluable: flagEvaluationIsImplemented(),
  });
};

/**
 * The stores this package exports, by the names `CALLERLESS_FLAG_STORES` has to use.
 *
 * The forcing function on the declaration: a renamed or deleted store makes the invariant test
 * fail, so the list cannot rot into naming symbols that no longer exist — which is the failure mode
 * of every hand-maintained list in this repo (ADR-0288's `needsAuditEmitter`, wrong three times).
 * The constructors are referenced rather than the names typed twice, so this is checked by the type
 * system as well as by the test.
 */
export const EXPORTED_STORE_SYMBOLS: Readonly<Record<string, unknown>> = Object.freeze({
  PostgresFeatureFlagStore,
  PostgresKillSwitchStore,
  PostgresTargetingRuleStore,
});
