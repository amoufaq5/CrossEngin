import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import {
  ABAC_DENIAL_EFFECT,
  ABAC_DENIAL_EFFECTS,
  ABAC_DENIAL_EFFECT_DESCRIPTIONS,
  ABAC_GRANT_POSITIONS,
  ABAC_OUTCOME_ALLOWS,
  ABAC_RECORD_AVAILABILITIES,
  ABAC_RECORD_AVAILABILITY,
  ABAC_RECORD_AVAILABILITY_REASONS,
  UNDISCHARGEABLE_ABAC_EVALUATOR,
  abacAttributesResolved,
  abacGrantPosition,
  abacRecordAvailabilityFor,
  describeOperation,
  dischargeAbac,
  dischargeAbacBatch,
  formatAbacObligation,
  isAbacDeferred,
  surveyAbacObligations,
  type AbacBatchAnswer,
  type AbacBatchEvaluator,
  type AbacBatchRequest,
  type AbacEvaluationInput,
  type AbacEvaluator,
  type AbacDenialEffect,
  type AbacGrantPosition,
  type AbacObligation,
} from "./abac.js";
import {
  ABAC_OUTCOMES,
  MAX_ABAC_POLICY_KEY_LENGTH,
  OPERATION_NAMES,
  RbacGrantSchema,
  type AbacOutcome,
  type OperationName,
  type PermissionMap,
  type Principal,
} from "./types.js";

const PRINCIPAL: Principal = {
  kind: "user",
  tenantId: "t" as TenantId,
  userId: "u" as UserId,
  primaryRole: "pharmacist",
  secondaryRoles: [],
  abacAttributes: { department: "oncology" },
  mfaProofAgeSeconds: null,
};

const CONTEXT: Omit<AbacEvaluationInput, "policyKey"> = {
  principal: PRINCIPAL,
  entity: "prescription",
  operation: "update",
};

/** The same principal with no directory consulted, which is not the same as holding no attributes. */
const UNRESOLVED_PRINCIPAL: Principal = { ...PRINCIPAL, abacAttributes: null };

const UNRESOLVED_CONTEXT: Omit<AbacEvaluationInput, "policyKey"> = {
  ...CONTEXT,
  principal: UNRESOLVED_PRINCIPAL,
};

/** Records every call so a test can assert the evaluator was never reached, not merely ignored. */
function spyEvaluator(answer: AbacOutcome): {
  readonly evaluator: AbacEvaluator;
  readonly calls: AbacEvaluationInput[];
} {
  const calls: AbacEvaluationInput[] = [];
  return {
    evaluator: (input) => {
      calls.push(input);
      return answer;
    },
    calls,
  };
}

describe("ABAC_OUTCOMES", () => {
  it("names exactly four outcomes", () => {
    expect(ABAC_OUTCOMES).toEqual(["satisfied", "denied", "undischargeable", "deferred"]);
  });

  it("separates a refusal about the principal from an inability to answer", () => {
    // `denied` is a claim about this principal's attributes; `undischargeable` says nothing could
    // answer at all. Collapsing them would send an operator to the wrong remedy.
    expect(ABAC_OUTCOMES).toContain("denied");
    expect(ABAC_OUTCOMES).toContain("undischargeable");
  });

  it("separates 'needs the record' from both of those", () => {
    // `deferred` is a statement about the *call site*, not about the principal and not about the
    // policy layer's reachability: the remedy is to load the record and ask again.
    expect(ABAC_OUTCOMES).toContain("deferred");
  });
});

describe("ABAC_OUTCOME_ALLOWS", () => {
  it("admits only 'satisfied'", () => {
    expect(ABAC_OUTCOME_ALLOWS).toEqual({
      satisfied: true,
      denied: false,
      undischargeable: false,
      deferred: false,
    });
  });

  it("refuses 'deferred', so a caller that never re-asks denies", () => {
    // The whole load-bearing value. A `deferred` read as a skip would grant an obligation nothing
    // evaluated — ADR-0340's defect reintroduced one level up.
    expect(ABAC_OUTCOME_ALLOWS.deferred).toBe(false);
  });

  it("has exactly one key per outcome", () => {
    expect(Object.keys(ABAC_OUTCOME_ALLOWS)).toHaveLength(ABAC_OUTCOMES.length);
  });

  it("is total over ABAC_OUTCOMES", () => {
    for (const outcome of ABAC_OUTCOMES) {
      expect(typeof ABAC_OUTCOME_ALLOWS[outcome]).toBe("boolean");
    }
    expect(Object.keys(ABAC_OUTCOME_ALLOWS).sort()).toEqual([...ABAC_OUTCOMES].sort());
  });

  it("refuses every outcome but one, so an unmapped answer could only ever deny", () => {
    const allowing = ABAC_OUTCOMES.filter((o) => ABAC_OUTCOME_ALLOWS[o]);
    expect(allowing).toEqual(["satisfied"]);
  });
});

describe("MAX_ABAC_POLICY_KEY_LENGTH", () => {
  it("matches workflow-engine's ABAC_CHECK_GUARD.policyKey bound", () => {
    expect(MAX_ABAC_POLICY_KEY_LENGTH).toBe(200);
  });
});

describe("describeOperation", () => {
  it("renders a plain operation as its own name", () => {
    expect(describeOperation("update")).toBe("update");
    expect(describeOperation("list")).toBe("list");
  });

  it("renders a transition with its name", () => {
    expect(describeOperation({ kind: "transition", name: "verify" })).toBe("transition:verify");
  });

  it("covers every operation name", () => {
    for (const op of OPERATION_NAMES) {
      expect(describeOperation(op)).toBe(op);
    }
  });
});

describe("dischargeAbac — no obligation", () => {
  it("returns null when the grant carries no policy key", () => {
    expect(dischargeAbac(undefined, CONTEXT, () => "satisfied")).toBeNull();
  });

  it("returns null rather than a satisfied discharge", () => {
    // "there was nothing to check" and "a policy answered yes" are different facts; reporting the
    // second would claim an evaluation that never happened.
    const d = dischargeAbac(undefined, CONTEXT, undefined);
    expect(d).toBeNull();
  });

  it("does not call the evaluator when there is no policy key", () => {
    const calls: AbacEvaluationInput[] = [];
    dischargeAbac(
      undefined,
      CONTEXT,
      (input) => {
        calls.push(input);
        return "satisfied";
      },
    );
    expect(calls).toEqual([]);
  });
});

describe("dischargeAbac — no evaluator", () => {
  it("answers undischargeable, not denied", () => {
    expect(dischargeAbac("p.key", CONTEXT, undefined)).toEqual({
      policyKey: "p.key",
      outcome: "undischargeable",
    });
  });

  it("does not allow", () => {
    const d = dischargeAbac("p.key", CONTEXT, undefined);
    expect(d).not.toBeNull();
    expect(ABAC_OUTCOME_ALLOWS[(d as { outcome: AbacOutcome }).outcome]).toBe(false);
  });

  it("echoes the policy key so the refusal names what must be arranged", () => {
    expect(dischargeAbac("data.access.allow_update", CONTEXT, undefined)?.policyKey).toBe(
      "data.access.allow_update",
    );
  });
});

