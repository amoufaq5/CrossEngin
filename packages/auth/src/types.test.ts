import { describe, expect, it } from "vitest";
import {
  EntityPermissionsSchema,
  FIELD_WRITE_OPERATIONS,
  fieldWriteGrant,
  fieldWriteGrantArm,
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

  it("accepts a role + abac policy key", () => {
    // The key is opaque and nothing here parses it, so this expression-shaped string is accepted as
    // a *key* rather than as an expression. It read as an expression before the meaning was
    // declared; `abac.test.ts` pins both readings parsing for the same reason.
    expect(() =>
      RbacGrantSchema.parse({
        roles: ["doctor"],
        abac: "patient.same_department",
      }),
    ).not.toThrow();
  });

  it("rejects an empty abac policy key", () => {
    // `"" !== undefined`, so an empty key was a live obligation naming nothing.
    expect(() => RbacGrantSchema.parse({ roles: ["doctor"], abac: "" })).toThrow();
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

describe("fieldWriteGrant / fieldWriteGrantArm", () => {
  const CREATE = { roles: ["registrar"] };
  const UPDATE = { roles: ["admin"] };

  it("takes the create arm on a create when one is declared", () => {
    const perm = FieldPermissionSchema.parse({ create: CREATE, update: UPDATE });
    expect(fieldWriteGrant(perm, "create")).toEqual(CREATE);
    expect(fieldWriteGrantArm(perm, "create")).toBe("create");
  });

  // The arm is what a refusal must name, and it is `update` here even though the write op is
  // `create`: an absent `create` inherits `update`, so the update grant genuinely is what decided
  // and widening it genuinely is the remedy. A rule derived from the write op would say "create"
  // and send an operator to add an arm they do not need.
  it("falls back to the update arm on a create, and names update as the arm that decided", () => {
    const perm = FieldPermissionSchema.parse({ update: UPDATE });
    expect(fieldWriteGrant(perm, "create")).toEqual(UPDATE);
    expect(fieldWriteGrantArm(perm, "create")).toBe("update");
  });

  it("never takes the create arm on an update, because create says who may SET not who may CHANGE", () => {
    const perm = FieldPermissionSchema.parse({ create: CREATE });
    expect(fieldWriteGrant(perm, "update")).toBeUndefined();
    expect(fieldWriteGrantArm(perm, "update")).toBeUndefined();
  });

  it("reads the update arm on an update even when a create arm sits beside it", () => {
    const perm = FieldPermissionSchema.parse({ create: CREATE, update: UPDATE });
    expect(fieldWriteGrant(perm, "update")).toEqual(UPDATE);
    expect(fieldWriteGrantArm(perm, "update")).toBe("update");
  });

  it("answers undefined for a perm with neither write arm, on both operations", () => {
    const perm = FieldPermissionSchema.parse({ read: { roles: ["auditor"] } });
    for (const op of FIELD_WRITE_OPERATIONS) {
      expect(fieldWriteGrant(perm, op)).toBeUndefined();
      expect(fieldWriteGrantArm(perm, op)).toBeUndefined();
    }
  });

  it("answers undefined for an absent perm, on both operations", () => {
    for (const op of FIELD_WRITE_OPERATIONS) {
      expect(fieldWriteGrant(undefined, op)).toBeUndefined();
      expect(fieldWriteGrantArm(undefined, op)).toBeUndefined();
    }
  });

  // The property that makes the arm reportable: the arm is named iff a grant was found, and the
  // named arm is the one holding that exact grant. Written over every shape so a third arm on
  // `FieldPermission` cannot satisfy it by accident.
  it("names an arm exactly when a grant was found, and that arm holds it", () => {
    const shapes = [
      {},
      { read: { roles: ["auditor"] } },
      { update: UPDATE },
      { create: CREATE },
      { create: CREATE, update: UPDATE },
      { read: { roles: ["auditor"] }, create: CREATE },
    ];
    for (const raw of shapes) {
      const perm = FieldPermissionSchema.parse(raw);
      for (const op of FIELD_WRITE_OPERATIONS) {
        const grant = fieldWriteGrant(perm, op);
        const arm = fieldWriteGrantArm(perm, op);
        expect(arm === undefined).toBe(grant === undefined);
        if (arm !== undefined) expect(perm[arm]).toEqual(grant);
      }
    }
  });
});
