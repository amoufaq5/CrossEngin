import { fieldWriteGrant, type EntityPermissions, type FieldPermission } from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { ERP_GROCERY_ENTITIES } from "./entities.js";
import {
  ERP_GROCERY_PERMISSIONS,
  PERISHABLE_LOT_PERMISSIONS,
  SUPPLIER_PERMISSIONS,
} from "./permissions.js";
import { ERP_GROCERY_ROLES } from "./roles.js";
import { PERISHABLE_LOT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_GROCERY_ROLES));

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
  for (const entity of ERP_GROCERY_ENTITIES) {
    const entityPerms = ERP_GROCERY_PERMISSIONS[entity.name];
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

describe("grocery permissions", () => {
  it("covers exactly the two grocery entities", () => {
    expect(Object.keys(ERP_GROCERY_PERMISSIONS).sort()).toEqual(["PerishableLot", "Supplier"]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_GROCERY_PERMISSIONS)) {
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

  it("each guarded transition has a matching grant", () => {
    const grants = PERISHABLE_LOT_PERMISSIONS.transitions ?? {};
    for (const t of PERISHABLE_LOT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `PerishableLot.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(Object.keys(grants).sort()).toEqual(["deplete", "shelve"]);
  });
});

describe("grocery field grants (ADR-0348)", () => {
  it("grants every classified field in the pack", () => {
    const granted = new Set(grantedFields().map((g) => `${g.entity}.${g.field}`));
    const classified = ERP_GROCERY_ENTITIES.flatMap((e) =>
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
    // Vacuity guard: cost_per_unit is required.
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it("lets a receiving clerk book a lot's cost without ever reading one", () => {
    const perm = PERISHABLE_LOT_PERMISSIONS.fields?.cost_per_unit;
    // The entity grant and the create arm have to agree, or a required field
    // makes the entity uncreatable by a role holding the entity's create grant.
    expect(fieldWriteGrant(perm, "create")?.roles).toEqual(
      PERISHABLE_LOT_PERMISSIONS.create?.roles,
    );
    expect(fieldWriteGrant(perm, "create")?.roles).toContain("receiving_clerk");
    expect(fieldWriteGrant(perm, "update")?.roles).not.toContain("receiving_clerk");
    expect(perm?.read?.roles).not.toContain("receiving_clerk");
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

  it("withholds the supplier's contact from the receiving clerk who reads the supplier", () => {
    expect(SUPPLIER_PERMISSIONS.read?.roles).toContain("receiving_clerk");
    expect(SUPPLIER_PERMISSIONS.fields?.contact_email?.read?.roles).not.toContain(
      "receiving_clerk",
    );
  });
});