describe("dischargeAbac — unresolved attributes", () => {
  it("answers undischargeable for an obligation when no directory was consulted", () => {
    expect(dischargeAbac("p.key", UNRESOLVED_CONTEXT, undefined)).toEqual({
      policyKey: "p.key",
      outcome: "undischargeable",
    });
  });

  it("never calls the evaluator, even when one is supplied", () => {
    // The point of the rule: an evaluator handed `{}` cannot tell "no attributes" from "nobody
    // looked", so it must not be asked at all rather than asked with a fabricated input.
    const spy = spyEvaluator("satisfied");
    const d = dischargeAbac("p.key", UNRESOLVED_CONTEXT, spy.evaluator);
    expect(spy.calls).toEqual([]);
    expect(d).toEqual({ policyKey: "p.key", outcome: "undischargeable" });
  });

  it("refuses even an evaluator that would have denied, so the outcome names the real reason", () => {
    const spy = spyEvaluator("denied");
    expect(dischargeAbac("p.key", UNRESOLVED_CONTEXT, spy.evaluator)?.outcome).toBe(
      "undischargeable",
    );
    expect(spy.calls).toEqual([]);
  });

  it("does not allow", () => {
    const d = dischargeAbac("p.key", UNRESOLVED_CONTEXT, () => "satisfied");
    expect(d).not.toBeNull();
    expect(ABAC_OUTCOME_ALLOWS[(d as { outcome: AbacOutcome }).outcome]).toBe(false);
  });

  it("echoes the policy key, so the refusal still names what could not be answered", () => {
    expect(dischargeAbac("rx.update", UNRESOLVED_CONTEXT, () => "satisfied")?.policyKey).toBe(
      "rx.update",
    );
  });

  it("is ordered after the no-obligation check: no obligation still returns null", () => {
    // Nothing was going to be checked, so the missing input does not matter — and reporting an
    // `undischargeable` here would invent an obligation the grant never carried.
    const spy = spyEvaluator("satisfied");
    expect(dischargeAbac(undefined, UNRESOLVED_CONTEXT, spy.evaluator)).toBeNull();
    expect(spy.calls).toEqual([]);
  });

  it("is indistinguishable in outcome from having no evaluator, and that is deliberate", () => {
    // Both say nothing could answer. The remedies differ (wire a directory / wire an evaluator) and
    // neither is a claim about this principal's attributes.
    expect(dischargeAbac("p.key", UNRESOLVED_CONTEXT, () => "satisfied")).toEqual(
      dischargeAbac("p.key", CONTEXT, undefined),
    );
  });
});

describe("dischargeAbac — resolved-but-empty attributes", () => {
  it("is a usable input: a satisfied evaluator still satisfies", () => {
    // `{}` asserts this principal holds no attributes, which is a fact a policy can answer from.
    // Only `null` refuses, so the new rule cannot swallow the empty case.
    const empty: Principal = { ...PRINCIPAL, abacAttributes: {} };
    const spy = spyEvaluator("satisfied");
    const d = dischargeAbac("p.key", { ...CONTEXT, principal: empty }, spy.evaluator);
    expect(d).toEqual({ policyKey: "p.key", outcome: "satisfied" });
    expect(spy.calls).toHaveLength(1);
  });

  it("reaches the evaluator with the empty record intact", () => {
    const empty: Principal = { ...PRINCIPAL, abacAttributes: {} };
    const spy = spyEvaluator("denied");
    dischargeAbac("p.key", { ...CONTEXT, principal: empty }, spy.evaluator);
    expect(spy.calls[0]?.principal.abacAttributes).toEqual({});
  });
});

describe("abacAttributesResolved", () => {
  it("is false when no directory was consulted", () => {
    expect(abacAttributesResolved(UNRESOLVED_PRINCIPAL)).toBe(false);
  });

  it("is true for an empty record, which asserts there are none", () => {
    expect(abacAttributesResolved({ ...PRINCIPAL, abacAttributes: {} })).toBe(true);
  });

  it("is true for a populated record", () => {
    expect(abacAttributesResolved(PRINCIPAL)).toBe(true);
    expect(
      abacAttributesResolved({ ...PRINCIPAL, abacAttributes: { clearance: 3, ward: "icu" } }),
    ).toBe(true);
  });

  it("agrees with the rule dischargeAbac applies", () => {
    for (const p of [UNRESOLVED_PRINCIPAL, PRINCIPAL, { ...PRINCIPAL, abacAttributes: {} }]) {
      const d = dischargeAbac("p.key", { ...CONTEXT, principal: p }, () => "satisfied");
      expect(d?.outcome === "satisfied").toBe(abacAttributesResolved(p));
    }
  });
});

describe("dischargeAbac — evaluator answers", () => {
  it("passes satisfied through", () => {
    expect(dischargeAbac("p.key", CONTEXT, () => "satisfied")).toEqual({
      policyKey: "p.key",
      outcome: "satisfied",
    });
  });

  it("passes denied through", () => {
    expect(dischargeAbac("p.key", CONTEXT, () => "denied")).toEqual({
      policyKey: "p.key",
      outcome: "denied",
    });
  });

  it("passes undischargeable through", () => {
    expect(dischargeAbac("p.key", CONTEXT, () => "undischargeable")).toEqual({
      policyKey: "p.key",
      outcome: "undischargeable",
    });
  });

  it("hands the evaluator the policy key and the whole context", () => {
    const calls: AbacEvaluationInput[] = [];
    dischargeAbac(
      "p.key",
      { ...CONTEXT, field: "mrn" },
      (input) => {
        calls.push(input);
        return "satisfied";
      },
    );
    expect(calls).toEqual([
      {
        policyKey: "p.key",
        principal: PRINCIPAL,
        entity: "prescription",
        operation: "update",
        field: "mrn",
      },
    ]);
  });

  it("calls the evaluator exactly once", () => {
    let n = 0;
    dischargeAbac("p.key", CONTEXT, () => {
      n += 1;
      return "satisfied";
    });
    expect(n).toBe(1);
  });
});

describe("dischargeAbac — a throwing evaluator", () => {
  const throwing: AbacEvaluator = () => {
    throw new Error("policy service unreachable");
  };

  it("does not propagate the exception", () => {
    expect(() => dischargeAbac("p.key", CONTEXT, throwing)).not.toThrow();
  });

  it("answers undischargeable", () => {
    // An exception inside an authorization check must never become an allow, and must not escape as
    // a 500 that a client retries into the same refusal.
    expect(dischargeAbac("p.key", CONTEXT, throwing)).toEqual({
      policyKey: "p.key",
      outcome: "undischargeable",
    });
  });

  it("swallows a thrown non-Error too", () => {
    const d = dischargeAbac("p.key", CONTEXT, () => {
      throw "a string";
    });
    expect(d?.outcome).toBe("undischargeable");
  });
});

describe("dischargeAbac — an evaluator returning a value outside the enum", () => {
  function bogus(value: unknown): AbacEvaluator {
    return (() => value) as AbacEvaluator;
  }

  it("refuses an unrecognised string", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus("allow"))?.outcome).toBe("undischargeable");
  });

  it("refuses true, which a JS caller might mean as an allow", () => {
    // Reachable across a package boundary where the caller is JS, and the unsafe reading of a
    // truthy answer is exactly the allow this module exists to refuse.
    expect(dischargeAbac("p.key", CONTEXT, bogus(true))?.outcome).toBe("undischargeable");
  });

  it("refuses undefined", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus(undefined))?.outcome).toBe("undischargeable");
  });

  it("refuses null", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus(null))?.outcome).toBe("undischargeable");
  });

  it("refuses an object", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus({ outcome: "satisfied" }))?.outcome).toBe(
      "undischargeable",
    );
  });
});

