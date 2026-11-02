import { readFileSync } from "node:fs";

import { generateEd25519Keypair } from "@crossengin/crypto";
import { InMemoryEntityStore, LicenseEntitlementResolver, signLicense } from "@crossengin/operate-runtime";
import { buildProfileFromTemplate } from "@crossengin/residency";
import { InMemoryTenantResidencyDirectory } from "@crossengin/residency-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

const API_KEYS = [
  parseApiKeySpec(`key-cashier:cashier:${TENANT}`),
  parseApiKeySpec(`key-manager:store_manager:${TENANT}`),
];

function makeServer(): OperateHttpServer {
  const { httpServer } = buildOperateHttpServer({
    edgeTrust: "untrusted",
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: API_KEYS,
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  });
  return httpServer;
}

function req(method: string, url: string, key: string): RawHttpRequest {
  return { method, url, headers: { "x-api-key": key, host: "api.example.com" }, remoteAddress: "203.0.113.1" };
}

function jsonBody(method: string, url: string, key: string, body: unknown): { raw: RawHttpRequest; bytes: Uint8Array } {
  return {
    raw: {
      method,
      url,
      headers: { "x-api-key": key, host: "api.example.com", "content-type": "application/json" },
      remoteAddress: "203.0.113.1",
    },
    bytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function parse(body: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as Record<string, unknown>;
}

const PRODUCT = {
  sku: "SKU-1",
  name: "Milk",
  unit_price: 2,
  unit_cost: 1.1,
  status: "active",
  category: "grocery",
};

describe("OperateHttpServer — serving a pack over raw HTTP", () => {
  it("rejects an unknown HTTP method with 405", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("BREW", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(405);
    expect(res.headers["content-type"]).toContain("problem+json");
  });

  it("401s a request with no/unknown API key", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("GET", "/v1/products", "key-nobody"), null);
    expect(res.status).toBe(401);
  });

  it("creates a product (manager) then lists it back", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", PRODUCT);
    const created = await server.dispatch(raw, bytes);
    expect(created.status).toBe(201);
    expect(typeof parse(created.body)["id"]).toBe("string");

    const list = await server.dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(list.status).toBe(200);
    const rows = parse(list.body)["data"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // `unit_cost` is `decimal(12, 2)`: it leaves the gateway as its canonical wire string.
    expect(rows[0]).toMatchObject({ sku: "SKU-1", unit_cost: "1.10" });
  });

  it("redacts unit_cost for a cashier but not a manager (same route)", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", PRODUCT);
    await server.dispatch(raw, bytes);

    const cashier = await server.dispatch(req("GET", "/v1/products", "key-cashier"), null);
    const cashierRows = parse(cashier.body)["data"] as Array<Record<string, unknown>>;
    expect(cashierRows[0]).not.toHaveProperty("unit_cost");
    expect(cashierRows[0]).toMatchObject({ sku: "SKU-1" });

    const manager = await server.dispatch(req("GET", "/v1/products", "key-manager"), null);
    const managerRows = parse(manager.body)["data"] as Array<Record<string, unknown>>;
    expect(managerRows[0]).toHaveProperty("unit_cost", "1.10");
  });

  it("denies a cashier creating a product with 403", async () => {
    const server = makeServer();
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-cashier", PRODUCT);
    const res = await server.dispatch(raw, bytes);
    expect(res.status).toBe(403);
  });

  it("decodes a query string into the gateway request (does not 404 on ?cursor=)", async () => {
    const server = makeServer();
    const res = await server.dispatch(req("GET", "/v1/products?limit=10&cursor=abc", "key-manager"), null);
    expect(res.status).toBe(200);
  });

  it("paginates over HTTP: ?limit drives the page + an opaque nextCursor (P1.8)", async () => {
    const server = makeServer();
    for (const p of [
      { sku: "A", name: "Apple" },
      { sku: "B", name: "Banana" },
      { sku: "C", name: "Cherry" },
    ]) {
      const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", {
        ...p,
        unit_price: 1,
        unit_cost: 0.5,
        status: "active",
        category: "grocery",
      });
      await server.dispatch(raw, bytes);
    }

    const first = await server.dispatch(req("GET", "/v1/products?limit=2", "key-manager"), null);
    const firstBody = parse(first.body);
    expect((firstBody["data"] as unknown[]).length).toBe(2);
    const page = firstBody["page"] as { nextCursor: string | null; limit: number };
    expect(page.limit).toBe(2);
    expect(page.nextCursor).not.toBeNull();

    const second = await server.dispatch(
      req("GET", `/v1/products?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`, "key-manager"),
      null,
    );
    const secondBody = parse(second.body);
    expect((secondBody["data"] as unknown[]).length).toBe(1);
    expect((secondBody["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });
});

describe("OperateHttpServer — offline license entitlement gate", () => {
  function licensedServer(status: "active" | "canceled"): OperateHttpServer {
    const { publicKeyBase64, privateKeyBase64 } = generateEd25519Keypair();
    const token = signLicense(privateKeyBase64, publicKeyBase64, {
      tenantId: TENANT,
      status,
      planId: "pro",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const { httpServer } = buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      entitlementResolver: new LicenseEntitlementResolver(token, publicKeyBase64, {
        now: () => new Date("2026-06-03T12:00:00.000Z"),
      }),
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    return httpServer;
  }

  it("serves a tenant with a valid active license", async () => {
    const res = await licensedServer("active").dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(200);
  });

  it("denies a tenant whose license status is canceled with 402", async () => {
    const res = await licensedServer("canceled").dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(402);
    expect(parse(res.body).reason).toBe("subscription_canceled");
  });

  it("denies when the license is for a different tenant (public key still valid)", async () => {
    const { publicKeyBase64, privateKeyBase64 } = generateEd25519Keypair();
    const token = signLicense(privateKeyBase64, publicKeyBase64, {
      tenantId: "99999999-9999-4999-8999-999999999999",
      status: "active",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const { httpServer } = buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      entitlementResolver: new LicenseEntitlementResolver(token, publicKeyBase64, {
        now: () => new Date("2026-06-03T12:00:00.000Z"),
      }),
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    const res = await httpServer.dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(402);
    expect(parse(res.body).reason).toBe("no_subscription");
  });
});

describe("OperateHttpServer — webhook route (signature-authenticated, bypasses the gateway)", () => {
  function serverWithWebhook() {
    const calls: Array<{ body: string; sig: string | undefined }> = [];
    const { httpServer } = buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      webhookRoute: {
        method: "POST",
        path: "/v1/webhooks/stripe",
        handle: async (body, headers) => {
          calls.push({
            body: new TextDecoder().decode(body ?? new Uint8Array()),
            sig: (headers["stripe-signature"] as string | undefined),
          });
          const bytes = new TextEncoder().encode(JSON.stringify({ received: true }));
          return { status: 200, headers: { "content-type": "application/json" }, body: bytes };
        },
      },
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    return { httpServer, calls };
  }

  it("routes a POST to the webhook path directly, without an API key", async () => {
    const { httpServer, calls } = serverWithWebhook();
    const raw: RawHttpRequest = {
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { host: "api.example.com", "stripe-signature": "t=1,v1=abc" },
      remoteAddress: "203.0.113.1",
    };
    const res = await httpServer.dispatch(raw, new TextEncoder().encode('{"type":"customer.subscription.updated"}'));
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ received: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sig).toBe("t=1,v1=abc");
    expect(calls[0]!.body).toContain("customer.subscription.updated");
  });

  it("does not intercept a different method on the same path (falls through to the gateway)", async () => {
    const { httpServer, calls } = serverWithWebhook();
    const res = await httpServer.dispatch(req("GET", "/v1/webhooks/stripe", "key-manager"), null);
    expect(calls).toHaveLength(0); // webhook is POST-only
    expect(res.status).not.toBe(200); // no such gateway route → 4xx
  });
});

describe("OperateHttpServer — data-residency edge routing", () => {
  const euOnly = buildProfileFromTemplate("eu-only", { establishedAt: "2026-01-01T00:00:00.000Z" });

  function regionServer(region: string): OperateHttpServer {
    const directory = new InMemoryTenantResidencyDirectory([[TENANT, euOnly]]);
    const { httpServer } = buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      regionGuard: { region: region as never, directory },
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    return httpServer;
  }

  function reqWithTenant(url: string, key: string, tenantHint?: string): RawHttpRequest {
    const headers: Record<string, string> = { "x-api-key": key, host: "api.example.com" };
    if (tenantHint !== undefined) headers["x-tenant-id"] = tenantHint;
    return { method: "GET", url, headers, remoteAddress: "203.0.113.1" };
  }

  it("redirects (421) an eu-only tenant hitting a forbidden region, naming the home region", async () => {
    const res = await regionServer("us-east").dispatch(reqWithTenant("/v1/products", "key-manager", TENANT), null);
    expect(res.status).toBe(421);
    expect(res.headers["x-crossengin-region"]).toBe("eu-central");
    expect(parse(res.body).extensions).toMatchObject({ correctRegion: "eu-central" });
  });

  it("serves the tenant in an allowed region (guard proceeds to the gateway)", async () => {
    const res = await regionServer("eu-central").dispatch(reqWithTenant("/v1/products", "key-manager", TENANT), null);
    expect(res.status).toBe(200);
  });

  it("proceeds when no tenant hint is present (routing needs a hint)", async () => {
    const res = await regionServer("us-east").dispatch(reqWithTenant("/v1/products", "key-manager"), null);
    expect(res.status).toBe(200);
  });

  it("proceeds for a tenant with no residency profile (unconstrained)", async () => {
    // Empty directory → the tenant has no profile → the guard doesn't constrain it, even in a
    // region that would be forbidden for an eu-only tenant. The hint matches the key's tenant.
    const { httpServer } = buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      regionGuard: { region: "us-east" as never, directory: new InMemoryTenantResidencyDirectory() },
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    const res = await httpServer.dispatch(reqWithTenant("/v1/products", "key-manager", TENANT), null);
    expect(res.status).toBe(200);
  });
});

/**
 * The sibling of `compile.test.ts`' option-forwarding fence, one hop out.
 *
 * That one reads `compile.ts` as text and asserts every option `buildOperateGateway` accepts and
 * `GatewayRuntime` also accepts appears in the `new GatewayRuntime({…})` literal. It was written
 * because ADR-0386's fix was silently dropped at exactly such a literal, and the drop was invisible
 * three ways at once: the caller passes its options inside a conditional **spread**, which bypasses
 * TypeScript's excess-property check; the field is optional on the target; and its default there was
 * the strict one, so the drop produced a *safe* wrong answer rather than a crash.
 *
 * `buildOperateHttpServer` → `buildOperateGateway` is the hop before it, and it is covered **per
 * field and not as a class**: `node.test.ts`' *"is forwarded on again by buildOperateHttpServer,
 * which is the unfenced hop"* pins `allowUncoveredSettlement` by name and says in so many words
 * that the general rule is somebody else's open end. This is that rule. The two compose rather than
 * duplicating — a per-field pin belongs with the wiring chain it is part of, which is why it is in
 * `node.test.ts`, and the class belongs with the literal it is about, which is here.
 *
 * It is ADR-0386's shape with one difference that makes it worse: `allowUncoveredSettlement`
 * defaults to `false` in the compiler, and `false` means **the settlement-coverage guard is not
 * built** — so dropping that spread fails in the *permissive* direction, where ADR-0386's dropped
 * field failed in the strict one. Measured by deleting the three-line spread: `tsc` exits **0**,
 * and **2** of this app's 5,080 tests fail — this fence and that per-field pin, which is the pair
 * doing its job rather than one covering for the other. And the boot line is unaffected by
 * construction, because `node.ts` hands the flag to `surveySettlementCoverage` directly: the survey
 * reads the flag and the guard list is built one hop further in, so a deployment would be told
 * `2 of 3 guarded` with nothing guarded.
 *
 * The unit is the **intersection** of the two interfaces' field names rather than everything the
 * app accepts, which is what keeps it free of a maintained list: only a shared field can be dropped
 * here, and a `notForwarded` map in `compile.test.ts`'s shape would need an entry for every
 * app-only option — ADR-0288's lesson being that such a list is the thing that goes wrong.
 *
 * **Do not restate the three counts here.** The figures move with every option added on either
 * side: this sentence read "the app has 29 options and the gateway 30, 16 are shared" and was 34 /
 * 35 / 18 two increments later, so a reader checking the comment would have found it wrong about
 * all three. The floors below are one-sided for exactly that reason, and the intersection is
 * re-derived on every run — print it from the test if you want today's number.
 *
 * `compile.ts` is read by relative path as **text**, which is the idiom `deployment-defaults.test.ts`
 * in this app already uses for `deploy/`: no build output is consulted, so the fence answers on a
 * fresh checkout, and a path that stopped resolving fails by name rather than silently emptying the
 * population.
 */
/**
 * The two surveys that used to run only at boot, now run wherever a manifest is compiled.
 *
 * `serve()` surveyed the boot pack and printed `[fields]` and `[cursor]`; a tenant's own activated
 * manifest is compiled **inside this function** (ADR-0314) and was surveyed by nothing, so
 * ADR-0339's write-open/read-closed asymmetry and ADR-0357's cursor disclosure were measured for
 * the boot pack and for nothing a tenant ever authored.
 *
 * The register prescribed `applyTenantManifestSchema` and that is refuted: its only caller is
 * built solely under `--store pg-columns` and the shipped compose is `--store pg`, so the check
 * would have been dark on the deployment that ships. This function is reached on every store.
 */
describe("buildOperateHttpServer's manifest surveys", () => {
  function build(over: Partial<Parameters<typeof buildOperateHttpServer>[0]> = {}): void {
    buildOperateHttpServer({
      edgeTrust: "untrusted",
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      ...over,
    });
  }

  it("reports both surveys to onSurvey, over the manifest it was handed", () => {
    const reports: { sensitive: unknown; cursorDisclosure: unknown }[] = [];
    build({
      onSurvey: (r) => {
        reports.push(r);
      },
    });
    expect(reports).toHaveLength(1);
    const r = reports[0] as {
      sensitive: { totalSensitive: number };
      cursorDisclosure: { verdict: string };
    };
    // `erp-retail` declares classified fields and a sortable classified one, so both halves have a
    // member — a survey over a manifest with neither would pass vacuously.
    expect(r.sensitive.totalSensitive).toBeGreaterThan(0);
    expect(r.cursorDisclosure.verdict).toBe("plaintext_disclosing");
  });

  it("reports the cursor as sealed when the deployment supplies a sealing mode", () => {
    // The same manifest, two answers — which is what makes the report a fact about the DEPLOYMENT
    // and the manifest together rather than about the manifest alone.
    const seen: string[] = [];
    build({
      cursorSealing: { mode: "sealed", sealer: null },
      onSurvey: (r) => {
        seen.push(r.cursorDisclosure.verdict);
      },
    });
    expect(seen).toEqual(["sealed"]);
  });

  it("surveys nothing when nobody reads it", () => {
    // ADR-0341's rule — the producer exists exactly when a consumer does. Not a micro-optimisation:
    // `serve()` surveys the boot manifest itself before this function is reached, because
    // `--classified-write-mask`'s refusal has to fire before anything mounts, so running the
    // surveys here unconditionally would survey the boot pack twice and report it once.
    //
    // The observable is a DELTA and not zero, which is what the first draft of this test asserted
    // and what measuring it refuted: `policyForEntity` has **two** consumers — the redaction
    // registry `buildOperateGateway` builds also resolves it, once per entity that carries a
    // classified field — so "never consulted" was never available. The survey's contribution is
    // one call per entity of the manifest, which is derived here rather than hardcoded.
    const count = (withSurvey: boolean): number => {
      let calls = 0;
      build({
        policyForEntity: () => {
          calls += 1;
          return undefined;
        },
        ...(withSurvey ? { onSurvey: (): undefined => undefined } : {}),
      });
      return calls;
    };
    const entities = (manifest.entities ?? []).length;
    expect(entities).toBeGreaterThan(1);
    expect(count(true) - count(false)).toBe(entities);
  });

  it("consults policyForEntity per entity when a reader is supplied", () => {
    // Per entity and not once with `""`, which is what `surveySensitiveFields` did when it took a
    // declaration. The seam's type permits per-entity variation, its own doc says a per-entity
    // declaration is "expressible later without moving it", and a deployment may supply its own
    // resolver — asked per entity, the survey is right for all three.
    const asked: string[] = [];
    build({
      policyForEntity: (entity) => {
        asked.push(entity);
        return undefined;
      },
      onSurvey: () => undefined,
    });
    // Real entity names, not the empty string the old call passed — which is the whole change.
    expect(asked).not.toContain("");
    // Every entity is asked about. Not an exact set equality, because the redaction registry asks
    // too and its population is the classified-field-bearing subset, so `asked` legitimately
    // carries repeats (measured: 66 calls over 54 entities, the 12 extra being the registry's).
    for (const e of manifest.entities ?? []) expect(asked).toContain(e.name);
  });

  it("reports and never refuses, whatever the surveys find", () => {
    // The one way these differ from the obligation check beside them. A write-open/read-closed
    // field is a capability answer and a plaintext cursor is `CURSOR_DISCLOSURE_MAY_SERVE`-true on
    // every verdict, so a tenant whose manifest has either still gets a working gateway — refusing
    // would take a tenant's whole deployment away over a declaration activation validates
    // (ADR-0348's split).
    expect(() =>
      build({
        onSurvey: () => undefined,
      }),
    ).not.toThrow();
  });
});

describe("buildOperateHttpServer's option forwarding", () => {
  const serverSrc = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const compileSrc = readFileSync(
    new URL("../../../packages/operate-runtime/src/compile.ts", import.meta.url),
    "utf8",
  );

  /** The field names declared on an interface, by name, from the source. */
  function interfaceFields(text: string, name: string): readonly string[] {
    const start = text.indexOf(`export interface ${name} `);
    expect(start, `interface ${name} not found`).toBeGreaterThan(-1);
    const open = text.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return [...text.slice(open, end).matchAll(/^\s{2}readonly (\w+)\??:/gm)].map(
      (m) => m[1] as string,
    );
  }

  const accepted = interfaceFields(serverSrc, "BuildOperateHttpServerOptions");
  const gatewayAccepts = new Set([
    ...interfaceFields(compileSrc, "OperateGatewayOptions"),
    ...interfaceFields(compileSrc, "OperateRuntimeOptions"),
  ]);
  const shared = accepted.filter((f) => gatewayAccepts.has(f)).sort();

  it("forwards every option it shares with the gateway", () => {
    const call = serverSrc.indexOf("buildOperateGateway(options.manifest, {");
    expect(call, "the buildOperateGateway call moved").toBeGreaterThan(-1);
    const literal = serverSrc.slice(call, serverSrc.indexOf("\n  });", call));
    expect(literal.length, "the forwarding literal read as empty").toBeGreaterThan(500);

    const dropped = shared.filter((f) => !new RegExp(`\\b${f}\\b`).test(literal));
    expect(
      dropped,
      `these options reach buildOperateHttpServer, are accepted by buildOperateGateway, and are ` +
        `not forwarded to it — so they are silently discarded`,
    ).toEqual([]);
  });

  it("reads both interfaces, so the assertion above is not vacuous", () => {
    // Floors on both sides and on the intersection, because this fence's whole failure mode is a
    // reader that stopped matching: an empty `shared` makes the assertion above pass over nothing.
    expect(accepted.length, "BuildOperateHttpServerOptions read as empty").toBeGreaterThan(20);
    expect(gatewayAccepts.size, "the gateway's option interfaces read as empty").toBeGreaterThan(20);
    expect(shared.length, "the shared option set read as empty").toBeGreaterThanOrEqual(16);
    // And the member this fence was written for is in it.
    expect(shared).toContain("allowUncoveredSettlement");
  });
});
