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

// Retail with only its list views + no reports/dashboards — the base for the
// view-injection fixtures below, since the pack now authors real kanban/calendar/
// map/dashboard/pivot views (P3.21) that would otherwise collide with injected ones.
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
      { key: "adm", role: "retail_admin", tenantId: TENANT },
    ],
  });
}

function req(url: string, key?: string): RawWebRequest {
  return { method: "GET", url, headers: key !== undefined ? { "x-api-key": key } : {} };
}

function writeReq(method: string, url: string, key: string, payload?: unknown): RawWebRequest {
  return {
    method,
    url,
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: payload === undefined ? null : new TextEncoder().encode(JSON.stringify(payload)),
  };
}

function body(res: RawWebResponse): any {
  return JSON.parse(new TextDecoder().decode(res.body!));
}

describe("OperateWebServer.dispatch — auth", () => {
  it("401s without a key", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/app"))).status).toBe(401);
  });

  it("405s an unsupported method (only GET/POST/PATCH/DELETE are routed)", async () => {
    const server = await makeServer();
    const res = await server.dispatch({ method: "PUT", url: "/ui/Product", headers: { "x-api-key": "mgr" } });
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

describe("GET /ui/_describe — per-caller route discovery (P3.27)", () => {
  it("401s an unauthenticated caller", async () => {
    const server = await makeServer();
    expect((await server.dispatch(req("/ui/_describe"))).status).toBe(401);
  });

  it("lists global routes + every entity's table/detail/form routes", async () => {
    const server = await makeServer();
    const d = body(await server.dispatch(req("/ui/_describe", "mgr")));
    expect(d.routes).toContainEqual({ kind: "app", method: "GET", path: "/ui/app" });
    expect(d.routes).toContainEqual({ kind: "describe", method: "GET", path: "/ui/_describe" });
    const product = d.entities.find((e: { entity: string }) => e.entity === "Product");
    expect(product.routes.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(["table", "detail", "form"]));
    expect(product.routes).toContainEqual({ kind: "table", method: "GET", path: "/ui/Product", entity: "Product" });
    expect(product.routes).toContainEqual({ kind: "detail", method: "GET", path: "/ui/Product/{id}", entity: "Product" });
    expect(product.routes).toContainEqual({ kind: "form", method: "GET", path: "/ui/Product/new", entity: "Product" });
  });

  it("surfaces the kanban route once a board is authored for the caller", async () => {
    const server = await makeServerWithViews();
    const d = body(await server.dispatch(req("/ui/_describe", "mgr")));
    const product = d.entities.find((e: { entity: string }) => e.entity === "Product");
    expect(product.views).toContain("kanban");
    expect(product.routes).toContainEqual({ kind: "kanban", method: "GET", path: "/ui/Product/kanban", entity: "Product" });
  });

  it("carries a redaction-aware field schema per entity, dropping fields the caller can't read (P3.34)", async () => {
    const server = await makeServer();
    const mgr = body(await server.dispatch(req("/ui/_describe", "mgr")));
    const csh = body(await server.dispatch(req("/ui/_describe", "csh")));
    const mgrProduct = mgr.entities.find((e: { entity: string }) => e.entity === "Product");
    const cshProduct = csh.entities.find((e: { entity: string }) => e.entity === "Product");
    expect(mgrProduct.schema.properties.unit_cost).toBeDefined();
    expect(cshProduct.schema.properties.unit_cost).toBeUndefined();
    expect(cshProduct.schema.properties.sku).toBeDefined();
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
  ...retailListOnly,
  views: {
    ...(retailListOnly.views ?? {}),
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
    productMap: {
      kind: "map",
      entity: "Product",
      geoField: "sku",
      markerColorField: "unit_cost",
      markerLabelField: "name",
      defaultZoom: 6,
      layers: [{ id: "all", label: { en: "All" }, kind: "markers" }],
    },
    storeDashView: { kind: "dashboard", entity: "Store", dashboardRef: "storeDash" },
    storePivotView: { kind: "pivot", entity: "Store", reportRef: "salesPivot", allowReshape: true },
  },
  dashboards: {
    storeDash: {
      layout: "grid",
      refreshIntervalSeconds: 90,
      cells: [
        { x: 0, y: 0, w: 6, h: 2, widget: { kind: "kpi", report: "salesKpi", title: { en: "Sales" } } },
        { x: 6, y: 0, w: 6, h: 2, widget: { kind: "markdown", body: { en: "Welcome" } } },
      ],
    },
  },
  reports: {
    salesKpi: { kind: "kpi", entity: "Product", measure: { name: "n", kind: "count" } },
    salesPivot: {
      kind: "pivot",
      entity: "Product",
      label: { en: "Sales pivot" },
      rows: ["category"],
      columns: ["status"],
      measures: [{ name: "n", kind: "count" }],
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

describe("POST /ui/:entity — create (RBAC + write-mask)", () => {
  it("a manager creates a Product (201) and the redacted record carries unit_cost", async () => {
    const server = await makeServer();
    const res = await server.dispatch(
      writeReq("POST", "/ui/Product", "mgr", { id: "new1", sku: "NEW-1", name: "New", category: "home", unit_price: 5, unit_cost: 2, status: "active" }),
    );
    expect(res.status).toBe(201);
    expect(body(res).record.unit_cost).toBe(2);
    // round-trips through the store
    expect((await server.dispatch(req("/ui/Product/new1", "mgr"))).status).toBe(200);
  });

  it("a cashier cannot create a Product (403 — no create grant)", async () => {
    const server = await makeServer();
    const res = await server.dispatch(writeReq("POST", "/ui/Product", "csh", { sku: "X", name: "Y" }));
    expect(res.status).toBe(403);
  });

  it("rejects a payload with a field the viewer can't write (422)", async () => {
    // SalesOrder create is allowed for a cashier, but customer_email (pii) has no
    // write grant → the write mask blocks it.
    const server = await makeServer();
    const blocked = await server.dispatch(
      writeReq("POST", "/ui/SalesOrder", "csh", { order_number: "SO-1", customer_email: "a@b.com" }),
    );
    expect(blocked.status).toBe(422);
    expect(body(blocked).detail).toContain("customer_email");

    const ok = await server.dispatch(writeReq("POST", "/ui/SalesOrder", "csh", { order_number: "SO-2" }));
    expect(ok.status).toBe(201);
  });

  it("rejects an unknown field not in the manifest (422)", async () => {
    const server = await makeServer();
    const res = await server.dispatch(writeReq("POST", "/ui/Product", "mgr", { sku: "Z", bogus: 1 }));
    expect(res.status).toBe(422);
    expect(body(res).detail).toContain("bogus");
  });

  it("400s a missing / invalid JSON body", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("POST", "/ui/Product", "mgr"))).status).toBe(400);
    const bad: RawWebRequest = { method: "POST", url: "/ui/Product", headers: { "x-api-key": "mgr" }, body: new TextEncoder().encode("{not json") };
    expect((await server.dispatch(bad)).status).toBe(400);
  });
});

describe("PATCH /ui/:entity/:id — update (RBAC + write-mask)", () => {
  it("a manager patches a field (200)", async () => {
    const server = await makeServer();
    const res = await server.dispatch(writeReq("PATCH", "/ui/Product/p1", "mgr", { unit_price: 12.5 }));
    expect(res.status).toBe(200);
    expect(body(res).record.unit_price).toBe(12.5);
  });

  it("a cashier cannot patch a Product (403)", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("PATCH", "/ui/Product/p1", "csh", { unit_price: 1 }))).status).toBe(403);
  });

  it("404s a missing record", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("PATCH", "/ui/Product/nope", "mgr", { unit_price: 1 }))).status).toBe(404);
  });

  it("does not treat a reserved sub-route word as a record id", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("PATCH", "/ui/Product/new", "mgr", { unit_price: 1 }))).status).toBe(404);
  });
});

