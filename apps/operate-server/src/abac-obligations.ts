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
  formatAbacObligation,
  surveyAbacObligations,
  type AbacObligation,
} from "@crossengin/auth";

import { ABAC_POLICY_FLAG } from "./abac-policy.js";

/**
 * There is deliberately no escape-hatch flag for either refusal. ADR-0338 shipped
 * `--allow-plaintext-phi` because plaintext PHI is a degraded-but-coherent state an operator
 * may knowingly accept; an unevaluated obligation is not degraded, it is the opposite of what
 * the manifest declares, so a flag here would be an option to serve the hole on purpose.
 */
export const ABAC_OBLIGATION_REFUSALS = ["obligation_unevaluable", "policy_undeclared"] as const;
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

  let refusal: AbacObligationRefusal | null = null;
  if (obligations.length > 0) {
    if (!evaluatorDeclared) refusal = "obligation_unevaluable";
    else if (unanswerable.length > 0) refusal = "policy_undeclared";
  }

  return { obligations, evaluatorDeclared, unanswerable, refusal };
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
 * The refusal detail, selected by refusal and shared by the boot line and the thrown error so the
 * two cannot disagree.
 */
function refusalMessage(check: AbacObligationCheck): string {
  return check.refusal === "policy_undeclared"
    ? undeclaredMessage(check.unanswerable)
    : unevaluableMessage(check.obligations);
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
    `declared, so each is evaluated per request: ${renderObligations(check.obligations)}`
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

  constructor(check: AbacObligationCheck) {
    super(refusalMessage(check));
    this.name = "AbacObligationsUnevaluable";
    // A check whose `refusal` the caller did not consult still names one, and it is the stricter
    // of the two: `obligation_unevaluable` claims nothing about which keys are declared.
    this.refusal = check.refusal ?? "obligation_unevaluable";
    this.obligations = check.obligations;
    this.unanswerable = check.unanswerable;
  }
}
