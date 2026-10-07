/**
 * The boot-time decision about ABAC-qualified grants.
 *
 * A manifest `RbacGrant` may carry `abac`, naming an attribute policy the grant is
 * conditional on. Nothing in this workspace ever evaluated one: `rbacCheck` handed
 * `requiresAbac` back and no caller read it, and all four field-level functions in
 * `@crossengin/auth` read `rule.roles` and ignored `rule.abac`. So an ABAC-qualified grant
 * granted **unconditionally** — the inverse of this repo's fail-closed invariant, and in the
 * one place a manifest author wrote down a condition.
 *
 * `@crossengin/auth` fails closed now: with no `AbacEvaluator` supplied — or with one that does
 * not hold this grant's policy key — the obligation resolves `undischargeable` and the grant is
 * denied. That closes the hole and converts it into a **silent total denial**, which is
 * ADR-0339's own finding — total redaction looks exactly like classification working, so a
 * deployment serving a manifest whose declared obligations it denies at every request reads as
 * healthy until somebody asks why a role with a grant cannot use it.
 *
 * So the deployment refuses at boot, naming what it cannot evaluate. That is ADR-0334's
 * conversion for an unservable `duration` field (refused at plan time by name rather than
 * 500ing on page 1) and ADR-0338's for a missing column-encryption key (a boot refusal
 * naming the entities and fields). A failure that is certain at boot belongs at boot.
 *
 * This matters without a pack author in the loop: `ManifestSchema.permissions` *is*
 * `@crossengin/auth`'s `EntityPermissionsSchema`, so the AI Architect can author an `abac`
 * grant, a reviewer approves it reading a declaration the runtime discarded, and activation
 * serves it. The seven builtin packs declare none today, which is what makes this refusal
 * vacuous now and a forcing function later — `abac-obligations.test.ts` measures that.
 */

import type { Manifest } from "@crossengin/kernel";
import {
  abacGrantPosition,
  abacRecordAvailabilityFor,
  formatAbacObligation,
  surveyAbacObligations,
  ABAC_RECORD_AVAILABILITY_REASONS,
  type AbacObligation,
} from "@crossengin/auth";

import { ABAC_POLICY_FLAG } from "./abac-policy.js";

/**
 * There is deliberately no escape-hatch flag for any of these refusals. ADR-0338 shipped
 * `--allow-plaintext-phi` because plaintext PHI is a degraded-but-coherent state an operator
 * may knowingly accept; an unevaluated obligation is not degraded, it is the opposite of what
 * the manifest declares, so a flag here would be an option to serve the hole on purpose.
 */
export const ABAC_OBLIGATION_REFUSALS = [
  "obligation_unevaluable",
  "policy_undeclared",
  "record_unavailable",
] as const;
export type AbacObligationRefusal = (typeof ABAC_OBLIGATION_REFUSALS)[number];

/** Entity+field pairs printed before the line truncates. */
export const OBLIGATION_DETAIL_LIMIT = 8;

export interface AbacObligationCheckInput {
  readonly manifest: Manifest;
  /**
   * The policy keys the deployment's evaluator can answer. Empty = no evaluator declared.
   *
   * The set rather than a `boolean`, because "an evaluator exists" was never the right
   * question. A declared-but-incomplete evaluator answers `undischargeable` at request time
   * for exactly the keys it does not hold, which is the same silent total denial — per grant
   * instead of per deployment — that this boot refusal exists to prevent. "Can it answer
   * *this* grant" is the question, and only the key set can be asked it.
   */
  readonly answerableKeys: ReadonlySet<string>;
  /**
   * The subset of those keys whose policy compares against a **field of the record** — the half
   * ADR-0341's Q1 left inexpressible and this increment closes.
   *
   * Required rather than optional, and the reason is the direction of the mistake: a caller that
   * forgot it would compute an empty set, find no record-bearing obligation anywhere and refuse
   * nothing, so a manifest putting a record policy on a `create` would boot and deny that grant at
   * every request — the silent total denial this whole module exists to convert into a boot
   * refusal. An optional field can be forgotten with the type still valid (ADR-0330's rule), so
   * the compiler asks instead.
   *
   * In a correct deployment it is a subset of `answerableKeys`: a key the evaluator cannot answer
   * is reported by `policy_undeclared`, which is checked first.
   */
  readonly recordBearingKeys: ReadonlySet<string>;
}

