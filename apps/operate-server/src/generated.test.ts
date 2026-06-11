import { readFileSync } from "node:fs";

import {
  InMemoryEntityStore,
  compileOperateServer,
  emitOperateClientModule,
  emitOperatePythonClient,
} from "@crossengin/operate-runtime";
import type { OpenApiDocument } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import { buildPrincipalWiring } from "./principals.js";

/**
 * Drift guard for the committed reference client (P3.38). Regenerates the retail
 * client exactly as `operate-server openapi-client --pack erp-retail
 * --client-name createRetailClient` does and asserts it matches the checked-in
 * `src/generated/retail-client.ts`. If the emitter or the retail manifest changes
 * without regenerating, this fails — keeping the artifact honest. (The committed
 * file is also typechecked by `tsc` as part of the package build.)
 */
async function retailDoc(): Promise<OpenApiDocument> {
  const manifest = await loadBuiltinPack("erp-retail");
  const compiled = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: buildPrincipalWiring([]).principalRoles,
    reportRunner: { run: () => Promise.resolve(null) },
  });
  return compiled.openApiDocument;
}

async function regenerateRetailClient(): Promise<string> {
  return emitOperateClientModule(await retailDoc(), { clientName: "createRetailClient" });
}

async function regenerateRetailPythonClient(): Promise<string> {
  return emitOperatePythonClient(await retailDoc(), { className: "RetailClient" });
}

describe("generated retail reference client", () => {
  it("matches the committed src/generated/retail-client.ts (regenerate to update)", async () => {
    const committed = readFileSync(new URL("./generated/retail-client.ts", import.meta.url), "utf8");
    expect(await regenerateRetailClient()).toBe(committed);
  });

  it("exposes typed CRUD + lifecycle + report methods", async () => {
    const out = await regenerateRetailClient();
    expect(out).toContain("export function createRetailClient(");
    expect(out).toContain("productList: (query?: QueryParams): Promise<ListResult<Product>> =>");
    expect(out).toContain("salesOrderPlace: (id: string, body: { transition: string }, query?: QueryParams): Promise<SalesOrder> =>");
    expect(out).toContain("reportRun: (report: string, query?: QueryParams): Promise<ReportData> =>");
  });
});

describe("generated retail Python reference client (P3.40)", () => {
  it("matches the committed src/generated/retail_client.py (regenerate to update)", async () => {
    const committed = readFileSync(new URL("./generated/retail_client.py", import.meta.url), "utf8");
    expect(await regenerateRetailPythonClient()).toBe(committed);
  });

  it("exposes a TypedDict-typed, snake_case stdlib client", async () => {
    const out = await regenerateRetailPythonClient();
    expect(out).toContain("class RetailClient:");
    expect(out).toContain("class Product(TypedDict):");
    expect(out).toContain("def product_list(self, query: dict | None = None) -> ListResult:");
    expect(out).toContain("def sales_order_place(self, id: str, body: dict[str, Any], query: dict | None = None) -> SalesOrder:");
  });
});
