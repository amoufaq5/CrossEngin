import type { AbacEvaluationInput, Principal } from "@crossengin/auth";
import type { TenantId, UserId } from "@crossengin/types";
import { describe, expect, it } from "vitest";

import {
  ABAC_OPERATOR_NEEDS_RECORD,
  ABAC_OPERATORS,
  ABAC_POLICY_FLAG,
  ABAC_POLICY_REFUSALS,
  AbacPolicyRefused,
  buildAbacEvaluator,
  formatAbacPolicies,
  parseAbacPolicies,
  parseAbacPolicySpec,
  policyNeedsRecord,
  recordBearingPolicyKeys,
  type AbacPolicy,
  type AbacPolicyRefusal,
} from "./abac-policy.js";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;

function principal(attributes: Readonly<Record<string, unknown>> | null): Principal {
  return {
    kind: "user",
    tenantId: TENANT,
    userId: "22222222-2222-4222-8222-222222222222" as UserId,
    primaryRole: "clinician",
    secondaryRoles: [],
    abacAttributes: attributes,
    mfaProofAgeSeconds: null,
  };
}

function input(
  policyKey: string,
  attributes: Readonly<Record<string, unknown>> | null,
): AbacEvaluationInput {
  return {
    policyKey,
    principal: principal(attributes),
    entity: "Patient",
    operation: "read",
  };
}

/** Evaluates one spec against one attribute bag, which is what almost every case below needs. */
function evaluate(spec: string, attributes: Readonly<Record<string, unknown>> | null): string {
  const policies = parseAbacPolicies([spec]);
  const key = [...policies.keys()][0] as string;
  return buildAbacEvaluator(policies)(input(key, attributes));
}

/**
 * The same, with a record on the input. `record` is spread conditionally rather than passed as
 * `undefined`, because `exactOptionalPropertyTypes` makes "absent" and "present and undefined"
 * different types — and absent is the fact the deferral turns on.
 */
function inputWithRecord(
  policyKey: string,
  attributes: Readonly<Record<string, unknown>> | null,
  record: Readonly<Record<string, unknown>> | undefined,
): AbacEvaluationInput {
  return {
    ...input(policyKey, attributes),
    ...(record === undefined ? {} : { record }),
  };
}

function evaluateWithRecord(
  spec: string,
  attributes: Readonly<Record<string, unknown>> | null,
  record: Readonly<Record<string, unknown>> | undefined,
): string {
  const policies = parseAbacPolicies([spec]);
  const key = [...policies.keys()][0] as string;
  return buildAbacEvaluator(policies)(inputWithRecord(key, attributes, record));
}

function refusalOf(spec: string): AbacPolicyRefusal {
  try {
    parseAbacPolicySpec(spec);
  } catch (err) {
    if (err instanceof AbacPolicyRefused) return err.refusal;
    throw err;
  }
  throw new Error(`expected ${spec} to be refused`);
}

describe("ABAC_POLICY_FLAG", () => {
  it("is the flag the CLI parses, so a refusal cannot name one that does not exist", () => {
    expect(ABAC_POLICY_FLAG).toBe("--abac-policy");
  });
});

/**
 * Both of this suite's original assertions were about the limitation this increment closes — the
 * four-operator list, and that no operator reached a record because the seam could not carry one.
 * They are restated rather than deleted: the second becomes the positive form, so the three record
 * operators cannot be removed without a test naming the reason they exist.
 */
describe("ABAC_OPERATORS", () => {
  it("names the four literal operators and the three record ones", () => {
    expect(ABAC_OPERATORS).toEqual([
      "eq",
      "ne",
      "in",
      "present",
      "eq_record",
      "ne_record",
      "in_record",
    ]);
  });

  it("offers an operator over a record for each comparison a literal has but `present`", () => {
    const record = ABAC_OPERATORS.filter((op) => op.endsWith("_record"));
    expect(record).toEqual(["eq_record", "ne_record", "in_record"]);
  });
});

describe("ABAC_POLICY_REFUSALS", () => {
  it("names every refusal", () => {
    expect(ABAC_POLICY_REFUSALS).toEqual([
      "malformed",
      "unknown_operator",
      "value_required",
      "value_forbidden",
      "duplicate_key",
      "empty_attribute",
      "empty_key",
    ]);
  });
});

