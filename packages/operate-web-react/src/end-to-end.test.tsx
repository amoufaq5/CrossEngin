import {
  resolveManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { compileDetailModel, compileWebApp } from "@crossengin/operate-web";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell, DetailView } from "./components.js";
import { renderPage } from "./render.js";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

const MANAGER = { roles: ["store_manager"] };
const CASHIER = { roles: ["cashier"] };
const RECORD = { id: "p1", sku: "ABC-1", name: "Widget", unit_cost: 4.2 };

describe("end-to-end: real retail pack models render cleanly", () => {
  it("renders the app shell with every retail entity in the nav", () => {
    const app = compileWebApp(retail, MANAGER);
    const html = renderPage(<AppShell app={app} />, { title: app.title });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('data-entity="Product"');
    expect(html).toContain('data-entity="SalesOrder"');
  });

  it("a privileged manager's detail HTML contains the classified unit_cost; a cashier's omits it", () => {
    const managerModel = compileDetailModel(retail, "Product", MANAGER, RECORD);
    const cashierModel = compileDetailModel(retail, "Product", CASHIER, RECORD);

    const managerHtml = renderToStaticMarkup(<DetailView model={managerModel} record={RECORD} />);
    const cashierHtml = renderToStaticMarkup(<DetailView model={cashierModel} record={RECORD} />);

    // The manager's compiled model includes unit_cost, so the markup has it…
    expect(managerHtml).toContain("Unit cost");
    expect(managerHtml).toContain("4.2");
    // …while the cashier's model dropped it, so the markup never describes it.
    expect(cashierHtml).not.toContain("Unit cost");
    expect(cashierHtml).not.toContain("4.2");
    // both still show the readable sku
    expect(managerHtml).toContain("ABC-1");
    expect(cashierHtml).toContain("ABC-1");
  });
});
