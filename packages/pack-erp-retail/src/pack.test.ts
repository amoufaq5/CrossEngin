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

  it("merges core + retail entities (23 + 4 = 27)", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    expect((resolved.entities ?? []).map((e) => e.name).sort()).toEqual([
      "Account",
      "Bill",
      "BillLine",
      "Contact",
      "Department",
      "Employee",
      "Expense",
      "GoodsReceipt",
      "Invoice",
      "InvoiceLine",
      "Item",
      "JournalEntry",
      "JournalLine",
      "LeaveRequest",
      "LedgerAccount",
      "OrderLine",
      "Payment",
      "Position",
      "Product",
      "PurchaseOrder",
      "PurchaseOrderLine",
      "SalesOrder",
      "StockLevel",
      "StockMovement",
      "Store",
      "Vendor",
      "Warehouse",
    ]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual([
      "ap_clerk",
      "cashier",
      "controller",
      "erp_accountant",
      "erp_admin",
      "erp_viewer",
      "hr_manager",
      "inventory_manager",
      "procurement_manager",
      "retail_admin",
      "retail_analyst",
      "store_manager",
      "warehouse_clerk",
    ]);
  });

  it("concatenates relations across packs (23 core + 5 retail)", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    expect(resolved.relations).toHaveLength(28);
  });

  it("keeps all lifecycle workflows", async () => {
    const resolved = await resolveManifest(buildErpRetailPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual([
      "bill_lifecycle",
      "expense_lifecycle",
      "invoice_lifecycle",
      "journal_entry_lifecycle",
      "leave_request_lifecycle",
      "payment_lifecycle",
      "purchase_order_lifecycle",
      "sales_order_lifecycle",
    ]);
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
