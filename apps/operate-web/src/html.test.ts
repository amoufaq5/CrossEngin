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
    jwksKeys: [],
    jwksFile: null,
    jwksUrl: null,
    jwtIssuer: null,
    jwtAudience: null,
    help: false,
    version: false,
  });
  base = `http://127.0.0.1:${running.port.toString()}`;
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

describe("operate-web SSR HTML routes", () => {
  it("serves the app shell as text/html with a doctype + nav", async () => {
    const res = await fetch(`${base}/app`, { headers: { "x-api-key": "mgr" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('data-entity="Product"');
  });

  it("401s an unauthenticated HTML request", async () => {
    const res = await fetch(`${base}/app`);
    expect(res.status).toBe(401);
  });

  it("renders the entity table as HTML with the seeded row", async () => {
    const res = await fetch(`${base}/app/Product`, { headers: { "x-api-key": "mgr" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<table>");
    expect(html).toContain("ABC-1");
  });

  it("a manager's detail HTML contains the classified unit_cost; a cashier's omits it", async () => {
    const mgrRes = await fetch(`${base}/app/Product/p1`, { headers: { "x-api-key": "mgr" } });
    const cshRes = await fetch(`${base}/app/Product/p1`, { headers: { "x-api-key": "csh" } });
    expect(mgrRes.status).toBe(200);
    expect(cshRes.status).toBe(200);
    const mgrHtml = await mgrRes.text();
    const cshHtml = await cshRes.text();
    // both expose the readable sku
    expect(mgrHtml).toContain("ABC-1");
    expect(cshHtml).toContain("ABC-1");
    // only the manager's HTML carries the classified unit_cost label + value
    expect(mgrHtml).toContain("Unit cost");
    expect(mgrHtml).toContain("4.2");
    expect(cshHtml).not.toContain("Unit cost");
    expect(cshHtml).not.toContain("4.2");
  });

  it("renders the create form as HTML", async () => {
    const res = await fetch(`${base}/app/Product/new`, { headers: { "x-api-key": "mgr" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain('data-entity="Product"');
  });
});
