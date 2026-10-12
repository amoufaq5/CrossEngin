import {
  EntityPermissionsSchema,
  fieldWriteGrant,
  type EntityPermissions,
} from "@crossengin/auth";
import { isSensitiveDataClass } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { buildErpCorePack } from "./pack.js";
import {
  ACCOUNT_PERMISSIONS,
  ERP_CORE_PERMISSIONS,
  INVOICE_PERMISSIONS,
} from "./permissions.js";
import { ERP_EXT_PERMISSIONS } from "./permissions-ext.js";

describe("ACCOUNT_PERMISSIONS", () => {
  it("parses", () => {
    expect(() => EntityPermissionsSchema.parse(ACCOUNT_PERMISSIONS)).not.toThrow();
  });

  it("admin-only delete", () => {
    expect(ACCOUNT_PERMISSIONS.delete?.roles).toEqual(["erp_admin"]);
  });

  it("viewer can list and read", () => {
    expect(ACCOUNT_PERMISSIONS.list?.roles).toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.read?.roles).toContain("erp_viewer");
  });

  it("viewer cannot create / update / delete", () => {
    expect(ACCOUNT_PERMISSIONS.create?.roles).not.toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.update?.roles).not.toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.delete?.roles).not.toContain("erp_viewer");
  });
});

describe("INVOICE_PERMISSIONS", () => {
  it("has transitions for send / mark_paid / mark_overdue / void", () => {
    const t = INVOICE_PERMISSIONS.transitions;
    expect(Object.keys(t ?? {}).sort()).toEqual([
      "mark_overdue",
      "mark_paid",
      "send",
      "void",
    ]);
  });

  it("void is admin-only", () => {
    expect(INVOICE_PERMISSIONS.transitions?.["void"]?.roles).toEqual([
      "erp_admin",
    ]);
  });
});

describe("ERP_CORE_PERMISSIONS", () => {
  it("covers all 23 entities", () => {
    expect(Object.keys(ERP_CORE_PERMISSIONS).sort()).toEqual([
      "Account",
      "Bill",
      "BillLine",
      "Contact",
      "Department",
      "Employee",
      "Expense",
      "GoodsReceipt",
      "Invoice",
      "InvoiceLine",
      "Item",
      "JournalEntry",
      "JournalLine",
      "LeaveRequest",
      "LedgerAccount",
      "Payment",
      "Position",
      "PurchaseOrder",
      "PurchaseOrderLine",
      "StockLevel",
      "StockMovement",
      "Vendor",
      "Warehouse",
    ]);
  });
});

// ---- per-field grants on sensitive-classified fields -------------------------
//
// Derived rather than restated: the census comes from the manifest's own entities and the rules
// are evaluated against the entity grants they constrain, so a field whose classification
// changes, a role dropped from an entity grant, or a 22nd classified field lands here as a
// failure instead of drifting past a hand-maintained list.
//
// The grants are read from this pack's two permission maps rather than through
// `Manifest["permissions"]`, which is the same declaration one indirection out — asserted below —
// but typed through `@crossengin/kernel`'s build, so reaching the `create` arm through it would
// be green or red depending on whether the workspace had been rebuilt.

const PACK = buildErpCorePack();

const DECLARED_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  ...ERP_CORE_PERMISSIONS,
  ...ERP_EXT_PERMISSIONS,
};

interface SensitiveField {
  readonly entity: string;
  readonly field: string;
  readonly required: boolean;
  readonly perms: EntityPermissions;
}

function sensitiveFields(): readonly SensitiveField[] {
  const out: SensitiveField[] = [];
  for (const entity of PACK.entities ?? []) {
    const perms = DECLARED_PERMISSIONS[entity.name];
    for (const f of entity.fields) {
      if (f.classification === undefined || !isSensitiveDataClass(f.classification)) continue;
      // A classified field on an entity with no permissions at all would be a different defect;
      // assert it here rather than silently skipping the row.
      expect(perms, `${entity.name} has no entity permissions`).toBeDefined();
      out.push({
        entity: entity.name,
        field: f.name,
        required: f.required === true,
        perms: perms as EntityPermissions,
      });
    }
  }
  return out;
}

