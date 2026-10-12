import type { RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  CONSERVATIVE_RATE_LIMIT_POLICY,
  RATE_LIMIT_POLICY_ID_PATTERN,
  RateLimitPolicyDeclarationError,
  declareRateLimitPolicies,
  parseRateLimitPolicySpec,
  resolvePolicyForRoute,
  surveyRoutePolicies,
} from "./rate-limit-policy.js";

function route(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    ...overrides,
  };
}

const DEFAULT = { policyId: "rlp_defaultpolicy", limit: 10, windowSeconds: 60 };

describe("CONSERVATIVE_RATE_LIMIT_POLICY", () => {
  it("is a well-formed policy the declaration accepts", () => {
    expect(RATE_LIMIT_POLICY_ID_PATTERN.test(CONSERVATIVE_RATE_LIMIT_POLICY.policyId)).toBe(true);
    expect(() =>
      declareRateLimitPolicies({ defaultPolicy: CONSERVATIVE_RATE_LIMIT_POLICY }),
    ).not.toThrow();
  });

  it("carries a real rlp_ id rather than a sentinel, so an audit row names where the limit came from", () => {
    expect(CONSERVATIVE_RATE_LIMIT_POLICY.policyId).toMatch(/^rlp_/);
    expect(CONSERVATIVE_RATE_LIMIT_POLICY.limit).toBeGreaterThan(0);
  });

  it("is frozen, so a deployment cannot mutate the shared starting point", () => {
    expect(Object.isFrozen(CONSERVATIVE_RATE_LIMIT_POLICY)).toBe(true);
  });
});

describe("declareRateLimitPolicies — accepts", () => {
  it("accepts a default alone and puts it in the map", () => {
    const decl = declareRateLimitPolicies({ defaultPolicy: DEFAULT });
    expect(decl.defaultPolicy.policyId).toBe("rlp_defaultpolicy");
    expect(Object.keys(decl.byPolicyId)).toEqual(["rlp_defaultpolicy"]);
  });

  it("accepts additional policies beside the default", () => {
    const decl = declareRateLimitPolicies({
      defaultPolicy: DEFAULT,
      policies: [{ policyId: "rlp_strictwrites", limit: 2, windowSeconds: 1 }],
    });
    expect(Object.keys(decl.byPolicyId).sort()).toEqual(["rlp_defaultpolicy", "rlp_strictwrites"]);
  });

  it("accepts the default restated identically in policies", () => {
    const decl = declareRateLimitPolicies({ defaultPolicy: DEFAULT, policies: [{ ...DEFAULT }] });
    expect(decl.defaultPolicy.limit).toBe(10);
  });

  it("freezes the declaration and its entries", () => {
    const decl = declareRateLimitPolicies({ defaultPolicy: DEFAULT });
    expect(Object.isFrozen(decl)).toBe(true);
    expect(Object.isFrozen(decl.byPolicyId)).toBe(true);
    expect(Object.isFrozen(decl.byPolicyId["rlp_defaultpolicy"])).toBe(true);
  });

  it("accepts a one-second window and a limit of 1", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_minimumvalues", limit: 1, windowSeconds: 1 },
      }),
    ).not.toThrow();
  });

  it("accepts a 24-hour window", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_dailyceiling", limit: 100, windowSeconds: 86_400 },
      }),
    ).not.toThrow();
  });
});

describe("declareRateLimitPolicies — refuses", () => {
  it("refuses a malformed policy id by name", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "default", limit: 1, windowSeconds: 1 },
      }),
    ).toThrow(RateLimitPolicyDeclarationError);
    try {
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "default", limit: 1, windowSeconds: 1 },
      });
    } catch (err) {
      expect((err as RateLimitPolicyDeclarationError).defect).toBe("policy_id_malformed");
    }
  });

  it("refuses an uppercase policy id, matching the catalog CHECK", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_DefaultPolicy", limit: 1, windowSeconds: 1 },
      }),
    ).toThrow(/policy_id_malformed/);
  });

  it("refuses a limit of zero", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_zerolimitxx", limit: 0, windowSeconds: 60 },
      }),
    ).toThrow(/limit_out_of_range/);
  });

  it("refuses a fractional limit", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_fractional1", limit: 1.5, windowSeconds: 60 },
      }),
    ).toThrow(/limit_out_of_range/);
  });

  it("refuses a window of zero and a window past a day", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_zerowindowx", limit: 1, windowSeconds: 0 },
      }),
    ).toThrow(/window_out_of_range/);
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_hugewindowx", limit: 1, windowSeconds: 86_401 },
      }),
    ).toThrow(/window_out_of_range/);
  });

  it("refuses a duplicate policy id", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: DEFAULT,
        policies: [
          { policyId: "rlp_strictwrites", limit: 2, windowSeconds: 1 },
          { policyId: "rlp_strictwrites", limit: 3, windowSeconds: 1 },
        ],
      }),
    ).toThrow(/duplicate_policy_id/);
  });

  it("refuses the default restated with different terms", () => {
    expect(() =>
      declareRateLimitPolicies({
        defaultPolicy: DEFAULT,
        policies: [{ ...DEFAULT, limit: 99 }],
      }),
    ).toThrow(/map_key_disagrees_with_policy_id/);
  });
});

