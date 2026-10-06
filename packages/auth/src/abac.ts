import { ABAC_OUTCOMES, OPERATION_NAMES } from "./types.js";
import type {
  AbacDischarge,
  AbacOutcome,
  Operation,
  PermissionMap,
  Principal,
} from "./types.js";

/**
 * Which outcomes admit the act, as a **total map** rather than a condition: a fourth outcome is a
 * compile error here instead of a member falling into whichever branch an `if`-chain ended on —
 * and the branch it would fall into is the one that allows.
 */
export const ABAC_OUTCOME_ALLOWS: Readonly<Record<AbacOutcome, boolean>> = {
  satisfied: true,
  denied: false,
  undischargeable: false,
};

export interface AbacEvaluationInput {
  readonly policyKey: string;
  readonly principal: Principal;
  readonly entity: string;
  readonly operation: Operation;
  /** Present for a field-level grant, absent for an entity-level one. */
  readonly field?: string;
}

export type AbacEvaluator = (input: AbacEvaluationInput) => AbacOutcome;

/**
 * What a field-level caller supplies to have obligations enforced.
 *
 * `entity` is **required** inside the object: a caller cannot ask for enforcement without naming
 * the entity the policy is about, because an evaluation input with an empty entity hands the
 * deployment's policy layer a question it cannot answer and gets back an answer that means nothing.
 * The four field-level functions take `EntityPermissions` rather than an entity name, so this is
 * the only place that name can come from.
 */
export interface AbacEnforcement {
  readonly entity: string;
  readonly evaluator?: AbacEvaluator;
}

/**
 * The evaluator a deployment that has declared no policy layer gets: every obligation is
 * undischargeable, so an ABAC-qualified grant refuses rather than granting unconditionally.
 */
export const UNDISCHARGEABLE_ABAC_EVALUATOR: AbacEvaluator = () => "undischargeable";

export function describeOperation(op: Operation): string {
  return typeof op === "object" ? `transition:${op.name}` : op;
}

function isAbacOutcome(value: unknown): value is AbacOutcome {
  return typeof value === "string" && (ABAC_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Whether an attribute directory was consulted for this principal. One spelling of the comparison,
 * so a caller can ask the question `dischargeAbac` asks without restating which value means which.
 */
export function abacAttributesResolved(principal: Principal): boolean {
  return principal.abacAttributes !== null;
}

/**
 * The one place in this package that ever calls an evaluator, with five callers — `rbacCheck` and
 * the four field-level functions — so the fail-closed rules below cannot diverge between them.
 */
export function dischargeAbac(
  policyKey: string | undefined,
  context: Omit<AbacEvaluationInput, "policyKey">,
  evaluator: AbacEvaluator | undefined,
): AbacDischarge | null {
  // No obligation. `null` rather than a `satisfied` discharge, because "there was nothing to check"
  // and "a policy answered yes" are different facts, and a caller reporting the second when the
  // first is true would claim an evaluation that never happened.
  if (policyKey === undefined) return null;

  // Attributes were never gathered, so no policy over them can be answered — and an evaluator handed
  // `{}` would read it as "this principal has no attributes" and could answer `denied` or even
  // `satisfied` from an input nobody collected.
  if (context.principal.abacAttributes === null) return { policyKey, outcome: "undischargeable" };

  // `undischargeable` and not `denied`: `denied` is a claim about this principal's attributes,
  // while this says no evaluator could answer at all. Different facts, different remedies.
  if (evaluator === undefined) return { policyKey, outcome: "undischargeable" };

  let outcome: AbacOutcome;
  try {
    const answer: unknown = evaluator({ ...context, policyKey });
    // Validated rather than trusted: the evaluator crosses a package boundary and its caller may be
    // JS, so a value outside the enum is reachable — and an unrecognised answer must not allow.
    outcome = isAbacOutcome(answer) ? answer : "undischargeable";
  } catch {
    // An exception inside an authorization check must never become an allow, and must not propagate
    // as a 500 that a client retries into the same refusal.
    outcome = "undischargeable";
  }

  return { policyKey, outcome };
}

export interface AbacObligation {
  readonly entity: string;
  readonly operation: Operation;
  readonly field: string | null;
  readonly policyKey: string;
}

/**
 * Every place a permission map carries an ABAC obligation, so a deployment can be told at boot
 * which grants its evaluator must answer for rather than discovering it at the first refusal.
 *
 * Deterministic: entities ascending, then the five operation names in `OPERATION_NAMES` order,
 * then transitions by name, then fields by name with `read` before `update`.
 */
export function surveyAbacObligations(permissions: PermissionMap): readonly AbacObligation[] {
  const out: AbacObligation[] = [];

  for (const entity of Object.keys(permissions).sort()) {
    const perms = permissions[entity];
    if (perms === undefined) continue;

    for (const op of OPERATION_NAMES) {
      const key = perms[op]?.abac;
      if (key !== undefined) out.push({ entity, operation: op, field: null, policyKey: key });
    }

    const transitions = perms.transitions;
    if (transitions !== undefined) {
      for (const name of Object.keys(transitions).sort()) {
        const key = transitions[name]?.abac;
        if (key !== undefined) {
          out.push({
            entity,
            operation: { kind: "transition", name },
            field: null,
            policyKey: key,
          });
        }
      }
    }

    const fields = perms.fields;
    if (fields !== undefined) {
      for (const name of Object.keys(fields).sort()) {
        const perm = fields[name];
        if (perm === undefined) continue;
        if (perm.read?.abac !== undefined) {
          out.push({ entity, operation: "read", field: name, policyKey: perm.read.abac });
        }
        if (perm.update?.abac !== undefined) {
          out.push({ entity, operation: "update", field: name, policyKey: perm.update.abac });
        }
      }
    }
  }

  return out;
}

export function formatAbacObligation(o: AbacObligation): string {
  const target =
    o.field === null
      ? `${o.entity}.${describeOperation(o.operation)}`
      : `${o.entity}.${describeOperation(o.operation)} -> ${o.field}`;
  return `${target} requires abac policy '${o.policyKey}'`;
}
