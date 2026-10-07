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
 * predicate declared in argv, with seven operators. The seam stays `AbacEvaluator`, so a
 * deployment that wants OPA or Cedar still supplies one through `buildOperateHttpServer` and this
 * module is simply not used.
 *
 * **What is expressible, and what is still not.** The four original operators compare the
 * principal's own attributes against literals the operator typed. The three `*_record` operators
 * compare an attribute against a **field of the record** the request is about, which is the
 * canonical ABAC shape and was inexpressible by any evaluator here until `AbacEvaluationInput`
 * gained a record. So `user.department == record.department` is
 * `same_dept=department:eq_record:department`, and "owns this row" is
 * `owns=user_id:eq_record:owner_id` — which works exactly when the deployment writes the user's own
 * id into their membership attributes, because the **principal's own id is deliberately not an
 * operand**. The left side of every policy is an attribute *name*, and a reserved spelling like
 * `principal.id` would shadow a real attribute of that name: an attribute directory that happened
 * to hold `principal.id` would have its value silently ignored, and one that did not would have a
 * value invented for it. That is the `hasOwnProperty` lesson in a new place — a declaration must
 * not be able to mean something other than what it names — and it is this increment's main stated
 * limitation. What also remains out of reach is any comparison between two record fields, or any
 * predicate over a *set* of records: `list` holds no single record, so a policy over one is
 * `deferred` there and the obligation refuses.
 *
 * **No attribute value and no record value may appear in anything this module logs.**
 * `formatAbacPolicies` renders the declaration — keys, attribute names, operators, declared record
 * field names and declared literals, all of which the operator typed — and never a principal's
 * attributes nor any field of the record, which is tenant data and the very thing the obligation
 * exists to guard. `sensitive-field-policy.ts` and `column-encryption.ts` draw the same line.
 */

import type { AbacEvaluationInput, AbacEvaluator, AbacOutcome } from "@crossengin/auth";

/**
 * A constant rather than a string literal per message, following `ALLOW_PLAINTEXT_PHI_FLAG`: a
 * refusal must not be able to name a flag the CLI does not parse.
 */
export const ABAC_POLICY_FLAG = "--abac-policy";

/**
 * Four operators over literals the operator declared, and three over a field of the record.
 *
 * A separate operator rather than a `record.<field>` prefix on the operand, which is the obvious
 * alternative and is wrong for the reason `==` was rejected as an operator spelling: a prefix
 * collides with a literal value that happens to begin with `record.`, so `k=tag:eq:record.x` would
 * have two readings — a literal and a record field — and the parser would pick one silently. The
 * operator is the declaration of which kind of comparison this is, so there is exactly one reading
 * of every spec and a literal beginning with `record.` stays declarable.
 */
export const ABAC_OPERATORS = [
  "eq",
  "ne",
  "in",
  "present",
  "eq_record",
  "ne_record",
  "in_record",
] as const;
export type AbacOperator = (typeof ABAC_OPERATORS)[number];

export interface AbacPolicy {
  readonly key: string;
  readonly attribute: string;
  readonly operator: AbacOperator;
  /**
   * The declared operands. Empty for `present`, one for `eq`/`ne`/`eq_record`/`ne_record`, one or
   * more for `in`/`in_record`.
   *
   * They hold **literals** for `eq`/`ne`/`in` and **record field names** for `eq_record`/
   * `ne_record`/`in_record`. The operator decides how a member is read, which is why there is no
   * second field: two fields would admit a policy declaring both, or neither, and then the
   * operator and the operand could disagree about what this policy compares against.
   */
  readonly values: readonly string[];
}

/**
 * Whether an operator's operands name fields of the record rather than literals, as a **total map**
 * so an eighth operator is a compile error rather than a member inheriting whichever branch an
 * `if`-chain ended on. The branch it would inherit here is `false` — "needs no record" — which
 * would evaluate the policy against literals that are really field names, matching nothing, and so
 * answer `denied` for every principal instead of `deferred`. A total denial reads exactly like the
 * rule working, which is the failure this repo keeps finding; `deferred` is the answer that says a
 * record was needed and none arrived.
 */
