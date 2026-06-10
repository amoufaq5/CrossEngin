import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { WEB_DESCRIBE_PATH, describeWebApi, type WebEntityDescriptor } from "./describe.js";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

// Retail stripped to list views only, so injected views don't collide with the
// pack's authored ones (same pattern as compile.test.ts).
const retailListOnly = {
  ...retail,
  views: Object.fromEntries(
    Object.entries((retail as { views?: Record<string, { kind: string }> }).views ?? {}).filter(
      ([, v]) => v.kind === "list",
    ),
  ),
  reports: {},
  dashboards: {},
} as unknown as Manifest;

const withBoard = {
  ...retailListOnly,
  views: {
    ...(retailListOnly.views ?? {}),
    orderBoard: {
      kind: "kanban",
      entity: "SalesOrder",
      stateField: "state",
      columns: [
        { state: "cart", label: { en: "Cart" } },
        { state: "placed", label: { en: "Placed" } },
      ],
      cardFields: ["order_number"],
      allowedTransitions: ["place"],
    },
  },
} as unknown as Manifest;

const MANAGER = { roles: ["store_manager"] };
const CASHIER = { roles: ["cashier"] };

function entityOf(d: ReturnType<typeof describeWebApi>, name: string): WebEntityDescriptor {
  const e = d.entities.find((x) => x.entity === name);
  if (e === undefined) throw new Error(`no descriptor for ${name}`);
  return e;
}

describe("describeWebApi", () => {
  it("lists the global routes (app + describe)", () => {
    const d = describeWebApi(retailListOnly, MANAGER);
    expect(d.routes).toEqual([
      { kind: "app", method: "GET", path: "/ui/app" },
      { kind: "describe", method: "GET", path: WEB_DESCRIBE_PATH },
    ]);
    expect(d.title).toBe(retail.meta.name);
  });

  it("gives every entity table/detail/form routes with the right paths", () => {
    const d = describeWebApi(retailListOnly, MANAGER);
    const product = entityOf(d, "Product");
    expect(product.views).toEqual(["table", "detail", "form"]);
    expect(product.routes).toContainEqual({ kind: "table", method: "GET", path: "/ui/Product", entity: "Product" });
    expect(product.routes).toContainEqual({ kind: "detail", method: "GET", path: "/ui/Product/{id}", entity: "Product" });
    expect(product.routes).toContainEqual({ kind: "form", method: "GET", path: "/ui/Product/new", entity: "Product" });
  });

  it("includes the kanban route only when a board compiles for the caller", () => {
    const without = entityOf(describeWebApi(retailListOnly, MANAGER), "SalesOrder");
    expect(without.views).not.toContain("kanban");
    expect(without.routes.some((r) => r.kind === "kanban")).toBe(false);

    const withIt = entityOf(describeWebApi(withBoard, MANAGER), "SalesOrder");
    expect(withIt.views).toContain("kanban");
    expect(withIt.routes).toContainEqual({
      kind: "kanban",
      method: "GET",
      path: "/ui/SalesOrder/kanban",
      entity: "SalesOrder",
    });
  });

  it("lists RBAC-gated mutation routes the caller may invoke (P3.28)", () => {
    // A store_manager can create + update Product; a cashier can do neither.
    const mgrProduct = entityOf(describeWebApi(retailListOnly, MANAGER), "Product");
    expect(mgrProduct.routes).toContainEqual({ kind: "create", method: "POST", path: "/ui/Product", entity: "Product" });
    expect(mgrProduct.routes).toContainEqual({ kind: "update", method: "PATCH", path: "/ui/Product/{id}", entity: "Product" });

    const cshProduct = entityOf(describeWebApi(retailListOnly, CASHIER), "Product");
    expect(cshProduct.routes.some((r) => r.kind === "create")).toBe(false);
    expect(cshProduct.routes.some((r) => r.kind === "update")).toBe(false);
  });

  it("lists transition routes the caller may fire, gated per transition", () => {
    // place is granted to sellers (incl. cashier); fulfill is managers-only.
    const mgr = entityOf(describeWebApi(retailListOnly, MANAGER), "SalesOrder");
    const mgrTransitions = mgr.routes.filter((r) => r.kind === "transition").map((r) => r.transition);
    expect(mgrTransitions).toContain("place");
    expect(mgrTransitions).toContain("fulfill");
    expect(mgr.routes).toContainEqual({
      kind: "transition",
      method: "POST",
      path: "/ui/SalesOrder/{id}/transition",
      entity: "SalesOrder",
      transition: "place",
    });

    const csh = entityOf(describeWebApi(retailListOnly, CASHIER), "SalesOrder");
    const cshTransitions = csh.routes.filter((r) => r.kind === "transition").map((r) => r.transition);
    expect(cshTransitions).toContain("place");
    expect(cshTransitions).not.toContain("fulfill");
  });

  it("publishes the view-model shapes under `models` (P3.35)", () => {
    const d = describeWebApi(retailListOnly, MANAGER);
    expect(Object.keys(d.models)).toContain("TableModel");
    expect(d.models["TableModel"]!.type).toBe("object");
    expect(d.models["TableModel"]!.properties!["columns"]!.type).toBe("array");
    expect(d.models["FormModel"]).toBeDefined();
  });

  it("carries a redaction-aware field schema per entity (P3.34)", () => {
    const mgr = entityOf(describeWebApi(retailListOnly, MANAGER), "Product");
    expect(mgr.schema.type).toBe("object");
    expect(mgr.schema.properties!["id"]).toEqual({ type: "string" });
    // a manager can read the commercial_sensitive unit_cost → present + typed
    expect(mgr.schema.properties!["unit_cost"]).toBeDefined();
    expect(mgr.schema.properties!["sku"]).toBeDefined();

    // a cashier can't read unit_cost → dropped from the schema (parity with model/data redaction)
    const csh = entityOf(describeWebApi(retailListOnly, CASHIER), "Product");
    expect(csh.schema.properties!["unit_cost"]).toBeUndefined();
    expect(csh.schema.properties!["sku"]).toBeDefined();
  });
});
