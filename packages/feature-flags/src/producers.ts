import { EVALUATION_REASONS, type EvaluationReason } from "./evaluations.js";

/**
 * What would produce a `FlagEvaluation` carrying a given reason — and the two shapes this
 * workspace has already established for answering that, neither of which is built.
 *
 * `"none"` is the answer for every reason today, and it is an answer rather than a gap in the map:
 * **nothing in this workspace evaluates a feature flag.** The package models every ingredient of an
 * evaluation — `isFlagActive`, `isFlagInEnvironment`, `parseDefaultValue`, `parseKilledValue`,
 * `findActiveKillSwitch`, `chooseTargetingRule`, `computeStableBucket`, and `FlagEvaluationSchema`
 * for the record one would write — and composes none of them. `chooseTargetingRule`'s own comment
 * says "every would-be caller", which is exact: there are no callers, only would-be ones. The only
 * importer of this package outside its own tests is `observability-runtime`, and it takes
 * `KillSwitch` alone — the half that *plans* a rollback, never the half that applies one.
 *
 * The two reserved producers are not speculation; they are the two mechanisms the repo has already
 * chosen between for the same question in two other subsystems, named here so the choice is
 * expressible rather than implicit:
 *
 * - **`stored_flags`** — a request-path evaluator reading `meta.feature_flags` and
 *   `meta.feature_flag_targeting_rules` through `feature-flags-pg`. This is the *record* answer, and
 *   it is the shape ADR-0331 took for workflow definitions: authored rows, read back and driven.
 * - **`declared_flags`** — an evaluator over flags the deployment declares at boot, which is
 *   ADR-0334's `--rate-limit-policy` shape: the *declaration* is argv and the database holds only
 *   what happened. The repo's rule that declared beats probed (ADR-0328) points here, and two
 *   neighbouring decisions already constrain the record answer hard — `meta.feature_flag_changes`
 *   must be written in the same transaction as the change it records, and
 *   `meta.feature_flag_evaluations` must never get a Postgres writer at all (measured: 394 bytes a
 *   row, ~124 TB/year at 1,000 req/s × 10 flags, on the request path, under RLS).
 *
 * A **total** map over `EVALUATION_REASONS` rather than a predicate, so an eighteenth reason is a
 * compile error here instead of a reason that silently reads as produced by something — the rule
 * ADR-0334 applied to `JOB_KIND_PRODUCERS`, ADR-0330 to the design-output shapes and ADR-0329 to the
 * cancellation effects. The forcing property is the point: whoever builds the evaluator has to say,
 * per reason, that it now produces it, and whoever adds a reason has to say that nothing does.
 */
export type FlagEvaluationProducer = "none" | "stored_flags" | "declared_flags";

export const FLAG_EVALUATION_REASON_PRODUCERS: Readonly<
  Record<EvaluationReason, FlagEvaluationProducer>
> = Object.freeze({
  default_returned: "none",
  /**
   * The sharpest of the seventeen. The SLO enforcement loop really does write a `KillSwitch` row
   * when it rolls a flag back (`PostgresKillSwitchStore.record`, reached from
   * `observability-runtime-pg`'s two persisting engines) — so this reason names a decision the
   * deployment *takes*, and still nothing produces it, because nothing ever asks whether a flag is
   * killed. `listActiveForFlag` is called only by its own test; so are `findActiveKillSwitch`,
   * `isKillSwitchActive` and `parseKilledValue`. The rollback is a stored intent.
   */
  kill_switch_active: "none",
  flag_not_found: "none",
  flag_archived: "none",
  flag_paused: "none",
  flag_disabled_for_environment: "none",
  specific_principal_match: "none",
  specific_tenant_match: "none",
  tenant_attribute_match: "none",
  principal_attribute_match: "none",
  percentage_bucket_match: "none",
  segment_match: "none",
  custom_predicate_match: "none",
  exclusion_rule_hit: "none",
  fallthrough_to_default: "none",
  error_returned_default: "none",
  expired_returned_default: "none",
});

/**
 * The reasons nothing in this workspace can produce, in `EVALUATION_REASONS` order.
 *
 * Derived rather than restated, so it cannot disagree with the map; `summarizeChangeHistory`'s
 * neighbour `unproducibleJobKinds` has the same shape in `@crossengin/jobs`.
 */
export const unproducibleEvaluationReasons = (): readonly EvaluationReason[] =>
  EVALUATION_REASONS.filter((r) => FLAG_EVALUATION_REASON_PRODUCERS[r] === "none");

/**
 * Whether any reason has a producer — i.e. whether a flag is evaluated anywhere at all.
 *
 * A single call a survey or a boot line can ask, so the fact does not have to be re-derived by
 * anybody who wants it. False today.
 */
export const flagEvaluationIsImplemented = (): boolean =>
  unproducibleEvaluationReasons().length !== EVALUATION_REASONS.length;