export const ABAC_OPERATOR_NEEDS_RECORD: Readonly<Record<AbacOperator, boolean>> = {
  eq: false,
  ne: false,
  in: false,
  present: false,
  eq_record: true,
  ne_record: true,
  in_record: true,
};

/** How many operands an operator takes, as a total map for `ABAC_OPERATOR_NEEDS_RECORD`'s reason. */
const OPERATOR_OPERANDS: Readonly<Record<AbacOperator, "none" | "one" | "list">> = {
  eq: "one",
  ne: "one",
  in: "list",
  present: "none",
  eq_record: "one",
  ne_record: "one",
  in_record: "list",
};

/** The operator word `formatAbacPolicies` prints; the `record.` prefix carries the rest. */
const OPERATOR_RENDERED_WORD: Readonly<Record<AbacOperator, string>> = {
  eq: "eq",
  ne: "ne",
  in: "in",
  present: "present",
  eq_record: "eq",
  ne_record: "ne",
  in_record: "in",
};

export function policyNeedsRecord(policy: AbacPolicy): boolean {
  return ABAC_OPERATOR_NEEDS_RECORD[policy.operator];
}

/**
 * The declared keys whose policies cannot be answered without a record, in declaration order.
 *
 * This is what the boot check reads: a manifest declaring one of these keys at a grant position
 * that can never supply a record would be refused unconditionally at request time, and a refusal
 * an operator can be told about at boot must not be discovered as a 403.
 */
export function recordBearingPolicyKeys(
  policies: ReadonlyMap<string, AbacPolicy>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, policy] of policies) {
    if (policyNeedsRecord(policy)) out.add(key);
  }
  return out;
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

/** What the operand of this operator is, so one refusal can name the thing it is requiring. */
function operandNoun(operator: AbacOperator, plural: boolean): string {
  if (ABAC_OPERATOR_NEEDS_RECORD[operator]) {
    return plural ? "record field names" : "record field name";
  }
  return plural ? "values" : "value";
}

/**
 * `<key>=<attribute>:<op>[:<operand>]`, splitting the key on the **first** `=` and the remainder on
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
      `expected <key>=<attribute>:<op>[:<operand>], with one of ${ABAC_OPERATORS.join("/")} as <op>`,
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
      `expected <attribute>:<op>[:<operand>] after the key, got ${parts.length.toString()} ` +
        `colon-separated field(s); an operand containing \`:\` cannot be declared`,
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

  const arity = OPERATOR_OPERANDS[operatorRaw];
  if (arity === "none") {
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
  // An empty member is not an operand: `department:eq:`, `department:in:a,,b` and
  // `department:eq_record:` all declare a comparison against nothing — which no attribute rendering
  // can equal, and which no record can hold a field named — and which an operator almost certainly
  // did not mean.
  if (values.length === 0 || values.some((v) => v === "")) {
    throw new AbacPolicyRefused(
      "value_required",
      raw,
      arity === "list"
        ? `\`${operatorRaw}\` takes a non-empty comma-separated list of ` +
          `${operandNoun(operatorRaw, true)}`
        : `\`${operatorRaw}\` takes exactly one non-empty ${operandNoun(operatorRaw, false)}`,
    );
  }
  if (arity === "one" && values.length !== 1) {
    const listForm = ABAC_OPERATOR_NEEDS_RECORD[operatorRaw] ? "in_record" : "in";
    throw new AbacPolicyRefused(
      "value_required",
      raw,
      `\`${operatorRaw}\` takes exactly one ${operandNoun(operatorRaw, false)}; ` +
        `use \`${listForm}\` to compare against several`,
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
 * What a name resolved to, as three cases rather than a `string | undefined`: "the value is set to
 * something a scalar comparison cannot be applied to" is a third fact, and collapsing it into
 * either of the other two is what decides `present` wrongly.
 */
