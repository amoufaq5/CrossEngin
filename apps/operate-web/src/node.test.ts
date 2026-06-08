import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serve, type RunningServer } from "./node.js";

const TENANT = "t1";

let running: RunningServer;
let base: string;

beforeAll(async () => {
  running = await serve({
    port: 0,
    pack: "erp-retail",
    manifestPath: null,
    apiKeys: ["mgr:store_manager:t1", "csh:cashier:t1"],
    help: false,
    version: false,
  });
  base = `http://127.0.0.1:${running.port.toString()}`;
  // seed one Product into the in-memory store the server holds
  await running.webServer.entityStore.create(TENANT, "Product", {
    id: "p1",
    sku: "ABC-1",
    name: "Widget",
    category: "home",
    unit_price: 9.99,
    unit_cost: 4.2,
    status: "active",
  });
});

afterAll(async () => {
  await running.close();
});

describe("operate-web serve() loopback", () => {
  it("serves the app model over real HTTP (200)", async () => {
    const res = await fetch(`${base}/ui/app`, { headers: { "x-api-key": "mgr" } });
    expect(res.status).toBe(200);
    const app = (await res.json()) as { nav: { entity: string }[] };
    expect(app.nav.map((n) => n.entity)).toContain("Product");
  });

  it("401s an unauthenticated request", async () => {
    const res = await fetch(`${base}/ui/app`);
    expect(res.status).toBe(401);
  });

  it("a privileged caller's table data includes the classified unit_cost; an unprivileged caller's omits it", async () => {
    const mgr = await (await fetch(`${base}/ui/Product/p1`, { headers: { "x-api-key": "mgr" } })).json();
    const csh = await (await fetch(`${base}/ui/Product/p1`, { headers: { "x-api-key": "csh" } })).json();
    expect((mgr as { record: { unit_cost?: number } }).record.unit_cost).toBe(4.2);
    expect("unit_cost" in (csh as { record: Record<string, unknown> }).record).toBe(false);
  });
});