describe("UNDISCHARGEABLE_ABAC_EVALUATOR", () => {
  it("answers undischargeable for any input", () => {
    expect(UNDISCHARGEABLE_ABAC_EVALUATOR({ ...CONTEXT, policyKey: "a" })).toBe("undischargeable");
    expect(
      UNDISCHARGEABLE_ABAC_EVALUATOR({ ...CONTEXT, policyKey: "b", field: "mrn" }),
    ).toBe("undischargeable");
  });

  it("is interchangeable with supplying no evaluator at all", () => {
    expect(dischargeAbac("p.key", CONTEXT, UNDISCHARGEABLE_ABAC_EVALUATOR)).toEqual(
      dischargeAbac("p.key", CONTEXT, undefined),
    );
  });
});

const SURVEY_PERMS: PermissionMap = {
  prescription: {
    read: { roles: ["pharmacist"] },
    update: { roles: ["pharmacist"], abac: "rx.update" },
    transitions: {
      verify: { roles: ["pharmacist"], abac: "rx.verify" },
      cancel: { roles: ["manager"] },
    },
    fields: {
      mrn: {
        read: { roles: ["clinician"], abac: "field.mrn.read" },
        update: { roles: ["clinician"], abac: "field.mrn.update" },
      },
      notes: { read: { roles: ["clinician"] } },
    },
  },
  patient: {
    list: { roles: ["clinician"], abac: "patient.list" },
  },
};

