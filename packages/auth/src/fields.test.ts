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
