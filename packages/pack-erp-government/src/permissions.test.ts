import { fieldWriteGrant, type EntityPermissions, type FieldPermission } from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { ERP_GOVERNMENT_ENTITIES } from "./entities.js";
import {
  CASE_PERMISSIONS,
  CITIZEN_PERMISSIONS,
  ERP_GOVERNMENT_PERMISSIONS,
} from "./permissions.js";
import { ERP_GOVERNMENT_ROLES } from "./roles.js";
import { CASE_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_GOVERNMENT_ROLES));

type GrantedField = {
  readonly entity: string;
  readonly field: string;
  readonly perm: FieldPermission;
  readonly entityPerms: EntityPermissions;
  readonly required: boolean;
  readonly classification: string | undefined;
};

// Derived from the declarations rather than restated, so these assertions cannot
// drift from the grants the way a hand-maintained role list does.
function grantedFields(): readonly GrantedField[] {
  const out: GrantedField[] = [];
  for (const entity of ERP_GOVERNMENT_ENTITIES) {
    const entityPerms = ERP_GOVERNMENT_PERMISSIONS[entity.name];
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
        classification: declared?.classification,
      });
    }
  }
  return out;
}

describe("government permissions", () => {
  it("covers exactly the three government entities", () => {
    expect(Object.keys(ERP_GOVERNMENT_PERMISSIONS).sort()).toEqual([
      "Case",
      "Citizen",
      "Permit",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_GOVERNMENT_PERMISSIONS)) {
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

  it("excludes the permit officer from reading the national id", () => {
    const idRead = CITIZEN_PERMISSIONS.fields?.national_id?.read?.roles ?? [];
    expect(idRead).not.toContain("permit_officer");
    expect(idRead).toContain("gov_auditor");
  });

  it("grants the four Case lifecycle transitions", () => {
    expect(Object.keys(CASE_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "approve",
      "close",
      "deny",
      "submit_for_review",
    ]);
  });

  it("each guarded transition has a matching grant; close is admin-only", () => {
    const grants = CASE_PERMISSIONS.transitions ?? {};
    for (const t of CASE_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Case.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["close"]?.roles).toEqual(["gov_admin"]);
  });
});

describe("government field grants (ADR-0348)", () => {
  it("grants every classified field in the pack", () => {
    const granted = new Set(grantedFields().map((g) => `${g.entity}.${g.field}`));
    const classified = ERP_GOVERNMENT_ENTITIES.flatMap((e) =>
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
    // Vacuity guard: national_id and fee_amount are both required.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("R3 — no field grant names a role the entity grant does not reach", () => {
    for (const g of grantedFields()) {
      for (const [arm, entityOp] of [
        ["read", "read"],
        ["update", "update"],
        ["create", "create"],
      ] as const) {
        const entityRoles = g.entityPerms[entityOp]?.roles ?? [];
        for (const role of g.perm[arm]?.roles ?? []) {
          expect(entityRoles, `${g.entity}.${g.field} ${arm}:${role}`).toContain(role);
        }
      }
    }
  });

  it("lets a case worker set a national id but never change one", () => {
    const perm = CITIZEN_PERMISSIONS.fields?.national_id;
    // The entity grant and the create arm have to agree, which is the whole fix:
    // before it, a case_worker holding Citizen.create was refused on a required
    // field and could not register a citizen at all.
    expect(fieldWriteGrant(perm, "create")?.roles).toEqual(CITIZEN_PERMISSIONS.create?.roles);
    expect(fieldWriteGrant(perm, "update")?.roles).toEqual(["gov_admin"]);
    expect(fieldWriteGrant(perm, "create")?.roles).toContain("case_worker");
    expect(fieldWriteGrant(perm, "update")?.roles).not.toContain("case_worker");
  });
});
