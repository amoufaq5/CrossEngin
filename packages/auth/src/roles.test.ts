import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import { resolveEffectiveRoles } from "./roles.js";
import type { Principal, RoleDefinition } from "./types.js";

function principal(primary: string, secondary: string[] = []): Principal {
  return {
    kind: "user",
    tenantId: "t" as TenantId,
    userId: "u" as UserId,
    primaryRole: primary,
    secondaryRoles: secondary,
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["staff", { name: "staff" }],
  ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
  ["technician", { name: "technician", inherits: ["staff"] }],
  ["manager", { name: "manager", inherits: ["pharmacist"] }],
  ["a", { name: "a", inherits: ["b"] }],
  ["b", { name: "b", inherits: ["a"] }],
]);

describe("resolveEffectiveRoles", () => {
  it("returns the primary role for a role without inheritance", () => {
    expect(resolveEffectiveRoles(principal("staff"), ROLES)).toEqual(new Set(["staff"]));
  });

  it("includes parent role via inheritance", () => {
    expect(resolveEffectiveRoles(principal("pharmacist"), ROLES)).toEqual(
      new Set(["pharmacist", "staff"]),
    );
  });

  it("resolves transitive inheritance (manager -> pharmacist -> staff)", () => {
    expect(resolveEffectiveRoles(principal("manager"), ROLES)).toEqual(
      new Set(["manager", "pharmacist", "staff"]),
    );
  });

  it("merges secondary roles + their parents into the effective set", () => {
    expect(resolveEffectiveRoles(principal("staff", ["technician"]), ROLES)).toEqual(
      new Set(["staff", "technician"]),
    );
  });

  it("throws UnknownRoleError on unknown primary role", () => {
    expect(() => resolveEffectiveRoles(principal("nonexistent"), ROLES)).toThrow(
      UnknownRoleError,
    );
  });

  it("throws UnknownRoleError on unknown secondary role", () => {
    expect(() => resolveEffectiveRoles(principal("staff", ["unknown"]), ROLES)).toThrow(
      UnknownRoleError,
    );
  });

  it("throws RoleInheritanceCycleError on a cycle", () => {
    expect(() => resolveEffectiveRoles(principal("a"), ROLES)).toThrow(
      RoleInheritanceCycleError,
    );
  });
});
