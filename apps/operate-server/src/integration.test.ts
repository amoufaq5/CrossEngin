import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";
import { PostgresEntityStore } from "@crossengin/operate-runtime-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

/**
 * Real-Postgres integration test for the operate serving stack. Gated on
 * `CROSSENGIN_PG_TEST=1` (skipped offline / in CI). It drives the full HTTP →
 * gateway → `PostgresEntityStore` → Postgres path against the retail pack,
 * proving CRUD persistence, **tenant isolation** (the store's
 * `WHERE tenant_id = $1` + `withTenantContext`), per-caller classification
 * redaction, RBAC, and keyset pagination end-to-end — what the offline
 * in-memory test (server.test.ts) can't show against a real database.
 *
 * To run: bring up Postgres + apply the meta-schema, then
 *   CROSSENGIN_PG_TEST=1 PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=… \
 *   PGSSLMODE=disable pnpm --filter @crossengin/operate-server test
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const manifest = await loadBuiltinPack("erp-retail");

const PRODUCT = { sku: "SKU-1", name: "Milk", unit_price: 2, unit_cost: 1.1, status: "active", category: "grocery" };

function parse(body: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as Record<string, unknown>;
}

suite("operate-server integration (real Postgres)", () => {
  let conn: PgConnection;
  let server: OperateHttpServer;
  let tenantA: string;
  let tenantB: string;

  async function seedTenant(): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`os-${suffix}`, `tenant_os_${suffix}`],
    );
    return res.rows[0]!.id;
  }

  function req(method: string, url: string, key: string): RawHttpRequest {
    return { method, url, headers: { "x-api-key": key, host: "api.example.com" }, remoteAddress: "203.0.113.1" };
  }

  function jsonBody(method: string, url: string, key: string, body: unknown): { raw: RawHttpRequest; bytes: Uint8Array } {
    return {
      raw: { method, url, headers: { "x-api-key": key, host: "api.example.com", "content-type": "application/json" }, remoteAddress: "203.0.113.1" },
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    };
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    tenantA = await seedTenant();
    tenantB = await seedTenant();
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new PostgresEntityStore(conn),
      apiKeys: [
        parseApiKeySpec(`key-mgr-a:store_manager:${tenantA}`),
        parseApiKeySpec(`key-cashier-a:cashier:${tenantA}`),
        parseApiKeySpec(`key-mgr-b:store_manager:${tenantB}`),
      ],
    });
    server = httpServer;
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("creates a product and reads it back from Postgres", async () => {
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-mgr-a", PRODUCT);
    const created = await server.dispatch(raw, bytes);
    expect(created.status).toBe(201);
    const id = parse(created.body)["id"] as string;
    expect(typeof id).toBe("string");

    const read = await server.dispatch(req("GET", `/v1/products/${id}`, "key-mgr-a"), null);
    expect(read.status).toBe(200);
    expect(parse(read.body)).toMatchObject({ sku: "SKU-1", unit_cost: 1.1 });
  });

  it("isolates tenants: tenant B cannot see tenant A's products", async () => {
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-mgr-a", { ...PRODUCT, sku: "ISO-A" });
    await server.dispatch(raw, bytes);

    const listB = await server.dispatch(req("GET", "/v1/products", "key-mgr-b"), null);
    const rowsB = parse(listB.body)["data"] as Array<Record<string, unknown>>;
    expect(rowsB.every((r) => r["sku"] !== "ISO-A")).toBe(true);
  });

  it("redacts unit_cost for a cashier but not a manager (over real PG)", async () => {
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-mgr-a", { ...PRODUCT, sku: "RED-1" });
    await server.dispatch(raw, bytes);

    const cashier = await server.dispatch(req("GET", "/v1/products", "key-cashier-a"), null);
    const cashierRows = parse(cashier.body)["data"] as Array<Record<string, unknown>>;
    expect(cashierRows.length).toBeGreaterThan(0);
    expect(cashierRows.every((r) => !("unit_cost" in r))).toBe(true);

    const manager = await server.dispatch(req("GET", "/v1/products", "key-mgr-a"), null);
    const managerRows = parse(manager.body)["data"] as Array<Record<string, unknown>>;
    expect(managerRows.some((r) => r["unit_cost"] === 1.1)).toBe(true);
  });

  it("denies a cashier creating a product with 403", async () => {
    const { raw, bytes } = jsonBody("POST", "/v1/products", "key-cashier-a", PRODUCT);
    expect((await server.dispatch(raw, bytes)).status).toBe(403);
  });

  it("paginates with keyset over real PG: ?limit drives the page + nextCursor", async () => {
    const tenant = await seedTenant();
    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new PostgresEntityStore(conn),
      apiKeys: [parseApiKeySpec(`key-pg:store_manager:${tenant}`)],
    });
    for (const sku of ["PA", "PB", "PC"]) {
      const { raw, bytes } = jsonBody("POST", "/v1/products", "key-pg", { ...PRODUCT, sku });
      await httpServer.dispatch(raw, bytes);
    }
    const first = await httpServer.dispatch(req("GET", "/v1/products?limit=2", "key-pg"), null);
    const firstBody = parse(first.body);
    expect((firstBody["data"] as unknown[]).length).toBe(2);
    const page = firstBody["page"] as { nextCursor: string | null };
    expect(page.nextCursor).not.toBeNull();

    const second = await httpServer.dispatch(
      req("GET", `/v1/products?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`, "key-pg"),
      null,
    );
    expect((parse(second.body)["data"] as unknown[]).length).toBe(1);
  });
});
