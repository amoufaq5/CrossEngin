import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import {
  computeClassifiedFieldRedaction,
  computeClassifiedFieldRedactionForRecords,
  computeFieldRedaction,
  validateClassifiedWriteMask,
  validateWriteMask,
  type ClassifiedField,
} from "./fields.js";
import {
  ABAC_OUTCOME_ALLOWS,
  type AbacBatchEvaluator,
  type AbacEvaluationInput,
  type AbacEvaluator,
} from "./abac.js";
import {
  ABAC_OUTCOMES,
  type AbacOutcome,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
} from "./types.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["pharmacist", { name: "pharmacist" }],
  ["technician", { name: "technician" }],
  ["manager", { name: "manager", inherits: ["pharmacist"] }],
]);

function principal(role: string): Principal {
  return {
    kind: "user",
    tenantId: "t" as TenantId,
    userId: "u" as UserId,
    primaryRole: role,
    secondaryRoles: [],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

const PERMS: EntityPermissions = {
  read: { roles: ["pharmacist", "technician", "manager"] },
  update: { roles: ["pharmacist", "manager"] },
  fields: {
    narcotic_schedule: {
      read: { roles: ["pharmacist", "manager"] },
      update: { roles: ["pharmacist"] },
    },
    internal_notes: {
      read: { roles: ["pharmacist", "technician", "manager"] },
      update: { roles: ["pharmacist", "manager"] },
    },
  },
};

describe("computeFieldRedaction", () => {
  it("returns fields without rules as readable", () => {
    const r = computeFieldRedaction(principal("technician"), PERMS, ROLES, ["a", "b"]);
    expect(r.readable).toEqual(["a", "b"]);
    expect(r.redacted).toEqual([]);
  });

  it("redacts a field a role cannot read", () => {
    const r = computeFieldRedaction(
      principal("technician"),
      PERMS,
      ROLES,
      ["internal_notes", "narcotic_schedule"],
    );
    expect(r.readable).toEqual(["internal_notes"]);
    expect(r.redacted).toEqual(["narcotic_schedule"]);
  });

  it("respects inheritance (manager can read pharmacist-restricted fields)", () => {
    const r = computeFieldRedaction(
      principal("manager"),
      PERMS,
      ROLES,
      ["narcotic_schedule"],
    );
    expect(r.readable).toEqual(["narcotic_schedule"]);
    expect(r.redacted).toEqual([]);
  });

  it("returns empty arrays for an empty field list", () => {
    const r = computeFieldRedaction(principal("technician"), PERMS, ROLES, []);
    expect(r.readable).toEqual([]);
    expect(r.redacted).toEqual([]);
  });
});

describe("validateWriteMask", () => {
  it("accepts a patch that touches no field-level-controlled fields", () => {
    const r = validateWriteMask(principal("technician"), PERMS, ROLES, ["a", "b"]);
    expect(r.ok).toBe(true);
  });

  it("rejects a patch touching a forbidden field (technician cannot update narcotic_schedule)", () => {
    const r = validateWriteMask(
      principal("technician"),
      PERMS,
      ROLES,
      ["narcotic_schedule"],
    );
    expect(r.ok).toBe(false);
    expect(r.rejectedField).toBe("narcotic_schedule");
  });

  it("rejects on the first forbidden field encountered", () => {
    const r = validateWriteMask(
      principal("technician"),
      PERMS,
      ROLES,
      ["internal_notes", "narcotic_schedule"],
    );
    expect(r.ok).toBe(false);
    expect(r.rejectedField).toBe("internal_notes");
  });

  it("accepts when all touched fields are permitted", () => {
    const r = validateWriteMask(
      principal("pharmacist"),
      PERMS,
      ROLES,
      ["internal_notes", "narcotic_schedule"],
    );
    expect(r.ok).toBe(true);
  });
});

const CLINICAL_ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["clinician", { name: "clinician" }],
  ["front_desk", { name: "front_desk" }],
]);

const NO_FIELD_PERMS: EntityPermissions = { read: { roles: ["clinician", "front_desk"] } };

const CLINICAL_FIELDS: readonly ClassifiedField[] = [
  { name: "mrn", classification: "phi" },
  { name: "given_name", classification: "pii" },
  { name: "status" },
];

describe("computeClassifiedFieldRedaction", () => {
  it("redacts sensitive fields by default for a non-privileged role", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
    );
    expect(r.readable).toEqual(["status"]);
    expect(r.redacted).toEqual(["mrn", "given_name"]);
  });

  it("reveals sensitive fields to a privileged role", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
    );
    expect(r.redacted).toEqual([]);
  });

  it("lets an explicit field read grant override the default", () => {
    const perms: EntityPermissions = {
      fields: { mrn: { read: { roles: ["front_desk"] } } },
    };
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      perms,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
    );
    expect(r.readable).toContain("mrn");
    expect(r.redacted).toEqual(["given_name"]);
  });

  it("never redacts unclassified fields", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "status" }, { name: "label" }],
      { privilegedRoles: ["clinician"] },
    );
    expect(r.redacted).toEqual([]);
  });

  it("honours a custom redactByDefault predicate (phi only)", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"], redactByDefault: (c) => c === "phi" },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.readable).toEqual(["given_name", "status"]);
  });
});

describe("validateClassifiedWriteMask", () => {
  it("blocks a non-privileged role from writing a sensitive field", () => {
    const r = validateClassifiedWriteMask(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      { privilegedRoles: ["clinician"] },
    );
    expect(r).toEqual({ ok: false, rejectedField: "mrn" });
  });

  it("allows a privileged role to write a sensitive field", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }, { name: "status" }],
      { privilegedRoles: ["clinician"] },
    );
    expect(r.ok).toBe(true);
  });

  it("lets an explicit update grant override the default", () => {
    const perms: EntityPermissions = {
      fields: { mrn: { update: { roles: ["front_desk"] } } },
    };
    const r = validateClassifiedWriteMask(
      principal("front_desk"),
      perms,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      { privilegedRoles: ["clinician"] },
    );
    expect(r.ok).toBe(true);
  });
});

