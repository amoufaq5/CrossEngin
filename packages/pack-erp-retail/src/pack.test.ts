import {
  ManifestSchema,
  manifestClassifiedFields,
  manifestHash,
  resolveManifest,
  tryValidateManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import {
  ERP_RETAIL_PACK_SLUG,
  ERP_RETAIL_PACK_VERSION,
  buildErpRetailPack,
} from "./pack.js";

function coreRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      return parentId === ERP_CORE_PACK_SLUG ? core : null;
    },
  };
}

describe("buildErpRetailPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpRetailPack())).not.toThrow();
  });

  it("uses the documented slug, version, and extends lineage", () => {
    const m = buildErpRetailPack();
    expect(m.meta.slug).toBe(ERP_RETAIL_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_RETAIL_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("declares PCI as the default compliance posture", () => {
    expect(buildErpRetailPack().meta.compliancePacks).toEqual(["pci"]);
  });

  it("ships four retail entities", () => {
    expect(buildErpRetailPack().entities?.map((e) => e.name)).toEqual([
      "Product",
      "Store",
      "SalesOrder",
      "OrderLine",
    ]);
  });
});

describe("buildErpRetailPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    expect(tryValidateManifest(buildErpRetailPack()).ok).toBe(false);
  });
});

describe("buildErpRetailPack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core entities with retail's own (retail overrides SalesOrder)", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const names = (resolved.entities ?? []).map((e) => e.name);
    for (const core of ["Account", "Invoice", "Item", "Employee"]) expect(names).toContain(core);
    const coreNames = new Set(buildErpCorePack().entities.map((e) => e.name));
    const retailOwn = names.filter((n) => !coreNames.has(n)).sort();
    expect(retailOwn).toEqual(["OrderLine", "Product", "Store"]);
    expect(names).toContain("SalesOrder");
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const coreRoles = new Set(Object.keys(buildErpCorePack().roles ?? {}));
    const own = Object.keys(resolved.roles ?? {}).filter((r) => !coreRoles.has(r)).sort();
    expect(own).toEqual(["cashier", "retail_admin", "retail_analyst", "store_manager"]);
    expect(Object.keys(resolved.roles ?? {})).toEqual(expect.arrayContaining(["erp_admin", "controller"]));
  });

  it("concatenates relations across packs (core + 5 retail)", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    expect(resolved.relations).toHaveLength((buildErpCorePack().relations ?? []).length + 5);
  });

  it("keeps all lifecycle workflows (retail overrides sales_order_lifecycle)", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const keys = Object.keys(resolved.workflows ?? {});
    expect(keys).toContain("sales_order_lifecycle");
    expect(keys).toContain("invoice_lifecycle");
    // retail's only workflow overrides an existing core key, so the count is unchanged
    expect(keys).toHaveLength(Object.keys(buildErpCorePack().workflows ?? {}).length);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries commercial_sensitive + pii field classifications", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "Product",
      field: "unit_cost",
      classification: "commercial_sensitive",
    });
    expect(classified).toContainEqual({
      entity: "SalesOrder",
      field: "customer_email",
      classification: "pii",
    });
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(resolveManifest(buildErpRetailPack(), { registry: empty })).rejects.toThrow();
  });
});

describe("buildErpRetailPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpRetailPack())).toBe(manifestHash(buildErpRetailPack()));
  });

  it("threads custom compliance packs", () => {
    expect(buildErpRetailPack({ compliancePacks: ["pci", "soc2"] }).meta.compliancePacks).toEqual([
      "pci",
      "soc2",
    ]);
  });
});