describe("surveyAbacObligations", () => {
  it("finds an obligation on a plain operation", () => {
    const found = surveyAbacObligations(SURVEY_PERMS).filter(
      (o) => o.entity === "prescription" && o.operation === "update" && o.field === null,
    );
    expect(found).toEqual([
      { entity: "prescription", operation: "update", field: null, policyKey: "rx.update" },
    ]);
  });

  it("finds an obligation on a transition", () => {
    const found = surveyAbacObligations(SURVEY_PERMS).filter(
      (o) => typeof o.operation === "object",
    );
    expect(found).toEqual([
      {
        entity: "prescription",
        operation: { kind: "transition", name: "verify" },
        field: null,
        policyKey: "rx.verify",
      },
    ]);
  });

  it("finds an obligation on a field read grant", () => {
    const found = surveyAbacObligations(SURVEY_PERMS).filter(
      (o) => o.field === "mrn" && o.operation === "read",
    );
    expect(found).toEqual([
      { entity: "prescription", operation: "read", field: "mrn", policyKey: "field.mrn.read" },
    ]);
  });

  it("finds an obligation on a field update grant", () => {
    const found = surveyAbacObligations(SURVEY_PERMS).filter(
      (o) => o.field === "mrn" && o.operation === "update",
    );
    expect(found).toEqual([
      { entity: "prescription", operation: "update", field: "mrn", policyKey: "field.mrn.update" },
    ]);
  });

  it("finds every obligation and no others", () => {
    expect(surveyAbacObligations(SURVEY_PERMS).map((o) => o.policyKey)).toEqual([
      "patient.list",
      "rx.update",
      "rx.verify",
      "field.mrn.read",
      "field.mrn.update",
    ]);
  });

  it("orders entities ascending", () => {
    const entities = surveyAbacObligations(SURVEY_PERMS).map((o) => o.entity);
    expect(entities).toEqual([...entities].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("orders plain operations in OPERATION_NAMES order, not alphabetically", () => {
    const perms: PermissionMap = {
      e: {
        delete: { roles: ["a"], abac: "k.delete" },
        list: { roles: ["a"], abac: "k.list" },
        create: { roles: ["a"], abac: "k.create" },
        read: { roles: ["a"], abac: "k.read" },
        update: { roles: ["a"], abac: "k.update" },
      },
    };
    expect(surveyAbacObligations(perms).map((o) => o.operation)).toEqual([...OPERATION_NAMES]);
  });

  it("puts a field's read before its update", () => {
    const perms: PermissionMap = {
      e: {
        fields: {
          f: {
            update: { roles: ["a"], abac: "u" },
            read: { roles: ["a"], abac: "r" },
          },
        },
      },
    };
    expect(surveyAbacObligations(perms).map((o) => o.policyKey)).toEqual(["r", "u"]);
  });

  it("is deterministic across two calls on the same input", () => {
    expect(surveyAbacObligations(SURVEY_PERMS)).toEqual(surveyAbacObligations(SURVEY_PERMS));
  });

  it("is insensitive to key insertion order", () => {
    const shuffled: PermissionMap = {
      patient: SURVEY_PERMS.patient as PermissionMap[string],
      prescription: {
        transitions: {
          cancel: { roles: ["manager"] },
          verify: { roles: ["pharmacist"], abac: "rx.verify" },
        },
        fields: {
          notes: { read: { roles: ["clinician"] } },
          mrn: {
            update: { roles: ["clinician"], abac: "field.mrn.update" },
            read: { roles: ["clinician"], abac: "field.mrn.read" },
          },
        },
        update: { roles: ["pharmacist"], abac: "rx.update" },
        read: { roles: ["pharmacist"] },
      },
    };
    expect(surveyAbacObligations(shuffled)).toEqual(surveyAbacObligations(SURVEY_PERMS));
  });

  it("returns [] for a permission map with no abac anywhere", () => {
    const perms: PermissionMap = {
      a: {
        read: { roles: ["x"] },
        transitions: { go: { roles: ["x"] } },
        fields: { f: { read: { roles: ["x"] }, update: { roles: ["x"] } } },
      },
    };
    expect(surveyAbacObligations(perms)).toEqual([]);
  });

  it("returns [] for an empty permission map", () => {
    expect(surveyAbacObligations({})).toEqual([]);
  });

  it("returns [] for an entity with an empty permissions block", () => {
    expect(surveyAbacObligations({ e: {} })).toEqual([]);
  });
});

describe("formatAbacObligation", () => {
  it("renders a field obligation with the field after an arrow", () => {
    const o: AbacObligation = {
      entity: "Patient",
      operation: "update",
      field: "mrn",
      policyKey: "x",
    };
    expect(formatAbacObligation(o)).toBe("Patient.update -> mrn requires abac policy 'x'");
  });

  it("renders a non-field obligation without an arrow", () => {
    const o: AbacObligation = {
      entity: "Patient",
      operation: "update",
      field: null,
      policyKey: "x",
    };
    expect(formatAbacObligation(o)).toBe("Patient.update requires abac policy 'x'");
  });

  it("renders a transition obligation through describeOperation", () => {
    const o: AbacObligation = {
      entity: "Patient",
      operation: { kind: "transition", name: "admit" },
      field: null,
      policyKey: "x",
    };
    expect(formatAbacObligation(o)).toBe("Patient.transition:admit requires abac policy 'x'");
  });

  it("renders every surveyed obligation without throwing", () => {
    for (const o of surveyAbacObligations(SURVEY_PERMS)) {
      expect(formatAbacObligation(o)).toContain(o.policyKey);
    }
  });
});

describe("OPERATION_NAMES", () => {
  it("lists the five entity operations", () => {
    expect(OPERATION_NAMES).toEqual(["list", "read", "create", "update", "delete"]);
  });

  it("matches the OperationName union exhaustively", () => {
    // A `Record<OperationName, true>` built from the list: a member added to the union and not the
    // list fails to typecheck here, and a member in the list and not the union fails too.
    const exhaustive: Record<OperationName, true> = {
      list: true,
      read: true,
      create: true,
      update: true,
      delete: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...OPERATION_NAMES].sort());
    for (const op of OPERATION_NAMES) {
      expect(exhaustive[op]).toBe(true);
    }
  });
});

describe("RbacGrantSchema — the policy key bound", () => {
  it("accepts a 200-character key", () => {
    const key = "k".repeat(MAX_ABAC_POLICY_KEY_LENGTH);
    expect(() => RbacGrantSchema.parse({ roles: ["a"], abac: key })).not.toThrow();
  });

  it("rejects a 201-character key", () => {
    const key = "k".repeat(MAX_ABAC_POLICY_KEY_LENGTH + 1);
    expect(() => RbacGrantSchema.parse({ roles: ["a"], abac: key })).toThrow();
  });

  it("rejects an empty key", () => {
    // An empty key is an obligation naming nothing, and `"" !== undefined` made it a live
    // obligation that no evaluator could ever discharge.
    expect(() => RbacGrantSchema.parse({ roles: ["a"], abac: "" })).toThrow();
  });

  it("still accepts a grant with no key at all", () => {
    expect(() => RbacGrantSchema.parse({ roles: ["a"] })).not.toThrow();
  });

  it("treats a key as opaque, not as an expression", () => {
    // Converging with workflow-engine's `ABAC_CHECK_GUARD.policyKey`: nothing here parses it, so a
    // path and an expression are equally valid *strings* and equally unparsed.
    expect(() =>
      RbacGrantSchema.parse({ roles: ["a"], abac: "user.department == record.department" }),
    ).not.toThrow();
    expect(() =>
      RbacGrantSchema.parse({ roles: ["a"], abac: "data.access.allow_update" }),
    ).not.toThrow();
  });
});

const RECORD: Readonly<Record<string, unknown>> = { id: "rx-1", department: "oncology" };

describe("dischargeAbac — the record", () => {
  it("passes a supplied record through to the evaluator verbatim", () => {
    const spy = spyEvaluator("satisfied");
    dischargeAbac("p.key", { ...CONTEXT, record: RECORD }, spy.evaluator);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.record).toEqual(RECORD);
  });

  it("does not copy or reshape it — the evaluator sees the same object", () => {
    // A policy over `record.department` is answered against whatever the handler loaded; this module
    // is a courier and must not normalise a value a policy will compare.
    const spy = spyEvaluator("satisfied");
    dischargeAbac("p.key", { ...CONTEXT, record: RECORD }, spy.evaluator);
    expect(spy.calls[0]?.record).toBe(RECORD);
  });

  it("omits the key entirely when the caller passed none", () => {
    // `"record" in input === false`, not merely `undefined`: an evaluator distinguishing "no record
    // supplied" from "a record of nothing" needs the key absent, which is the same distinction
    // `abacAttributes`' null draws one level in.
    const spy = spyEvaluator("satisfied");
    dischargeAbac("p.key", CONTEXT, spy.evaluator);
    const input = spy.calls[0] as AbacEvaluationInput;
    expect("record" in input).toBe(false);
  });

  it("carries an empty record through as a record, not as an absence", () => {
    const spy = spyEvaluator("satisfied");
    dischargeAbac("p.key", { ...CONTEXT, record: {} }, spy.evaluator);
    const input = spy.calls[0] as AbacEvaluationInput;
    expect("record" in input).toBe(true);
    expect(input.record).toEqual({});
  });

  it("does not itself refuse a record-free obligation", () => {
    // Deliberate: only the evaluator knows whether a policy key needs a record, so a refusal here
    // would reject every obligation at every record-free position including the ones over the
    // principal's own attributes.
    expect(dischargeAbac("p.key", CONTEXT, () => "satisfied")).toEqual({
      policyKey: "p.key",
      outcome: "satisfied",
    });
  });

  it("still refuses undischargeable on unresolved attributes when a record is supplied", () => {
    // The attribute rule is upstream of the record rule: a record cannot make up for an input
    // nobody gathered.
    const spy = spyEvaluator("satisfied");
    const d = dischargeAbac("p.key", { ...UNRESOLVED_CONTEXT, record: RECORD }, spy.evaluator);
    expect(d).toEqual({ policyKey: "p.key", outcome: "undischargeable" });
    expect(spy.calls).toEqual([]);
  });

  it("returns null for no obligation even when a record is supplied", () => {
    const spy = spyEvaluator("satisfied");
    expect(dischargeAbac(undefined, { ...CONTEXT, record: RECORD }, spy.evaluator)).toBeNull();
    expect(spy.calls).toEqual([]);
  });

  it("hands the evaluator the record beside the field on a field-level input", () => {
    const spy = spyEvaluator("satisfied");
    dischargeAbac("p.key", { ...CONTEXT, field: "mrn", record: RECORD }, spy.evaluator);
    expect(spy.calls).toEqual([
      {
        policyKey: "p.key",
        principal: PRINCIPAL,
        entity: "prescription",
        operation: "update",
        field: "mrn",
        record: RECORD,
      },
    ]);
  });
});

describe("dischargeAbac — a deferred answer", () => {
  it("passes deferred through rather than coercing it", () => {
    // `deferred` is inside the enum now, so `isAbacOutcome` admits it; before this change the same
    // string would have been rewritten to `undischargeable`, which names the wrong remedy.
    expect(dischargeAbac("p.key", CONTEXT, () => "deferred")).toEqual({
      policyKey: "p.key",
      outcome: "deferred",
    });
  });

  it("does not allow", () => {
    const d = dischargeAbac("p.key", CONTEXT, () => "deferred");
    expect(d).not.toBeNull();
    expect(ABAC_OUTCOME_ALLOWS[(d as AbacDischargeLike).outcome]).toBe(false);
  });

  it("echoes the policy key, so the refusal names the policy awaiting a record", () => {
    expect(dischargeAbac("rx.owns_row", CONTEXT, () => "deferred")?.policyKey).toBe("rx.owns_row");
  });

  it("can be satisfied by the same evaluator once the record is supplied", () => {
    // The whole round trip: refuse, load, re-ask. An evaluator that needs a record is a function of
    // whether one arrived, and nothing in this module decides that for it.
    const evaluator: AbacEvaluator = (input) =>
      input.record === undefined ? "deferred" : "satisfied";
    expect(dischargeAbac("p.key", CONTEXT, evaluator)?.outcome).toBe("deferred");
    expect(dischargeAbac("p.key", { ...CONTEXT, record: RECORD }, evaluator)?.outcome).toBe(
      "satisfied",
    );
  });

  it("still denies when the record arrives and the policy refuses it", () => {
    const evaluator: AbacEvaluator = (input) =>
      input.record === undefined ? "deferred" : "denied";
    expect(dischargeAbac("p.key", { ...CONTEXT, record: RECORD }, evaluator)?.outcome).toBe(
      "denied",
    );
  });
});

interface AbacDischargeLike {
  readonly outcome: AbacOutcome;
}

describe("isAbacDeferred", () => {
  it("is true for a deferred discharge", () => {
    expect(isAbacDeferred({ policyKey: "k", outcome: "deferred" })).toBe(true);
  });

  it("is false for the other three outcomes", () => {
    for (const outcome of ABAC_OUTCOMES) {
      expect(isAbacDeferred({ policyKey: "k", outcome })).toBe(outcome === "deferred");
    }
  });

  it("is false for null — no obligation existed, so nothing is pending", () => {
    expect(isAbacDeferred(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isAbacDeferred(undefined)).toBe(false);
  });

  it("agrees with what dischargeAbac produced", () => {
    expect(isAbacDeferred(dischargeAbac("p.key", CONTEXT, () => "deferred"))).toBe(true);
    expect(isAbacDeferred(dischargeAbac("p.key", CONTEXT, () => "satisfied"))).toBe(false);
    expect(isAbacDeferred(dischargeAbac(undefined, CONTEXT, () => "deferred"))).toBe(false);
  });

  it("never reads as an allow: every deferred discharge is refused by the total map", () => {
    const d = dischargeAbac("p.key", CONTEXT, () => "deferred");
    expect(isAbacDeferred(d)).toBe(true);
    expect(ABAC_OUTCOME_ALLOWS[(d as AbacDischargeLike).outcome]).toBe(false);
  });
});

describe("dischargeAbac — an out-of-enum answer is still refused", () => {
  function bogus(value: unknown): AbacEvaluator {
    return (() => value) as AbacEvaluator;
  }

  it("refuses 'defer', which is not the enum member", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus("defer"))?.outcome).toBe("undischargeable");
  });

  it("refuses 'Deferred' — the match is exact", () => {
    expect(dischargeAbac("p.key", CONTEXT, bogus("Deferred"))?.outcome).toBe("undischargeable");
  });
});