describe("DELETE /ui/:entity/:id — delete (RBAC)", () => {
  it("an admin deletes a record (204), then it is gone (404)", async () => {
    const server = await makeServer();
    const del = await server.dispatch(writeReq("DELETE", "/ui/Product/p1", "adm"));
    expect(del.status).toBe(204);
    expect((await server.dispatch(req("/ui/Product/p1", "adm"))).status).toBe(404);
  });

  it("a manager cannot delete (403 — delete is admin-only)", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("DELETE", "/ui/Product/p1", "mgr"))).status).toBe(403);
  });

  it("404s deleting a missing record (as admin)", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("DELETE", "/ui/Product/nope", "adm"))).status).toBe(404);
  });
});

function htmlBody(res: RawWebResponse): string {
  return new TextDecoder().decode(res.body!);
}

describe("GET /ui/:entity/map — map model + data page", () => {
  it("serves the map model; a manager's markerColorField is unit_cost, a cashier's is omitted", async () => {
    const server = await makeServerWithViews();
    const mgr = body(await server.dispatch(req("/ui/Product/map", "mgr")));
    expect(mgr.map.geoField).toBe("sku");
    expect(mgr.map.markerColorField).toBe("unit_cost");
    expect(mgr.map.layers[0].kind).toBe("markers");
    expect(mgr.page.data[0].unit_cost).toBe(4.2);

    const csh = body(await server.dispatch(req("/ui/Product/map", "csh")));
    expect("markerColorField" in csh.map).toBe(false);
    expect("unit_cost" in csh.page.data[0]).toBe(false);
  });

  it("404s an entity with no map view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/ui/SalesOrder/map", "mgr"))).status).toBe(404);
  });
});