/**
 * Per-class sensitive grants (ADR-0329).
 *
 * `privilegedRoles` is wholesale: a role granted it reads pii *and* phi. So a deployment wanting
 * support staff to see a customer's contact details had to expose patient records to them too, or
 * redact everything — and for a HIPAA deployment only the second is acceptable, which means the
 * grant was unusable for its actual purpose.
 */
describe("computeClassifiedFieldRedaction — per-class grants (ADR-0329)", () => {
  it("grants one class without granting the others", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRolesByClass: { pii: ["front_desk"] } },
    );
    // The whole point: contact details readable, the medical record number not.
    expect(r.readable).toEqual(["given_name", "status"]);
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("makes a named class authoritative, so the wholesale grant no longer reaches it", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"], privilegedRolesByClass: { phi: ["auditor"] } },
    );
    // Read as a union instead, a wholesale grantee could never be withheld from phi — which is the
    // one narrowing the feature exists for.
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.readable).toContain("given_name");
  });

  it("treats an explicit empty list as a refusal, not as a fall-through", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"], privilegedRolesByClass: { phi: [] } },
    );
    // `{phi: []}` withholds phi from everyone including the wholesale grantee. Falling through to
    // the flat list would make the empty array mean nothing at all.
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("leaves a class with no entry to the wholesale grant", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"], privilegedRolesByClass: { pii: ["front_desk"] } },
    );
    // phi has no entry, so the existing grant still reads it — a deployment that upgrades and names
    // only one class must not silently lose access to the rest.
    expect(r.readable).toContain("mrn");
  });

  it("changes nothing for a policy that names no classes", () => {
    const withEmpty = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"], privilegedRolesByClass: {} },
    );
    const without = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
    );
    expect(withEmpty).toEqual(without);
  });

  it("still redacts for a role in no grant at all", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRolesByClass: { phi: ["clinician"] } },
    );
    // Fail closed: naming a class for somebody else grants nothing to anybody else.
    expect(r.redacted).toEqual(["mrn", "given_name"]);
  });

  it("lets an explicit field grant still win over a per-class refusal", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      { fields: { mrn: { read: { roles: ["front_desk"] } } } },
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRolesByClass: { phi: [] } },
    );
    // Unchanged precedence: an explicit per-field rule is a deliberate statement about one field
    // and outranks a class-wide default, exactly as it outranks the wholesale grant.
    expect(r.readable).toContain("mrn");
  });
});

describe("validateClassifiedWriteMask — per-class grants (ADR-0329)", () => {
  it("refuses a write to a class the role is not granted, even holding another", () => {
    const r = validateClassifiedWriteMask(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      { privilegedRolesByClass: { pii: ["front_desk"] } },
    );
    expect(r).toEqual({ ok: false, rejectedField: "mrn" });
  });

  it("allows a write to the class it is granted", () => {
    const r = validateClassifiedWriteMask(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "given_name", classification: "pii" }],
      { privilegedRolesByClass: { pii: ["front_desk"] } },
    );
    expect(r.ok).toBe(true);
  });

  it("asks the same question the read path does, so write cannot outrun read", () => {
    const policy = { privilegedRoles: ["clinician"], privilegedRolesByClass: { phi: [] } };
    const read = computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" as const }],
      policy,
    );
    const write = validateClassifiedWriteMask(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      policy,
    );
    // One function behind both, so a role cannot end up able to change a value it may not see.
    expect(read.redacted).toEqual(["mrn"]);
    expect(write.ok).toBe(false);
  });
});

/**
 * Field-level ABAC obligations.
 *
 * Each of the four functions read `rule.roles` and ignored `rule.abac`, so an ABAC-qualified field
 * `read` grant disclosed the field and an ABAC-qualified field `update` grant permitted the write —
 * the repo's "fail closed" invariant inverted, since a check that cannot be completed must deny.
 */
const ABAC_PERMS: EntityPermissions = {
  fields: {
    mrn: {
      read: { roles: ["pharmacist", "manager"], abac: "field.mrn.read" },
      update: { roles: ["pharmacist", "manager"], abac: "field.mrn.update" },
    },
    plain: {
      read: { roles: ["pharmacist", "manager"] },
      update: { roles: ["pharmacist", "manager"] },
    },
  },
};

function recordingEvaluator(outcome: AbacOutcome): {
  readonly fn: AbacEvaluator;
  readonly calls: AbacEvaluationInput[];
} {
  const calls: AbacEvaluationInput[] = [];
  return {
    fn: (input) => {
      calls.push(input);
      return outcome;
    },
    calls,
  };
}

describe("computeFieldRedaction — abac obligations", () => {
  it("redacts an abac-qualified field when the parameter is omitted", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"]);
    // Omitting the parameter is a caller with no evaluator, not a way to skip the obligation.
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.readable).toEqual([]);
  });

  it("redacts it identically when an entity is named with no evaluator", () => {
    const omitted = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"]);
    const named = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
    });
    expect(named).toEqual(omitted);
    expect(named.redacted).toEqual(["mrn"]);
  });

  it("reads the field when the evaluator answers satisfied", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "satisfied",
    });
    expect(r.readable).toEqual(["mrn"]);
  });

  it("redacts the field when the evaluator answers denied", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "denied",
    });
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("redacts the field when the evaluator throws", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => {
        throw new Error("down");
      },
    });
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("leaves an unqualified field grant untouched", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["plain"], {
      entity: "Prescription",
      evaluator: () => "denied",
    });
    expect(r.readable).toEqual(["plain"]);
  });

  it("names the entity, the read operation and the field in the evaluation input", () => {
    const spy = recordingEvaluator("satisfied");
    computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(spy.calls).toEqual([
      {
        policyKey: "field.mrn.read",
        principal: principal("pharmacist"),
        entity: "Prescription",
        operation: "read",
        field: "mrn",
      },
    ]);
  });

  it("does not consult the evaluator when the roles check already failed", () => {
    const spy = recordingEvaluator("satisfied");
    const r = computeFieldRedaction(principal("technician"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(r.redacted).toEqual(["mrn"]);
    expect(spy.calls).toEqual([]);
  });
});