describe("resolvePolicyForRoute", () => {
  const decl = declareRateLimitPolicies({
    defaultPolicy: DEFAULT,
    policies: [{ policyId: "rlp_strictwrites", limit: 2, windowSeconds: 1 }],
  });

  it("applies the default to a route naming no policy", () => {
    const r = resolvePolicyForRoute(decl, route());
    expect(r.kind).toBe("default");
    expect(r.kind !== "undeclared" && r.policy.policyId).toBe("rlp_defaultpolicy");
  });

  it("applies the default when there is no route at all", () => {
    const r = resolvePolicyForRoute(decl, null);
    expect(r.kind).toBe("default");
  });

  it("applies the policy a route names", () => {
    const r = resolvePolicyForRoute(decl, route({ rateLimitPolicyId: "rlp_strictwrites" }));
    expect(r.kind).toBe("declared");
    expect(r.kind !== "undeclared" && r.policy.limit).toBe(2);
  });

  it("answers undeclared — never the default — for a policy the deployment did not declare", () => {
    // The fallback is the defect: it would apply the default's limit while writing a policy id the
    // route did not name, so the audit row would describe terms that were not applied.
    const r = resolvePolicyForRoute(decl, route({ rateLimitPolicyId: "rlp_neverdeclared" }));
    expect(r.kind).toBe("undeclared");
    expect(r.kind === "undeclared" && r.policyId).toBe("rlp_neverdeclared");
  });
});

describe("surveyRoutePolicies", () => {
  const decl = declareRateLimitPolicies({
    defaultPolicy: DEFAULT,
    policies: [
      { policyId: "rlp_strictwrites", limit: 2, windowSeconds: 1 },
      { policyId: "rlp_neverusedxx", limit: 5, windowSeconds: 10 },
    ],
  });

  it("classifies every route", () => {
    const survey = surveyRoutePolicies(decl, [
      route({ operationId: "a.create" }),
      route({ operationId: "b.create", rateLimitPolicyId: "rlp_strictwrites" }),
      route({ operationId: "c.create", rateLimitPolicyId: "rlp_missingpol1" }),
    ]);
    expect(survey.findings.map((f) => f.verdict)).toEqual([
      "default_applies",
      "declared",
      "undeclared",
    ]);
  });

  it("separates the undeclared ones, which are the only requests that would be refused", () => {
    const survey = surveyRoutePolicies(decl, [
      route({ operationId: "c.create", rateLimitPolicyId: "rlp_missingpol1" }),
    ]);
    expect(survey.undeclared).toHaveLength(1);
    expect(survey.undeclared[0]?.policyId).toBe("rlp_missingpol1");
  });

  it("reports a declared policy no route uses, without calling it a defect", () => {
    const survey = surveyRoutePolicies(decl, [route()]);
    expect(survey.unusedPolicyIds).toEqual(["rlp_neverusedxx", "rlp_strictwrites"]);
    expect(survey.undeclared).toHaveLength(0);
  });

  it("answers for an empty route list without claiming anything", () => {
    const survey = surveyRoutePolicies(decl, []);
    expect(survey.findings).toHaveLength(0);
    expect(survey.unusedPolicyIds).toHaveLength(3);
  });

  it("lists the declared ids sorted, so a boot log is stable across runs", () => {
    const survey = surveyRoutePolicies(decl, []);
    expect(survey.declaredPolicyIds).toEqual([
      "rlp_defaultpolicy",
      "rlp_neverusedxx",
      "rlp_strictwrites",
    ]);
  });
});

describe("parseRateLimitPolicySpec", () => {
  it("parses the three-field argv form", () => {
    expect(parseRateLimitPolicySpec("rlp_strictwrites:2:1")).toEqual({
      policyId: "rlp_strictwrites",
      limit: 2,
      windowSeconds: 1,
    });
  });

  it("refuses the wrong field count", () => {
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites:2")).toThrow(/expected/);
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites:2:1:extra")).toThrow(/expected/);
  });

  it("refuses a hex, exponent or padded limit rather than coercing it", () => {
    // `Number("0x10")` is 16 and `Number("1e3")` is 1000 — a ceiling the operator did not configure.
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites:0x10:1")).toThrow(/limit_out_of_range/);
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites:1e3:1")).toThrow(/limit_out_of_range/);
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites: 2 :1")).toThrow(/limit_out_of_range/);
  });

  it("refuses a negative window", () => {
    expect(() => parseRateLimitPolicySpec("rlp_strictwrites:2:-1")).toThrow(/window_out_of_range/);
  });

  it("refuses a malformed id through the same assertion the object form uses", () => {
    expect(() => parseRateLimitPolicySpec("strict:2:1")).toThrow(/policy_id_malformed/);
  });

  it("returns a frozen policy", () => {
    expect(Object.isFrozen(parseRateLimitPolicySpec("rlp_strictwrites:2:1"))).toBe(true);
  });
});
