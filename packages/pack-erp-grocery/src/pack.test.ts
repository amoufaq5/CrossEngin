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
import { ERP_RETAIL_PACK_SLUG, buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import {
  ERP_GROCERY_PACK_SLUG,
  ERP_GROCERY_PACK_VERSION,
  buildErpGroceryPack,
} from "./pack.js";

// Registry for the whole lineage: grocery -> retail -> core.
function chainRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  const retail = buildErpRetailPack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      if (parentId === ERP_CORE_PACK_SLUG) return core;
      if (parentId === ERP_RETAIL_PACK_SLUG) return retail;
      return null;
    },
  };
}

describe("buildErpGroceryPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpGroceryPack())).not.toThrow();
  });

  it("extends RETAIL (a pack that itself extends core)", () => {
    const m = buildErpGroceryPack();
    expect(m.meta.slug).toBe(ERP_GROCERY_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_GROCERY_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_RETAIL_PACK_SLUG]);
    expect(m.meta.compliancePacks).toEqual(["haccp"]);
  });
});

describe("buildErpGroceryPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (references retail + core entities)", () => {
    expect(tryValidateManifest(buildErpGroceryPack()).ok).toBe(false);
  });

  it("does NOT resolve with only retail available (retail needs core too)", async () => {
    const retailOnly: ManifestRegistry = {
      async getManifest(id) {
        return id === ERP_RETAIL_PACK_SLUG ? buildErpRetailPack() : null;
      },
    };
    await expect(
      resolveManifest(buildErpGroceryPack(), { registry: retailOnly }),
    ).rejects.toThrow();
  });
});

describe("buildErpGroceryPack — transitive resolution (grocery -> retail -> core)", () => {
  it("resolves the full chain and cross-validates", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges all three packs' entities (4 core + 4 retail + 2 grocery = 10)", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    expect((resolved.entities ?? []).map((e) => e.name).sort()).toEqual([
      "Account",
      "Contact",
      "Invoice",
      "InvoiceLine",
      "OrderLine",
      "PerishableLot",
      "Product",
      "SalesOrder",
      "Store",
      "Supplier",
    ]);
  });

  it("merges roles from all three packs", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual([
      "cashier",
      "erp_accountant",
      "erp_admin",
      "erp_viewer",
      "grocery_admin",
      "receiving_clerk",
      "retail_admin",
      "retail_analyst",
      "store_manager",
    ]);
  });

  it("keeps all three lifecycle workflows", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual([
      "invoice_lifecycle",
      "perishable_lot_lifecycle",
      "sales_order_lifecycle",
    ]);
  });

  it("concatenates relations across the chain (3 core + 5 retail + 3 grocery = 11)", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    expect(resolved.relations).toHaveLength(11);
  });

  it("records both retail and core in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    const slugs = (resolved.meta.manifestResolution?.parents ?? []).map((p) => p.slug);
    expect(slugs).toContain(ERP_RETAIL_PACK_SLUG);
    expect(slugs).toContain(ERP_CORE_PACK_SLUG);
  });

  it("resolves a grocery reference to a retail entity (PerishableLot -> Product)", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    const lot = (resolved.entities ?? []).find((e) => e.name === "PerishableLot");
    const productRef = lot?.fields.find((f) => f.name === "product_id");
    expect(productRef?.type).toEqual({ kind: "reference", target: "Product" });
    // and Product is present in the merged manifest, so validation passed above
    expect((resolved.entities ?? []).some((e) => e.name === "Product")).toBe(true);
  });

  it("strips extends and carries the commercial_sensitive + pii classifications", async () => {
    const resolved = await resolveManifest(buildErpGroceryPack(), { registry: chainRegistry() });
    expect(resolved.meta.extends).toBeUndefined();
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "PerishableLot",
      field: "cost_per_unit",
      classification: "commercial_sensitive",
    });
    expect(classified).toContainEqual({
      entity: "Supplier",
      field: "contact_email",
      classification: "pii",
    });
    // retail's classifications survive the deeper merge too
    expect(classified).toContainEqual({
      entity: "Product",
      field: "unit_cost",
      classification: "commercial_sensitive",
    });
  });
});

describe("buildErpGroceryPack — determinism", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpGroceryPack())).toBe(manifestHash(buildErpGroceryPack()));
  });
});