type ResolvedValue =
  | { readonly kind: "absent" }
  | { readonly kind: "scalar"; readonly rendered: string }
  | { readonly kind: "structured" };

const ABSENT: ResolvedValue = { kind: "absent" };
const STRUCTURED: ResolvedValue = { kind: "structured" };
const NO_RECORD_VALUES: readonly ResolvedValue[] = Object.freeze([]);

/**
 * One resolver for **either** source — the principal's attribute map or the record — because the
 * two sides of a record comparison must be read by the same rules or `eq_record` would compare a
 * string against a convention.
 *
 * Comparison is against a **scalar rendering**: a string is itself, a number or boolean goes
 * through `String()`, and `null` counts as absent. An object or array renders as nothing — a
 * structured value cannot satisfy a scalar comparison, and picking a rendering for it (JSON? the
 * first element?) would make the answer depend on a convention the declaration does not state.
 *
 * Own properties only. `source["constructor"]` would otherwise reach `Object` through the prototype
 * chain, so a policy naming `constructor` or `toString` would find the value "present" on every
 * principal — a fail-open reachable from the declaration alone — and the record is now a **second**
 * source with exactly the same exposure, reachable from a declared field name rather than a
 * declared attribute name.
 */
function resolveScalar(source: Readonly<Record<string, unknown>>, name: string): ResolvedValue {
  if (!Object.prototype.hasOwnProperty.call(source, name)) return ABSENT;
  const value: unknown = source[name];
  if (value === null || value === undefined) return ABSENT;
  if (typeof value === "string") return { kind: "scalar", rendered: value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "scalar", rendered: String(value) };
  }
  return STRUCTURED;
}

/**
 * Both resolved sides, so one map can dispatch both families. A literal operator ignores
 * `recordValues` and a record operator ignores `values` — which is the honest shape, because the
 * alternative is a predicate signature that varies with the operator and a dispatch outside the
 * map.
 */
interface PredicateSides {
  readonly attribute: ResolvedValue;
  /** The declared literals, for `eq`/`ne`/`in`. */
  readonly values: readonly string[];
  /** The declared record field names resolved out of the record, in declaration order. */
  readonly recordValues: readonly ResolvedValue[];
}

/**
 * One predicate per operator, as a **total map** so an eighth operator is a compile error rather
 * than a member inheriting whichever branch an `if`-chain ended on — and the branch it would
 * inherit is the one that allows.
 *
 * Three rules live here and each reads as a bug until the reason is stated:
 *
 * `ne` is deliberately **not** the negation of `eq`, and `ne_record` is not the negation of
 * `eq_record`. An **absent** value answers false for every operator including both `ne` forms,
 * because an absence means nothing is known and a grant condition evaluated against nothing must
 * not be satisfied. For the record operators that holds on **either** side: an absent record field
 * is as unknown as an absent attribute, and "the record does not carry `owner_id`" is not evidence
 * that this principal is not the owner. `present` is the only operator that asks a question an
 * absence can answer.
 *
 * A **structured** value answers false for all three record operators on either side, for
 * `resolveScalar`'s reason: picking a rendering for it would make the answer depend on a convention
 * the declaration does not state.
 *
 * Every single-operand operator re-checks its operand count although `parseAbacPolicySpec`
 * guarantees it, because `AbacPolicy` is an exported interface a caller can build by hand:
 * `{operator: "ne", values: []}` would otherwise compare against `undefined` and satisfy every
 * principal, and `{operator: "eq_record", values: []}` would compare against no field at all.
 */
