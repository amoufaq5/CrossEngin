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

  it("emits the hydration scaffold: #root, embedded state, and the client script", async () => {
    const res = await fetch(`${base}/app/Product`, { headers: { "x-api-key": "mgr" } });
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("window.__OPERATE_WEB_STATE__ =");
    expect(html).toContain('<script src="/assets/operate-web-client.js" defer></script>');
    // the embedded state carries the table + the seeded row for client hydration
    expect(html).toContain('"kind":"table"');
    expect(html).toContain("ABC-1");
  });

  it("the embedded redacted state for a cashier omits the classified column", async () => {
    const mgrHtml = await (await fetch(`${base}/app/Product/p1`, { headers: { "x-api-key": "mgr" } })).text();
    const cshHtml = await (await fetch(`${base}/app/Product/p1`, { headers: { "x-api-key": "csh" } })).text();
    // the embedded state mirrors the visible markup: the manager's blob has the
    // classified value, the cashier's does not (redaction baked into the state)
    expect(mgrHtml).toContain('"unit_cost"');
    expect(mgrHtml).toContain("4.2");
    expect(cshHtml).not.toContain('"unit_cost"');
    expect(cshHtml).not.toContain("4.2");
  });

  it("escapes a </script> in the data so the embedded state can't break out", async () => {
    await running.webServer.entityStore.create(TENANT, "Product", {
      id: "xss",
      sku: "</script><script>alert(1)</script>",
      name: "Evil",
      category: "home",
      unit_price: 1,
      unit_cost: 1,
      status: "active",
    });
    const html = await (await fetch(`${base}/app/Product/xss`, { headers: { "x-api-key": "mgr" } })).text();
    // every real </script> is one of ours (the state script + the client script);
    // the data's </script> never appears literally — it's \u-escaped in the blob.
    const closes = html.match(/<\/script>/g) ?? [];
    expect(closes.length).toBe(2);
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("serves a helpful 503 for the client bundle when it isn't built", async () => {
    // the loopback server is built with the default loader; in the test
    // environment the on-disk bundle may or may not exist. Either way the route
    // resolves to JS (200) or a helpful notice (503) — never a 404/500.
    const res = await fetch(`${base}/assets/operate-web-client.js`);
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("javascript");
    } else {
      const body = await res.json();
      expect(body.detail).toContain("build:client");
    }
  });
});
