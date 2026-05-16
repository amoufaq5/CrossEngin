import { describe, expect, it } from "vitest";
import {
  EntityPermissionsSchema,
  FieldPermissionSchema,
  PermissionMapSchema,
  RbacGrantSchema,
  RoleDefinitionSchema,
  RoleNameSchema,
} from "./types.js";

describe("RoleNameSchema", () => {
  it("accepts a non-empty string", () => {
    expect(() => RoleNameSchema.parse("admin")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => RoleNameSchema.parse("")).toThrow();
  });
});

describe("RoleDefinitionSchema", () => {
  it("accepts a minimal role definition", () => {
    expect(() =>
      RoleDefinitionSchema.parse({
        name: "admin",
      }),
    ).not.toThrow();
  });

  it("accepts a full role with inherits + abac + auditor flag", () => {
    expect(() =>
      RoleDefinitionSchema.parse({
        name: "compliance_officer",
        label: { en: "Compliance Officer", fr: "Responsable Conformité" },
        description: "Reviews audit logs and attestations",
        inherits: ["reader"],
        isAuditor: true,
        abacAttributes: { department: "compliance" },
      }),
    ).not.toThrow();
  });

  it("rejects missing required name", () => {
    expect(() =>
      RoleDefinitionSchema.parse({
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects non-string inherits entries", () => {
    expect(() =>
      RoleDefinitionSchema.parse({
        name: "x",
        inherits: ["valid", ""],
      }),
    ).toThrow();
  });
});

describe("RbacGrantSchema", () => {
  it("accepts a role-only grant", () => {
    expect(() =>
      RbacGrantSchema.parse({
        roles: ["admin"],
      }),
    ).not.toThrow();
  });

  it("accepts a role + abac grant", () => {
    expect(() =>
      RbacGrantSchema.parse({
        roles: ["doctor"],
        abac: "user.department == record.department",
      }),
    ).not.toThrow();
  });

  it("rejects missing roles", () => {
    expect(() =>
      RbacGrantSchema.parse({
        abac: "x",
      }),
    ).toThrow();
  });
});

describe("FieldPermissionSchema", () => {
  it("accepts read-only field permission", () => {
    expect(() =>
      FieldPermissionSchema.parse({
        read: { roles: ["analyst"] },
      }),
    ).not.toThrow();
  });

  it("accepts read + update separately gated", () => {
    expect(() =>
      FieldPermissionSchema.parse({
        read: { roles: ["analyst", "doctor"] },
        update: { roles: ["doctor"] },
      }),
    ).not.toThrow();
  });

  it("accepts empty permission (default deny)", () => {
    expect(() => FieldPermissionSchema.parse({})).not.toThrow();
  });
});

describe("EntityPermissionsSchema", () => {
  it("accepts a permissions block with CRUD + transitions + fields", () => {
    expect(() =>
      EntityPermissionsSchema.parse({
        list: { roles: ["reader"] },
        read: { roles: ["reader"] },
        create: { roles: ["editor"] },
        update: { roles: ["editor"] },
        delete: { roles: ["admin"] },
        transitions: {
          submit: { roles: ["editor"] },
          approve: { roles: ["admin"] },
        },
        fields: {
          ssn: {
            read: { roles: ["compliance_officer"] },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts an empty entity permissions block", () => {
    expect(() => EntityPermissionsSchema.parse({})).not.toThrow();
  });
});

describe("PermissionMapSchema", () => {
  it("accepts a multi-entity permission map", () => {
    expect(() =>
      PermissionMapSchema.parse({
        patient: { read: { roles: ["doctor"] } },
        prescription: { create: { roles: ["doctor"] } },
      }),
    ).not.toThrow();
  });

  it("accepts an empty map", () => {
    expect(() => PermissionMapSchema.parse({})).not.toThrow();
  });

  it("rejects non-object value at the entity level", () => {
    expect(() =>
      PermissionMapSchema.parse({
        patient: "invalid",
      }),
    ).toThrow();
  });
});
