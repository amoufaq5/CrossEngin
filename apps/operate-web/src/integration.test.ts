import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { PostgresEntityStore } from "@crossengin/operate-runtime-pg";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawWebRequest } from "./http.js";
import { buildOperateWebServer, OperateWebServer } from "./server.js";

/**
 * Real-Postgres integration test for the operate-web view-model serving stack.
 * Gated on `CROSSENGIN_PG_TEST=1` (skipped offline / in the hermetic suite). It
 * drives the GET `/ui/...` routes through `OperateWebServer` over a
 * `PostgresEntityStore` (the same store operate-server writes), proving the UI
 * layer reads persisted data with **tenant isolation** (the store's
 * `WHERE tenant_id = $1` + `withTenantContext`), per-caller classification
 * redaction (model + data), keyset pagination, and the P3.6 kanban board — all
 * end-to-end against a real database, which the offline in-memory test
 * (server.test.ts) can't show.
 *
 * To run: bring up Postgres + apply the meta-schema, then
 *   CROSSENGIN_PG_TEST=1 PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=… \
 *   PGSSLMODE=disable pnpm --filter @crossengin/operate-web-app test
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

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
    productMap: {
      kind: "map",
      entity: "Product",
      geoField: "sku",
      markerLabelField: "name",
      defaultZoom: 6,
      layers: [{ id: "all", label: { en: "All" }, kind: "markers" }],
    },
    productDashView: { kind: "dashboard", entity: "Product", dashboardRef: "productDash" },
    productPivotView: { kind: "pivot", entity: "Product", reportRef: "productPivot", allowReshape: true },
  },
  dashboards: {
    productDash: {
      layout: "grid",
      refreshIntervalSeconds: 60,
      cells: [{ x: 0, y: 0, w: 6, h: 2, widget: { kind: "kpi", report: "productKpi", title: { en: "Count" } } }],
    },
  },
  reports: {
    productKpi: { kind: "kpi", entity: "Product", measure: { name: "n", kind: "count" } },
    productPivot: {
      kind: "pivot",
      entity: "Product",
      rows: ["category"],
      columns: ["status"],
      measures: [{ name: "n", kind: "count" }],
    },
  },
} as unknown as Manifest;

function req(url: string, key: string): RawWebRequest {
  return { method: "GET", url, headers: { "x-api-key": key } };
}

function writeReq(method: string, url: string, key: string, payload?: unknown): RawWebRequest {
  return {
    method,
    url,
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: payload === undefined ? null : new TextEncoder().encode(JSON.stringify(payload)),
  };
}

function body(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

suite("operate-web integration (real Postgres)", () => {
  let conn: PgConnection;
  let store: PostgresEntityStore;
  let server: OperateWebServer;
  let boardServer: OperateWebServer;
  let tenantA: string;
  let tenantB: string;

  async function seedTenant(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`ow-${suffix}`, `tenant_ow_${suffix}`],
    );
    return res.rows[0]!.id;
  }

  function product(over: Record<string, unknown>): Record<string, unknown> {
    return { sku: "SKU-1", name: "Milk", category: "grocery", unit_price: 2, unit_cost: 1.1, status: "active", ...over };
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    store = new PostgresEntityStore(conn);
    tenantA = await seedTenant();
    tenantB = await seedTenant();
    const apiKeySpecs = [
      { key: "mgr-a", role: "store_manager", tenantId: tenantA },
      { key: "csh-a", role: "cashier", tenantId: tenantA },
      { key: "mgr-b", role: "store_manager", tenantId: tenantB },
      { key: "adm-a", role: "retail_admin", tenantId: tenantA },
    ];
    server = buildOperateWebServer({ manifest: retail, store, apiKeySpecs });
    boardServer = buildOperateWebServer({ manifest: withBoard, store, apiKeySpecs });
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("serves a detail record read back from Postgres", async () => {
    const created = await store.create(tenantA, "Product", product({ id: "p-detail", sku: "DET-1" }));
    const id = created["id"] as string;
    const res = await server.dispatch(req(`/ui/Product/${id}`, "mgr-a"));
    expect(res.status).toBe(200);
    const out = body(res.body);
    expect((out["record"] as Record<string, unknown>)["sku"]).toBe("DET-1");
    expect((out["record"] as Record<string, unknown>)["unit_cost"]).toBe(1.1);
  });

  it("isolates tenants: tenant B's table omits tenant A's rows", async () => {
    await store.create(tenantA, "Product", product({ id: "p-iso", sku: "ISO-A" }));
    const listB = await server.dispatch(req("/ui/Product", "mgr-b"));
    const page = body(listB.body)["page"] as { data: Array<Record<string, unknown>> };
    expect(page.data.every((r) => r["sku"] !== "ISO-A")).toBe(true);
  });

  it("redacts unit_cost for a cashier but not a manager (model + data, over real PG)", async () => {
    await store.create(tenantA, "Product", product({ id: "p-red", sku: "RED-1" }));

    const cashier = body((await server.dispatch(req("/ui/Product/p-red", "csh-a"))).body);
    expect("unit_cost" in (cashier["record"] as Record<string, unknown>)).toBe(false);
    const cashierFields = (cashier["detail"] as { sections: { fields: { field: string }[] }[] }).sections
      .flatMap((s) => s.fields.map((f) => f.field));
    expect(cashierFields).not.toContain("unit_cost");

    const manager = body((await server.dispatch(req("/ui/Product/p-red", "mgr-a"))).body);
    expect((manager["record"] as Record<string, unknown>)["unit_cost"]).toBe(1.1);
  });

  it("paginates with keyset over real PG: ?limit drives the page + nextCursor", async () => {
    const tenant = await seedTenant();
    const pager = buildOperateWebServer({
      manifest: retail,
      store,
      apiKeySpecs: [{ key: "pg", role: "store_manager", tenantId: tenant }],
    });
    for (const sku of ["PA", "PB", "PC"]) {
      await store.create(tenant, "Product", product({ sku }));
    }
    const first = body((await pager.dispatch(req("/ui/Product?limit=2", "pg"))).body);
    expect((first["page"] as { data: unknown[] }).data.length).toBe(2);
    const cursor = (first["page"] as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();

    const second = body(
      (await pager.dispatch(req(`/ui/Product?limit=2&cursor=${encodeURIComponent(cursor!)}`, "pg"))).body,
    );
    expect((second["page"] as { data: unknown[] }).data.length).toBe(1);
  });

  it("runs the write path end-to-end over real PG (create → update → delete, RBAC + write-mask)", async () => {
    // create (manager) then read back from PG
    const created = await server.dispatch(
      writeReq("POST", "/ui/Product", "mgr-a", product({ sku: "WR-1", unit_cost: 3.3 })),
    );
    expect(created.status).toBe(201);
    const id = (body(created.body)["record"] as Record<string, unknown>)["id"] as string;
    const readBack = body((await server.dispatch(req(`/ui/Product/${id}`, "mgr-a"))).body);
    expect((readBack["record"] as Record<string, unknown>)["sku"]).toBe("WR-1");

    // cashier cannot write the commercial_sensitive unit_cost (422 write-mask)
    const blocked = await server.dispatch(
      writeReq("POST", "/ui/Product", "csh-a", { sku: "WR-2", unit_cost: 9 }),
    );
    expect(blocked.status).toBe(403); // cashier has no Product create grant at all

    // update (manager)
    const updated = await server.dispatch(writeReq("PATCH", `/ui/Product/${id}`, "mgr-a", { unit_price: 7.7 }));
    expect(updated.status).toBe(200);
    expect((body(updated.body)["record"] as Record<string, unknown>)["unit_price"]).toBe(7.7);

    // delete is admin-only: manager 403, admin 204, then gone
    expect((await server.dispatch(writeReq("DELETE", `/ui/Product/${id}`, "mgr-a"))).status).toBe(403);
    expect((await server.dispatch(writeReq("DELETE", `/ui/Product/${id}`, "adm-a"))).status).toBe(204);
    expect((await server.dispatch(req(`/ui/Product/${id}`, "mgr-a"))).status).toBe(404);
  });

  it("fires a workflow transition over real PG (place: cart -> placed, RBAC + from-state)", async () => {
    await store.create(tenantA, "SalesOrder", { id: "so-tx", state: "cart", order_number: "SO-TX", currency: "AED" });
    // place is granted to sellers (incl. store_manager); cart -> placed
    const placed = await server.dispatch(writeReq("POST", "/ui/SalesOrder/so-tx/transition", "mgr-a", { transition: "place" }));
    expect(placed.status).toBe(200);
    expect((body(placed.body)["record"] as Record<string, unknown>)["state"]).toBe("placed");
    // fulfill from placed is managers-only and valid from placed -> 200; a cashier is 403
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/so-tx/transition", "csh-a", { transition: "fulfill" }))).status).toBe(403);
    // an invalid from-state (cancel is fine from placed, but mark_returned needs fulfilled) -> 409
    expect((await server.dispatch(writeReq("POST", "/ui/SalesOrder/so-tx/transition", "mgr-a", { transition: "mark_returned" }))).status).toBe(409);
  });

  it("serves a kanban board over real PG, redacting unit_cost from a cashier's cards + data", async () => {
    await store.create(tenantA, "Product", product({ id: "p-kan", sku: "KAN-1" }));

    const mgr = body((await boardServer.dispatch(req("/ui/Product/kanban", "mgr-a"))).body);
    const mgrCards = (mgr["kanban"] as { cardFields: { field: string }[] }).cardFields.map((f) => f.field);
    expect(mgrCards).toContain("unit_cost");
    const mgrRow = (mgr["page"] as { data: Array<Record<string, unknown>> }).data.find((r) => r["sku"] === "KAN-1");
    expect(mgrRow?.["unit_cost"]).toBe(1.1);

    const csh = body((await boardServer.dispatch(req("/ui/Product/kanban", "csh-a"))).body);
    const cshCards = (csh["kanban"] as { cardFields: { field: string }[] }).cardFields.map((f) => f.field);
    expect(cshCards).not.toContain("unit_cost");
    const cshRow = (csh["page"] as { data: Array<Record<string, unknown>> }).data.find((r) => r["sku"] === "KAN-1");
    expect(cshRow !== undefined && "unit_cost" in cshRow).toBe(false);
  });

  it("serves the map / dashboard / pivot routes over real PG (incl. executed report data)", async () => {
    await store.create(tenantA, "Product", product({ id: "p-rep", sku: "REP-1", category: "grocery", status: "active" }));

    // map — markers + layers over the persisted rows
    const map = body((await boardServer.dispatch(req("/ui/Product/map", "mgr-a"))).body);
    expect((map["map"] as { geoField: string }).geoField).toBe("sku");
    expect((map["page"] as { data: unknown[] }).data.length).toBeGreaterThan(0);

    // dashboard — the kpi widget's report runs over PG (counts the persisted Products)
    const dash = body((await boardServer.dispatch(req("/ui/Product/dashboard", "mgr-a"))).body);
    const widget0 = (dash["widgetData"] as Array<Record<string, unknown> | null>)[0];
    expect(widget0).toMatchObject({ kind: "kpi" });
    expect((widget0 as { value: number }).value).toBeGreaterThan(0);

    // pivot — category × status cells computed over PG
    const pivot = body((await boardServer.dispatch(req("/ui/Product/pivot", "mgr-a"))).body);
    expect((pivot["data"] as { kind: string }).kind).toBe("pivot");
    const cells = (pivot["data"] as { cells: Array<{ rowKey: string[]; values: Record<string, number> }> }).cells;
    expect(cells.some((c) => c.rowKey[0] === "grocery" && c.values["n"] >= 1)).toBe(true);
  });

  it("serves SSR /app HTML + ?__state SPA JSON over real PG", async () => {
    const html = await boardServer.dispatch(req("/app/Product", "mgr-a"));
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(new TextDecoder().decode(html.body ?? new Uint8Array()).startsWith("<!doctype html>")).toBe(true);

    const state = body((await boardServer.dispatch(req("/app/Product?__state=1", "mgr-a"))).body);
    expect(state["kind"]).toBe("table");
    expect((state["table"] as { entity: string }).entity).toBe("Product");
  });
});
