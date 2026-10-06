import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import {
  computeClassifiedFieldRedaction,
  computeFieldRedaction,
  validateClassifiedWriteMask,
  validateWriteMask,
  type ClassifiedField,
} from "./fields.js";
import { ABAC_OUTCOME_ALLOWS, type AbacEvaluationInput, type AbacEvaluator } from "./abac.js";
import type { AbacOutcome, EntityPermissions, Principal, RoleDefinition } from "./types.js";

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
    for (const outcome of (["satisfied", "denied", "undischargeable"] as const)) {
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
