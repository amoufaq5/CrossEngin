import { fieldWriteGrant, type EntityPermissions, type FieldPermission } from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { ERP_EDUCATION_ENTITIES } from "./entities.js";
import {
  ENROLLMENT_PERMISSIONS,
  ERP_EDUCATION_PERMISSIONS,
  STUDENT_PERMISSIONS,
} from "./permissions.js";
import { ERP_EDUCATION_ROLES } from "./roles.js";
import { ENROLLMENT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_EDUCATION_ROLES));

type GrantedField = {
  readonly entity: string;
  readonly field: string;
  readonly perm: FieldPermission;
  readonly entityPerms: EntityPermissions;
  readonly required: boolean;
};

// Derived from the declarations rather than restated, so these assertions cannot
// drift from the grants the way a hand-maintained role list does.
function grantedFields(): readonly GrantedField[] {
  const out: GrantedField[] = [];
  for (const entity of ERP_EDUCATION_ENTITIES) {
    const entityPerms = ERP_EDUCATION_PERMISSIONS[entity.name];
    if (!entityPerms?.fields) continue;
    const fieldPerms: Record<string, FieldPermission> = entityPerms.fields;
    for (const [field, perm] of Object.entries(fieldPerms)) {
      const declared = entity.fields.find((f) => f.name === field);
      expect(declared, `${entity.name}.${field} is granted but not declared`).toBeDefined();
      out.push({
        entity: entity.name,
        field,
        perm,
        entityPerms,
        required: declared?.required === true,
      });
    }
  }
  return out;
}

describe("education permissions", () => {
  it("covers exactly the three education entities", () => {
    expect(Object.keys(ERP_EDUCATION_PERMISSIONS).sort()).toEqual([
      "Course",
      "Enrollment",
      "Student",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_EDUCATION_PERMISSIONS)) {
      const buckets = [perms.list, perms.read, perms.create, perms.update, perms.delete];
      for (const bucket of buckets) {
        for (const role of bucket?.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const grant of Object.values(perms.transitions ?? {})) {
        for (const role of grant.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const fieldPerm of Object.values(perms.fields ?? {})) {
        for (const role of [
          ...(fieldPerm.read?.roles ?? []),
          ...(fieldPerm.update?.roles ?? []),
          ...(fieldPerm.create?.roles ?? []),
        ]) {
          expect(KNOWN_ROLES.has(role)).toBe(true);
        }
      }
    }
  });

  it("restricts grade writes to registrar + instructor (excludes the auditor)", () => {
    const gradeWrite = ENROLLMENT_PERMISSIONS.fields?.grade?.update?.roles ?? [];
    expect(gradeWrite).not.toContain("ferpa_auditor");
    expect(gradeWrite).toContain("registrar");
    expect(gradeWrite).toContain("instructor");
  });

  it("grants the four Enrollment lifecycle transitions", () => {
    expect(Object.keys(ENROLLMENT_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "activate",
      "complete",
      "fail",
      "withdraw",
    ]);
  });

  it("each guarded transition has a matching grant; withdraw is registrar-only", () => {
    const grants = ENROLLMENT_PERMISSIONS.transitions ?? {};
    for (const t of ENROLLMENT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Enrollment.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["withdraw"]?.roles).toEqual(["edu_admin", "registrar"]);
  });
});

describe("education field grants (ADR-0348)", () => {
  it("grants every classified field in the pack", () => {
    const granted = new Set(grantedFields().map((g) => `${g.entity}.${g.field}`));
    const classified = ERP_EDUCATION_ENTITIES.flatMap((e) =>
      e.fields.filter((f) => f.classification !== undefined).map((f) => `${e.name}.${f.name}`),
    );
    expect(classified.length).toBeGreaterThan(0);
    for (const name of classified) expect(granted).toContain(name);
  });

  it("R2 — a field's update roles are a subset of its read roles", () => {
    const fields = grantedFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const g of fields) {
      const read = g.perm.read?.roles ?? [];
      for (const role of g.perm.update?.roles ?? []) {
        // Changing a value you cannot read is a blind overwrite.
        expect(read, `${g.entity}.${g.field} update:${role}`).toContain(role);
      }
    }
  });

  it("R1 — a required field is creatable by every role holding the entity's create grant", () => {
    let checked = 0;
    for (const g of grantedFields()) {
      if (!g.required) continue;
      const effective = fieldWriteGrant(g.perm, "create")?.roles ?? [];
      const missing = (g.entityPerms.create?.roles ?? []).filter((r) => !effective.includes(r));
      expect(missing, `${g.entity}.${g.field} is uncreatable by ${missing.join()}`).toEqual([]);
      checked += 1;
    }
    // Vacuity guard: student_email and date_of_birth are both required.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("R3 — no field grant names a role the entity grant does not reach", () => {
    for (const g of grantedFields()) {
      for (const arm of ["read", "update", "create"] as const) {
        const entityRoles = g.entityPerms[arm]?.roles ?? [];
        for (const role of g.perm[arm]?.roles ?? []) {
          expect(entityRoles, `${g.entity}.${g.field} ${arm}:${role}`).toContain(role);
        }
      }
    }
  });

  it("lets an instructor email a student but not read their date of birth", () => {
    expect(STUDENT_PERMISSIONS.fields?.student_email?.read?.roles).toContain("instructor");
    expect(STUDENT_PERMISSIONS.fields?.date_of_birth?.read?.roles).not.toContain("instructor");
    // Neither is an instructor's to write — they record grades, not the directory.
    for (const field of ["student_email", "date_of_birth"] as const) {
      expect(STUDENT_PERMISSIONS.fields?.[field]?.update?.roles).not.toContain("instructor");
    }
  });
});
