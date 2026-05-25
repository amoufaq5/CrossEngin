import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import { resolveEffectiveRoles, validateRoleGraph } from "./roles.js";
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
    expect(() => resolveEffectiveRoles(principal("nonexistent"), ROLES)).toThrow(UnknownRoleError);
  });

  it("throws UnknownRoleError on unknown secondary role", () => {
    expect(() => resolveEffectiveRoles(principal("staff", ["unknown"]), ROLES)).toThrow(
      UnknownRoleError,
    );
  });

  it("throws RoleInheritanceCycleError on a cycle", () => {
    expect(() => resolveEffectiveRoles(principal("a"), ROLES)).toThrow(RoleInheritanceCycleError);
  });
});

describe("validateRoleGraph", () => {
  it("accepts a flat role graph (no inheritance)", () => {
    const r = new Map<string, RoleDefinition>([
      ["staff", { name: "staff" }],
      ["pharmacist", { name: "pharmacist" }],
    ]);
    expect(() => validateRoleGraph(r)).not.toThrow();
  });

  it("accepts a hierarchical role graph", () => {
    const r = new Map<string, RoleDefinition>([
      ["staff", { name: "staff" }],
      ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
      ["manager", { name: "manager", inherits: ["pharmacist"] }],
    ]);
    expect(() => validateRoleGraph(r)).not.toThrow();
  });

  it("throws on a 2-node cycle", () => {
    const r = new Map<string, RoleDefinition>([
      ["a", { name: "a", inherits: ["b"] }],
      ["b", { name: "b", inherits: ["a"] }],
    ]);
    expect(() => validateRoleGraph(r)).toThrow(RoleInheritanceCycleError);
  });

  it("throws on an unknown inherits reference", () => {
    const r = new Map<string, RoleDefinition>([
      ["pharmacist", { name: "pharmacist", inherits: ["mystery"] }],
    ]);
    expect(() => validateRoleGraph(r)).toThrow(UnknownRoleError);
  });
});
