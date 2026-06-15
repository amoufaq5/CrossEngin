import type { PipelineExecution } from "@crossengin/api-gateway";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import type { PackInstallation } from "@crossengin/marketplace";
import type { PostgresPackInstallationStore } from "@crossengin/marketplace-pg";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { buildMarketplaceRoutes } from "./marketplace-routes.js";
import { buildPrincipalWiring, parseApiKeySpec } from "./principals.js";
import { buildManifestReportRunner } from "./reports.js";
import { OperateHttpServer, buildOperateHttpServer, type ExecutionSink } from "./server.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

const API_KEYS = [
  parseApiKeySpec(`key-cashier:cashier:${TENANT}`),
  parseApiKeySpec(`key-manager:store_manager:${TENANT}`),
];

function makeServer(): OperateHttpServer {
  const { httpServer } = buildOperateHttpServer({
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
    expect(rows[0]).toMatchObject({ sku: "SKU-1", unit_cost: 1.1 });
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
    expect(managerRows[0]).toHaveProperty("unit_cost", 1.1);
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
        status: "active",
        category: "g",
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

class CapturingExecutionSink implements ExecutionSink {
  readonly recorded: PipelineExecution[] = [];
  async record(execution: PipelineExecution): Promise<void> {
    this.recorded.push(execution);
  }
}

describe("OperateHttpServer — execution sink wiring (P2.45)", () => {
  function makeServerWithSink(sink: ExecutionSink, onError?: (err: unknown) => void): OperateHttpServer {
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
      executionSink: sink,
      ...(onError !== undefined ? { onExecutionSinkError: onError } : {}),
    });
    return httpServer;
  }

  it("records one PipelineExecution per dispatched request", async () => {
    const sink = new CapturingExecutionSink();
    const server = makeServerWithSink(sink);

    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-manager", PRODUCT);
    await server.dispatch(raw, bytes);
    await server.dispatch(req("GET", "/v1/products", "key-manager"), null);

    expect(sink.recorded).toHaveLength(2);
    expect(sink.recorded[0]?.finalStage).toBe("emit_audit");
    expect(typeof sink.recorded[0]?.requestId).toBe("string");
    expect(sink.recorded[1]?.routeOperationId).toBe("product.list");
  });

  it("records the execution even for a denied (401) request", async () => {
    const sink = new CapturingExecutionSink();
    const server = makeServerWithSink(sink);
    await server.dispatch(req("GET", "/v1/products", "key-nobody"), null);
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]?.finalOutcome).toBe("deny");
  });

  it("does not record on an unknown method (405 short-circuits before the gateway)", async () => {
    const sink = new CapturingExecutionSink();
    const server = makeServerWithSink(sink);
    const res = await server.dispatch(req("BREW", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(405);
    expect(sink.recorded).toHaveLength(0);
  });

  it("a sink failure is routed to onExecutionSinkError and never breaks the response", async () => {
    const errors: unknown[] = [];
    const failingSink: ExecutionSink = {
      record: () => Promise.reject(new Error("sink down")),
    };
    const server = makeServerWithSink(failingSink, (err) => errors.push(err));
    const res = await server.dispatch(req("GET", "/v1/products", "key-manager"), null);
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sink down");
  });
});

describe("OperateHttpServer — GET /v1/reports/:report (P3.25)", () => {
  async function makeReportServer(): Promise<OperateHttpServer> {
    const store = new InMemoryEntityStore();
    for (const o of [
      { order_number: "O1", state: "placed", currency: "AED", total: 100 },
      { order_number: "O2", state: "placed", currency: "AED", total: 60 },
    ]) {
      await store.create(TENANT, "SalesOrder", o);
    }
    const reportRunner = buildManifestReportRunner({
      manifest,
      store,
      principalRoles: buildPrincipalWiring(API_KEYS).principalRoles,
    });
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store,
      apiKeys: API_KEYS,
      reportRunner,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    return httpServer;
  }

  it("serves executed report data through the gateway (200 kpi)", async () => {
    const server = await makeReportServer();
    const res = await server.dispatch(req("GET", "/v1/reports/salesRevenue", "key-manager"), null);
    expect(res.status).toBe(200);
    expect(parse(res.body)).toMatchObject({ kind: "kpi", name: "total_revenue", value: 160 });
  });

  it("404s an unknown report (fail-closed)", async () => {
    const server = await makeReportServer();
    const res = await server.dispatch(req("GET", "/v1/reports/ghost", "key-manager"), null);
    expect(res.status).toBe(404);
    expect(parse(res.body)["error"]).toBe("report_unavailable");
  });

  it("401s an unauthenticated report request", async () => {
    const server = await makeReportServer();
    const res = await server.dispatch(req("GET", "/v1/reports/salesRevenue", "key-nobody"), null);
    expect(res.status).toBe(401);
  });
});

describe("OperateHttpServer — GET /v1/openapi.json (P3.26)", () => {
  function makeDescribedServer(): OperateHttpServer {
    const store = new InMemoryEntityStore();
    const reportRunner = buildManifestReportRunner({
      manifest,
      store,
      principalRoles: buildPrincipalWiring(API_KEYS).principalRoles,
    });
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store,
      apiKeys: API_KEYS,
      reportRunner,
      serveApiDescriptor: true,
      openApiInfo: { title: "Retail API", version: "v1" },
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    return httpServer;
  }

  it("serves a minimal OpenAPI 3.1 document listing entity + report routes", async () => {
    const server = makeDescribedServer();
    const res = await server.dispatch(req("GET", "/v1/openapi.json", "key-manager"), null);
    expect(res.status).toBe(200);
    const doc = parse(res.body);
    expect(doc["openapi"]).toBe("3.1.0");
    expect(doc["info"]).toEqual({ title: "Retail API", version: "v1" });
    const paths = doc["paths"] as Record<string, Record<string, unknown>>;
    expect(paths["/v1/products"]?.["get"]).toBeDefined();
    // the report route is present (reportRunner was wired)
    expect((paths["/v1/reports/{report}"]?.["get"] as { operationId: string }).operationId).toBe("report.run");
    // the report catalog rides under x-reports
    const reports = doc["x-reports"] as Array<{ name: string }>;
    expect(reports.map((r) => r.name)).toContain("salesRevenue");
  });

  it("401s an unauthenticated openapi request (it rides the gateway pipeline)", async () => {
    const server = makeDescribedServer();
    const res = await server.dispatch(req("GET", "/v1/openapi.json", "key-nobody"), null);
    expect(res.status).toBe(401);
  });

  it("embeds component schemas + references them from operations (P3.32)", async () => {
    const server = makeDescribedServer();
    const doc = parse((await server.dispatch(req("GET", "/v1/openapi.json", "key-manager"), null)).body);
    const components = doc["components"] as { schemas: Record<string, { properties?: Record<string, unknown> }> };
    // a typed schema per entity (Product carries its fields) + the ReportData union
    expect(components.schemas["Product"]?.properties).toBeDefined();
    expect(Object.keys(components.schemas["Product"]!.properties!)).toContain("unit_price");
    expect(components.schemas["ReportData"]).toBeDefined();
    // the create operation's requestBody + response reference the Product schema
    const post = (doc["paths"] as Record<string, Record<string, { requestBody?: { content: Record<string, { schema: unknown }> }; responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>)["/v1/products"]?.["post"];
    expect(post?.requestBody?.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Product" });
    // P3.33: RFC 9457 error responses reference ProblemDetails (always present)
    expect(components.schemas["ProblemDetails"]).toBeDefined();
    expect(post?.responses["403"]?.content?.["application/problem+json"].schema).toEqual({
      $ref: "#/components/schemas/ProblemDetails",
    });
  });

  it("filters the document per caller's RBAC — a cashier's omits the create it can't perform (P3.28)", async () => {
    const server = makeDescribedServer();
    const mgr = parse((await server.dispatch(req("GET", "/v1/openapi.json", "key-manager"), null)).body);
    const csh = parse((await server.dispatch(req("GET", "/v1/openapi.json", "key-cashier"), null)).body);
    const mgrPaths = mgr["paths"] as Record<string, Record<string, unknown>>;
    const cshPaths = csh["paths"] as Record<string, Record<string, unknown>>;
    // a store_manager can create products → POST present; a cashier cannot → absent
    expect(mgrPaths["/v1/products"]?.["post"]).toBeDefined();
    expect(cshPaths["/v1/products"]?.["post"]).toBeUndefined();
    // both can still read products (GET present for each)
    expect(mgrPaths["/v1/products"]?.["get"]).toBeDefined();
    expect(cshPaths["/v1/products"]?.["get"]).toBeDefined();
  });
});

describe("marketplace install routes (P5.1) — over the gateway", () => {
  const INSTALL = {
    packId: "acme.crm.sales",
    status: "installed",
    installedVersion: "1.0.0",
    tenantId: TENANT,
  } as unknown as PackInstallation;
  const fakeStore = {
    listForTenant: async () => [INSTALL],
    activeForPack: async () => null,
    record: async () => {},
  } as unknown as PostgresPackInstallationStore;

  function makeMarketplaceServer(): OperateHttpServer {
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: API_KEYS,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
      extraRoutes: buildMarketplaceRoutes(fakeStore, { now: () => new Date(), newId: () => "11111111-1111-4111-8111-111111111111" }),
    });
    return httpServer;
  }

  it("GET /v1/marketplace/installations lists the authenticated tenant's installs", async () => {
    const res = await makeMarketplaceServer().dispatch(req("GET", "/v1/marketplace/installations", "key-manager"), null);
    expect(res.status).toBe(200);
    const installations = parse(res.body)["installations"] as Array<Record<string, unknown>>;
    expect(installations).toHaveLength(1);
    expect(installations[0]!["packId"]).toBe("acme.crm.sales");
  });

  it("requires authentication (401 without a key)", async () => {
    const res = await makeMarketplaceServer().dispatch(
      { method: "GET", url: "/v1/marketplace/installations", headers: { host: "api.example.com" }, remoteAddress: "203.0.113.1" },
      null,
    );
    expect(res.status).toBe(401);
  });
});

describe("public health route", () => {
  it("GET /healthz → 200 ok without a credential", async () => {
    const res = await makeServer().dispatch(
      { method: "GET", url: "/healthz", headers: { host: "api.example.com" } },
      null,
    );
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ status: "ok" });
  });
});