describe("parseAbacPolicySpec", () => {
  it("parses an eq policy", () => {
    expect(parseAbacPolicySpec("clinical_only=department:eq:clinical")).toEqual({
      key: "clinical_only",
      attribute: "department",
      operator: "eq",
      values: ["clinical"],
    });
  });

  it("parses an ne policy", () => {
    expect(parseAbacPolicySpec("not_temp=employment:ne:temporary")).toEqual({
      key: "not_temp",
      attribute: "employment",
      operator: "ne",
      values: ["temporary"],
    });
  });

  it("parses an in policy with several values", () => {
    expect(parseAbacPolicySpec("care_team=department:in:clinical,nursing")).toEqual({
      key: "care_team",
      attribute: "department",
      operator: "in",
      values: ["clinical", "nursing"],
    });
  });

  it("parses an in policy with one value, which is legal and not the same declaration as eq", () => {
    const policy = parseAbacPolicySpec("one=department:in:clinical");
    expect(policy.operator).toBe("in");
    expect(policy.values).toEqual(["clinical"]);
  });

  it("parses a present policy with no values", () => {
    expect(parseAbacPolicySpec("vetted=clearance:present")).toEqual({
      key: "vetted",
      attribute: "clearance",
      operator: "present",
      values: [],
    });
  });

  it("splits the key on the first `=` only, so a value may contain one", () => {
    const policy = parseAbacPolicySpec("k=tag:eq:a=b");
    expect(policy.key).toBe("k");
    expect(policy.attribute).toBe("tag");
    expect(policy.values).toEqual(["a=b"]);
  });

  it("accepts a key containing no `=` of its own", () => {
    expect(parseAbacPolicySpec("same_facility=facility:present").key).toBe("same_facility");
  });

  it("refuses a spec with no `=` as malformed", () => {
    expect(refusalOf("department:eq:clinical")).toBe("malformed");
  });

  it("refuses an empty key", () => {
    expect(refusalOf("=department:eq:clinical")).toBe("empty_key");
  });

  it("refuses an empty attribute", () => {
    expect(refusalOf("k=:eq:clinical")).toBe("empty_attribute");
  });

  it("refuses an attribute with no operator as malformed", () => {
    expect(refusalOf("k=department")).toBe("malformed");
  });

  it("refuses a fourth colon-separated field, because a value containing `:` is not declarable", () => {
    expect(refusalOf("k=department:eq:a:b")).toBe("malformed");
  });

  it("refuses an unknown operator", () => {
    expect(refusalOf("k=department:equals:clinical")).toBe("unknown_operator");
  });

  it("refuses an `==`-style operator rather than guessing which side the key ends on", () => {
    expect(refusalOf("k=department==clinical")).toBe("malformed");
  });

  it("refuses eq with no value", () => {
    expect(refusalOf("k=department:eq")).toBe("value_required");
  });

  it("refuses ne with no value", () => {
    expect(refusalOf("k=department:ne")).toBe("value_required");
  });

  it("refuses in with no value", () => {
    expect(refusalOf("k=department:in")).toBe("value_required");
  });

  it("refuses an empty value segment, which compares against nothing", () => {
    expect(refusalOf("k=department:eq:")).toBe("value_required");
  });

  it("refuses an empty member inside an in list", () => {
    expect(refusalOf("k=department:in:clinical,,nursing")).toBe("value_required");
  });

  it("refuses eq with several values, pointing at `in`", () => {
    expect(refusalOf("k=department:eq:clinical,nursing")).toBe("value_required");
    expect(() => parseAbacPolicySpec("k=department:eq:clinical,nursing")).toThrow(/use `in`/);
  });

  it("refuses present with a value", () => {
    expect(refusalOf("k=clearance:present:high")).toBe("value_forbidden");
  });

  it("refuses present with an empty value segment, because a trailing colon is a typo", () => {
    expect(refusalOf("k=clearance:present:")).toBe("value_forbidden");
  });

  it("carries the refusal, the spec and the flag on the error", () => {
    const spec = "k=clearance:present:high";
    try {
      parseAbacPolicySpec(spec);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(AbacPolicyRefused);
      const refused = err as AbacPolicyRefused;
      expect(refused.name).toBe("AbacPolicyRefused");
      expect(refused.refusal).toBe("value_forbidden");
      expect(refused.spec).toBe(spec);
      expect(refused.message).toContain(ABAC_POLICY_FLAG);
    }
  });

  it("names the operators in the malformed message, so the grammar is recoverable from it", () => {
    expect(() => parseAbacPolicySpec("nope")).toThrow(/present/);
  });
});

describe("parseAbacPolicies", () => {
  it("returns an empty map for no specs, which is how `no evaluator` is spelled", () => {
    expect(parseAbacPolicies([]).size).toBe(0);
  });

  it("keys the map by policy key in declaration order", () => {
    const policies = parseAbacPolicies(["b=department:present", "a=clearance:eq:high"]);
    expect([...policies.keys()]).toEqual(["b", "a"]);
    expect(policies.get("a")?.attribute).toBe("clearance");
  });

  it("refuses a repeated key rather than taking the last, so argv order cannot decide a grant", () => {
    expect(refusalOfList(["k=department:eq:clinical", "k=department:eq:nursing"])).toBe(
      "duplicate_key",
    );
  });

  it("names the repeated key in the message", () => {
    expect(() => parseAbacPolicies(["k=department:eq:clinical", "k=clearance:present"])).toThrow(
      /"k"/,
    );
  });

  it("propagates a per-spec refusal unchanged", () => {
    expect(refusalOfList(["ok=department:present", "bad=clearance:present:high"])).toBe(
      "value_forbidden",
    );
  });

  function refusalOfList(specs: readonly string[]): AbacPolicyRefusal {
    try {
      parseAbacPolicies(specs);
    } catch (err) {
      if (err instanceof AbacPolicyRefused) return err.refusal;
      throw err;
    }
    throw new Error("expected a refusal");
  }
});

describe("buildAbacEvaluator — the four operators", () => {
  it("satisfies eq on an exact match", () => {
    expect(evaluate("k=department:eq:clinical", { department: "clinical" })).toBe("satisfied");
  });

  it("denies eq on a different value", () => {
    expect(evaluate("k=department:eq:clinical", { department: "nursing" })).toBe("denied");
  });

  it("satisfies ne on a different value", () => {
    expect(evaluate("k=department:ne:temporary", { department: "clinical" })).toBe("satisfied");
  });

  it("denies ne on the declared value", () => {
    expect(evaluate("k=department:ne:temporary", { department: "temporary" })).toBe("denied");
  });

  it("satisfies in on any listed value", () => {
    const spec = "k=department:in:clinical,nursing";
    expect(evaluate(spec, { department: "clinical" })).toBe("satisfied");
    expect(evaluate(spec, { department: "nursing" })).toBe("satisfied");
  });

  it("denies in on an unlisted value", () => {
    expect(evaluate("k=department:in:clinical,nursing", { department: "billing" })).toBe("denied");
  });

  it("satisfies in with a single-value list", () => {
    expect(evaluate("k=department:in:clinical", { department: "clinical" })).toBe("satisfied");
  });

  it("satisfies present on any set value", () => {
    expect(evaluate("k=clearance:present", { clearance: "high" })).toBe("satisfied");
  });

  it("satisfies present on an empty string, which is a set value", () => {
    expect(evaluate("k=clearance:present", { clearance: "" })).toBe("satisfied");
  });

  it("satisfies present on `false`, which is a set value and not an absence", () => {
    expect(evaluate("k=clearance:present", { clearance: false })).toBe("satisfied");
  });
});

