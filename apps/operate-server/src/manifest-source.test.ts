import { describe, expect, it } from "vitest";

import {
  BUILTIN_PACK_NAMES,
  loadBuiltinPack,
  loadManifestFromJson,
} from "./manifest-source.js";

describe("loadBuiltinPack", () => {
  it("resolves the retail pack's meta.extends lineage (core merged in)", async () => {
    const manifest = await loadBuiltinPack("erp-retail");
    const entityNames = (manifest.entities ?? []).map((e) => e.name);
    // 4 core + 4 retail entities once resolved
    expect(entityNames).toContain("Product");
    expect(entityNames).toContain("Account");
    expect(entityNames.length).toBeGreaterThanOrEqual(8);
  });

  it("resolves grocery's transitive (3-level) lineage", async () => {
    const manifest = await loadBuiltinPack("erp-grocery");
    const entityNames = (manifest.entities ?? []).map((e) => e.name);
    expect(entityNames).toContain("PerishableLot"); // grocery
    expect(entityNames).toContain("Product"); // retail
    expect(entityNames).toContain("Account"); // core
  });

  it("loads a standalone core pack", async () => {
    const manifest = await loadBuiltinPack("erp-core");
    expect((manifest.entities ?? []).map((e) => e.name)).toContain("Invoice");
  });

  it("resolves the construction pack against core (Project + Account)", async () => {
    const manifest = await loadBuiltinPack("erp-construction");
    const entityNames = (manifest.entities ?? []).map((e) => e.name);
    expect(entityNames).toContain("Project"); // construction
    expect(entityNames).toContain("ChangeOrder"); // construction
    expect(entityNames).toContain("Account"); // core
    // both construction lifecycles + the core invoice lifecycle resolve
    expect(Object.keys(manifest.workflows ?? {}).sort()).toEqual([
      "change_order_lifecycle",
      "invoice_lifecycle",
      "project_lifecycle",
    ]);
  });

  it("lists the built-in pack names", () => {
    expect(BUILTIN_PACK_NAMES).toContain("erp-retail");
    expect(BUILTIN_PACK_NAMES).toContain("erp-grocery");
    expect(BUILTIN_PACK_NAMES).toContain("erp-construction");
  });

  it("throws on an unknown pack", async () => {
    await expect(loadBuiltinPack("erp-nope")).rejects.toThrow(/unknown pack/);
  });
});

describe("loadManifestFromJson", () => {
  it("round-trips a resolved pack serialized to JSON", async () => {
    const manifest = await loadBuiltinPack("erp-core");
    const reloaded = loadManifestFromJson(JSON.stringify(manifest));
    expect((reloaded.entities ?? []).map((e) => e.name).sort()).toEqual(
      (manifest.entities ?? []).map((e) => e.name).sort(),
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => loadManifestFromJson("{not json")).toThrow(/not valid JSON/);
  });

  it("throws on a structurally invalid manifest", () => {
    expect(() => loadManifestFromJson(JSON.stringify({ slug: "x" }))).toThrow();
  });
});