const OPERATOR_PREDICATES: Readonly<Record<AbacOperator, (sides: PredicateSides) => boolean>> = {
  eq: ({ attribute, values }) =>
    attribute.kind === "scalar" && values.length === 1 && attribute.rendered === values[0],
  ne: ({ attribute, values }) =>
    attribute.kind === "scalar" && values.length === 1 && attribute.rendered !== values[0],
  in: ({ attribute, values }) =>
    attribute.kind === "scalar" && values.includes(attribute.rendered),
  present: ({ attribute }) => attribute.kind !== "absent",
  eq_record: ({ attribute, recordValues }) => {
    if (attribute.kind !== "scalar" || recordValues.length !== 1) return false;
    const other = recordValues[0];
    return other !== undefined && other.kind === "scalar" && attribute.rendered === other.rendered;
  },
  ne_record: ({ attribute, recordValues }) => {
    if (attribute.kind !== "scalar" || recordValues.length !== 1) return false;
    const other = recordValues[0];
    return other !== undefined && other.kind === "scalar" && attribute.rendered !== other.rendered;
  },
  in_record: ({ attribute, recordValues }) => {
    if (attribute.kind !== "scalar") return false;
    const rendered = attribute.rendered;
    return recordValues.some((v) => v.kind === "scalar" && v.rendered === rendered);
  },
};

/**
 * The evaluator over a declaration.
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
    //
    // **Before** the deferral, deliberately: `deferred` tells the caller to re-ask with a record,
    // and a record would not make unresolved attributes resolvable, so answering `deferred` here
    // would send the caller round a loop that cannot terminate. The record is not even read.
    if (attributes === null) return "undischargeable";

    const policy = policies.get(input.policyKey);
    // `undischargeable` and never `denied`: the deployment declared a policy layer and this key is
    // not in it, which is a configuration gap rather than a statement about the principal.
    // `checkAbacObligations` exists so this cannot reach a request from a manifest.
    if (policy === undefined) return "undischargeable";

    const record = input.record;
    // The call site could not supply a record — `list` holds a set and `create` holds only the
    // client's patch — so this policy cannot be answered here. `deferred` rather than `denied`,
    // because the second is a claim about this principal and the record and nothing was compared;
    // `ABAC_OUTCOME_ALLOWS.deferred` is false, so the grant still refuses unless the caller
    // re-asks with one.
    if (policyNeedsRecord(policy) && record === undefined) return "deferred";

    // Resolved through the same reader as the attribute, and only for the operators whose operands
    // are field names — `policyNeedsRecord` is the total map, so a literal operator never reads the
    // record and an eighth operator cannot default into reading it.
    const recordValues =
      policyNeedsRecord(policy) && record !== undefined
        ? policy.values.map((name) => resolveScalar(record, name))
        : NO_RECORD_VALUES;

    // Exact and case-sensitive on both sides. An attribute is written through
    // `--platform-user-routes` and a record field is tenant data; a silent fold or trim would make
    // two distinct values collide.
    return OPERATOR_PREDICATES[policy.operator]({
      attribute: resolveScalar(attributes, policy.attribute),
      values: policy.values,
      recordValues,
    })
      ? "satisfied"
      : "denied";
  };
}

/**
 * A record operator renders its operands behind a `record.` prefix, so the line says which side of
 * the comparison each name belongs to. Only the **declaration** is rendered: the field names are
 * ones the operator typed, never a value read out of a record.
 */
function renderOperand(policy: AbacPolicy): string {
  const joined = policy.values.join(",");
  if (!ABAC_OPERATOR_NEEDS_RECORD[policy.operator]) return joined;
  return policy.values.length === 1 ? `record.${joined}` : `record.(${joined})`;
}

function renderPolicy(policy: AbacPolicy): string {
  const word = OPERATOR_RENDERED_WORD[policy.operator];
  return policy.operator === "present"
    ? `${policy.key}: ${policy.attribute} ${word}`
    : `${policy.key}: ${policy.attribute} ${word} ${renderOperand(policy)}`;
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
