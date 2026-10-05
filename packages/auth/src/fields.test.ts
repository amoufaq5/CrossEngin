import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import {
  computeClassifiedFieldRedaction,
  computeFieldRedaction,
  validateClassifiedWriteMask,
  validateWriteMask,
  type ClassifiedField,
} from "./fields.js";
import type { EntityPermissions, Principal, RoleDefinition } from "./types.js";

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