describe("ABAC_GRANT_POSITIONS", () => {
  it("names the nine positions a permission map can carry an obligation in", () => {
    expect(ABAC_GRANT_POSITIONS).toEqual([
      "entity_create",
      "entity_read",
      "entity_update",
      "entity_delete",
      "entity_list",
      "entity_transition",
      "field_read",
      "field_update",
      "field_create",
    ]);
  });

  it("matches the AbacGrantPosition union exhaustively", () => {
    const exhaustive: Record<AbacGrantPosition, true> = {
      entity_create: true,
      entity_read: true,
      entity_update: true,
      entity_delete: true,
      entity_list: true,
      entity_transition: true,
      field_read: true,
      field_update: true,
      field_create: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...ABAC_GRANT_POSITIONS].sort());
  });
});

describe("ABAC_RECORD_AVAILABILITY", () => {
  it("answers 'never' for a create: the record does not exist yet", () => {
    expect(ABAC_RECORD_AVAILABILITY.entity_create).toBe("never");
  });

  it("answers 'always' for a list: the handler loads the page, so every row is in hand", () => {
    // Flipped from `never`, and for the same shape of reason `field_read` was: the obstacle was
    // never that no record exists, it was that a denial there is a *filter*. Having the record and
    // what a denial does with it are two axes, and `ABAC_DENIAL_EFFECT` is the second.
    expect(ABAC_RECORD_AVAILABILITY.entity_list).toBe("always");
  });

  it("answers 'always' for a field read: redaction answers per record", () => {
    // Flipped from `never`: response redaction locates the records a response carries and computes
    // the field set for each, so a per-field read policy is answered against the record the field
    // came from. `FieldRedactionResult.deferred` is what tells it whether that second pass is owed.
    expect(ABAC_RECORD_AVAILABILITY.field_read).toBe("always");
  });

  it("answers 'always' for read, update, delete, list, a transition and a field read", () => {
    expect(ABAC_RECORD_AVAILABILITY.entity_read).toBe("always");
    expect(ABAC_RECORD_AVAILABILITY.entity_update).toBe("always");
    expect(ABAC_RECORD_AVAILABILITY.entity_delete).toBe("always");
    expect(ABAC_RECORD_AVAILABILITY.entity_list).toBe("always");
    expect(ABAC_RECORD_AVAILABILITY.entity_transition).toBe("always");
    expect(ABAC_RECORD_AVAILABILITY.field_read).toBe("always");
  });

  it("answers 'never' for exactly the two create positions, which have no record to find", () => {
    // Pinned as the exact set rather than per key, because per-key assertions on this map are what
    // let `field_read` sit on the wrong value: flipping a position back to `never` without arguing
    // for it fails here rather than passing quietly. A `never` position is refused at boot with no
    // escape hatch.
    //
    // `field_create` joined `entity_create` with `FieldPermission.create`, and the set grew rather
    // than the rule changing: both are a create, and the record a policy there would be about does
    // not exist until the write commits.
    const never = ABAC_GRANT_POSITIONS.filter((p) => ABAC_RECORD_AVAILABILITY[p] === "never");
    expect(never).toEqual(["entity_create", "field_create"]);
  });

  it("answers 'sometimes' for a field update, and only for that one", () => {
    // The update path holds the record and the create path cannot, so this is the one position
    // whose answer depends on which handler is asking.
    expect(ABAC_RECORD_AVAILABILITY.field_update).toBe("sometimes");
    const sometimes = ABAC_GRANT_POSITIONS.filter(
      (p) => ABAC_RECORD_AVAILABILITY[p] === "sometimes",
    );
    expect(sometimes).toEqual(["field_update"]);
  });

  it("is total: exactly one key per position", () => {
    expect(Object.keys(ABAC_RECORD_AVAILABILITY)).toHaveLength(ABAC_GRANT_POSITIONS.length);
    expect(Object.keys(ABAC_RECORD_AVAILABILITY).sort()).toEqual([...ABAC_GRANT_POSITIONS].sort());
  });

  it("only ever answers with a declared availability", () => {
    for (const p of ABAC_GRANT_POSITIONS) {
      expect(ABAC_RECORD_AVAILABILITIES).toContain(ABAC_RECORD_AVAILABILITY[p]);
    }
  });
});

describe("ABAC_RECORD_AVAILABILITY_REASONS", () => {
  it("is total: exactly one reason per position", () => {
    expect(Object.keys(ABAC_RECORD_AVAILABILITY_REASONS)).toHaveLength(
      ABAC_GRANT_POSITIONS.length,
    );
    expect(Object.keys(ABAC_RECORD_AVAILABILITY_REASONS).sort()).toEqual(
      [...ABAC_GRANT_POSITIONS].sort(),
    );
  });

  it("has a non-empty reason for every position", () => {
    // A ninth position cannot land with a missing reason: the boot refusal prints these, and an
    // empty one would refuse a deployment without saying why.
    for (const p of ABAC_GRANT_POSITIONS) {
      expect(ABAC_RECORD_AVAILABILITY_REASONS[p].length).toBeGreaterThan(0);
    }
  });

  it("says something beyond the position name", () => {
    // A reason that only restates its key is worthless to the operator reading it.
    for (const p of ABAC_GRANT_POSITIONS) {
      const reason = ABAC_RECORD_AVAILABILITY_REASONS[p];
      expect(reason).not.toBe(p);
      expect(reason.split(" ").length).toBeGreaterThan(5);
    }
  });

  it("reads as a fragment, not a sentence, so it appends to a refusal", () => {
    for (const p of ABAC_GRANT_POSITIONS) {
      const reason = ABAC_RECORD_AVAILABILITY_REASONS[p];
      expect(reason[0]).toBe(reason[0]?.toLowerCase());
      expect(reason.endsWith(".")).toBe(false);
    }
  });

  it("names the structural obstacle on the one 'never' position", () => {
    expect(ABAC_RECORD_AVAILABILITY_REASONS.entity_create).toContain("does not exist");
  });

  it("names what supplies the record on a list, and that a denial there filters", () => {
    // Two facts, both load-bearing: a `never` reason left on an `always` position would refuse a
    // policy the deployment can in fact answer, and an author reading only "the page is in hand"
    // would expect a 403 where they will get a shorter page.
    const reason = ABAC_RECORD_AVAILABILITY_REASONS.entity_list;
    expect(reason).toContain("page");
    expect(reason).toContain("drops that row");
    expect(reason).not.toContain("set of records");
  });

  it("names what supplies the record on a field read, now that one does", () => {
    // The reason is the whole of what an operator is told, so it has to have stopped claiming the
    // obstacle that was removed: a `never` reason on an `always` position would read as a refusal
    // for a policy the deployment can in fact answer.
    const reason = ABAC_RECORD_AVAILABILITY_REASONS.field_read;
    expect(reason).toContain("per record");
    expect(reason).not.toContain("cannot");
  });
});