/**
 * The hardest-pinned rule in the module. `ne` is deliberately **not** the negation of `eq`: an
 * absent attribute means nothing is known about the principal, and a grant condition evaluated
 * against nothing must not be satisfied. All four operators therefore deny an absence.
 */
describe("buildAbacEvaluator — an absent attribute denies, for every operator", () => {
  const cases: readonly [string, string][] = [
    ["eq", "k=department:eq:clinical"],
    ["ne", "k=department:ne:clinical"],
    ["in", "k=department:in:clinical,nursing"],
    ["present", "k=department:present"],
  ];

  for (const [op, spec] of cases) {
    it(`denies ${op} when the attribute is missing from the bag`, () => {
      expect(evaluate(spec, { other: "x" })).toBe("denied");
    });

    it(`denies ${op} when the bag is empty`, () => {
      expect(evaluate(spec, {})).toBe("denied");
    });

    it(`denies ${op} when the attribute is null`, () => {
      expect(evaluate(spec, { department: null })).toBe("denied");
    });

    it(`denies ${op} when the attribute is undefined`, () => {
      expect(evaluate(spec, { department: undefined })).toBe("denied");
    });
  }

  it("denies ne on an absence rather than reading the absence as `not clinical`", () => {
    expect(evaluate("k=department:ne:clinical", {})).toBe("denied");
    expect(evaluate("k=department:ne:clinical", { department: "nursing" })).toBe("satisfied");
  });

  it("denies present for an attribute reachable only through the prototype chain", () => {
    expect(evaluate("k=constructor:present", {})).toBe("denied");
    expect(evaluate("k=toString:present", {})).toBe("denied");
  });
});

describe("buildAbacEvaluator — the scalar rendering", () => {
  it("renders a number through String()", () => {
    expect(evaluate("k=level:eq:3", { level: 3 })).toBe("satisfied");
    expect(evaluate("k=level:eq:3", { level: 4 })).toBe("denied");
  });

  it("renders a boolean through String()", () => {
    expect(evaluate("k=vetted:eq:true", { vetted: true })).toBe("satisfied");
    expect(evaluate("k=vetted:eq:true", { vetted: false })).toBe("denied");
    expect(evaluate("k=vetted:eq:false", { vetted: false })).toBe("satisfied");
  });

  it("matches a number against its own rendering and not against a padded one", () => {
    expect(evaluate("k=level:in:1,2,3", { level: 2 })).toBe("satisfied");
    expect(evaluate("k=level:eq:3.0", { level: 3 })).toBe("denied");
  });

  it("compares exactly and case-sensitively, with no trimming", () => {
    expect(evaluate("k=department:eq:clinical", { department: "Clinical" })).toBe("denied");
    expect(evaluate("k=department:eq:clinical", { department: " clinical" })).toBe("denied");
    expect(evaluate("k=department:eq:clinical", { department: "clinical " })).toBe("denied");
  });

  it("compares an in list case-sensitively too", () => {
    expect(evaluate("k=department:in:clinical,nursing", { department: "NURSING" })).toBe("denied");
  });
});

/**
 * A structured value cannot satisfy a scalar comparison, and picking a rendering for it (JSON? the
 * first element?) would make the answer depend on a convention the declaration does not state. It
 * is nonetheless *present*, which is the one question an unrenderable value can answer.
 */
describe("buildAbacEvaluator — a structured attribute", () => {
  const structured: readonly [string, unknown][] = [
    ["an object", { nested: "clinical" }],
    ["an array", ["clinical"]],
    ["an empty object", {}],
    ["an empty array", []],
  ];

  for (const [label, value] of structured) {
    it(`denies eq against ${label}`, () => {
      expect(evaluate("k=department:eq:clinical", { department: value })).toBe("denied");
    });

    it(`denies ne against ${label}, since "not clinical" is not what an unrenderable value says`, () => {
      expect(evaluate("k=department:ne:clinical", { department: value })).toBe("denied");
    });

    it(`denies in against ${label}`, () => {
      expect(evaluate("k=department:in:clinical,nursing", { department: value })).toBe("denied");
    });

    it(`satisfies present against ${label}, which is set`, () => {
      expect(evaluate("k=department:present", { department: value })).toBe("satisfied");
    });
  }
});

describe("buildAbacEvaluator — unresolved attributes", () => {
  it("answers undischargeable, not denied, when the directory was never consulted", () => {
    expect(evaluate("k=department:present", null)).toBe("undischargeable");
  });

  it("answers undischargeable before consulting the policy, so a satisfying bag is not assumed", () => {
    const policies = parseAbacPolicies(["k=department:eq:clinical"]);
    const evaluator = buildAbacEvaluator(policies);
    expect(evaluator(input("k", { department: "clinical" }))).toBe("satisfied");
    expect(evaluator(input("k", null))).toBe("undischargeable");
  });

  it("distinguishes null from `{}`, which asserts this principal has no attributes", () => {
    expect(evaluate("k=department:present", null)).toBe("undischargeable");
    expect(evaluate("k=department:present", {})).toBe("denied");
  });
});

describe("buildAbacEvaluator — an undeclared policy key", () => {
  it("answers undischargeable, never denied: a configuration gap is not a claim about the principal", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies(["known=department:present"]));
    expect(evaluator(input("unknown", { department: "clinical" }))).toBe("undischargeable");
  });

  it("answers undischargeable for every key when nothing is declared", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies([]));
    expect(evaluator(input("anything", { department: "clinical" }))).toBe("undischargeable");
  });

  it("matches the key exactly, so a near-miss is undischargeable rather than silently another policy", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies(["known=department:present"]));
    expect(evaluator(input("Known", { department: "clinical" }))).toBe("undischargeable");
  });
});

