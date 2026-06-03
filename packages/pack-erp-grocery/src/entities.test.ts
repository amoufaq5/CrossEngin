import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  ERP_GROCERY_ENTITIES,
  PERISHABLE_LOT_ENTITY,
  SUPPLIER_ENTITY,
} from "./entities.js";
import {
  PERISHABLE_LOT_PERMISSIONS,
  SUPPLIER_PERMISSIONS,
} from "./permissions.js";
import { ERP_GROCERY_ROLES } from "./roles.js";
import { PERISHABLE_LOT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_GROCERY_ROLES));

describe("grocery entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_GROCERY_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("are all auditable", () => {
    for (const e of ERP_GROCERY_ENTITIES) expect(e.traits).toContain("auditable");
  });

  it("Supplier references the core Account; PerishableLot references the retail Product", () => {
    expect(SUPPLIER_ENTITY.fields.find((f) => f.name === "account_id")?.type).toEqual({
      kind: "reference",
      target: "Account",
    });
    expect(PERISHABLE_LOT_ENTITY.fields.find((f) => f.name === "product_id")?.type).toEqual({
      kind: "reference",
      target: "Product",
    });
  });

  it("classifies lot cost (commercial_sensitive) + supplier email (pii), no phi", () => {
    expect(PERISHABLE_LOT_ENTITY.fields.find((f) => f.name === "cost_per_unit")?.classification).toBe(
      "commercial_sensitive",
    );
    expect(SUPPLIER_ENTITY.fields.find((f) => f.name === "contact_email")?.classification).toBe("pii");
    const classes = ERP_GROCERY_ENTITIES.flatMap((e) => e.fields.map((f) => f.classification));
    expect(classes).not.toContain("phi");
  });
});

describe("grocery permissions + workflow alignment", () => {
  it("only grants declared roles", () => {
    for (const perms of [SUPPLIER_PERMISSIONS, PERISHABLE_LOT_PERMISSIONS]) {
      const roles = [
        ...(perms.read?.roles ?? []),
        ...Object.values(perms.transitions ?? {}).flatMap((g) => g.roles ?? []),
        ...Object.values(perms.fields ?? {}).flatMap((f) => f.read?.roles ?? []),
      ];
      for (const r of roles) expect(KNOWN_ROLES.has(r)).toBe(true);
    }
  });

  it("redacts lot cost from the receiving clerk", () => {
    expect(PERISHABLE_LOT_PERMISSIONS.fields?.cost_per_unit?.read?.roles).toEqual(["grocery_admin"]);
  });

  it("every permission-guarded transition has a grant; expire is automatic", () => {
    const grants = PERISHABLE_LOT_PERMISSIONS.transitions ?? {};
    for (const t of PERISHABLE_LOT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `PerishableLot.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(PERISHABLE_LOT_LIFECYCLE_WORKFLOW.transitions.find((t) => t.name === "expire")?.trigger).toEqual({
      kind: "automatic",
    });
  });
});