describe("GET /ui/:entity/dashboard — dashboard layout model", () => {
  it("serves the dashboard model (layout + widget descriptors)", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/ui/Store/dashboard", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.dashboard.layout).toBe("grid");
    expect(out.dashboard.cells).toHaveLength(2);
    expect(out.dashboard.cells[0].widget.kind).toBe("kpi");
    expect(out.dashboard.cells[1].widget.body).toBe("Welcome");
  });

  it("executes report-backed widgets (P3.18): the kpi widget counts the seeded Product", async () => {
    const server = await makeServerWithViews();
    const out = body(await server.dispatch(req("/ui/Store/dashboard", "mgr")));
    // widgetData aligns to cells: [kpi report, markdown → null]
    expect(out.widgetData[0]).toMatchObject({ kind: "kpi", value: 1 });
    expect(out.widgetData[1]).toBeNull();
  });

  it("404s an entity with no dashboard view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/ui/Product/dashboard", "mgr"))).status).toBe(404);
  });
});

describe("GET /ui/:entity/pivot — pivot model", () => {
  it("serves the pivot model (report ref + reshape flag + label)", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/ui/Store/pivot", "mgr"));
    expect(res.status).toBe(200);
    const out = body(res);
    expect(out.pivot.reportRef).toBe("salesPivot");
    expect(out.pivot.allowReshape).toBe(true);
    expect(out.pivot.reportLabel).toBe("Sales pivot");
  });

  it("executes the pivot report (P3.18): cells over the seeded Product's category × status", async () => {
    const server = await makeServerWithViews();
    const out = body(await server.dispatch(req("/ui/Store/pivot", "mgr")));
    expect(out.data.kind).toBe("pivot");
    expect(out.data.rowFields).toEqual(["category"]);
    // the one seeded Product (category "home", status "active") → one cell, count 1
    const cell = out.data.cells.find((c: { rowKey: string[]; colKey: string[] }) => c.rowKey[0] === "home" && c.colKey[0] === "active");
    expect(cell.values.n).toBe(1);
  });

  it("404s an entity with no pivot view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/ui/Product/pivot", "mgr"))).status).toBe(404);
  });
});

describe("GET /app/...?__state=1 — SPA navigation (WebPageState JSON)", () => {
  it("returns the WebPageState as JSON instead of HTML", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/app/Product?__state=1", "mgr"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const state = body(res);
    expect(state.kind).toBe("table");
    expect(state.table.entity).toBe("Product");
    expect(state.rows[0].sku).toBe("ABC-1");
    // it is NOT an HTML document
    expect(htmlBody(res).startsWith("<!doctype html>")).toBe(false);
  });

  it("a detail __state carries the RBAC affordance flags + the redacted record", async () => {
    const server = await makeServer();
    const mgr = body(await server.dispatch(req("/app/Product/p1?__state=1", "mgr")));
    expect(mgr.kind).toBe("detail");
    expect(mgr.canEdit).toBe(true); // store_manager may update Product
    expect(mgr.canDelete).toBe(false); // delete is admin-only
    expect(mgr.record.unit_cost).toBe(4.2);

    const csh = body(await server.dispatch(req("/app/Product/p1?__state=1", "csh")));
    expect(csh.canEdit).toBe(false);
    expect("unit_cost" in csh.record).toBe(false);
  });

  it("still serves HTML without the flag", async () => {
    const server = await makeServer();
    const res = await server.dispatch(req("/app/Product", "mgr"));
    expect(res.headers["content-type"]).toContain("text/html");
    expect(htmlBody(res).startsWith("<!doctype html>")).toBe(true);
  });
});

