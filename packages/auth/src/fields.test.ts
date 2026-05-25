import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import { computeFieldRedaction, validateWriteMask } from "./fields.js";
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
    const r = computeFieldRedaction(principal("technician"), PERMS, ROLES, [
      "internal_notes",
      "narcotic_schedule",
    ]);
    expect(r.readable).toEqual(["internal_notes"]);
    expect(r.redacted).toEqual(["narcotic_schedule"]);
  });

  it("respects inheritance (manager can read pharmacist-restricted fields)", () => {
    const r = computeFieldRedaction(principal("manager"), PERMS, ROLES, ["narcotic_schedule"]);
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
    const r = validateWriteMask(principal("technician"), PERMS, ROLES, ["narcotic_schedule"]);
    expect(r.ok).toBe(false);
    expect(r.rejectedField).toBe("narcotic_schedule");
  });

  it("rejects on the first forbidden field encountered", () => {
    const r = validateWriteMask(principal("technician"), PERMS, ROLES, [
      "internal_notes",
      "narcotic_schedule",
    ]);
    expect(r.ok).toBe(false);
    expect(r.rejectedField).toBe("internal_notes");
  });

  it("accepts when all touched fields are permitted", () => {
    const r = validateWriteMask(principal("pharmacist"), PERMS, ROLES, [
      "internal_notes",
      "narcotic_schedule",
    ]);
    expect(r.ok).toBe(true);
  });
});
