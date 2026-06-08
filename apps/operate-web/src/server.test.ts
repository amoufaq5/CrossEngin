import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import type { RawWebRequest, RawWebResponse } from "./http.js";
import { buildOperateWebServer, OperateWebServer } from "./server.js";

const TENANT = "t1";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

async function makeServer(): Promise<OperateWebServer> {
  const store = new InMemoryEntityStore();
  await store.create(TENANT, "Product", {
    id: "p1",
    sku: "ABC-1",
    name: "Widget",
    category: "home",
    unit_price: 9.99,
    unit_cost: 4.2,
    status: "active",
  });
  return buildOperateWebServer({
    manifest: retail,
    store,
    apiKeySpecs: [
      { key: "mgr", role: "store_manager", tenantId: TENANT },
      { key: "csh", role: "cashier", tenantId: TENANT },
    ],
  });
}

function req(url: string, key?: string): RawWebRequest {
  return { method: "GET", url, headers: key !== undefined ? { "x-api-key": key } : {} };
}

function body(res: RawWebResponse): any {
  return JSON.parse(new TextDecoder().decode(res.body!));
}

describe("OperateWebServer.dispatch — auth", () => {
  it("401s without a key", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/app"))).status).toBe(401);
  });

  it("405s a non-GET", async () => {
    const server = await makeServer();
    const res = await server.dispatch({ method: "POST", url: "/ui/app", headers: { "x-api-key": "mgr" } });
    expect(res.status).toBe(405);
  });

  it("404s an unknown entity / route", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/Nope", "mgr"))).status).toBe(404);
    expect((await server.dispatch(req("/elsewhere", "mgr"))).status).toBe(404);
  });
});

describe("GET /ui/app", () => {
  it("returns the WebAppModel for the caller", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/ui/app", "mgr"));
    expect(res.status).toBe(200);
    const app = body(res);
    expect(app.nav.map((n: { entity: string }) => n.entity)).toContain("Product");
  });
});

describe("GET /ui/:entity — table + redacted data page", () => {
  it("manager's product table includes the list-view columns and a data row", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/ui/Product", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.table.columns.map((c: { field: string }) => c.field)).toContain("unit_price");
    expect(out.page.data).toHaveLength(1);
    expect(out.page.data[0].sku).toBe("ABC-1");
  });
});

describe("GET /ui/:entity/:id — detail + redacted record (the redaction proof)", () => {
  it("a privileged caller's record carries the classified unit_cost", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/ui/Product/p1", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.record.unit_cost).toBe(4.2);
    const detailFields = out.detail.sections.flatMap((s: { fields: { field: string }[] }) => s.fields.map((f) => f.field));
    expect(detailFields).toContain("unit_cost");
  });

  it("an unprivileged caller's record OMITS the classified unit_cost (model + data)", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/ui/Product/p1", "csh"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect("unit_cost" in out.record).toBe(false);
    expect(out.record.sku).toBe("ABC-1");
    const detailFields = out.detail.sections.flatMap((s: { fields: { field: string }[] }) => s.fields.map((f) => f.field));
    expect(detailFields).not.toContain("unit_cost");
  });

  it("404s a missing record", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/Product/nope", "mgr"))).status).toBe(404);
  });
});

describe("GET /ui/:entity/new — form", () => {
  it("returns a form model, omitting unreadable fields for an unprivileged caller", async () => {
    const server = await makeServer();
    const mgr = body(await server.dispatch(req("/ui/Product/new", "mgr")));
    const csh = body(await server.dispatch(req("/ui/Product/new", "csh")));
    expect(mgr.form.fields.map((f: { field: string }) => f.field)).toContain("unit_cost");
    expect(csh.form.fields.map((f: { field: string }) => f.field)).not.toContain("unit_cost");
  });
});

const withBoard = {
  ...retail,
  views: {
    ...(retail.views ?? {}),
    productBoard: {
      kind: "kanban",
      entity: "Product",
      stateField: "status",
      columns: [
        { state: "active", label: { en: "Active" } },
        { state: "discontinued", label: { en: "Discontinued" } },
      ],
      cardFields: ["sku", "name", "unit_cost"],
      allowedTransitions: [],
    },
    orderCalendar: {
      kind: "calendar",
      entity: "SalesOrder",
      startField: "placed_at",
      titleField: "order_number",
      defaultView: "month",
    },
  },
} as unknown as Manifest;

async function makeServerWithViews(): Promise<OperateWebServer> {
  const store = new InMemoryEntityStore();
  await store.create(TENANT, "Product", {
    id: "p1",
    sku: "ABC-1",
    name: "Widget",
    category: "home",
    unit_price: 9.99,
    unit_cost: 4.2,
    status: "active",
  });
  return buildOperateWebServer({
    manifest: withBoard,
    store,
    apiKeySpecs: [
      { key: "mgr", role: "store_manager", tenantId: TENANT },
      { key: "csh", role: "cashier", tenantId: TENANT },
    ],
  });
}

describe("GET /ui/:entity/kanban — board + redacted card fields", () => {
  it("404s when the manifest declares no kanban view for the entity", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/Product/kanban", "mgr"))).status).toBe(404);
  });

  it("serves the board model + a data page; a manager's cards include unit_cost", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/ui/Product/kanban", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.kanban.stateField).toBe("status");
    expect(out.kanban.columns.map((c: { state: string }) => c.state)).toEqual(["active", "discontinued"]);
    expect(out.kanban.cardFields.map((f: { field: string }) => f.field)).toContain("unit_cost");
    expect(out.page.data[0].unit_cost).toBe(4.2);
  });

  it("a cashier's board omits the classified unit_cost in both the card model and the data", async () => {
    const server = await makeServerWithViews();
    const out = body(await server.dispatch(req("/ui/Product/kanban", "csh")));
    expect(out.kanban.cardFields.map((f: { field: string }) => f.field)).not.toContain("unit_cost");
    expect("unit_cost" in out.page.data[0]).toBe(false);
  });
});

describe("GET /ui/:entity/calendar — calendar model + data page", () => {
  it("serves the calendar model for a declared view", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/ui/SalesOrder/calendar", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.calendar.startField).toBe("placed_at");
    expect(out.calendar.titleField).toBe("order_number");
  });

  it("404s an entity with no calendar view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/ui/Product/calendar", "mgr"))).status).toBe(404);
  });
});