describe("validateWriteMask — abac obligations", () => {
  it("rejects an abac-qualified field when the parameter is omitted", () => {
    const r = validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"]);
    expect(r.ok).toBe(false);
    expect(r.rejectedField).toBe("mrn");
    expect(r.abac).toEqual({ policyKey: "field.mrn.update", outcome: "undischargeable" });
  });

  it("accepts the write when the evaluator answers satisfied", () => {
    const r = validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "satisfied",
    });
    expect(r).toEqual({ ok: true });
  });

  it("attaches the discharge beside the rejected field on a denial", () => {
    const r = validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "denied",
    });
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "denied" },
    });
  });

  it("sets no abac on a roles-only rejection", () => {
    const r = validateWriteMask(principal("technician"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "satisfied",
    });
    expect(r).toEqual({ ok: false, rejectedField: "mrn" });
  });

  it("names the update operation in the evaluation input", () => {
    const spy = recordingEvaluator("satisfied");
    validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(spy.calls[0]?.operation).toBe("update");
    expect(spy.calls[0]?.field).toBe("mrn");
  });
});

const CLASSIFIED_ABAC_PERMS: EntityPermissions = {
  fields: {
    mrn: {
      read: { roles: ["clinician"], abac: "field.mrn.read" },
      update: { roles: ["clinician"], abac: "field.mrn.update" },
    },
  },
};

describe("computeClassifiedFieldRedaction — abac obligations", () => {
  it("redacts an abac-qualified field with no evaluator", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
    );
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("reads it when the evaluator answers satisfied", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
      { entity: "Patient", evaluator: () => "satisfied" },
    );
    expect(r.readable).toEqual(["mrn"]);
  });

  it("does not reach the classification default when an explicit rule's obligation refuses", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: () => "denied" },
    );
    // An explicit per-field rule is the answer for that field; a privileged class grant must not
    // rescue a field whose own obligation was refused.
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("does not consult the evaluator for a field with no explicit rule", () => {
    const spy = recordingEvaluator("satisfied");
    computeClassifiedFieldRedaction(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: spy.fn },
    );
    expect(spy.calls).toEqual([]);
  });
});

describe("validateClassifiedWriteMask — abac obligations", () => {
  it("rejects an abac-qualified field with no evaluator", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.abac?.outcome).toBe("undischargeable");
  });

  it("accepts it when the evaluator answers satisfied", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
      { entity: "Patient", evaluator: () => "satisfied" },
    );
    expect(r).toEqual({ ok: true });
  });

  it("rejects it when the evaluator answers denied, naming the policy", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: () => "denied" },
    );
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "denied" },
    });
  });
});

describe("the classified read/write pair cannot diverge on an obligation (ADR-0329's property)", () => {
  const FIELD = { name: "mrn", classification: "phi" as const };

  it("refuses both read and write for one grant carrying abac and no evaluator", () => {
    const read = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
    );
    const write = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
    );
    // The field is neither readable nor writable: an obligation nobody can discharge must not leave
    // the write half open, which is the asymmetry that made `privilegedForClass`' own property
    // unenforceable.
    expect(read.redacted).toEqual(["mrn"]);
    expect(read.readable).toEqual([]);
    expect(write.ok).toBe(false);
  });

  it("agrees on every outcome of the enum", () => {
    for (const outcome of ABAC_OUTCOMES) {
      const enforcement = { entity: "Patient", evaluator: () => outcome };
      const read = computeClassifiedFieldRedaction(
        principal("clinician"),
        CLASSIFIED_ABAC_PERMS,
        CLINICAL_ROLES,
        [FIELD],
        {},
        enforcement,
      );
      const write = validateClassifiedWriteMask(
        principal("clinician"),
        CLASSIFIED_ABAC_PERMS,
        CLINICAL_ROLES,
        [FIELD],
        {},
        enforcement,
      );
      expect(read.readable.includes("mrn")).toBe(ABAC_OUTCOME_ALLOWS[outcome]);
      expect(write.ok).toBe(ABAC_OUTCOME_ALLOWS[outcome]);
    }
  });
});

