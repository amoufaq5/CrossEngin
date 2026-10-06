import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import {
  ABAC_OUTCOME_ALLOWS,
  UNDISCHARGEABLE_ABAC_EVALUATOR,
  describeOperation,
  dischargeAbac,
  formatAbacObligation,
  surveyAbacObligations,
  type AbacEvaluationInput,
  type AbacEvaluator,
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

describe("ABAC_OUTCOMES", () => {
  it("names exactly three outcomes", () => {
    expect(ABAC_OUTCOMES).toEqual(["satisfied", "denied", "undischargeable"]);
  });

  it("separates a refusal about the principal from an inability to answer", () => {
    // `denied` is a claim about this principal's attributes; `undischargeable` says nothing could
    // answer at all. Collapsing them would send an operator to the wrong remedy.
    expect(ABAC_OUTCOMES).toContain("denied");
    expect(ABAC_OUTCOMES).toContain("undischargeable");
  });
});

describe("ABAC_OUTCOME_ALLOWS", () => {
  it("admits only 'satisfied'", () => {
    expect(ABAC_OUTCOME_ALLOWS).toEqual({
      satisfied: true,
      denied: false,
      undischargeable: false,
    });
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
