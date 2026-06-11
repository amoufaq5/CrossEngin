import { readFileSync } from "node:fs";

import { InMemoryEntityStore, compileOperateServer, emitOperateClientModule } from "@crossengin/operate-runtime";
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
async function regenerateRetailClient(): Promise<string> {
  const manifest = await loadBuiltinPack("erp-retail");
  const compiled = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: buildPrincipalWiring([]).principalRoles,
    reportRunner: { run: () => Promise.resolve(null) },
  });
  return emitOperateClientModule(compiled.openApiDocument, { clientName: "createRetailClient" });
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