export interface AbacObligationCheck {
  readonly obligations: readonly AbacObligation[];
  readonly evaluatorDeclared: boolean;
  /**
   * The obligations an evaluator **is** declared for and cannot answer. Empty when no
   * evaluator is declared: with none, there is no per-key gap to report — every obligation is
   * unanswerable for one reason, which `obligation_unevaluable` states once. Reporting both
   * would name a remedy (declare these keys) beside one that supersedes it (declare a policy
   * layer at all).
   */
  readonly unanswerable: readonly AbacObligation[];
  /**
   * Record-bearing obligations at a position where no call site can **ever** supply a record —
   * entity `create` (the record does not exist until the write commits), entity `list` (the subject
   * is a set, so a per-record answer is a filter and not an authorization decision) and field
   * `read` (response redaction computes one field set per response and applies it by a generic JSON
   * walk, so it cannot tell which record a field came from). Each would be denied at every request.
   */
  readonly recordUnavailable: readonly AbacObligation[];
  /**
   * Record-bearing obligations on a per-field `update` grant, where the availability is
   * `sometimes`: the update path loads the record and the create path has none, so the field is
   * not settable at create.
   *
   * Reported and **not refused**, because unlike the three above this is a real consequence of a
   * coherent declaration rather than a configuration error — "you may only set this field on a
   * record that is yours" genuinely cannot admit a create. So the boot line says it and the
   * deployment starts (ADR-0322's rule: a surface that degrades rather than refusing has to say so
   * out loud).
   */
  readonly createBlocked: readonly AbacObligation[];
  readonly refusal: AbacObligationRefusal | null;
}

/**
 * Surveys the manifest's declared obligations and answers whether the server may start.
 *
 * The manifest is already resolved — `loadBuiltinPack` follows `meta.extends` through
 * `resolveManifest` before anything here sees it — so a pack extending another is surveyed
 * over its merged lineage and an inherited `abac` grant is in scope.
 */
export function checkAbacObligations(input: AbacObligationCheckInput): AbacObligationCheck {
  const obligations = surveyAbacObligations(input.manifest.permissions ?? {});
  const evaluatorDeclared = input.answerableKeys.size > 0;
  const unanswerable = evaluatorDeclared
    ? obligations.filter((o) => !input.answerableKeys.has(o.policyKey))
    : [];

  // Availability is read off `@crossengin/auth`'s total map rather than re-listed here, so the
  // positions a record can reach and the handlers that reach them have one definition.
  const recordBearing = obligations.filter((o) => input.recordBearingKeys.has(o.policyKey));
  const recordUnavailable = recordBearing.filter((o) => abacRecordAvailabilityFor(o) === "never");
  const createBlocked = recordBearing.filter((o) => abacRecordAvailabilityFor(o) === "sometimes");

  // First refusal wins, and the order is chosen so the one reported is the one whose remedy is
  // true (ADR-0340's ordering argument). With no evaluator, `recordBearingKeys` is empty by
  // construction, so nothing could be classified record-bearing and `record_unavailable` would be
  // vacuously silent — hence it comes last, after both questions that do not need the declaration.
  let refusal: AbacObligationRefusal | null = null;
  if (obligations.length > 0) {
    if (!evaluatorDeclared) refusal = "obligation_unevaluable";
    else if (unanswerable.length > 0) refusal = "policy_undeclared";
    else if (recordUnavailable.length > 0) refusal = "record_unavailable";
  }

  return {
    obligations,
    evaluatorDeclared,
    unanswerable,
    recordUnavailable,
    createBlocked,
    refusal,
  };
}

/**
 * `a, b, c (+N more)` over `formatAbacObligation`. The count is reported separately by every
 * caller, so a truncated list never stands in for the figure an operator compares.
 */