const SENSITIVE = sensitiveFields();

function roles(grant: { readonly roles: readonly string[] } | undefined): readonly string[] {
  return grant?.roles ?? [];
}

describe("sensitive-classified field grants", () => {
  it("reads the same declaration the manifest carries", () => {
    // What makes substituting the two maps for `PACK.permissions` sound: the manifest is their
    // spread, so an entity added to one and not served here would be invisible to every rule.
    expect(Object.keys(PACK.permissions ?? {}).sort()).toEqual(
      Object.keys(DECLARED_PERMISSIONS).sort(),
    );
    for (const name of Object.keys(DECLARED_PERMISSIONS)) {
      expect(PACK.permissions?.[name], name).toBe(DECLARED_PERMISSIONS[name]);
    }
  });

  it("finds the pack's classified fields", () => {
    // Vacuity guard: every assertion below iterates this set, so an empty or shrunken census
    // would make them all pass having checked nothing.
    expect(SENSITIVE.length).toBe(21);
    expect(SENSITIVE.filter((s) => s.required).map((s) => `${s.entity}.${s.field}`).sort()).toEqual([
      "Employee.work_email",
      "FixedAsset.acquisition_cost",
      "Lead.full_name",
      "Opportunity.amount",
    ]);
  });

  it("declares a grant with both read and update arms for every one of them", () => {
    for (const { entity, field, perms } of SENSITIVE) {
      const fp = perms.fields?.[field];
      expect(fp, `${entity}.${field} has no field grant`).toBeDefined();
      expect(roles(fp?.read), `${entity}.${field} read`).not.toEqual([]);
      expect(roles(fp?.update), `${entity}.${field} update`).not.toEqual([]);
    }
  });

  it("R2 — update is a subset of read, so nothing is writable but unreadable", () => {
    for (const { entity, field, perms } of SENSITIVE) {
      const fp = perms.fields?.[field];
      const readable = new Set(roles(fp?.read));
      const blind = roles(fp?.update).filter((r) => !readable.has(r));
      expect(blind, `${entity}.${field} can be overwritten blind by`).toEqual([]);
    }
  });

  it("R3 — no field arm names a role outside the matching entity arm", () => {
    for (const { entity, field, perms } of SENSITIVE) {
      const fp = perms.fields?.[field];
      for (const arm of ["read", "update", "create"] as const) {
        const granted = arm === "create" ? roles(fieldWriteGrant(fp, "create")) : roles(fp?.[arm]);
        const entityRoles = new Set(roles(perms[arm]));
        const excess = granted.filter((r) => !entityRoles.has(r));
        expect(excess, `${entity}.${field} ${arm} exceeds the entity grant for`).toEqual([]);
      }
    }
  });

  it("R1 — a required field's effective create grant covers the entity's create roles", () => {
    for (const { entity, field, required, perms } of SENSITIVE) {
      if (!required) continue;
      const creators = new Set(roles(fieldWriteGrant(perms.fields?.[field], "create")));
      const refused = roles(perms.create).filter((r) => !creators.has(r));
      expect(refused, `${entity} is uncreatable via ${field} by`).toEqual([]);
    }
  });

  it("Employee.national_id is set-once: HR creates it, only the admin changes it", () => {
    const fp = DECLARED_PERMISSIONS["Employee"]?.fields?.["national_id"];
    expect(roles(fieldWriteGrant(fp, "create"))).toContain("hr_manager");
    expect(roles(fieldWriteGrant(fp, "update"))).not.toContain("hr_manager");
    // The arm earns its place only if the fallback would have said something different.
    expect(fp?.create).not.toEqual(fp?.update);
  });

  it("drops the general observer from every classified field it granted", () => {
    for (const { entity, field, perms } of SENSITIVE) {
      const fp = perms.fields?.[field];
      expect(roles(fp?.read), `${entity}.${field}`).not.toContain("erp_viewer");
    }
  });
});
