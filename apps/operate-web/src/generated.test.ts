import { readFileSync } from "node:fs";

import { describeWebApi, emitWebClientModule } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";

/**
 * Drift guard for the committed reference view-model client (P3.39). Regenerates
 * the retail web client exactly as `operate-web web-client --pack erp-retail
 * --role retail_admin --role store_manager --client-name createRetailWebClient`
 * does and asserts it matches the checked-in
 * `src/generated/retail-web-client.ts`. If the emitter, the descriptor, or the
 * retail manifest changes without regenerating, this fails. (The committed file
 * is also typechecked by `tsc` as part of the package build.)
 */
async function regenerateRetailWebClient(): Promise<string> {
  const manifest = await loadBuiltinPack("erp-retail");
  const descriptor = describeWebApi(manifest, { roles: ["retail_admin", "store_manager"] });
  return emitWebClientModule(descriptor, { clientName: "createRetailWebClient" });
}

describe("generated retail view-model reference client", () => {
  it("matches the committed src/generated/retail-web-client.ts (regenerate to update)", async () => {
    const committed = readFileSync(new URL("./generated/retail-web-client.ts", import.meta.url), "utf8");
    expect(await regenerateRetailWebClient()).toBe(committed);
  });

  it("exposes typed view + mutation + transition methods", async () => {
    const out = await regenerateRetailWebClient();
    expect(out).toContain("export function createRetailWebClient(");
    expect(out).toContain("productTable: (query?: QueryParams): Promise<{ table: TableModel;");
    expect(out).toContain("salesOrderPlace: (id: string, query?: QueryParams):");
    expect(out).toContain("export interface TableModel {");
  });
});
