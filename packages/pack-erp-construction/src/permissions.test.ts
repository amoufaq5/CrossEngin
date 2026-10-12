import { fieldWriteGrant, type EntityPermissions, type FieldPermission } from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { ERP_CONSTRUCTION_ENTITIES } from "./entities.js";
import {
  ERP_CONSTRUCTION_PERMISSIONS,
  PROJECT_PERMISSIONS,
  SUBCONTRACTOR_PERMISSIONS,
  WORK_ORDER_PERMISSIONS,
} from "./permissions.js";
import { ERP_CONSTRUCTION_ROLES } from "./roles.js";
import { PROJECT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_CONSTRUCTION_ROLES));

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
  for (const entity of ERP_CONSTRUCTION_ENTITIES) {
    const entityPerms = ERP_CONSTRUCTION_PERMISSIONS[entity.name];
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

function rolesMissingFromCreate(g: GrantedField): readonly string[] {
  const effective = fieldWriteGrant(g.perm, "create")?.roles ?? [];
  return (g.entityPerms.create?.roles ?? []).filter((r) => !effective.includes(r));
}

describe("construction permissions", () => {
  it("covers exactly the three construction entities", () => {
    expect(Object.keys(ERP_CONSTRUCTION_PERMISSIONS).sort()).toEqual([
      "Project",
      "Subcontractor",
      "WorkOrder",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_CONSTRUCTION_PERMISSIONS)) {
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

  it("excludes the foreman from reading the project budget and work-order cost", () => {
    const budgetRead = PROJECT_PERMISSIONS.fields?.budget_amount?.read?.roles ?? [];
    expect(budgetRead).not.toContain("foreman");
    expect(budgetRead).toContain("cost_analyst");
    const costRead = WORK_ORDER_PERMISSIONS.fields?.cost_estimate?.read?.roles ?? [];
    expect(costRead).not.toContain("foreman");
    expect(costRead).toContain("project_manager");
  });

  it("grants the five Project lifecycle transitions", () => {
    expect(Object.keys(PROJECT_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "cancel",
      "complete",
      "hold",
      "resume",
      "start_work",
    ]);
  });

  it("each guarded transition has a matching grant; cancel is admin-only", () => {
    const grants = PROJECT_PERMISSIONS.transitions ?? {};
    for (const t of PROJECT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Project.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["cancel"]?.roles).toEqual(["construction_admin"]);
  });
});

describe("construction field grants (ADR-0348)", () => {
  it("grants every classified field in the pack", () => {
    const granted = new Set(grantedFields().map((g) => `${g.entity}.${g.field}`));
    const classified = ERP_CONSTRUCTION_ENTITIES.flatMap((e) =>
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
      const missing = rolesMissingFromCreate(g);
      expect(missing, `${g.entity}.${g.field} is uncreatable by ${missing.join()}`).toEqual([]);
      checked += 1;
    }
    // Vacuity guard: budget_amount and cost_estimate are both required.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("lets a foreman raise a work order without ever reading its cost", () => {
    const perm = WORK_ORDER_PERMISSIONS.fields?.cost_estimate;
    // The entity grant and the create arm have to agree, or a required field
    // makes the entity uncreatable by a role holding the entity's create grant.
    expect(fieldWriteGrant(perm, "create")?.roles).toEqual(WORK_ORDER_PERMISSIONS.create?.roles);
    expect(fieldWriteGrant(perm, "create")?.roles).toContain("foreman");
    expect(fieldWriteGrant(perm, "update")?.roles).not.toContain("foreman");
    expect(perm?.read?.roles).not.toContain("foreman");
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

  it("withholds a subcontractor's contact from the cost analyst who reads its tax id", () => {
    const fields = SUBCONTRACTOR_PERMISSIONS.fields;
    expect(fields?.tax_id?.read?.roles).toContain("cost_analyst");
    expect(fields?.contact_email?.read?.roles).not.toContain("cost_analyst");
  });
});