function renderObligations(obligations: readonly AbacObligation[]): string {
  const shown = obligations.slice(0, OBLIGATION_DETAIL_LIMIT).map(formatAbacObligation);
  const hidden = obligations.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

/**
 * The no-evaluator text. Both remedies are named, and the second is worded as a capability
 * rather than a flag because there is no flag — supplying an evaluator is a change to what this
 * deployment can do.
 */
function unevaluableMessage(obligations: readonly AbacObligation[]): string {
  return (
    `${obligations.length.toString()} abac-qualified grant(s) are declared and this ` +
    `deployment has no ABAC evaluator, so each would be denied at every request rather ` +
    `than evaluated: ${renderObligations(obligations)}. Remove the \`abac\` key from the ` +
    `grant — the role grant beside it is enforced and stays — or give the deployment an ` +
    `ABAC evaluator, a capability it does not currently have.`
  );
}

/**
 * The other refusal's text. This one **does** name a flag where `unevaluableMessage` refuses to,
 * and the asymmetry is the point: declaring a policy for a key is something the CLI can do, while
 * supplying an evaluator is a capability no flag confers. A message naming a remedy that does not
 * exist is worse than one naming none.
 */
function undeclaredMessage(unanswerable: readonly AbacObligation[]): string {
  const keys = [...new Set(unanswerable.map((o) => o.policyKey))].sort();
  return (
    `${unanswerable.length.toString()} abac-qualified grant(s) name a policy key this ` +
    `deployment's ABAC evaluator cannot answer, so each would be denied at every request ` +
    `rather than evaluated: ${renderObligations(unanswerable)}. Declare a policy for ` +
    `${keys.map((k) => `'${k}'`).join(", ")} with ${ABAC_POLICY_FLAG}, or remove the \`abac\` ` +
    `key from the grant — the role grant beside it is enforced and stays.`
  );
}

/**
 * `Chart.create requires abac policy 'same_dept' — ⟨why no record can reach it⟩`, one per line.
 *
 * The reason is attached **per obligation** and comes from `ABAC_RECORD_AVAILABILITY_REASONS`
 * rather than being written here, so the position's reason and the handler that enforces it have
 * one definition. Repeating a reason across two obligations at the same position is accepted: an
 * operator reads the line for the grant they are fixing, and grouping would make a truncated list
 * ambiguous about which reason belonged to which grant.
 */
function renderWithReason(obligations: readonly AbacObligation[]): string {
  const shown = obligations
    .slice(0, OBLIGATION_DETAIL_LIMIT)
    .map(
      (o) =>
        `${formatAbacObligation(o)} — ${ABAC_RECORD_AVAILABILITY_REASONS[abacGrantPosition(o)]}`,
    );
  const hidden = obligations.length - shown.length;
  const suffix = hidden > 0 ? `; (+${hidden.toString()} more)` : "";
  return `${shown.join("; ")}${suffix}`;
}

/**
 * The record-position refusal's text. Three remedies, in the order an operator would try them:
 * weaken the policy, move the obligation, or drop it. The first is named with the flag because the
 * CLI can do it; the second is a manifest edit and is described rather than flagged.
 */
function recordUnavailableMessage(recordUnavailable: readonly AbacObligation[]): string {
  return (
    `${recordUnavailable.length.toString()} abac-qualified grant(s) name a policy that compares ` +
    `against a field of the record, at a position where no call site can ever supply one, so each ` +
    `would be denied at every request rather than evaluated: ${renderWithReason(recordUnavailable)}. ` +
    `Declare that key as a comparison that does not reference the record ` +
    `(${ABAC_POLICY_FLAG} <key>=<attribute>:eq|ne|in|present[:<value>]), move the \`abac\` key to a ` +
    `grant that does supply a record (an entity \`read\`/\`update\`/\`delete\`, a transition, or a ` +
    `per-field \`update\`), or remove it — the role grant beside it is enforced and stays.`
  );
}

/**
 * The refusal detail, selected by refusal and shared by the boot line and the thrown error so the
 * two cannot disagree.
 */
function refusalMessage(check: AbacObligationCheck): string {
  if (check.refusal === "policy_undeclared") return undeclaredMessage(check.unanswerable);
  if (check.refusal === "record_unavailable") {
    return recordUnavailableMessage(check.recordUnavailable);
  }
  return unevaluableMessage(check.obligations);
}

/**
 * The `sometimes` note, appended to an otherwise healthy boot line. Said on every boot rather than
 * only when somebody asks, because an obligated field silently refusing every create is exactly
 * the shape of thing a deployment reads as the rule working.
 */
function createBlockedNote(createBlocked: readonly AbacObligation[]): string {
  return (
    `; ${createBlocked.length.toString()} obligated field(s) are therefore not settable at ` +
    `create: ${renderWithReason(createBlocked)}`
  );
}

/**
 * One boot line. The no-obligations case says so **affirmatively**: "we surveyed and found
 * none" cannot be claimed from the absence of a log line, which is this repo's recurring
 * rule, and it is the line that makes the refusal's vacuity visible on every boot.
 */
export function formatAbacObligationCheck(check: AbacObligationCheck): string {
  if (check.obligations.length === 0) {
    return "abac obligations: none declared, so no grant depends on an ABAC evaluator";
  }
  if (check.refusal !== null) {
    return `abac obligations: ${refusalMessage(check)}`;
  }
  return (
    `abac obligations: ${check.obligations.length.toString()} declared and an evaluator is ` +
    `declared, so each is evaluated per request: ${renderObligations(check.obligations)}` +
    (check.createBlocked.length > 0 ? createBlockedNote(check.createBlocked) : "")
  );
}

/**
 * Thrown at boot for either refusal. Carries the obligations and the unanswerable subset so a
 * caller can report them structurally rather than re-deriving them from the message.
 *
 * One error for both rather than a second class: `policy_undeclared` is the same fact narrowed to
 * a subset of the grants — an obligation this deployment cannot evaluate — so `refusal` is what
 * distinguishes them and a caller catching one catches both.
 */
export class AbacObligationsUnevaluable extends Error {
  readonly refusal: AbacObligationRefusal;
  readonly obligations: readonly AbacObligation[];
  readonly unanswerable: readonly AbacObligation[];
  readonly recordUnavailable: readonly AbacObligation[];

  constructor(check: AbacObligationCheck) {
    super(refusalMessage(check));
    this.name = "AbacObligationsUnevaluable";
    // A check whose `refusal` the caller did not consult still names one, and it is the strictest
    // of the three: `obligation_unevaluable` claims nothing about which keys are declared.
    this.refusal = check.refusal ?? "obligation_unevaluable";
    this.obligations = check.obligations;
    this.unanswerable = check.unanswerable;
    this.recordUnavailable = check.recordUnavailable;
  }
}
