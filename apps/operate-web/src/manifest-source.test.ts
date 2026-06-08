import { describe, expect, it } from "vitest";

import { BUILTIN_PACK_NAMES, loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";

describe("loadBuiltinPack", () => {
  it("resolves the retail pack's extends lineage (core merged in)", async () => {
    const manifest = await loadBuiltinPack("erp-retail");
    const names = (manifest.entities ?? []).map((e) => e.name);
    expect(names).toContain("Product");
    expect(names).toContain("Account"); // from core
  });

  it("lists the known packs", () => {
    expect(BUILTIN_PACK_NAMES).toContain("erp-retail");
    expect(BUILTIN_PACK_NAMES).toContain("erp-healthcare");
  });

  it("throws on an unknown alias", async () => {
    await expect(loadBuiltinPack("nope")).rejects.toThrow();
  });
});

describe("loadManifestFromJson", () => {
  it("rejects non-JSON", () => {
    expect(() => loadManifestFromJson("{not json")).toThrow();
  });
});