describe("ABAC_DENIAL_EFFECTS", () => {
  it("names the three things a refusal can do to a response", () => {
    expect(ABAC_DENIAL_EFFECTS).toEqual(["refuses_request", "withholds_field", "filters_rows"]);
  });

  it("matches the AbacDenialEffect union exhaustively", () => {
    const exhaustive: Record<AbacDenialEffect, true> = {
      refuses_request: true,
      withholds_field: true,
      filters_rows: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...ABAC_DENIAL_EFFECTS].sort());
  });
});

describe("ABAC_DENIAL_EFFECT", () => {
  it("is total: exactly one key per position", () => {
    expect(Object.keys(ABAC_DENIAL_EFFECT)).toHaveLength(ABAC_GRANT_POSITIONS.length);
    expect(Object.keys(ABAC_DENIAL_EFFECT).sort()).toEqual([...ABAC_GRANT_POSITIONS].sort());
  });

  it("only ever answers with a declared effect", () => {
    for (const p of ABAC_GRANT_POSITIONS) {
      expect(ABAC_DENIAL_EFFECTS).toContain(ABAC_DENIAL_EFFECT[p]);
    }
  });

  it("filters rows for exactly one position, the list", () => {
    // The exact set, not the one key: this is the axis `ABAC_RECORD_AVAILABILITY` could not express,
    // and a second position silently acquiring it would mean a page shortening somewhere nobody
    // argued for.
    const filtering = ABAC_GRANT_POSITIONS.filter(
      (p) => ABAC_DENIAL_EFFECT[p] === "filters_rows",
    );
    expect(filtering).toEqual(["entity_list"]);
  });

  it("withholds a field for exactly one position, the field read", () => {
    const withholding = ABAC_GRANT_POSITIONS.filter(
      (p) => ABAC_DENIAL_EFFECT[p] === "withholds_field",
    );
    expect(withholding).toEqual(["field_read"]);
  });

  it("refuses the request everywhere else, field_update included", () => {
    // A field *update* denial is a 403 and not a silent drop: writing part of a patch and discarding
    // the rest would report success for a write the caller did not make.
    const refusing = ABAC_GRANT_POSITIONS.filter(
      (p) => ABAC_DENIAL_EFFECT[p] === "refuses_request",
    );
    expect(refusing).toEqual([
      "entity_create",
      "entity_read",
      "entity_update",
      "entity_delete",
      "entity_transition",
      "field_update",
      "field_create",
    ]);
  });

  it("answers for entity_create even though a boot refusal makes it unreachable", () => {
    // Honest rather than a hole: it is what a denial there would do, and a total map with a gap is
    // the thing a total map exists to prevent — the position would otherwise have to be remembered
    // the day the boot refusal moves.
    expect(ABAC_DENIAL_EFFECT.entity_create).toBe("refuses_request");
    expect(ABAC_RECORD_AVAILABILITY.entity_create).toBe("never");
  });

  it("is a second axis: the two maps do not determine each other", () => {
    // `entity_read` and `entity_list` agree on availability and differ on effect; `entity_create`
    // and `entity_read` differ on availability and agree on effect. Either map alone loses a fact.
    expect(ABAC_RECORD_AVAILABILITY.entity_read).toBe(ABAC_RECORD_AVAILABILITY.entity_list);
    expect(ABAC_DENIAL_EFFECT.entity_read).not.toBe(ABAC_DENIAL_EFFECT.entity_list);
    expect(ABAC_RECORD_AVAILABILITY.entity_create).not.toBe(ABAC_RECORD_AVAILABILITY.entity_read);
    expect(ABAC_DENIAL_EFFECT.entity_create).toBe(ABAC_DENIAL_EFFECT.entity_read);
  });
});

describe("ABAC_DENIAL_EFFECT_DESCRIPTIONS", () => {
  it("is total: exactly one description per effect", () => {
    expect(Object.keys(ABAC_DENIAL_EFFECT_DESCRIPTIONS)).toHaveLength(ABAC_DENIAL_EFFECTS.length);
    expect(Object.keys(ABAC_DENIAL_EFFECT_DESCRIPTIONS).sort()).toEqual(
      [...ABAC_DENIAL_EFFECTS].sort(),
    );
  });

  it("has a non-empty description for every effect", () => {
    for (const e of ABAC_DENIAL_EFFECTS) {
      expect(ABAC_DENIAL_EFFECT_DESCRIPTIONS[e].length).toBeGreaterThan(0);
    }
  });

  it("says something beyond the effect name", () => {
    // Same rule as the availability reasons: a description that only restates its key is worthless
    // to the operator reading the boot report it is printed in.
    for (const e of ABAC_DENIAL_EFFECTS) {
      const description = ABAC_DENIAL_EFFECT_DESCRIPTIONS[e];
      expect(description).not.toBe(e);
      expect(description).not.toBe(e.replace("_", " "));
      expect(description.split(" ").length).toBeGreaterThan(5);
    }
  });

  it("reads as a fragment, not a sentence, so it appends to a report line", () => {
    for (const e of ABAC_DENIAL_EFFECTS) {
      const description = ABAC_DENIAL_EFFECT_DESCRIPTIONS[e];
      expect(description[0]).toBe(description[0]?.toLowerCase());
      expect(description.endsWith(".")).toBe(false);
    }
  });

  it("gives each effect a distinct description", () => {
    expect(new Set(ABAC_DENIAL_EFFECTS.map((e) => ABAC_DENIAL_EFFECT_DESCRIPTIONS[e])).size).toBe(
      ABAC_DENIAL_EFFECTS.length,
    );
  });

  it("describes every position's effect, so a report can always say what a denial does", () => {
    for (const p of ABAC_GRANT_POSITIONS) {
      expect(ABAC_DENIAL_EFFECT_DESCRIPTIONS[ABAC_DENIAL_EFFECT[p]].length).toBeGreaterThan(0);
    }
  });
});

