import type { AbacEvaluationInput, Principal } from "@crossengin/auth";
import type { TenantId, UserId } from "@crossengin/types";
import { describe, expect, it } from "vitest";

import {
  ABAC_OPERATORS,
  ABAC_POLICY_FLAG,
  ABAC_POLICY_REFUSALS,
  AbacPolicyRefused,
  buildAbacEvaluator,
  formatAbacPolicies,
  parseAbacPolicies,
  parseAbacPolicySpec,
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

describe("ABAC_OPERATORS", () => {
  it("names the four operators", () => {
    expect(ABAC_OPERATORS).toEqual(["eq", "ne", "in", "present"]);
  });

  it("offers no operator over a record, which this seam cannot carry", () => {
    expect(ABAC_OPERATORS.some((op) => /record|owns|same/.test(op))).toBe(false);
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
