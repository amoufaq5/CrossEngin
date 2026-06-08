import { generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { asModuleWorker, buildEdgeFetchHandler, fetchToRaw, rawToFetchResponse } from "./edge.js";
import { buildJwksProvider } from "./jwks.js";
import type { JwtVerifyConfig } from "./principals.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

async function seededStore(): Promise<InMemoryEntityStore> {
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
  return store;
}

describe("fetchToRaw / rawToFetchResponse", () => {
  it("maps a Fetch Request → RawWebRequest with coalesced headers", () => {
    const raw = fetchToRaw(new Request("https://app.example/ui/app", { headers: { "x-api-key": "mgr" } }));
    expect(raw.method).toBe("GET");
    expect(raw.url).toBe("https://app.example/ui/app");
    expect(raw.headers["x-api-key"]).toBe("mgr");
  });

  it("maps a RawWebResponse → a real Response", async () => {
    const res = rawToFetchResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("buildEdgeFetchHandler — api key", () => {
  it("serves the app model (200) and redacts per caller, identical to the Node path", async () => {
    const { fetch } = buildEdgeFetchHandler({
      manifest: retail,
      store: await seededStore(),
      apiKeySpecs: [
        { key: "mgr", role: "store_manager", tenantId: TENANT },
        { key: "csh", role: "cashier", tenantId: TENANT },
      ],
    });

    const app = await (await fetch(new Request("https://app/ui/app", { headers: { "x-api-key": "mgr" } }))).json();
    expect((app as { nav: { entity: string }[] }).nav.map((n) => n.entity)).toContain("Product");

    // the redaction proof, end-to-end over genuine Request/Response
    const mgr = await (await fetch(new Request("https://app/ui/Product/p1", { headers: { "x-api-key": "mgr" } }))).json();
    const csh = await (await fetch(new Request("https://app/ui/Product/p1", { headers: { "x-api-key": "csh" } }))).json();
    expect((mgr as { record: { unit_cost?: number } }).record.unit_cost).toBe(4.2);
    expect("unit_cost" in (csh as { record: Record<string, unknown> }).record).toBe(false);
  });

  it("401s an unauthenticated request", async () => {
    const { fetch } = buildEdgeFetchHandler({ manifest: retail, apiKeySpecs: [] });
    const res = await fetch(new Request("https://app/ui/app"));
    expect(res.status).toBe(401);
  });

  it("exposes the module-worker { fetch } shape", async () => {
    const handler = buildEdgeFetchHandler({ manifest: retail, apiKeySpecs: [] });
    const worker = asModuleWorker(handler.fetch);
    expect(typeof worker.fetch).toBe("function");
    expect((await worker.fetch(new Request("https://app/ui/app"))).status).toBe(401);
  });
});

describe("buildEdgeFetchHandler — JWT", () => {
  const ISS = "https://idp/";
  const AUD = "https://api/";
  const KID = "k1";
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const NOW_S = Math.floor(NOW.getTime() / 1000);
  const keypair = generateEd25519Keypair();

  function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function mintJwt(claims: Record<string, unknown>): string {
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const sig = signEd25519(keypair.privateKeyBase64, keypair.publicKeyBase64, new TextEncoder().encode(signingInput));
    return `${signingInput}.${b64url(Buffer.from(sig, "base64"))}`;
  }

  async function handler() {
    const jwt: JwtVerifyConfig = {
      jwksProvider: buildJwksProvider([{ kid: KID, publicKeyBase64: keypair.publicKeyBase64 }]),
      issuer: ISS,
      audience: AUD,
    };
    return buildEdgeFetchHandler({ manifest: retail, store: await seededStore(), apiKeySpecs: [], jwt, now: () => NOW });
  }

  it("a valid store_manager JWT gets the classified unit_cost", async () => {
    const { fetch } = await handler();
    const token = mintJwt({
      iss: ISS,
      aud: AUD,
      sub: "u1",
      scope: "store_manager",
      tenant_id: TENANT,
      exp: NOW_S + 3600,
      nbf: NOW_S - 60,
    });
    const res = await fetch(new Request("https://app/ui/Product/p1", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { record: { unit_cost?: number } }).record.unit_cost).toBe(4.2);
  });

  it("a valid cashier JWT has unit_cost redacted (scope drives the role)", async () => {
    const { fetch } = await handler();
    const token = mintJwt({
      iss: ISS,
      aud: AUD,
      sub: "u2",
      scope: "cashier",
      tenant_id: TENANT,
      exp: NOW_S + 3600,
      nbf: NOW_S - 60,
    });
    const res = await fetch(new Request("https://app/ui/Product/p1", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect("unit_cost" in ((await res.json()) as { record: Record<string, unknown> }).record).toBe(false);
  });

  it("401s a wrong-issuer JWT — fail-closed", async () => {
    const { fetch } = await handler();
    const token = mintJwt({
      iss: "https://evil/",
      aud: AUD,
      sub: "u1",
      scope: "store_manager",
      tenant_id: TENANT,
      exp: NOW_S + 3600,
    });
    expect(
      (await fetch(new Request("https://app/ui/app", { headers: { authorization: `Bearer ${token}` } }))).status,
    ).toBe(401);
  });
});