describe("abacGrantPosition", () => {
  function obligation(
    operation: AbacObligation["operation"],
    field: string | null,
  ): AbacObligation {
    return { entity: "Patient", operation, field, policyKey: "k" };
  }

  it("maps each entity-level operation to its own position", () => {
    expect(abacGrantPosition(obligation("create", null))).toBe("entity_create");
    expect(abacGrantPosition(obligation("read", null))).toBe("entity_read");
    expect(abacGrantPosition(obligation("update", null))).toBe("entity_update");
    expect(abacGrantPosition(obligation("delete", null))).toBe("entity_delete");
    expect(abacGrantPosition(obligation("list", null))).toBe("entity_list");
  });

  it("maps a transition to entity_transition", () => {
    expect(abacGrantPosition(obligation({ kind: "transition", name: "admit" }, null))).toBe(
      "entity_transition",
    );
  });

  it("maps a field read and a field update to the field positions", () => {
    expect(abacGrantPosition(obligation("read", "mrn"))).toBe("field_read");
    expect(abacGrantPosition(obligation("update", "mrn"))).toBe("field_update");
  });

  it("covers every position, so the nine are all reachable", () => {
    const reached = new Set<AbacGrantPosition>([
      abacGrantPosition(obligation("create", null)),
      abacGrantPosition(obligation("read", null)),
      abacGrantPosition(obligation("update", null)),
      abacGrantPosition(obligation("delete", null)),
      abacGrantPosition(obligation("list", null)),
      abacGrantPosition(obligation({ kind: "transition", name: "t" }, null)),
      abacGrantPosition(obligation("read", "mrn")),
      abacGrantPosition(obligation("update", "mrn")),
      abacGrantPosition(obligation("create", "mrn")),
    ]);
    expect([...reached].sort()).toEqual([...ABAC_GRANT_POSITIONS].sort());
  });

  it("maps a field obligation on create to field_create, which is now reachable", () => {
    // It used to answer `entity_create`, correctly, because a `FieldPermission` had no `create` arm
    // and so could not carry one. It has one now, and the position is its own: the availability
    // answer is the same as `entity_create`'s and for the same reason, but the obligation is about a
    // field and a boot refusal that named the entity position would send an operator to the wrong
    // grant.
    expect(abacGrantPosition(obligation("create", "mrn"))).toBe("field_create");
  });

  it("is total for a field obligation on an operation surveyAbacObligations cannot emit", () => {
    // `FieldPermission` has `read`, `update` and `create` arms and no others, so these two remain
    // unreachable from a permission map — answered rather than thrown, because an exception in an
    // authorization survey is worse than the decidable answer.
    expect(abacGrantPosition(obligation("delete", "mrn"))).toBe("entity_delete");
    expect(abacGrantPosition(obligation("list", "mrn"))).toBe("entity_list");
  });

  it("maps a transition carrying a field to entity_transition", () => {
    // The transition grant has no field arm, so the field cannot be what the act is about.
    expect(abacGrantPosition(obligation({ kind: "transition", name: "admit" }, "mrn"))).toBe(
      "entity_transition",
    );
  });

  it("never throws on anything surveyAbacObligations produces", () => {
    for (const o of surveyAbacObligations(SURVEY_PERMS)) {
      expect(ABAC_GRANT_POSITIONS).toContain(abacGrantPosition(o));
    }
  });

  it("classifies the surveyed fixture's five obligations", () => {
    expect(surveyAbacObligations(SURVEY_PERMS).map(abacGrantPosition)).toEqual([
      "entity_list",
      "entity_update",
      "entity_transition",
      "field_read",
      "field_update",
    ]);
  });
});

describe("abacRecordAvailabilityFor", () => {
  function obligation(
    operation: AbacObligation["operation"],
    field: string | null,
  ): AbacObligation {
    return { entity: "Patient", operation, field, policyKey: "k" };
  }

  it("agrees with ABAC_RECORD_AVAILABILITY for every position", () => {
    const cases: readonly (readonly [AbacObligation, AbacGrantPosition])[] = [
      [obligation("create", null), "entity_create"],
      [obligation("read", null), "entity_read"],
      [obligation("update", null), "entity_update"],
      [obligation("delete", null), "entity_delete"],
      [obligation("list", null), "entity_list"],
      [obligation({ kind: "transition", name: "t" }, null), "entity_transition"],
      [obligation("read", "mrn"), "field_read"],
      [obligation("update", "mrn"), "field_update"],
    ];
    for (const [o, position] of cases) {
      expect(abacRecordAvailabilityFor(o)).toBe(ABAC_RECORD_AVAILABILITY[position]);
    }
  });

  it("answers 'always' for the obligation on a field read grant", () => {
    expect(abacRecordAvailabilityFor(obligation("read", "mrn"))).toBe("always");
  });

  it("answers 'always' for the obligation on a list grant, as it does for a field read", () => {
    // The pair that looks alike: on *this* axis they now agree, because both have the record and
    // always did. What separates them is what a denial does, which `ABAC_DENIAL_EFFECT` answers —
    // a field read withholds columns within a row, a list withholds whole rows.
    expect(abacRecordAvailabilityFor(obligation("list", null))).toBe("always");
    expect(ABAC_DENIAL_EFFECT.entity_list).not.toBe(ABAC_DENIAL_EFFECT.field_read);
  });

  it("answers 'always' for an obligated update on the entity", () => {
    expect(abacRecordAvailabilityFor(obligation("update", null))).toBe("always");
  });

  it("answers for every obligation in the surveyed fixture", () => {
    expect(surveyAbacObligations(SURVEY_PERMS).map(abacRecordAvailabilityFor)).toEqual([
      "always",
      "always",
      "always",
      "always",
      "sometimes",
    ]);
  });
});

/**
 * The batch arm. Its rules are all about what must *not* happen: a batch must not be woken for
 * nothing, must not stand in for the single evaluator the other four readers need, and must not be
 * believed when the correspondence between a question and its answer cannot be shown.
 */
