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
  ERP_CONSTRUCTION_PACK_SLUG,
  ERP_CONSTRUCTION_PACK_VERSION,
  buildErpConstructionPack,
} from "./pack.js";

function coreRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      return parentId === ERP_CORE_PACK_SLUG ? core : null;
    },
  };
}

describe("buildErpConstructionPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpConstructionPack())).not.toThrow();
  });

  it("uses the documented slug, version, and extends lineage", () => {
    const m = buildErpConstructionPack();
    expect(m.meta.slug).toBe(ERP_CONSTRUCTION_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_CONSTRUCTION_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("declares OSHA as the default compliance posture", () => {
    expect(buildErpConstructionPack().meta.compliancePacks).toEqual(["osha"]);
  });

  it("ships four construction entities", () => {
    expect(buildErpConstructionPack().entities?.map((e) => e.name)).toEqual([
      "Project",
      "CostCode",
      "ChangeOrder",
      "DailyLog",
    ]);
  });
});

describe("buildErpConstructionPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    expect(tryValidateManifest(buildErpConstructionPack()).ok).toBe(false);
  });
});

describe("buildErpConstructionPack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core + construction entities (4 + 4 = 8)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    expect((resolved.entities ?? []).map((e) => e.name).sort()).toEqual([
      "Account",
      "ChangeOrder",
      "Contact",
      "CostCode",
      "DailyLog",
      "Invoice",
      "InvoiceLine",
      "Project",
    ]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual([
      "construction_admin",
      "erp_accountant",
      "erp_admin",
      "erp_viewer",
      "estimator",
      "project_manager",
      "site_supervisor",
    ]);
  });

  it("concatenates relations across packs (3 core + 5 construction)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    expect(resolved.relations).toHaveLength(8);
  });

  it("keeps all three lifecycle workflows (core invoice + project + change order)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual([
      "change_order_lifecycle",
      "invoice_lifecycle",
      "project_lifecycle",
    ]);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries commercial_sensitive + pii field classifications", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry: coreRegistry() });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "Project",
      field: "contract_value",
      classification: "commercial_sensitive",
    });
    expect(classified).toContainEqual({
      entity: "DailyLog",
      field: "reported_by_email",
      classification: "pii",
    });
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(resolveManifest(buildErpConstructionPack(), { registry: empty })).rejects.toThrow();
  });
});

describe("buildErpConstructionPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpConstructionPack())).toBe(manifestHash(buildErpConstructionPack()));
  });

  it("threads custom compliance packs", () => {
    expect(buildErpConstructionPack({ compliancePacks: ["osha", "iso9001"] }).meta.compliancePacks).toEqual([
      "osha",
      "iso9001",
    ]);
  });
});
