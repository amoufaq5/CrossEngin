import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  InMemoryPrincipalResolver,
  buildIncomingRequest,
  type OpaqueTokenLookup,
} from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { buildOperateGateway } from "./compile.js";
import { InMemoryEntityStore } from "./store.js";

// NOTE: this milestone proves the manifest -> routes -> gateway -> handler ->
// store -> classification-redaction chain for the READ path end-to-end through
// the real gateway pipeline. Two gateway-runtime gaps surface for the write
// path and are the documented P1.5 follow-up:
//   1. `parse_request` hashes the body but never populates `parsedBody`, so
//      handlers can't read POST/PATCH bodies through the pipeline.
//   2. a handler-returned 4xx/5xx is recorded with stage outcome "pass", which
//      trips the PipelineExecution "pass cannot be 4xx" invariant.
// Write/RBAC/lifecycle handler logic is covered directly in handlers.test.ts;
// here we seed via the store and exercise reads through the gateway.

const TENANT = "00000000-0000-4000-8000-000000000001";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolved = await resolveManifest(buildErpRetailPack(), { registry });

const KEYS: Record<string, string> = { "key-cashier": "cashier", "key-manager": "store_manager" };

function makeServer() {
  const store = new InMemoryEntityStore();
  const principalResolver = new InMemoryPrincipalResolver();
  for (const role of Object.values(KEYS)) {
    principalResolver.register(role, {
      principalId: "00000000-0000-4000-8000-0000000000aa",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [role],
      mfaProofAgeSeconds: null,
      resolvedAt: "2026-06-03T12:00:00.000Z",
    });
  }
  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const role = KEYS[token];
      return role === undefined ? null : { principalRef: role, scopes: [role], tenantId: TENANT };
    },
  };
  const server = buildOperateGateway(resolved, {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    principalResolver,
    opaqueTokenLookup,
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
  });
  return { server, store };
}

function getReq(path: string, token: string): IncomingRequest {
  return buildIncomingRequest({
    id: `req_${Math.random().toString(36).slice(2, 14)}`,
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: "GET",
    path,
    headers: { "x-api-key": token },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
  });
}

function bodyOf(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

const PRODUCT = {
  id: "prod-1",
  sku: "SKU-1",
  name: "Milk",
  unit_price: 2,
  unit_cost: 1.1,
  status: "active",
  category: "grocery",
};

describe("operate-server — manifest served end-to-end through the gateway", () => {
  it("serves a list with classification redaction (cashier: no unit_cost; manager: full)", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);

    const asCashier = await server.runtime.handleRequest(getReq("/v1/products", "key-cashier"));
    expect(asCashier.response.status).toBe(200);
    expect(asCashier.execution.routeOperationId).toBe("product.list");
    const cashierRows = bodyOf(asCashier.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(cashierRows[0]).not.toHaveProperty("unit_cost");
    expect(cashierRows[0]).toMatchObject({ sku: "SKU-1", unit_price: 2 });

    const asManager = await server.runtime.handleRequest(getReq("/v1/products", "key-manager"));
    const managerRows = bodyOf(asManager.response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(managerRows[0]).toHaveProperty("unit_cost", 1.1);
  });

  it("serves a single record read via the manifest-derived route, redacted per caller", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);

    const read = await server.runtime.handleRequest(getReq("/v1/products/prod-1", "key-cashier"));
    expect(read.response.status).toBe(200);
    expect(read.execution.routeOperationId).toBe("product.read");
    const record = bodyOf(read.response.bodyBytes);
    expect(record["sku"]).toBe("SKU-1");
    expect(record).not.toHaveProperty("unit_cost");
  });

  it("records a queryable PipelineExecution per served request", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Product", PRODUCT);
    const { execution } = await server.runtime.handleRequest(getReq("/v1/products", "key-manager"));
    expect(execution.finalOutcome).toBe("pass");
    expect(execution.tenantId).toBe(TENANT);
    expect(execution.stages.some((s) => s.stage === "transform_response")).toBe(true);
  });
});