describe("the four field functions — unresolved abac attributes", () => {
  function unresolved(role: string): Principal {
    return { ...principal(role), abacAttributes: null };
  }

  const FIELD = { name: "mrn", classification: "phi" as const };

  it("computeFieldRedaction redacts an obligated field even with an evaluator", () => {
    const spy = recordingEvaluator("satisfied");
    const r = computeFieldRedaction(unresolved("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(r.redacted).toEqual(["mrn"]);
    expect(spy.calls).toEqual([]);
  });

  it("validateWriteMask rejects an obligated field even with an evaluator", () => {
    const spy = recordingEvaluator("satisfied");
    const r = validateWriteMask(unresolved("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "undischargeable" },
    });
    expect(spy.calls).toEqual([]);
  });

  it("computeClassifiedFieldRedaction redacts an obligated field even with an evaluator", () => {
    const spy = recordingEvaluator("satisfied");
    const r = computeClassifiedFieldRedaction(
      unresolved("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: spy.fn },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(spy.calls).toEqual([]);
  });

  it("validateClassifiedWriteMask rejects an obligated field even with an evaluator", () => {
    const spy = recordingEvaluator("satisfied");
    const r = validateClassifiedWriteMask(
      unresolved("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: spy.fn },
    );
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "undischargeable" },
    });
    expect(spy.calls).toEqual([]);
  });

  it("keeps the read/write pair in agreement, which is the property the four share", () => {
    const enforcement = { entity: "Patient", evaluator: () => "satisfied" as const };
    const read = computeClassifiedFieldRedaction(
      unresolved("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      enforcement,
    );
    const write = validateClassifiedWriteMask(
      unresolved("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      enforcement,
    );
    expect(read.readable).toEqual([]);
    expect(write.ok).toBe(false);
  });

  it("leaves an unobligated field grant untouched on all four", () => {
    // The regression that matters most: these fixtures carry no `abac`, so an unwired directory must
    // change nothing about them — the rule is about obligations and not about every field grant.
    const p = unresolved("pharmacist");
    expect(computeFieldRedaction(p, PERMS, ROLES, ["narcotic_schedule"]).readable).toEqual([
      "narcotic_schedule",
    ]);
    expect(validateWriteMask(p, PERMS, ROLES, ["narcotic_schedule"])).toEqual({ ok: true });
    expect(
      computeClassifiedFieldRedaction(p, PERMS, ROLES, [{ name: "narcotic_schedule" }]).readable,
    ).toEqual(["narcotic_schedule"]);
    expect(
      validateClassifiedWriteMask(p, PERMS, ROLES, [{ name: "narcotic_schedule" }]),
    ).toEqual({ ok: true });
  });

  it("leaves the classification default untouched, since no evaluator is involved in it", () => {
    // A privileged class grant is answered from roles alone, so an unresolved directory neither
    // rescues nor refuses it.
    const granted = computeClassifiedFieldRedaction(
      unresolved("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
    );
    const withheld = computeClassifiedFieldRedaction(
      unresolved("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
    );
    expect(granted.readable).toEqual(["mrn"]);
    expect(withheld.redacted).toEqual(["mrn"]);
  });

  it("still refuses on roles first, so no discharge is attached to a roles-only rejection", () => {
    const r = validateWriteMask(unresolved("technician"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "satisfied",
    });
    expect(r).toEqual({ ok: false, rejectedField: "mrn" });
  });
});

describe("the four field functions — the record a policy needs", () => {
  const RECORD: Readonly<Record<string, unknown>> = { id: "p-1", department: "oncology" };
  const FIELD = { name: "mrn", classification: "phi" as const };

  /** Deferred without a record, satisfied with one — the shape of an "owns this row" policy. */
  const recordBearing: AbacEvaluator = (input) =>
    input.record === undefined ? "deferred" : "satisfied";

  it("computeFieldRedaction redacts on deferred", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: recordBearing,
    });
    // This is the *first* pass of a per-record redaction — asked with no record, to learn whether
    // any field's policy wants one. The field is redacted now, and `deferred` is what says the
    // answer could change; `field_read` is an `always` position because of that second pass.
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.readable).toEqual([]);
    expect(r.deferred).toEqual(["mrn"]);
  });

  it("computeFieldRedaction reads the field once the record is supplied", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: recordBearing,
      record: RECORD,
    });
    expect(r.readable).toEqual(["mrn"]);
  });

  it("validateWriteMask refuses on deferred, naming the outcome", () => {
    const r = validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: recordBearing,
    });
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "deferred" },
    });
  });

  it("validateWriteMask accepts the write once the record is supplied", () => {
    const r = validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: recordBearing,
      record: RECORD,
    });
    expect(r).toEqual({ ok: true });
  });

  it("computeClassifiedFieldRedaction redacts on deferred", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: recordBearing },
    );
    expect(r.redacted).toEqual(["mrn"]);
  });

  it("computeClassifiedFieldRedaction reads it once the record is supplied", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      { entity: "Patient", evaluator: recordBearing, record: RECORD },
    );
    expect(r.readable).toEqual(["mrn"]);
  });

  it("validateClassifiedWriteMask refuses on deferred, naming the outcome", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: recordBearing },
    );
    expect(r).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "deferred" },
    });
  });

  it("validateClassifiedWriteMask accepts once the record is supplied", () => {
    const r = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      { entity: "Patient", evaluator: recordBearing, record: RECORD },
    );
    expect(r).toEqual({ ok: true });
  });

  it("passes the record through verbatim on the read side", () => {
    const spy = recordingEvaluator("satisfied");
    computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
      record: RECORD,
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.record).toBe(RECORD);
  });

  it("passes the record through verbatim on the write side", () => {
    const spy = recordingEvaluator("satisfied");
    validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
      record: RECORD,
    });
    expect(spy.calls[0]?.record).toBe(RECORD);
    expect(spy.calls[0]?.operation).toBe("update");
  });

  it("omits the record key entirely when the enforcement carried none", () => {
    const spy = recordingEvaluator("satisfied");
    computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    const input = spy.calls[0] as AbacEvaluationInput;
    expect("record" in input).toBe(false);
  });

  it("carries an empty record through as a record on all four", () => {
    for (const run of [
      (e: Parameters<typeof computeFieldRedaction>[4]): void => {
        computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], e);
      },
      (e: Parameters<typeof computeFieldRedaction>[4]): void => {
        validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], e);
      },
      (e: Parameters<typeof computeFieldRedaction>[4]): void => {
        computeClassifiedFieldRedaction(
          principal("clinician"),
          CLASSIFIED_ABAC_PERMS,
          CLINICAL_ROLES,
          [FIELD],
          {},
          e,
        );
      },
      (e: Parameters<typeof computeFieldRedaction>[4]): void => {
        validateClassifiedWriteMask(
          principal("clinician"),
          CLASSIFIED_ABAC_PERMS,
          CLINICAL_ROLES,
          [FIELD],
          {},
          e,
        );
      },
    ]) {
      const spy = recordingEvaluator("satisfied");
      run({ entity: "Patient", evaluator: spy.fn, record: {} });
      const input = spy.calls[0] as AbacEvaluationInput;
      expect("record" in input).toBe(true);
      expect(input.record).toEqual({});
    }
  });

  it("still refuses undischargeable when the abac parameter is omitted entirely", () => {
    // Pinned against the no-evaluator result: omitting the parameter is a caller with no evaluator,
    // and a record-bearing policy never gets to answer `deferred` because no evaluator is reached.
    expect(computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"])).toEqual(
      computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
        entity: "Prescription",
      }),
    );
    expect(validateWriteMask(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"])).toEqual({
      ok: false,
      rejectedField: "mrn",
      abac: { policyKey: "field.mrn.update", outcome: "undischargeable" },
    });
    expect(
      validateClassifiedWriteMask(
        principal("clinician"),
        CLASSIFIED_ABAC_PERMS,
        CLINICAL_ROLES,
        [FIELD],
        {},
      ),
    ).toEqual(
      validateClassifiedWriteMask(
        principal("clinician"),
        CLASSIFIED_ABAC_PERMS,
        CLINICAL_ROLES,
        [FIELD],
        {},
        { entity: "Patient" },
      ),
    );
  });

  it("refuses an unresolved-attribute principal before the record can matter", () => {
    const spy = recordingEvaluator("satisfied");
    const r = validateWriteMask(
      { ...principal("pharmacist"), abacAttributes: null },
      ABAC_PERMS,
      ROLES,
      ["mrn"],
      { entity: "Prescription", evaluator: spy.fn, record: RECORD },
    );
    expect(r.abac?.outcome).toBe("undischargeable");
    expect(spy.calls).toEqual([]);
  });

  it("keeps the read/write pair in agreement on deferred, which is the shared property", () => {
    // ADR-0329's property under the new outcome: the read and write halves go through one
    // `ABAC_OUTCOME_ALLOWS`, so a `deferred` cannot refuse one side and admit the other.
    const enforcement = { entity: "Patient", evaluator: recordBearing };
    const read = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      enforcement,
    );
    const write = validateClassifiedWriteMask(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [FIELD],
      {},
      enforcement,
    );
    expect(read.readable).toEqual([]);
    expect(write.ok).toBe(false);
  });

  it("leaves an unobligated field grant untouched when a record is supplied", () => {
    // A record is an input to a policy, never a trigger for one.
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["plain"], {
      entity: "Prescription",
      evaluator: () => "deferred",
      record: RECORD,
    });
    expect(r.readable).toEqual(["plain"]);
  });
});

