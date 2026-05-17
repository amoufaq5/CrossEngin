import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import { rbacCheck } from "./rbac.js";
import type { PermissionMap, Principal, RoleDefinition } from "./types.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["staff", { name: "staff" }],
  ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
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

const PERMS: PermissionMap = {
  prescription: {
    read: { roles: ["pharmacist", "manager"] },
    create: { roles: ["pharmacist"] },
    update: { roles: ["pharmacist"], abac: "data.access.allow_update" },
    delete: { roles: [] },
    transitions: {
      verify: { roles: ["pharmacist"], abac: "data.access.signature_required_and_valid" },
      cancel: { roles: ["pharmacist", "manager"] },
    },
  },
};

describe("rbacCheck — entity-level operations", () => {
  it("allows pharmacist to read", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(true);
  });

  it("allows manager to read via inheritance", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(true);
  });

  it("denies staff (no inherited grant)", () => {
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/effective roles do not grant/);
  });

  it("denies delete when the grant list is empty", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "delete",
    });
    expect(r.allowed).toBe(false);
  });

  it("returns requiresAbac when the grant carries an abac path", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
    });
    expect(r.allowed).toBe(true);
    expect(r.requiresAbac).toBe("data.access.allow_update");
  });

  it("does not set requiresAbac when the grant has no abac path", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "create",
    });
    expect(r.allowed).toBe(true);
    expect(r.requiresAbac).toBeUndefined();
  });

  it("denies an operation that's not declared on the entity", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "list",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies operation on an entity not in the permission map", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "unknown",
      operation: "read",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no permissions declared/);
  });
});

describe("rbacCheck — transitions", () => {
  it("allows pharmacist to verify (with abac requirement)", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
    });
    expect(r.allowed).toBe(true);
    expect(r.requiresAbac).toBe("data.access.signature_required_and_valid");
  });

  it("allows manager to cancel via inheritance", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "cancel" },
    });
    expect(r.allowed).toBe(true);
  });

  it("denies an undeclared transition", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "nonexistent" },
    });
    expect(r.allowed).toBe(false);
  });

  it("denies a transition for a role not in the grant", () => {
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
    });
    expect(r.allowed).toBe(false);
  });
});
