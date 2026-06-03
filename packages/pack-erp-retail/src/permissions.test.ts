import { describe, expect, it } from "vitest";
import {
  ERP_RETAIL_PERMISSIONS,
  PRODUCT_PERMISSIONS,
  SALES_ORDER_PERMISSIONS,
} from "./permissions.js";
import { ERP_RETAIL_ROLES } from "./roles.js";
import { SALES_ORDER_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_RETAIL_ROLES));

describe("retail permissions", () => {
  it("covers exactly the four retail entities", () => {
    expect(Object.keys(ERP_RETAIL_PERMISSIONS).sort()).toEqual([
      "OrderLine",
      "Product",
      "SalesOrder",
      "Store",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_RETAIL_PERMISSIONS)) {
      const buckets = [perms.list, perms.read, perms.create, perms.update, perms.delete];
      for (const bucket of buckets) {
        for (const role of bucket?.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const grant of Object.values(perms.transitions ?? {})) {
        for (const role of grant.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const fieldPerm of Object.values(perms.fields ?? {})) {
        for (const role of [...(fieldPerm.read?.roles ?? []), ...(fieldPerm.update?.roles ?? [])]) {
          expect(KNOWN_ROLES.has(role)).toBe(true);
        }
      }
    }
  });

  it("excludes the cashier from reading wholesale cost", () => {
    const costRead = PRODUCT_PERMISSIONS.fields?.unit_cost?.read?.roles ?? [];
    expect(costRead).not.toContain("cashier");
    expect(costRead).toContain("store_manager");
  });

  it("grants the four SalesOrder lifecycle transitions", () => {
    expect(Object.keys(SALES_ORDER_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "cancel",
      "fulfill",
      "mark_returned",
      "place",
    ]);
  });

  it("each guarded transition has a matching grant; mark_returned is manager-only", () => {
    const grants = SALES_ORDER_PERMISSIONS.transitions ?? {};
    for (const t of SALES_ORDER_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `SalesOrder.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["mark_returned"]?.roles).toEqual(["retail_admin", "store_manager"]);
  });
});