/**
 * `FieldRedactionResult.deferred` — the signal that makes per-record redaction possible without
 * costing anything when no record-bearing field policy is declared.
 *
 * The gateway's two-pass needs one fact the read path could not express: *which* fields are
 * redacted only because their obligation wanted a record. Before this, a field refused on roles, a
 * field `denied` by policy and a field waiting on a record all landed in `redacted`
 * indistinguishably — so the only safe reading of a non-empty `redacted` was "locate every record
 * and ask again", which every deployment would have paid for and almost none would have needed.
 */
describe("FieldRedactionResult.deferred", () => {
  const RECORD: Readonly<Record<string, unknown>> = { id: "p-1", owner_id: "u" };

  /** Deferred without a record, satisfied with one — the shape of an "owns this row" policy. */
  const mixedByRecord: AbacEvaluator = (input) =>
    input.record === undefined ? "deferred" : "satisfied";

  /** Keyed on the policy key, so one evaluator produces every outcome in one pass. */
  const mixed: AbacEvaluator = (input) => {
    if (input.policyKey === "defers") return input.record === undefined ? "deferred" : "satisfied";
    if (input.policyKey === "denies") return "denied";
    return "undischargeable";
  };

  const MIXED_PERMS: EntityPermissions = {
    fields: {
      // Roles admit, obligation wants a record: the one field a record could rescue.
      waiting: { read: { roles: ["clinician"], abac: "defers" } },
      // Roles admit, policy said no: a statement about this principal that a record cannot revisit.
      refused: { read: { roles: ["clinician"], abac: "denies" } },
      // Roles admit, nothing could answer.
      unanswerable: { read: { roles: ["clinician"], abac: "unknown" } },
      // Roles refuse, and it carries an obligation anyway — the evaluator must not be reached.
      forbidden: { read: { roles: ["registrar"], abac: "defers" } },
      // Roles admit, no obligation.
      plain: { read: { roles: ["clinician"] } },
    },
  };

  const MIXED_NAMES = ["waiting", "refused", "unanswerable", "forbidden", "plain", "open"];

  const MIXED_CLASSIFIED: readonly ClassifiedField[] = MIXED_NAMES.map((name) => ({ name }));

  it("is empty when no field carries an obligation", () => {
    const r = computeFieldRedaction(
      principal("technician"),
      PERMS,
      ROLES,
      ["internal_notes", "narcotic_schedule"],
    );
    // `narcotic_schedule` is redacted on roles, so there is something in `redacted` and still
    // nothing to re-ask about: an empty `deferred` beside a non-empty `redacted` is the common case
    // and is exactly what lets the caller stop after one pass.
    expect(r.redacted).toEqual(["narcotic_schedule"]);
    expect(r.deferred).toEqual([]);
  });

  it("is empty for a field list with no rules at all", () => {
    expect(computeFieldRedaction(principal("technician"), PERMS, ROLES, ["a"]).deferred).toEqual(
      [],
    );
    expect(
      computeClassifiedFieldRedaction(principal("front_desk"), NO_FIELD_PERMS, CLINICAL_ROLES, [
        { name: "status" },
      ]).deferred,
    ).toEqual([]);
  });

  it("names a deferred field in both redacted and deferred — computeFieldRedaction", () => {
    const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "deferred",
    });
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual(["mrn"]);
    expect(r.readable).toEqual([]);
  });

  it("names a deferred field in both redacted and deferred — computeClassifiedFieldRedaction", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
      { entity: "Patient", evaluator: () => "deferred" },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual(["mrn"]);
  });

  it("empties on the second pass once the record is supplied, on both functions", () => {
    // The whole point of the signal: the caller re-asks with the record and the field comes back.
    const read = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: mixedByRecord,
      record: RECORD,
    });
    expect(read.readable).toEqual(["mrn"]);
    expect(read.deferred).toEqual([]);

    const classified = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
      { entity: "Patient", evaluator: mixedByRecord, record: RECORD },
    );
    expect(classified.readable).toEqual(["mrn"]);
    expect(classified.deferred).toEqual([]);
  });

  it("excludes a denied field, because a record cannot change a statement about the principal", () => {
    for (const r of [
      computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
        entity: "Prescription",
        evaluator: () => "denied",
      }),
      computeClassifiedFieldRedaction(
        principal("clinician"),
        CLASSIFIED_ABAC_PERMS,
        CLINICAL_ROLES,
        [{ name: "mrn", classification: "phi" }],
        {},
        { entity: "Patient", evaluator: () => "denied" },
      ),
    ]) {
      expect(r.redacted).toEqual(["mrn"]);
      expect(r.deferred).toEqual([]);
    }
  });

  it("excludes an undischargeable field, however the deployment arrived at it", () => {
    // Three routes to one outcome — an evaluator that says so, no evaluator, and no `abac`
    // parameter at all — and none of them is a question a record could answer.
    const byAnswer = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: () => "undischargeable",
    });
    const noEvaluator = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
    });
    const noParameter = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"]);
    for (const r of [byAnswer, noEvaluator, noParameter]) {
      expect(r.redacted).toEqual(["mrn"]);
      expect(r.deferred).toEqual([]);
    }
  });

  it("excludes a field whose evaluator threw", () => {
    const r = computeClassifiedFieldRedaction(
      principal("clinician"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      {},
      {
        entity: "Patient",
        evaluator: () => {
          throw new Error("policy layer down");
        },
      },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual([]);
  });

  it("excludes a field refused on roles, and never reaches the evaluator for it", () => {
    // The ordering ADR-0340 fixed, read through the new field: a roles refusal is not an obligation,
    // so it must neither be re-asked nor shown to the deployment's policy layer.
    const spy = recordingEvaluator("deferred");
    const r = computeFieldRedaction(principal("technician"), ABAC_PERMS, ROLES, ["mrn"], {
      entity: "Prescription",
      evaluator: spy.fn,
    });
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("excludes a roles-refused field on the classified function too, with no evaluation", () => {
    const spy = recordingEvaluator("deferred");
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      CLASSIFIED_ABAC_PERMS,
      CLINICAL_ROLES,
      [{ name: "mrn", classification: "phi" }],
      // Privileged for the class and still refused: an explicit rule is the answer for its field,
      // and the obligation behind it is not consulted once the roles say no.
      { privilegedRoles: ["front_desk"] },
      { entity: "Patient", evaluator: spy.fn },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("excludes a classification-default redaction, which carries no obligation", () => {
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
    );
    expect(r.redacted).toEqual(["mrn", "given_name"]);
    expect(r.deferred).toEqual([]);
  });

  it("excludes a classification default even when an evaluator would defer", () => {
    // The default branch never calls an evaluator, so a record-bearing policy declared elsewhere
    // cannot make a class-withheld field look re-askable.
    const r = computeClassifiedFieldRedaction(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: () => "deferred" },
    );
    expect(r.deferred).toEqual([]);
  });

  it("excludes an unresolved-attribute principal's obligated field", () => {
    // `null` attributes resolve `undischargeable` before any evaluator runs, so the remedy is an
    // attribute directory and not a record — re-asking with one would change nothing.
    const r = computeFieldRedaction(
      { ...principal("pharmacist"), abacAttributes: null },
      ABAC_PERMS,
      ROLES,
      ["mrn"],
      { entity: "Prescription", evaluator: () => "deferred", record: RECORD },
    );
    expect(r.redacted).toEqual(["mrn"]);
    expect(r.deferred).toEqual([]);
  });

  it("holds deferred ⊆ redacted over a mixed fixture, on both functions", () => {
    const enforcement = { entity: "Patient", evaluator: mixed };
    const flat = computeFieldRedaction(
      principal("clinician"),
      MIXED_PERMS,
      CLINICAL_ROLES,
      MIXED_NAMES,
      enforcement,
    );
    const classified = computeClassifiedFieldRedaction(
      principal("clinician"),
      MIXED_PERMS,
      CLINICAL_ROLES,
      MIXED_CLASSIFIED,
      {},
      enforcement,
    );

    for (const r of [flat, classified]) {
      // The subset relation pinned rather than implied: a caller reads `deferred` to decide whether
      // to re-ask, and a name in it that is not redacted would mean re-asking about a field already
      // being served.
      for (const name of r.deferred) expect(r.redacted).toContain(name);
      expect(r.deferred).toEqual(["waiting"]);
      expect(r.redacted).toEqual(["waiting", "refused", "unanswerable", "forbidden"]);
      expect(r.readable).toEqual(["plain", "open"]);
      // Totality: every field lands in exactly one of the two outcome lists.
      expect([...r.readable, ...r.redacted].sort()).toEqual([...MIXED_NAMES].sort());
    }
  });

  it("agrees with ABAC_OUTCOMES: exactly one outcome contributes to deferred", () => {
    const contributing = ABAC_OUTCOMES.filter((outcome) => {
      const r = computeFieldRedaction(principal("pharmacist"), ABAC_PERMS, ROLES, ["mrn"], {
        entity: "Prescription",
        evaluator: () => outcome,
      });
      return r.deferred.includes("mrn");
    });
    expect(contributing).toEqual(["deferred"]);
  });

  it("is reported in field order, so a caller can zip it against the field list", () => {
    const r = computeFieldRedaction(
      principal("clinician"),
      {
        fields: {
          a: { read: { roles: ["clinician"], abac: "defers" } },
          b: { read: { roles: ["clinician"], abac: "defers" } },
        },
      },
      CLINICAL_ROLES,
      ["b", "a"],
      { entity: "Patient", evaluator: mixed },
    );
    expect(r.deferred).toEqual(["b", "a"]);
  });
});

/**
 * The plural read path.
 *
 * Since ADR-0343 the gateway computes a field set per record, so a page of N records with F
 * obligated fields called a deployment-supplied evaluator N×F times with no way to hand it the whole
 * set. This entry point exists to pool them — and the property that makes the refactor behind it
 * safe is that N records answer exactly as N separate singular calls.
 */
describe("computeClassifiedFieldRedactionForRecords", () => {
  const RECORDS: readonly Readonly<Record<string, unknown>>[] = [
    { id: "p-1", department: "oncology" },
    { id: "p-2", department: "cardiology" },
    { id: "p-3", department: "oncology" },
  ];

  /** Two obligated read fields plus one with no obligation, so F is visibly 2 and not 3. */
  const TWO_OBLIGATED: EntityPermissions = {
    fields: {
      mrn: { read: { roles: ["clinician"], abac: "owns" } },
      dob: { read: { roles: ["clinician"], abac: "owns" } },
      status: { read: { roles: ["clinician"] } },
    },
  };

  const THREE_FIELDS: readonly ClassifiedField[] = [
    { name: "mrn", classification: "phi" },
    { name: "dob", classification: "phi" },
    { name: "status" },
  ];

  /** Counts batch calls and the pooled question count, which is the whole claim of this arm. */
  function spyBatch(outcome: (input: AbacEvaluationInput) => AbacOutcome): {
    readonly batch: AbacBatchEvaluator;
    readonly calls: AbacEvaluationInput[][];
  } {
    const calls: AbacEvaluationInput[][] = [];
    return {
      batch: (inputs) => {
        calls.push([...inputs]);
        return inputs.map((input, index) => ({ index, outcome: outcome(input) }));
      },
      calls,
    };
  }

  /** "Only a record in your own department", the shape a record-bearing policy actually takes. */
  const ownDepartment = (input: AbacEvaluationInput): AbacOutcome => {
    if (input.record === undefined) return "deferred";
    return input.record.department === "oncology" ? "satisfied" : "denied";
  };

  it("returns an empty array for no records, waking neither evaluator", () => {
    const single = recordingEvaluator("satisfied");
    const batch = spyBatch(() => "satisfied");
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      { entity: "Patient", evaluator: single.fn, evaluateBatch: batch.batch },
      [],
    );
    expect(out).toEqual([]);
    expect(batch.calls).toHaveLength(0);
    expect(single.calls).toHaveLength(0);
  });

  it("answers N records exactly as N separate singular calls", () => {
    // The property that makes the plan/discharge/assemble refactor safe: whatever the plural path
    // does to pool questions, each element must be the answer the singular function already gave.
    const policy = { privilegedRoles: ["clinician"] };
    const plural = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      policy,
      { entity: "Patient", evaluator: ownDepartment },
      RECORDS,
    );
    const singular = RECORDS.map((record) =>
      computeClassifiedFieldRedaction(
        principal("clinician"),
        TWO_OBLIGATED,
        CLINICAL_ROLES,
        THREE_FIELDS,
        policy,
        { entity: "Patient", evaluator: ownDepartment, record },
      ),
    );
    expect(plural).toEqual(singular);
    expect(plural.map((r) => r.readable)).toEqual([
      ["mrn", "dob", "status"],
      ["status"],
      ["mrn", "dob", "status"],
    ]);
  });

  it("agrees with the singular path elementwise on the classification default too", () => {
    const policy = { privilegedRolesByClass: { phi: [] } };
    const plural = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      policy,
      undefined,
      RECORDS,
    );
    for (const result of plural) {
      expect(result).toEqual(
        computeClassifiedFieldRedaction(
          principal("clinician"),
          NO_FIELD_PERMS,
          CLINICAL_ROLES,
          CLINICAL_FIELDS,
          policy,
        ),
      );
    }
  });

  it("asks the batch exactly once for N records x F obligated fields", () => {
    const batch = spyBatch(ownDepartment);
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      { entity: "Patient", evaluator: ownDepartment, evaluateBatch: batch.batch },
      RECORDS,
    );
    expect(batch.calls).toHaveLength(1);
    // 3 records x 2 obligated fields; `status` carries no obligation and contributes nothing.
    expect(batch.calls[0]).toHaveLength(6);
    expect(batch.calls[0]?.map((i) => i.field)).toEqual(["mrn", "dob", "mrn", "dob", "mrn", "dob"]);
    expect(batch.calls[0]?.map((i) => i.record?.id)).toEqual([
      "p-1",
      "p-1",
      "p-2",
      "p-2",
      "p-3",
      "p-3",
    ]);
    expect(out.map((r) => r.readable.length)).toEqual([3, 1, 3]);
  });

  it("costs one evaluator call per obligation when no batch arm is supplied", () => {
    // The fallback is exactly today's cost, which is what makes the batch arm optional.
    const single = recordingEvaluator("satisfied");
    computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      { entity: "Patient", evaluator: single.fn },
      RECORDS,
    );
    expect(single.calls).toHaveLength(6);
  });

  it("answers satisfied for one record and deferred for another in one call", () => {
    const batch = spyBatch(ownDepartment);
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      { entity: "Patient", evaluator: ownDepartment, evaluateBatch: batch.batch },
      // A `null` element means this call site had no record here — identical to an absent
      // `AbacEnforcement.record`, so the policy answers `deferred` for it and says so per field.
      [RECORDS[0] ?? null, null],
    );
    expect(batch.calls).toHaveLength(1);
    expect(out[0]?.readable).toEqual(["mrn", "dob", "status"]);
    expect(out[0]?.deferred).toEqual([]);
    expect(out[1]?.readable).toEqual(["status"]);
    expect(out[1]?.redacted).toEqual(["mrn", "dob"]);
    expect(out[1]?.deferred).toEqual(["mrn", "dob"]);
  });

  it("reports readable, redacted and deferred in field-list order", () => {
    const ordered: readonly ClassifiedField[] = [
      { name: "status" },
      { name: "dob", classification: "phi" },
      { name: "mrn", classification: "phi" },
    ];
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      ordered,
      undefined,
      { entity: "Patient", evaluator: () => "deferred" },
      [null],
    );
    expect(out[0]?.readable).toEqual(["status"]);
    expect(out[0]?.redacted).toEqual(["dob", "mrn"]);
    expect(out[0]?.deferred).toEqual(["dob", "mrn"]);
  });

  it("keeps deferred a subsequence of redacted, not merely a subset", () => {
    const perms: EntityPermissions = {
      fields: {
        waiting_a: { read: { roles: ["clinician"], abac: "defers" } },
        refused: { read: { roles: ["registrar"], abac: "defers" } },
        waiting_b: { read: { roles: ["clinician"], abac: "defers" } },
        unanswerable: { read: { roles: ["clinician"], abac: "nope" } },
      },
    };
    const evaluator: AbacEvaluator = (input) =>
      input.policyKey === "defers" ? "deferred" : "undischargeable";
    const names = ["waiting_a", "refused", "waiting_b", "unanswerable", "plain"];
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      perms,
      CLINICAL_ROLES,
      names.map((name) => ({ name })),
      undefined,
      { entity: "Patient", evaluator },
      [null, null],
    );
    for (const result of out) {
      expect(result.redacted).toEqual(["waiting_a", "refused", "waiting_b", "unanswerable"]);
      expect(result.deferred).toEqual(["waiting_a", "waiting_b"]);
      // Subsequence: the deferred names appear in `redacted` in the same relative order, which is
      // what lets a caller zip either against its own field list.
      expect(result.redacted.filter((n) => result.deferred.includes(n))).toEqual([
        ...result.deferred,
      ]);
    }
  });

  it("never defers a field refused on roles, and never evaluates one", () => {
    const perms: EntityPermissions = {
      fields: {
        forbidden: { read: { roles: ["registrar"], abac: "defers" } },
        allowed: { read: { roles: ["clinician"], abac: "defers" } },
      },
    };
    const batch = spyBatch(() => "deferred");
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      perms,
      CLINICAL_ROLES,
      [{ name: "forbidden" }, { name: "allowed" }],
      undefined,
      { entity: "Patient", evaluator: () => "deferred", evaluateBatch: batch.batch },
      [null, null],
    );
    // Two records x one *role-admitted* obligated field: the roles refusal returns before an
    // obligation is recorded, so it never reaches the deployment's policy layer (ADR-0340).
    expect(batch.calls[0]).toHaveLength(2);
    expect(batch.calls[0]?.map((i) => i.field)).toEqual(["allowed", "allowed"]);
    for (const result of out) {
      expect(result.redacted).toEqual(["forbidden", "allowed"]);
      expect(result.deferred).toEqual(["allowed"]);
    }
  });

  it("never defers a classification default, which carries no obligation", () => {
    const out = computeClassifiedFieldRedactionForRecords(
      principal("front_desk"),
      NO_FIELD_PERMS,
      CLINICAL_ROLES,
      CLINICAL_FIELDS,
      { privilegedRoles: ["clinician"] },
      { entity: "Patient", evaluator: () => "deferred" },
      RECORDS,
    );
    for (const result of out) {
      expect(result.redacted).toEqual(["mrn", "given_name"]);
      expect(result.deferred).toEqual([]);
    }
  });

  it("redacts every obligated field and defers none when no abac parameter is supplied", () => {
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      undefined,
      RECORDS,
    );
    for (const result of out) {
      // No entity to name, so no evaluation input can be built: `undischargeable`, which a record
      // could not change, so nothing is deferred.
      expect(result.readable).toEqual(["status"]);
      expect(result.redacted).toEqual(["mrn", "dob"]);
      expect(result.deferred).toEqual([]);
    }
  });

  it("refuses every obligation when the batch misaligns its answers", () => {
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      {
        entity: "Patient",
        evaluator: () => "satisfied",
        evaluateBatch: (inputs) =>
          // Correct outcomes, reversed indices: exactly the mis-assembled batch the echoed index
          // exists to catch, and the whole page is refused rather than half-trusted.
          inputs.map((_input, index) => ({ index: inputs.length - 1 - index, outcome: "satisfied" })),
      },
      RECORDS,
    );
    for (const result of out) {
      expect(result.readable).toEqual(["status"]);
      expect(result.redacted).toEqual(["mrn", "dob"]);
      expect(result.deferred).toEqual([]);
    }
  });

  it("refuses the obligated fields of every record when a principal's attributes are unresolved", () => {
    const batch = spyBatch(() => "satisfied");
    const unresolved: Principal = { ...principal("clinician"), abacAttributes: null };
    const out = computeClassifiedFieldRedactionForRecords(
      unresolved,
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      { entity: "Patient", evaluator: () => "satisfied", evaluateBatch: batch.batch },
      RECORDS,
    );
    // Every question is excluded before the evaluator, so nothing is asked at all (ADR-0341).
    expect(batch.calls).toHaveLength(0);
    for (const result of out) {
      expect(result.readable).toEqual(["status"]);
      expect(result.deferred).toEqual([]);
    }
  });

  it("resolves the roles map once for the whole call", () => {
    // A manager inherits pharmacist; reading the inherited grant for every record proves the shared
    // resolution is the same set a per-record one would have produced.
    const out = computeClassifiedFieldRedactionForRecords(
      principal("manager"),
      PERMS,
      ROLES,
      [{ name: "narcotic_schedule" }, { name: "internal_notes" }],
      undefined,
      undefined,
      [null, null, null],
    );
    expect(out).toHaveLength(3);
    for (const result of out) {
      expect(result.readable).toEqual(["narcotic_schedule", "internal_notes"]);
    }
  });

  it("aligns its results to the records, element by element", () => {
    const out = computeClassifiedFieldRedactionForRecords(
      principal("clinician"),
      TWO_OBLIGATED,
      CLINICAL_ROLES,
      THREE_FIELDS,
      undefined,
      {
        entity: "Patient",
        evaluator: (input) => (input.record?.id === "p-2" ? "satisfied" : "denied"),
      },
      RECORDS,
    );
    expect(out.map((r) => r.readable)).toEqual([
      ["status"],
      ["mrn", "dob", "status"],
      ["status"],
    ]);
  });
});