describe("buildAbacEvaluator — fail-closed shapes a hand-built policy could reach", () => {
  it("denies ne declared with no value, which would otherwise satisfy every principal", () => {
    const policy: AbacPolicy = { key: "k", attribute: "department", operator: "ne", values: [] };
    const evaluator = buildAbacEvaluator(new Map([["k", policy]]));
    expect(evaluator(input("k", { department: "clinical" }))).toBe("denied");
  });

  it("denies eq declared with no value", () => {
    const policy: AbacPolicy = { key: "k", attribute: "department", operator: "eq", values: [] };
    const evaluator = buildAbacEvaluator(new Map([["k", policy]]));
    expect(evaluator(input("k", { department: "clinical" }))).toBe("denied");
  });

  it("denies in declared with no value", () => {
    const policy: AbacPolicy = { key: "k", attribute: "department", operator: "in", values: [] };
    const evaluator = buildAbacEvaluator(new Map([["k", policy]]));
    expect(evaluator(input("k", { department: "clinical" }))).toBe("denied");
  });

  it("never throws, whatever the bag holds", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies(["k=department:eq:clinical"]));
    const bags: readonly Record<string, unknown>[] = [
      { department: Symbol("x") },
      { department: 10n },
      { department: () => "clinical" },
      { department: Number.NaN },
    ];
    for (const bag of bags) {
      expect(() => evaluator(input("k", bag))).not.toThrow();
      expect(evaluator(input("k", bag))).toBe("denied");
    }
  });

  it("ignores the field and operation on the input, because no declarable policy reads them", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies(["k=department:eq:clinical"]));
    const withField: AbacEvaluationInput = {
      ...input("k", { department: "clinical" }),
      operation: { kind: "transition", name: "close" },
      field: "mrn",
    };
    expect(evaluator(withField)).toBe("satisfied");
  });
});

describe("formatAbacPolicies", () => {
  it("says none are declared affirmatively, so a missing policy layer is not inferred from silence", () => {
    expect(formatAbacPolicies(parseAbacPolicies([]))).toBe(
      "abac policies: none declared, so no obligation can be discharged",
    );
  });

  it("names the count and each policy in declaration order", () => {
    const line = formatAbacPolicies(
      parseAbacPolicies([
        "clinical_only=department:eq:clinical",
        "care_team=department:in:clinical,nursing",
        "vetted=clearance:present",
      ]),
    );
    expect(line).toBe(
      "abac policies: 3 declared: clinical_only: department eq clinical, " +
        "care_team: department in clinical,nursing, vetted: clearance present",
    );
  });

  it("renders a present policy with no value where a value would go", () => {
    expect(formatAbacPolicies(parseAbacPolicies(["vetted=clearance:present"]))).toContain(
      "vetted: clearance present",
    );
  });

  it("renders an ne policy with its operator spelled out", () => {
    expect(formatAbacPolicies(parseAbacPolicies(["k=employment:ne:temporary"]))).toContain(
      "k: employment ne temporary",
    );
  });

  it("renders every declared member of an in list, so a truncated policy is visible as one", () => {
    expect(formatAbacPolicies(parseAbacPolicies(["k=department:in:a,b,c,d"]))).toContain(
      "k: department in a,b,c,d",
    );
  });

  it("names the map's size and not the spec count, so a key is reported once", () => {
    const line = formatAbacPolicies(parseAbacPolicies(["a=x:present", "b=y:present"]));
    expect(line).toContain("2 declared");
  });
});

describe("ABAC_OPERATOR_NEEDS_RECORD", () => {
  it("is total over the operators, so an eighth cannot inherit an answer", () => {
    expect(Object.keys(ABAC_OPERATOR_NEEDS_RECORD)).toHaveLength(ABAC_OPERATORS.length);
    for (const op of ABAC_OPERATORS) {
      expect(typeof ABAC_OPERATOR_NEEDS_RECORD[op]).toBe("boolean");
    }
  });

  it("answers false for the four literal operators", () => {
    expect(ABAC_OPERATOR_NEEDS_RECORD.eq).toBe(false);
    expect(ABAC_OPERATOR_NEEDS_RECORD.ne).toBe(false);
    expect(ABAC_OPERATOR_NEEDS_RECORD.in).toBe(false);
    expect(ABAC_OPERATOR_NEEDS_RECORD.present).toBe(false);
  });

  it("answers true for the three record operators", () => {
    expect(ABAC_OPERATOR_NEEDS_RECORD.eq_record).toBe(true);
    expect(ABAC_OPERATOR_NEEDS_RECORD.ne_record).toBe(true);
    expect(ABAC_OPERATOR_NEEDS_RECORD.in_record).toBe(true);
  });

  it("agrees with policyNeedsRecord for every operator", () => {
    for (const op of ABAC_OPERATORS) {
      const policy: AbacPolicy = {
        key: "k",
        attribute: "a",
        operator: op,
        values: op === "present" ? [] : ["x"],
      };
      expect(policyNeedsRecord(policy)).toBe(ABAC_OPERATOR_NEEDS_RECORD[op]);
    }
  });
});

describe("recordBearingPolicyKeys", () => {
  it("names only the record-bearing keys of a mixed declaration, in declaration order", () => {
    const policies = parseAbacPolicies([
      "clinical_only=department:eq:clinical",
      "same_dept=department:eq_record:department",
      "vetted=clearance:present",
      "owns=user_id:eq_record:owner_id",
      "teams=team:in_record:primary_team,secondary_team",
      "not_mine=user_id:ne_record:owner_id",
    ]);
    expect([...recordBearingPolicyKeys(policies)]).toEqual([
      "same_dept",
      "owns",
      "teams",
      "not_mine",
    ]);
  });

  it("is empty when every declared policy is over literals", () => {
    const policies = parseAbacPolicies(["a=x:eq:1", "b=y:in:1,2", "c=z:present", "d=w:ne:1"]);
    expect(recordBearingPolicyKeys(policies).size).toBe(0);
  });

  it("is empty for an empty declaration", () => {
    expect(recordBearingPolicyKeys(parseAbacPolicies([])).size).toBe(0);
  });
});

