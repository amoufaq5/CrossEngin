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
    expect(product.routes).toEqual([
      { kind: "table", method: "GET", path: "/ui/Product", entity: "Product" },
      { kind: "detail", method: "GET", path: "/ui/Product/{id}", entity: "Product" },
      { kind: "form", method: "GET", path: "/ui/Product/new", entity: "Product" },
    ]);
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
});
