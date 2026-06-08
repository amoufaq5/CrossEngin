import { generateEd25519Keypair } from "@crossengin/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WebServeOptions } from "./cli.js";
import { buildJwtConfigFromOptions, serve, type RunningServer } from "./node.js";

const TENANT = "t1";

function baseOptions(overrides: Partial<WebServeOptions>): WebServeOptions {
  return {
    port: 0,
    pack: "erp-retail",
    manifestPath: null,
    apiKeys: [],
    jwksKeys: [],
    jwksFile: null,
    jwksUrl: null,
    jwtIssuer: null,
    jwtAudience: null,
    help: false,
    version: false,
    ...overrides,
  };
}

describe("buildJwtConfigFromOptions", () => {
  it("returns null when no JWKS source is configured", async () => {
    expect(await buildJwtConfigFromOptions(baseOptions({}))).toBeNull();
  });

  it("builds an in-memory provider from --jwks-key + issuer/audience", async () => {
    const kp = generateEd25519Keypair();
    const cfg = await buildJwtConfigFromOptions(
      baseOptions({
        jwksKeys: [`k1:${kp.publicKeyBase64}`],
        jwtIssuer: "https://idp/",
        jwtAudience: "https://api/",
      }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.issuer).toBe("https://idp/");
    expect(await cfg!.jwksProvider.getPublicKeyForKid("k1")).toBe(kp.publicKeyBase64);
  });

  it("builds a remote provider from --jwks-url", async () => {
    const cfg = await buildJwtConfigFromOptions(
      baseOptions({ jwksUrl: "https://idp/jwks", jwtIssuer: "https://idp/", jwtAudience: "https://api/" }),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.audience).toBe("https://api/");
  });
});

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