describe("parseAbacPolicySpec — the record operators", () => {
  it("parses eq_record, whose operand is a record field name and not a literal", () => {
    expect(parseAbacPolicySpec("same_dept=department:eq_record:department")).toEqual({
      key: "same_dept",
      attribute: "department",
      operator: "eq_record",
      values: ["department"],
    });
  });

  it("parses eq_record naming two different sides, which is the ownership shape", () => {
    expect(parseAbacPolicySpec("owns=user_id:eq_record:owner_id")).toEqual({
      key: "owns",
      attribute: "user_id",
      operator: "eq_record",
      values: ["owner_id"],
    });
  });

  it("parses ne_record", () => {
    expect(parseAbacPolicySpec("not_mine=user_id:ne_record:owner_id")).toEqual({
      key: "not_mine",
      attribute: "user_id",
      operator: "ne_record",
      values: ["owner_id"],
    });
  });

  it("parses in_record with several field names", () => {
    expect(parseAbacPolicySpec("teams=team:in_record:primary_team,secondary_team")).toEqual({
      key: "teams",
      attribute: "team",
      operator: "in_record",
      values: ["primary_team", "secondary_team"],
    });
  });

  it("parses in_record with one field name, which is a different declaration from eq_record", () => {
    const policy = parseAbacPolicySpec("teams=team:in_record:primary_team");
    expect(policy.operator).toBe("in_record");
    expect(policy.values).toEqual(["primary_team"]);
  });

  it("refuses eq_record with no operand", () => {
    expect(refusalOf("k=user_id:eq_record")).toBe("value_required");
  });

  it("refuses eq_record with an empty operand segment", () => {
    expect(refusalOf("k=user_id:eq_record:")).toBe("value_required");
  });

  it("refuses ne_record with no operand", () => {
    expect(refusalOf("k=user_id:ne_record")).toBe("value_required");
  });

  it("refuses in_record with no operand", () => {
    expect(refusalOf("k=team:in_record")).toBe("value_required");
  });

  it("refuses an empty member inside an in_record list", () => {
    expect(refusalOf("k=team:in_record:primary,,secondary")).toBe("value_required");
  });

  it("refuses eq_record with two operands, pointing at in_record and not at in", () => {
    expect(refusalOf("k=user_id:eq_record:owner_id,approver_id")).toBe("value_required");
    expect(() => parseAbacPolicySpec("k=user_id:eq_record:owner_id,approver_id")).toThrow(
      /use `in_record`/,
    );
  });

  it("refuses ne_record with two operands", () => {
    expect(refusalOf("k=user_id:ne_record:owner_id,approver_id")).toBe("value_required");
  });

  it("names the operator in the refusal, so the message is actionable from the spec alone", () => {
    expect(() => parseAbacPolicySpec("k=user_id:eq_record")).toThrow(/`eq_record`/);
    expect(() => parseAbacPolicySpec("k=user_id:ne_record")).toThrow(/`ne_record`/);
    expect(() => parseAbacPolicySpec("k=team:in_record")).toThrow(/`in_record`/);
  });

  it("requires a *field name* rather than a value, since that is what the operand is", () => {
    expect(() => parseAbacPolicySpec("k=user_id:eq_record")).toThrow(/record field name/);
    expect(() => parseAbacPolicySpec("k=team:in_record")).toThrow(/record field names/);
    // The literal operators still require a value, so the two families stay distinguishable.
    expect(() => parseAbacPolicySpec("k=user_id:eq")).toThrow(/one non-empty value/);
  });

  it("names the record operators in the malformed message too", () => {
    expect(() => parseAbacPolicySpec("nope")).toThrow(/eq_record/);
  });

  it("keeps `present` the only operator forbidding an operand", () => {
    for (const op of ABAC_OPERATORS) {
      if (op === "present") continue;
      expect(refusalOf(`k=a:${op}`)).toBe("value_required");
    }
    expect(refusalOf("k=a:present:x")).toBe("value_forbidden");
  });

  /**
   * The whole reason the record comparison is a separate operator rather than a `record.` prefix on
   * the operand: with a prefix, this spec would have two readings and the parser would pick one.
   */
  it("still reads a literal beginning with `record.` as a literal under eq", () => {
    const policy = parseAbacPolicySpec("k=tag:eq:record.department");
    expect(policy.operator).toBe("eq");
    expect(policy.values).toEqual(["record.department"]);
    expect(evaluate("k=tag:eq:record.department", { tag: "record.department" })).toBe("satisfied");
  });
});

describe("buildAbacEvaluator — the deferral", () => {
  const needsRecord: readonly string[] = [
    "k=user_id:eq_record:owner_id",
    "k=user_id:ne_record:owner_id",
    "k=team:in_record:primary_team,secondary_team",
  ];

  for (const spec of needsRecord) {
    it(`defers ${spec} when no record was supplied`, () => {
      expect(evaluateWithRecord(spec, { user_id: "u1", team: "t1" }, undefined)).toBe("deferred");
    });
  }

  it("defers rather than denying, because nothing was compared", () => {
    expect(evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, undefined)).toBe(
      "deferred",
    );
    expect(
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, { owner_id: "u2" }),
    ).toBe("denied");
  });

  it("does not defer a literal policy when no record was supplied", () => {
    expect(evaluateWithRecord("k=department:eq:clinical", { department: "clinical" }, undefined)) //
      .toBe("satisfied");
    expect(evaluateWithRecord("k=department:present", {}, undefined)).toBe("denied");
  });

  it("defers for an empty record only when the declared field is the thing missing — it is not", () => {
    // An empty record *was* supplied, so the policy is answerable: the field is absent, which
    // denies. A deferral here would ask the caller to supply what they already did.
    expect(evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, {})).toBe("denied");
  });
});

