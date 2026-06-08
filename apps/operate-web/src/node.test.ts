import { generateEd25519Keypair } from "@crossengin/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WebServeOptions } from "./cli.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import { buildJwtConfigFromOptions, resolveJwtConfig, serve, type RunningServer } from "./node.js";

const TENANT = "t1";

function baseOptions(overrides: Partial<WebServeOptions>): WebServeOptions {
  return {
    port: 0,
    pack: "erp-retail",
    manifestPath: null,
    apiKeys: [],
    store: "memory",
    schema: null,
    jwksKeys: [],
    jwksFile: null,
    jwksUrl: null,
    jwksRefreshMs: null,
    jwtIssuer: null,
    jwtAudience: null,
    help: false,
    version: false,
    ...overrides,
  };
}

/** A deterministic scheduler that records every set/clear so a test can fire ticks by hand. */
class FakeScheduler implements IntervalScheduler {
  handlers = new Map<IntervalHandle, () => void>();
  cleared: IntervalHandle[] = [];
  private next = 0;
  setInterval(handler: () => void, _ms: number): IntervalHandle {
    const h = ++this.next;
    this.handlers.set(h, handler);
    return h;
  }
  clearInterval(handle: IntervalHandle): void {
    this.cleared.push(handle);
    this.handlers.delete(handle);
  }
  get scheduled(): number {
    return this.handlers.size + this.cleared.length;
  }
  fireAll(): void {
    for (const handler of this.handlers.values()) handler();
  }
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

describe("resolveJwtConfig — background JWKS poller", () => {
  // A stub fetch that returns an empty JWKS document — hermetic, no network.
  const stubFetch = async (): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => ({
    ok: true,
    status: 200,
    json: async () => ({ keys: [] }),
  });

  it("does not build a poller without a remote URL or without --jwks-refresh-ms", async () => {
    const noUrl = await resolveJwtConfig(
      baseOptions({ jwksKeys: ["k1:AAAA"], jwtIssuer: "i", jwtAudience: "a", jwksRefreshMs: 60000 }),
    );
    expect(noUrl.poller).toBeNull();
    const noInterval = await resolveJwtConfig(
      baseOptions({ jwksUrl: "https://idp/jwks", jwtIssuer: "i", jwtAudience: "a" }),
    );
    expect(noInterval.config).not.toBeNull();
    expect(noInterval.poller).toBeNull();
  });

  it("builds a poller for a remote URL + --jwks-refresh-ms and refreshes on start + tick", async () => {
    const scheduler = new FakeScheduler();
    let refreshes = 0;
    const fetch = async (): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
      refreshes += 1;
      return stubFetch();
    };
    const { config, poller } = await resolveJwtConfig(
      baseOptions({ jwksUrl: "https://idp/jwks", jwtIssuer: "i", jwtAudience: "a", jwksRefreshMs: 60000 }),
      { fetch, scheduler },
    );
    expect(config).not.toBeNull();
    expect(poller).not.toBeNull();
    poller!.start();
    // refreshOnStart fires one immediate tick; the interval fires more.
    await Promise.resolve();
    expect(scheduler.handlers.size).toBe(1);
    scheduler.fireAll();
    await Promise.resolve();
    expect(refreshes).toBeGreaterThanOrEqual(2);
    poller!.stop();
    expect(scheduler.cleared.length).toBe(1);
    expect(scheduler.handlers.size).toBe(0);
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
    store: "memory",
    schema: null,
    jwksKeys: [],
    jwksFile: null,
    jwksUrl: null,
    jwksRefreshMs: null,
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

describe("operate-web serve() starts + stops the JWKS poller", () => {
  it("starts the poller after listening (remote URL + interval) and stops it on close", async () => {
    const scheduler = new FakeScheduler();
    const fetch = async (): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [] }),
    });
    const handle = await serve(
      baseOptions({
        jwksUrl: "https://idp/jwks",
        jwtIssuer: "https://idp/",
        jwtAudience: "https://api/",
        jwksRefreshMs: 60000,
      }),
      { fetch, scheduler },
    );
    // The poller was started (its interval handler is registered).
    expect(scheduler.handlers.size).toBe(1);
    await handle.close();
    // close() stopped the poller (the interval was cleared).
    expect(scheduler.cleared.length).toBe(1);
    expect(scheduler.handlers.size).toBe(0);
  });
});