describe("dischargeAbacBatch", () => {
  function request(policyKey: string, principal: Principal = PRINCIPAL): AbacBatchRequest {
    return { policyKey, context: { ...CONTEXT, principal } };
  }

  /**
   * Records every batch call, so a test can assert it was never reached rather than ignored.
   *
   * The answer builder returns `unknown` and the function is cast once: the malformed returns below
   * are the point of half these tests, and a correctly typed spy could not express them.
   */
  function spyBatch(answers: (inputs: readonly AbacEvaluationInput[]) => unknown): {
    readonly batch: AbacBatchEvaluator;
    readonly calls: AbacEvaluationInput[][];
  } {
    const calls: AbacEvaluationInput[][] = [];
    const batch = (inputs: readonly AbacEvaluationInput[]): unknown => {
      calls.push([...inputs]);
      return answers(inputs);
    };
    return { batch: batch as AbacBatchEvaluator, calls };
  }

  /** The well-behaved shape: ascending indices, one answer per input. */
  function answerAll(outcome: AbacOutcome) {
    return (inputs: readonly AbacEvaluationInput[]): readonly AbacBatchAnswer[] =>
      inputs.map((_input, index) => ({ index, outcome }));
  }

  it("returns an empty array for no requests, waking neither function", () => {
    const single = spyEvaluator("satisfied");
    const batch = spyBatch(answerAll("satisfied"));
    expect(dischargeAbacBatch([], single.evaluator, batch.batch)).toEqual([]);
    // A policy service must not be woken for nothing — and two empty arrays line up trivially, so
    // the length check downstream would be vacuous on this input.
    expect(single.calls).toHaveLength(0);
    expect(batch.calls).toHaveLength(0);
  });

  it("refuses every request with no evaluator, and does not call the batch either", () => {
    const batch = spyBatch(answerAll("satisfied"));
    const out = dischargeAbacBatch([request("a"), request("b")], undefined, batch.batch);
    // `evaluateBatch` is a sibling of `evaluator`, never a replacement: a seam carrying only a batch
    // is half-wired, since `rbacCheck` and the two write masks can only ask one question each.
    expect(out).toEqual([
      { policyKey: "a", outcome: "undischargeable" },
      { policyKey: "b", outcome: "undischargeable" },
    ]);
    expect(batch.calls).toHaveLength(0);
  });

  it("answers through the batch when one is supplied", () => {
    const single = spyEvaluator("denied");
    const batch = spyBatch(answerAll("satisfied"));
    const out = dischargeAbacBatch([request("a"), request("b")], single.evaluator, batch.batch);
    expect(out).toEqual([
      { policyKey: "a", outcome: "satisfied" },
      { policyKey: "b", outcome: "satisfied" },
    ]);
    expect(batch.calls).toHaveLength(1);
    expect(single.calls).toHaveLength(0);
  });

  it("answers through the single evaluator when no batch is supplied, once per request", () => {
    const single = spyEvaluator("satisfied");
    const out = dischargeAbacBatch([request("a"), request("b"), request("c")], single.evaluator);
    expect(out.map((d) => d.outcome)).toEqual(["satisfied", "satisfied", "satisfied"]);
    // Exactly today's behaviour and today's cost for a deployment that declared no batch arm.
    expect(single.calls).toHaveLength(3);
    expect(single.calls.map((i) => i.policyKey)).toEqual(["a", "b", "c"]);
  });

  it("honours a deferred answer rather than reading it as a skip", () => {
    const out = dischargeAbacBatch(
      [request("a")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(answerAll("deferred")).batch,
    );
    expect(out).toEqual([{ policyKey: "a", outcome: "deferred" }]);
    expect(ABAC_OUTCOME_ALLOWS[out[0]?.outcome ?? "satisfied"]).toBe(false);
  });

  it("refuses the whole batch when the call throws", () => {
    const out = dischargeAbacBatch([request("a"), request("b")], UNDISCHARGEABLE_ABAC_EVALUATOR, () => {
      throw new Error("policy service down");
    });
    // An exception inside an authorization check must not become an allow, and must not escape as a
    // 500 a client retries into the same refusal.
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable", "undischargeable"]);
  });

  it("refuses the whole batch when the return is not an array", () => {
    const out = dischargeAbacBatch(
      [request("a")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => "satisfied").batch,
    );
    expect(out).toEqual([{ policyKey: "a", outcome: "undischargeable" }]);
  });

  it("refuses the whole batch on a short return", () => {
    const out = dischargeAbacBatch(
      [request("a"), request("b"), request("c")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [{ index: 0, outcome: "satisfied" }]).batch,
    );
    // Deliberately not "honour the one that lined up": a length fault means no answer can be shown
    // to belong to its question, so trusting the prefix would be guessing which.
    expect(out.map((d) => d.outcome)).toEqual([
      "undischargeable",
      "undischargeable",
      "undischargeable",
    ]);
  });

  it("refuses the whole batch on a long return", () => {
    const out = dischargeAbacBatch(
      [request("a")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [
        { index: 0, outcome: "satisfied" },
        { index: 1, outcome: "satisfied" },
      ]).batch,
    );
    expect(out).toEqual([{ policyKey: "a", outcome: "undischargeable" }]);
  });

  it("refuses the whole batch when an index does not match its position", () => {
    const out = dischargeAbacBatch(
      [request("a"), request("b"), request("c")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [
        { index: 0, outcome: "satisfied" },
        { index: 2, outcome: "denied" },
        { index: 1, outcome: "satisfied" },
      ]).batch,
    );
    // Including the one that happened to line up: a permutation is a silent mis-authorization of
    // which roughly half allows, and the echoed index is the only thing that can see it.
    expect(out.map((d) => d.outcome)).toEqual([
      "undischargeable",
      "undischargeable",
      "undischargeable",
    ]);
  });

  it("refuses the whole batch for an element that is not an object", () => {
    const out = dischargeAbacBatch(
      [request("a"), request("b")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => ["satisfied", { index: 1, outcome: "satisfied" }]).batch,
    );
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable", "undischargeable"]);
  });

  it("refuses the whole batch for a null element, which typeof calls an object", () => {
    const out = dischargeAbacBatch(
      [request("a")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [null]).batch,
    );
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable"]);
  });

  it("refuses only the element whose outcome is outside the enum", () => {
    const out = dischargeAbacBatch(
      [request("a"), request("b"), request("c")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [
        { index: 0, outcome: "satisfied" },
        { index: 1, outcome: "allow" },
        { index: 2, outcome: "denied" },
      ]).batch,
    );
    // Positional correspondence is intact here, so only that one answer is unreadable — the same
    // granularity the single path already has.
    expect(out).toEqual([
      { policyKey: "a", outcome: "satisfied" },
      { policyKey: "b", outcome: "undischargeable" },
      { policyKey: "c", outcome: "denied" },
    ]);
  });

  it("refuses only the element whose outcome is missing entirely", () => {
    const out = dischargeAbacBatch(
      [request("a"), request("b")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch(() => [{ index: 0 }, { index: 1, outcome: "satisfied" }]).batch,
    );
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable", "satisfied"]);
  });

  it("excludes an unresolved-attribute principal from the array the batch receives", () => {
    const batch = spyBatch(answerAll("satisfied"));
    const out = dischargeAbacBatch(
      [request("a"), request("b", UNRESOLVED_PRINCIPAL), request("c")],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      batch.batch,
    );
    // The batch is handed only questions it could answer, so its length is the number of those —
    // and the excluded one is refused before any evaluator sees it (ADR-0341).
    expect(batch.calls[0]).toHaveLength(2);
    expect(batch.calls[0]?.map((i) => i.policyKey)).toEqual(["a", "c"]);
    expect(out).toEqual([
      { policyKey: "a", outcome: "satisfied" },
      { policyKey: "b", outcome: "undischargeable" },
      { policyKey: "c", outcome: "satisfied" },
    ]);
  });

  it("excludes an unresolved-attribute principal on the single-evaluator arm too", () => {
    const single = spyEvaluator("satisfied");
    const out = dischargeAbacBatch(
      [request("a", UNRESOLVED_PRINCIPAL), request("b")],
      single.evaluator,
    );
    expect(single.calls.map((i) => i.policyKey)).toEqual(["b"]);
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable", "satisfied"]);
  });

  it("calls nothing when every request is excluded", () => {
    const single = spyEvaluator("satisfied");
    const batch = spyBatch(answerAll("satisfied"));
    const out = dischargeAbacBatch(
      [request("a", UNRESOLVED_PRINCIPAL), request("b", UNRESOLVED_PRINCIPAL)],
      single.evaluator,
      batch.batch,
    );
    expect(out.map((d) => d.outcome)).toEqual(["undischargeable", "undischargeable"]);
    expect(batch.calls).toHaveLength(0);
    expect(single.calls).toHaveLength(0);
  });

  it("aligns its result to the requests, policy key by policy key", () => {
    const keys = ["k0", "k1", "k2", "k3"];
    const out = dischargeAbacBatch(
      keys.map((k) => request(k)),
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch((inputs) =>
        inputs.map((input, index) => ({
          index,
          outcome: input.policyKey === "k2" ? "denied" : "satisfied",
        })),
      ).batch,
    );
    expect(out.map((d) => d.policyKey)).toEqual(keys);
    expect(out.map((d) => d.outcome)).toEqual(["satisfied", "satisfied", "denied", "satisfied"]);
  });

  it("passes each request's context through verbatim, with the policy key attached", () => {
    const record: Readonly<Record<string, unknown>> = { id: "p-1" };
    const batch = spyBatch(answerAll("satisfied"));
    dischargeAbacBatch(
      [{ policyKey: "owns", context: { ...CONTEXT, field: "mrn", record } }],
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      batch.batch,
    );
    expect(batch.calls[0]?.[0]).toEqual({
      policyKey: "owns",
      principal: PRINCIPAL,
      entity: "prescription",
      operation: "update",
      field: "mrn",
      record,
    });
  });

  it("answers every outcome of the enum through the batch", () => {
    const out = dischargeAbacBatch(
      ABAC_OUTCOMES.map((o) => request(o)),
      UNDISCHARGEABLE_ABAC_EVALUATOR,
      spyBatch((inputs) =>
        inputs.map((input, index) => ({ index, outcome: input.policyKey })),
      ).batch,
    );
    expect(out.map((d) => d.outcome)).toEqual([...ABAC_OUTCOMES]);
  });
});