/**
 * The ordering most likely to regress, so it is pinned by construction rather than by reading the
 * answer: the record's getter throws, and `buildAbacEvaluator` does not catch, so reaching the
 * record at all would surface as an exception instead of `undischargeable`.
 */
describe("buildAbacEvaluator — unresolved attributes outrank the deferral", () => {
  function explosiveRecord(): Readonly<Record<string, unknown>> {
    const record = {};
    Object.defineProperty(record, "owner_id", {
      enumerable: true,
      get(): never {
        throw new Error("the record must not be read when attributes are unresolved");
      },
    });
    return record;
  }

  it("answers undischargeable, not deferred, when attributes are null and the policy needs a record", () => {
    expect(evaluateWithRecord("k=user_id:eq_record:owner_id", null, undefined)).toBe(
      "undischargeable",
    );
  });

  it("answers undischargeable even when a record *was* supplied", () => {
    expect(evaluateWithRecord("k=user_id:eq_record:owner_id", null, { owner_id: "u1" })).toBe(
      "undischargeable",
    );
  });

  it("never reads the record, because re-asking with one could not help", () => {
    const run = (): string =>
      evaluateWithRecord("k=user_id:eq_record:owner_id", null, explosiveRecord());
    expect(run).not.toThrow();
    expect(run()).toBe("undischargeable");
  });

  it("reads the record once attributes resolve, so the probe is live and not vacuous", () => {
    expect(() =>
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, explosiveRecord()),
    ).toThrow(/must not be read/);
  });

  it("answers undischargeable for an undeclared key before deferring", () => {
    const evaluator = buildAbacEvaluator(parseAbacPolicies(["known=user_id:eq_record:owner_id"]));
    expect(evaluator(inputWithRecord("unknown", { user_id: "u1" }, undefined))).toBe(
      "undischargeable",
    );
  });
});

describe("buildAbacEvaluator — eq_record", () => {
  it("satisfies when the attribute equals the named record field", () => {
    expect(
      evaluateWithRecord(
        "k=department:eq_record:department",
        { department: "clinical" },
        { department: "clinical", mrn: "MRN-1" },
      ),
    ).toBe("satisfied");
  });

  it("satisfies ownership when the two sides are differently named", () => {
    expect(
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, { owner_id: "u1" }),
    ).toBe("satisfied");
  });

  it("denies when the record field holds another value", () => {
    expect(
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, { owner_id: "u2" }),
    ).toBe("denied");
  });

  it("compares exactly and case-sensitively on both sides", () => {
    expect(
      evaluateWithRecord(
        "k=department:eq_record:department",
        { department: "clinical" },
        { department: "Clinical" },
      ),
    ).toBe("denied");
    expect(
      evaluateWithRecord(
        "k=department:eq_record:department",
        { department: "clinical" },
        { department: "clinical " },
      ),
    ).toBe("denied");
  });

  it("denies when the attribute is absent", () => {
    expect(evaluateWithRecord("k=user_id:eq_record:owner_id", {}, { owner_id: "u1" })).toBe(
      "denied",
    );
  });

  it("denies when the record field is absent", () => {
    expect(
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, { other: "u1" }),
    ).toBe("denied");
  });

  it("denies when the record field is null, which is an absence and not a value", () => {
    expect(
      evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, { owner_id: null }),
    ).toBe("denied");
  });
});

/**
 * `ne_record` is deliberately **not** the negation of `eq_record`, for the reason `ne` is not the
 * negation of `eq`: an absence on *either* side means nothing is known, and a grant condition
 * evaluated against nothing must not be satisfied. "The record does not carry `owner_id`" is not
 * evidence that this principal is not the owner.
 */
describe("buildAbacEvaluator — ne_record", () => {
  it("satisfies when both sides are set and differ", () => {
    expect(
      evaluateWithRecord("k=user_id:ne_record:owner_id", { user_id: "u1" }, { owner_id: "u2" }),
    ).toBe("satisfied");
  });

  it("denies when both sides are set and match", () => {
    expect(
      evaluateWithRecord("k=user_id:ne_record:owner_id", { user_id: "u1" }, { owner_id: "u1" }),
    ).toBe("denied");
  });

  it("denies when the attribute side is absent", () => {
    expect(evaluateWithRecord("k=user_id:ne_record:owner_id", {}, { owner_id: "u2" })).toBe(
      "denied",
    );
  });

  it("denies when the record side is absent", () => {
    expect(evaluateWithRecord("k=user_id:ne_record:owner_id", { user_id: "u1" }, {})).toBe("denied");
  });

  it("is therefore not the negation of eq_record on an absence", () => {
    const spec = "k=user_id:ne_record:owner_id";
    const eqSpec = "k=user_id:eq_record:owner_id";
    expect(evaluateWithRecord(spec, { user_id: "u1" }, {})).toBe("denied");
    expect(evaluateWithRecord(eqSpec, { user_id: "u1" }, {})).toBe("denied");
  });
});

describe("buildAbacEvaluator — in_record", () => {
  const spec = "k=team:in_record:primary_team,secondary_team";

  it("satisfies on the first named field", () => {
    expect(
      evaluateWithRecord(spec, { team: "t1" }, { primary_team: "t1", secondary_team: "t2" }),
    ).toBe("satisfied");
  });

  it("satisfies on any later named field", () => {
    expect(
      evaluateWithRecord(spec, { team: "t2" }, { primary_team: "t1", secondary_team: "t2" }),
    ).toBe("satisfied");
  });

  it("denies when no named field holds the attribute", () => {
    expect(
      evaluateWithRecord(spec, { team: "t3" }, { primary_team: "t1", secondary_team: "t2" }),
    ).toBe("denied");
  });

  it("satisfies when one named field is absent and another matches", () => {
    expect(evaluateWithRecord(spec, { team: "t2" }, { secondary_team: "t2" })).toBe("satisfied");
  });

  it("denies when every named field is absent", () => {
    expect(evaluateWithRecord(spec, { team: "t2" }, { other: "t2" })).toBe("denied");
  });

  it("denies when the attribute is absent, however many fields match each other", () => {
    expect(evaluateWithRecord(spec, {}, { primary_team: "t1", secondary_team: "t1" })).toBe(
      "denied",
    );
  });

  it("does not match a field *name* against the attribute, only the field's value", () => {
    expect(evaluateWithRecord(spec, { team: "primary_team" }, { primary_team: "t1" })).toBe(
      "denied",
    );
  });
});

