/**
 * The deployment's ABAC policy layer: a declarable attribute-comparison vocabulary, and the
 * `AbacEvaluator` built from it.
 *
 * ADR-0340 made an obligation fail closed — `RbacGrant.abac` is an opaque policy key,
 * `dischargeAbac` is the one place an `AbacEvaluator` is called, and with no evaluator the
 * obligation resolves `undischargeable` and the grant is refused, with a boot refusal so that
 * silent total denial cannot be mistaken for the rule working. No flag supplied an evaluator, so
 * no manifest declaring an obligation could be served at all. This is the producer.
 *
 * It answers ADR-0340's Q2 with the **narrow** option rather than an embedded policy engine: a
 * predicate over the principal's own attributes, declared in argv, with four operators. The seam
 * stays `AbacEvaluator`, so a deployment that wants OPA or Cedar still supplies one through
 * `buildOperateHttpServer` and this module is simply not used.
 *
 * **No attribute value may appear in anything this module logs.** `formatAbacPolicies` renders the
 * declaration — keys, attribute names, operators and the operator's own declared values, all of
 * which the operator typed — and never a principal's attributes. `sensitive-field-policy.ts` and
 * `column-encryption.ts` draw the same line.
 */

import type { AbacEvaluationInput, AbacEvaluator, AbacOutcome } from "@crossengin/auth";

/**
 * A constant rather than a string literal per message, following `ALLOW_PLAINTEXT_PHI_FLAG`: a
 * refusal must not be able to name a flag the CLI does not parse.
 */
export const ABAC_POLICY_FLAG = "--abac-policy";

export const ABAC_OPERATORS = ["eq", "ne", "in", "present"] as const;
export type AbacOperator = (typeof ABAC_OPERATORS)[number];

export interface AbacPolicy {
  readonly key: string;
  readonly attribute: string;
  readonly operator: AbacOperator;
  /** The comparison values. Empty for `present`, one for `eq`/`ne`, one or more for `in`. */
  readonly values: readonly string[];
}

export const ABAC_POLICY_REFUSALS = [
  "malformed",
  "unknown_operator",
  "value_required",
  "value_forbidden",
  "duplicate_key",
  "empty_attribute",
  "empty_key",
] as const;
export type AbacPolicyRefusal = (typeof ABAC_POLICY_REFUSALS)[number];

export class AbacPolicyRefused extends Error {
  readonly refusal: AbacPolicyRefusal;
  readonly spec: string;

  constructor(refusal: AbacPolicyRefusal, spec: string, detail: string) {
    super(`${ABAC_POLICY_FLAG} ${JSON.stringify(spec)}: ${detail}`);
    this.name = "AbacPolicyRefused";
    this.refusal = refusal;
    this.spec = spec;
  }
}

function isAbacOperator(value: string): value is AbacOperator {
  return (ABAC_OPERATORS as readonly string[]).includes(value);
}

/**
 * `<key>=<attribute>:<op>[:<value>]`, splitting the key on the **first** `=` and the remainder on
 * `:`.
 *
 * Colon-delimited after the key because that is `--rate-limit-policy
 * <rlp_id>:<limit>:<windowSeconds>`'s existing convention in this app (ADR-0335). An `==`-style
 * operator spelling was not taken: it collides with the key separator, so `k=a==b` would have two
 * readings and the parser would pick one silently.
 *
 * A value containing `:` is therefore inexpressible and reads as `malformed` rather than being
 * re-joined — a declaration the parser had to guess at is a declaration the operator cannot check
 * against this message.
 */