describe("GET /app/:entity/kanban — SSR board page", () => {
  it("renders the board HTML with the seeded card; a manager sees unit_cost, a cashier doesn't", async () => {
    const server = await makeServerWithViews();
    const mgr = await server.dispatch(req("/app/Product/kanban", "mgr"));
    expect(mgr.status).toBe(200);
    expect(mgr.headers["content-type"]).toContain("text/html");
    const mgrHtml = htmlBody(mgr);
    expect(mgrHtml).toContain("ce-kanban");
    expect(mgrHtml).toContain('data-state="active"');
    expect(mgrHtml).toContain("4.2"); // unit_cost on the card

    const csh = htmlBody(await server.dispatch(req("/app/Product/kanban", "csh")));
    expect(csh).toContain("ce-kanban");
    expect(csh).not.toContain("4.2");
  });

  it("404s an entity with no kanban view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/app/SalesOrder/kanban", "mgr"))).status).toBe(404);
  });
});

describe("GET /app/:entity/calendar — SSR agenda page", () => {
  it("renders the calendar HTML for a declared view", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/app/SalesOrder/calendar", "mgr"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(htmlBody(res)).toContain("ce-calendar");
  });

  it("404s an entity with no calendar view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/app/Product/calendar", "mgr"))).status).toBe(404);
  });
});

describe("GET /app/:entity/{map,dashboard,pivot} — SSR pages", () => {
  it("renders the map marker-list page", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/app/Product/map", "mgr"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(htmlBody(res)).toContain("ce-map");
  });

  it("renders the dashboard grid page with the executed kpi value (P3.20)", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/app/Store/dashboard", "mgr"));
    expect(res.status).toBe(200);
    const html = htmlBody(res);
    expect(html).toContain("ce-dashboard");
    // the kpi report counts the one seeded Product → the value is rendered inline
    expect(html).toContain("ce-report-kpi");
    expect(html).toContain(">1<");
  });

  it("renders the pivot page", async () => {
    const server = await makeServerWithViews();
    const res = await server.dispatch(req("/app/Store/pivot", "mgr"));
    expect(res.status).toBe(200);
    expect(htmlBody(res)).toContain("ce-pivot");
  });

  it("404s an entity without the declared view", async () => {
    const server = await makeServerWithViews();
    expect((await server.dispatch(req("/app/SalesOrder/map", "mgr"))).status).toBe(404);
    expect((await server.dispatch(req("/app/Product/dashboard", "mgr"))).status).toBe(404);
  });
});

describe("POST /ui/:entity/:id/transition — workflow transition (RBAC + from-state)", () => {
  async function seedOrder(server: OperateWebServer): Promise<void> {
    await server.entityStore.create(TENANT, "SalesOrder", { id: "o1", state: "cart", order_number: "SO-1", currency: "AED" });
  }

  it("a cashier fires place (cart -> placed), authorized by the transition grant", async () => {
    const server = await makeServer();
    await seedOrder(server);
    const res = await server.dispatch(writeReq("POST", "/ui/SalesOrder/o1/transition", "csh", { transition: "place" }));
    expect(res.status).toBe(200);
    expect(body(res).record.state).toBe("placed");
  });

  it("a cashier cannot fire fulfill (managers only) — 403", async () => {
    const server = await makeServer();
    await seedOrder(server);
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/o1/transition", "csh", { transition: "fulfill" }))).status).toBe(403);
  });

  it("409s an invalid from-state (fulfill requires placed, the order is in cart)", async () => {
    const server = await makeServer();
    await seedOrder(server);
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/o1/transition", "mgr", { transition: "fulfill" }))).status).toBe(409);
  });

  it("404s an unknown transition name", async () => {
    const server = await makeServer();
    await seedOrder(server);
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/o1/transition", "mgr", { transition: "teleport" }))).status).toBe(404);
  });

  it("400s a body without a transition name", async () => {
    const server = await makeServer();
    await seedOrder(server);
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/o1/transition", "mgr", {}))).status).toBe(400);
  });
});

describe("write method guards", () => {
  it("405s an unsupported method", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("PUT", "/ui/Product", "mgr", {}))).status).toBe(405);
  });

  it("405s a write to an /app/* HTML page", async () => {
    const server = await makeServer();
    expect((await server.dispatch(writeReq("POST", "/app/Product", "mgr", {}))).status).toBe(405);
  });

  it("401s a write without a credential", async () => {
    const server = await makeServer();
    const res = await server.dispatch({ method: "POST", url: "/ui/Product", headers: {}, body: new TextEncoder().encode("{}") });
    expect(res.status).toBe(401);
  });
});