/**
 * A structured value on either side answers false for all three record operators, for the reason a
 * structured attribute already did: picking a rendering for it (JSON? the first element?) would
 * make the answer depend on a convention the declaration does not state.
 */
describe("buildAbacEvaluator — a structured value on either side of a record comparison", () => {
  const structured: readonly [string, unknown][] = [
    ["an object", { nested: "u1" }],
    ["an array", ["u1"]],
    ["an empty object", {}],
    ["an empty array", []],
  ];

  const specs: readonly [string, string][] = [
    ["eq_record", "k=user_id:eq_record:owner_id"],
    ["ne_record", "k=user_id:ne_record:owner_id"],
    ["in_record", "k=user_id:in_record:owner_id"],
  ];

  for (const [op, spec] of specs) {
    for (const [label, value] of structured) {
      it(`denies ${op} when the attribute is ${label}`, () => {
        expect(evaluateWithRecord(spec, { user_id: value }, { owner_id: "u1" })).toBe("denied");
      });

      it(`denies ${op} when the record field is ${label}`, () => {
        expect(evaluateWithRecord(spec, { user_id: "u1" }, { owner_id: value })).toBe("denied");
      });

      it(`denies ${op} when both sides are ${label}`, () => {
        expect(evaluateWithRecord(spec, { user_id: value }, { owner_id: value })).toBe("denied");
      });
    }
  }
});

/**
 * The prototype-chain guard, now on a **second** source. A declared field name is as much an
 * operator-supplied string as a declared attribute name, so a policy naming `constructor` would
 * otherwise find a value on every record that exists.
 */
describe("buildAbacEvaluator — a record field reachable only through the prototype chain", () => {
  const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"] as const;

  for (const name of names) {
    it(`treats a record field named ${name} as absent under eq_record`, () => {
      expect(evaluateWithRecord(`k=probe:eq_record:${name}`, { probe: "anything" }, {})).toBe(
        "denied",
      );
    });

    it(`treats a record field named ${name} as absent under ne_record`, () => {
      expect(evaluateWithRecord(`k=probe:ne_record:${name}`, { probe: "anything" }, {})).toBe(
        "denied",
      );
    });

    it(`treats a record field named ${name} as absent under in_record`, () => {
      expect(evaluateWithRecord(`k=probe:in_record:${name}`, { probe: "anything" }, {})).toBe(
        "denied",
      );
    });
  }

  it("reads an own field of that name when the record really carries one", () => {
    const record = JSON.parse('{"toString":"u1"}') as Readonly<Record<string, unknown>>;
    expect(evaluateWithRecord("k=user_id:eq_record:toString", { user_id: "u1" }, record)).toBe(
      "satisfied",
    );
  });
});

describe("buildAbacEvaluator — the scalar rendering on the record side", () => {
  it("renders a number through String(), so an attribute string matches it", () => {
    expect(evaluateWithRecord("k=count:eq_record:count", { count: "3" }, { count: 3 })).toBe(
      "satisfied",
    );
    expect(evaluateWithRecord("k=count:eq_record:count", { count: "4" }, { count: 3 })).toBe(
      "denied",
    );
  });

  it("renders both sides the same way, so a number matches a number", () => {
    expect(evaluateWithRecord("k=count:eq_record:count", { count: 3 }, { count: 3 })).toBe(
      "satisfied",
    );
  });

  it("does not pad or normalise, so 3 and 3.0 differ", () => {
    expect(evaluateWithRecord("k=count:eq_record:count", { count: "3.0" }, { count: 3 })).toBe(
      "denied",
    );
  });

  it("renders a boolean through String()", () => {
    expect(evaluateWithRecord("k=flag:eq_record:flag", { flag: "true" }, { flag: true })).toBe(
      "satisfied",
    );
    expect(evaluateWithRecord("k=flag:eq_record:flag", { flag: true }, { flag: false })).toBe(
      "denied",
    );
  });

  it("treats `false` on the record as a set value, so ne_record can satisfy against it", () => {
    expect(evaluateWithRecord("k=flag:ne_record:flag", { flag: true }, { flag: false })).toBe(
      "satisfied",
    );
  });

  it("matches an empty string on the record, which is a set value", () => {
    expect(evaluateWithRecord("k=tag:eq_record:tag", { tag: "" }, { tag: "" })).toBe("satisfied");
  });

  it("never throws on a record value no rendering covers", () => {
    const bags: readonly Record<string, unknown>[] = [
      { owner_id: Symbol("x") },
      { owner_id: 10n },
      { owner_id: () => "u1" },
      { owner_id: Number.NaN },
    ];
    for (const record of bags) {
      const run = (): string =>
        evaluateWithRecord("k=user_id:eq_record:owner_id", { user_id: "u1" }, record);
      expect(run).not.toThrow();
      expect(run()).toBe("denied");
    }
  });
});