export function parseAbacPolicySpec(raw: string): AbacPolicy {
  const split = raw.indexOf("=");
  if (split < 0) {
    throw new AbacPolicyRefused(
      "malformed",
      raw,
      `expected <key>=<attribute>:<op>[:<value>], with one of ${ABAC_OPERATORS.join("/")} as <op>`,
    );
  }

  const key = raw.slice(0, split);
  if (key === "") {
    throw new AbacPolicyRefused("empty_key", raw, "the policy key before `=` is empty");
  }

  const parts = raw.slice(split + 1).split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new AbacPolicyRefused(
      "malformed",
      raw,
      `expected <attribute>:<op>[:<value>] after the key, got ${parts.length.toString()} ` +
        `colon-separated field(s); a value containing \`:\` cannot be declared`,
    );
  }

  const [attribute, operatorRaw, valueRaw] = parts as [string, string, string | undefined];
  if (attribute === "") {
    throw new AbacPolicyRefused("empty_attribute", raw, "the attribute name is empty");
  }
  if (!isAbacOperator(operatorRaw)) {
    throw new AbacPolicyRefused(
      "unknown_operator",
      raw,
      `unknown operator ${JSON.stringify(operatorRaw)}; one of ${ABAC_OPERATORS.join(", ")}`,
    );
  }

  if (operatorRaw === "present") {
    // Refused even when the segment is empty (`clearance:present:`), because a trailing colon is a
    // typo and `present` has nothing to compare against — accepting it would make the declaration
    // and what is enforced differ by a character nobody can see.
    if (valueRaw !== undefined) {
      throw new AbacPolicyRefused(
        "value_forbidden",
        raw,
        "`present` takes no value: it asks whether the attribute is set at all",
      );
    }
    return Object.freeze({ key, attribute, operator: operatorRaw, values: Object.freeze([]) });
  }

  const values = valueRaw === undefined ? [] : valueRaw.split(",");
  // An empty member is not a value: `department:eq:` and `department:in:a,,b` both declare a
  // comparison against nothing, which no attribute rendering can equal and which an operator
  // almost certainly did not mean.
  if (values.length === 0 || values.some((v) => v === "")) {
    throw new AbacPolicyRefused(
      "value_required",
      raw,
      operatorRaw === "in"
        ? "`in` takes a non-empty comma-separated value list"
        : `\`${operatorRaw}\` takes exactly one non-empty value`,
    );
  }
  if (operatorRaw !== "in" && values.length !== 1) {
    throw new AbacPolicyRefused(
      "value_required",
      raw,
      `\`${operatorRaw}\` takes exactly one value; use \`in\` to compare against several`,
    );
  }

  return Object.freeze({ key, attribute, operator: operatorRaw, values: Object.freeze(values) });
}

/**
 * The declaration, keyed by policy key in argv order.
 *
 * A repeated key is **refused** rather than last-wins: which of two policies decides an
 * authorization must not depend on the order of the command line.
 */
export function parseAbacPolicies(raw: readonly string[]): ReadonlyMap<string, AbacPolicy> {
  const out = new Map<string, AbacPolicy>();
  for (const spec of raw) {
    const policy = parseAbacPolicySpec(spec);
    if (out.has(policy.key)) {
      throw new AbacPolicyRefused(
        "duplicate_key",
        spec,
        `policy key ${JSON.stringify(policy.key)} is declared more than once`,
      );
    }
    out.set(policy.key, policy);
  }
  return out;
}

/**
 * What the attribute resolved to, as three cases rather than a `string | undefined`: "the
 * attribute is set to something a scalar comparison cannot be applied to" is a third fact, and
 * collapsing it into either of the other two is what decides `present` wrongly.
 */
type ResolvedAttribute =
  | { readonly kind: "absent" }
  | { readonly kind: "scalar"; readonly rendered: string }
  | { readonly kind: "structured" };

const ABSENT: ResolvedAttribute = { kind: "absent" };
const STRUCTURED: ResolvedAttribute = { kind: "structured" };

/**
 * Comparison is against a **scalar rendering**: a string is itself, a number or boolean goes
 * through `String()`, and `null` counts as absent. An object or array renders as nothing — a
 * structured value cannot satisfy a scalar comparison, and picking a rendering for it (JSON? the
 * first element?) would make the answer depend on a convention the declaration does not state.
 *
 * Own properties only. `attributes["constructor"]` would otherwise reach `Object` through the
 * prototype chain, so a policy naming `constructor` or `toString` would find every principal's
 * attribute "present" — a fail-open reachable from the declaration alone.
 */
function resolveAttribute(
  attributes: Readonly<Record<string, unknown>>,
  name: string,
): ResolvedAttribute {
  if (!Object.prototype.hasOwnProperty.call(attributes, name)) return ABSENT;
  const value: unknown = attributes[name];
  if (value === null || value === undefined) return ABSENT;
  if (typeof value === "string") return { kind: "scalar", rendered: value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "scalar", rendered: String(value) };
  }
  return STRUCTURED;
}

/**
 * One predicate per operator, as a **total map** so a fifth operator is a compile error rather
 * than a member inheriting whichever branch an `if`-chain ended on — and the branch it would
 * inherit is the one that allows.
 *
 * Two rules live here and both read as bugs until the reason is stated:
 *
 * `ne` is deliberately **not** the negation of `eq`. An absent attribute answers false for every
 * operator including `ne`, because an absent attribute means nothing is known about the principal
 * and a grant condition evaluated against nothing must not be satisfied. `present` is the only
 * operator that asks a question an absence can answer.
 *
 * `eq` and `ne` re-check `values.length` although `parseAbacPolicySpec` guarantees it, because
 * `AbacPolicy` is an exported interface a caller can build by hand: `{operator: "ne", values: []}`
 * would otherwise compare against `undefined` and satisfy every principal.
 */
const OPERATOR_PREDICATES: Readonly<
  Record<AbacOperator, (attribute: ResolvedAttribute, values: readonly string[]) => boolean>
> = {
  eq: (attribute, values) =>
    attribute.kind === "scalar" && values.length === 1 && attribute.rendered === values[0],
  ne: (attribute, values) =>
    attribute.kind === "scalar" && values.length === 1 && attribute.rendered !== values[0],
  in: (attribute, values) => attribute.kind === "scalar" && values.includes(attribute.rendered),
  present: (attribute) => attribute.kind !== "absent",
};

/**
 * The evaluator over a declaration.
 *
 * **What this seam cannot express, by construction.** `AbacEvaluationInput` is
 * `{policyKey, principal, entity, operation, field?}` and carries **no record**. So a policy of
 * the form "this principal owns *this* record", or `user.department == record.department` — the
 * canonical ABAC shape, and one of the two spellings `packages/auth`'s own tests read `abac` as —
 * is inexpressible here by **any** evaluator, including an embedded OPA: the value to compare
 * against never reaches the function. What is expressible is a predicate over the principal's own
 * attributes, which is what this builds. Closing the other half means a record on the input and a
 * decision about the read path that fetches it before the authorization check; do not try to
 * express it here.
 *
 * The evaluator never throws. `dischargeAbac` catches a throw and maps it to `undischargeable`, so
 * throwing would be a slower way to the same answer with the reason lost.
 */
export function buildAbacEvaluator(policies: ReadonlyMap<string, AbacPolicy>): AbacEvaluator {
  return (input: AbacEvaluationInput): AbacOutcome => {
    const attributes = input.principal.abacAttributes;
    // No attribute directory was consulted, so no policy over attributes can be answered — and
    // `{}` would read as "this principal has no attributes", which is a different fact.
    // `dischargeAbac` refuses this before calling an evaluator; repeated here because an evaluator
    // that would answer from unresolved attributes is wrong on its own terms.
    if (attributes === null) return "undischargeable";

    const policy = policies.get(input.policyKey);
    // `undischargeable` and never `denied`: the deployment declared a policy layer and this key is
    // not in it, which is a configuration gap rather than a statement about the principal.
    // `checkAbacObligations` exists so this cannot reach a request from a manifest.
    if (policy === undefined) return "undischargeable";

    // Exact and case-sensitive. An attribute is written through `--platform-user-routes` and a
    // silent fold or trim would make two distinct declared values collide.
    return OPERATOR_PREDICATES[policy.operator](
      resolveAttribute(attributes, policy.attribute),
      policy.values,
    )
      ? "satisfied"
      : "denied";
  };
}

function renderPolicy(policy: AbacPolicy): string {
  return policy.operator === "present"
    ? `${policy.key}: ${policy.attribute} present`
    : `${policy.key}: ${policy.attribute} ${policy.operator} ${policy.values.join(",")}`;
}

/**
 * One boot line, in declaration order, so an operator reads back what this deployment will enforce
 * in the order they typed it. The empty case says so **affirmatively**: "no policy layer is
 * declared" cannot be claimed from the absence of a log line.
 */
export function formatAbacPolicies(policies: ReadonlyMap<string, AbacPolicy>): string {
  if (policies.size === 0) {
    return "abac policies: none declared, so no obligation can be discharged";
  }
  const rendered = [...policies.values()].map(renderPolicy).join(", ");
  return `abac policies: ${policies.size.toString()} declared: ${rendered}`;
}