describe("buildAbacEvaluator — record operators on a hand-built policy", () => {
  function evaluateHandBuilt(
    policy: AbacPolicy,
    record: Readonly<Record<string, unknown>>,
  ): string {
    return buildAbacEvaluator(new Map([[policy.key, policy]]))(
      inputWithRecord(policy.key, { user_id: "u1" }, record),
    );
  }

  it("denies eq_record declared with no field name, which would compare against nothing", () => {
    expect(
      evaluateHandBuilt(
        { key: "k", attribute: "user_id", operator: "eq_record", values: [] },
        { owner_id: "u1" },
      ),
    ).toBe("denied");
  });

  it("denies ne_record declared with no field name, which would otherwise satisfy everybody", () => {
    expect(
      evaluateHandBuilt(
        { key: "k", attribute: "user_id", operator: "ne_record", values: [] },
        { owner_id: "u1" },
      ),
    ).toBe("denied");
  });

  it("denies in_record declared with no field names", () => {
    expect(
      evaluateHandBuilt(
        { key: "k", attribute: "user_id", operator: "in_record", values: [] },
        { owner_id: "u1" },
      ),
    ).toBe("denied");
  });

  it("denies eq_record declared with two field names rather than taking the first", () => {
    expect(
      evaluateHandBuilt(
        { key: "k", attribute: "user_id", operator: "eq_record", values: ["owner_id", "other"] },
        { owner_id: "u1", other: "u1" },
      ),
    ).toBe("denied");
  });

  it("still defers a hand-built record policy when no record is supplied", () => {
    const policy: AbacPolicy = {
      key: "k",
      attribute: "user_id",
      operator: "eq_record",
      values: ["owner_id"],
    };
    expect(
      buildAbacEvaluator(new Map([["k", policy]]))(
        inputWithRecord("k", { user_id: "u1" }, undefined),
      ),
    ).toBe("deferred");
  });
});

describe("buildAbacEvaluator — a record supplied to a literal policy", () => {
  it("is ignored: a literal operator never reads the record", () => {
    expect(
      evaluateWithRecord(
        "k=department:eq:clinical",
        { department: "clinical" },
        { department: "nursing" },
      ),
    ).toBe("satisfied");
  });

  it("cannot make a literal policy satisfy from the record alone", () => {
    expect(
      evaluateWithRecord("k=department:eq:clinical", {}, { department: "clinical" }),
    ).toBe("denied");
  });

  it("never reads the record for a literal policy, pinned by a throwing getter", () => {
    const record = {};
    Object.defineProperty(record, "department", {
      enumerable: true,
      get(): never {
        throw new Error("a literal policy must not read the record");
      },
    });
    expect(() =>
      evaluateWithRecord("k=department:eq:clinical", { department: "clinical" }, record),
    ).not.toThrow();
  });
});

describe("formatAbacPolicies — the record operators", () => {
  it("renders eq_record with the operand behind a record. prefix", () => {
    expect(
      formatAbacPolicies(parseAbacPolicies(["same_dept=department:eq_record:department"])),
    ).toContain("same_dept: department eq record.department");
  });

  it("renders ne_record", () => {
    expect(
      formatAbacPolicies(parseAbacPolicies(["not_mine=user_id:ne_record:owner_id"])),
    ).toContain("not_mine: user_id ne record.owner_id");
  });

  it("renders a multi-field in_record as a parenthesised list, so the sides stay legible", () => {
    expect(
      formatAbacPolicies(parseAbacPolicies(["teams=team:in_record:primary,secondary"])),
    ).toContain("teams: team in record.(primary,secondary)");
  });

  it("renders a single-field in_record without the parentheses", () => {
    expect(formatAbacPolicies(parseAbacPolicies(["teams=team:in_record:primary"]))).toContain(
      "teams: team in record.primary",
    );
  });

  it("distinguishes a literal in from a record in, so one line cannot be read as the other", () => {
    const line = formatAbacPolicies(
      parseAbacPolicies(["lit=team:in:primary,secondary", "rec=team:in_record:primary,secondary"]),
    );
    expect(line).toContain("lit: team in primary,secondary");
    expect(line).toContain("rec: team in record.(primary,secondary)");
  });

  it("renders a mixed declaration exactly, which is also the no-leak assertion", () => {
    const line = formatAbacPolicies(
      parseAbacPolicies([
        "clinical_only=department:eq:clinical",
        "owns=user_id:eq_record:owner_id",
        "teams=team:in_record:primary,secondary",
        "vetted=clearance:present",
      ]),
    );
    expect(line).toBe(
      "abac policies: 4 declared: clinical_only: department eq clinical, " +
        "owns: user_id eq record.owner_id, teams: team in record.(primary,secondary), " +
        "vetted: clearance present",
    );
  });

  /**
   * The module's absolute rule: only the declaration is rendered. The probe values below are
   * *values* and appear in no declaration, so a line containing one could only have come from a
   * principal's attributes or from the record — which is tenant data, and PHI in the packs that
   * classify it.
   */
  it("contains no attribute value and no record value", () => {
    const policies = parseAbacPolicies([
      "owns=user_id:eq_record:owner_id",
      "same_dept=department:eq_record:department",
    ]);
    const evaluator = buildAbacEvaluator(policies);
    expect(
      evaluator(
        inputWithRecord(
          "owns",
          { user_id: "SECRET-PRINCIPAL", department: "SECRET-ATTRIBUTE" },
          { owner_id: "SECRET-RECORD", department: "SECRET-RECORD-DEPT", mrn: "MRN-SECRET" },
        ),
      ),
    ).toBe("denied");

    const line = formatAbacPolicies(policies);
    for (const leak of [
      "SECRET-PRINCIPAL",
      "SECRET-ATTRIBUTE",
      "SECRET-RECORD",
      "SECRET-RECORD-DEPT",
      "MRN-SECRET",
    ]) {
      expect(line).not.toContain(leak);
    }
    expect(line).toContain("owns: user_id eq record.owner_id");
  });

  it("still says none are declared affirmatively", () => {
    expect(formatAbacPolicies(new Map())).toBe(
      "abac policies: none declared, so no obligation can be discharged",
    );
  });
});
