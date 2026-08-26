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

  it("ships three construction entities", () => {
    expect(buildErpConstructionPack().entities?.map((e) => e.name)).toEqual([
      "Project",
      "Subcontractor",
      "WorkOrder",
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
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core entities with construction's own (construction overrides Project + WorkOrder)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const names = (resolved.entities ?? []).map((e) => e.name);
    for (const core of ["Account", "Invoice"]) expect(names).toContain(core);
    const coreNames = new Set(buildErpCorePack().entities.map((e) => e.name));
    const constructionOwn = names.filter((n) => !coreNames.has(n)).sort();
    // Project + WorkOrder already exist in core, so Subcontractor is the only net-new name.
    expect(constructionOwn).toEqual(["Subcontractor"]);
    for (const name of ["Project", "WorkOrder"]) expect(names).toContain(name);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const roleKeys = Object.keys(resolved.roles ?? {});
    for (const r of ["construction_admin", "project_manager", "foreman", "cost_analyst"]) {
      expect(roleKeys).toContain(r);
    }
    expect(roleKeys).toEqual(expect.arrayContaining(["erp_admin", "controller"]));
  });

  it("concatenates relations across packs (core + 3 construction)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    // -4: construction overrides core's manufacturing WorkOrder and its Project, so core's
    // WorkOrder.item_id / bom_id / warehouse_id and Project.manager_id relations bind columns
    // the construction versions do not have and are pruned at resolution.
    expect(resolved.relations).toHaveLength((buildErpCorePack().relations ?? []).length + 3 - 4);
  });

  it("keeps all lifecycle workflows (construction overrides project_lifecycle)", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const keys = Object.keys(resolved.workflows ?? {});
    expect(keys).toContain("project_lifecycle");
    expect(keys).toContain("invoice_lifecycle");
    // construction's only workflow overrides an existing core key, so the count is unchanged
    expect(keys).toHaveLength(Object.keys(buildErpCorePack().workflows ?? {}).length);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries commercial_sensitive + pii field classifications", async () => {
    const resolved = await resolveManifest(buildErpConstructionPack(), {
      registry: coreRegistry(),
    });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "Project",
      field: "budget_amount",
      classification: "commercial_sensitive",
    });
    expect(classified).toContainEqual({
      entity: "Subcontractor",
      field: "contact_email",
      classification: "pii",
    });
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(
      resolveManifest(buildErpConstructionPack(), { registry: empty }),
    ).rejects.toThrow();
  });
});

describe("buildErpConstructionPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpConstructionPack())).toBe(manifestHash(buildErpConstructionPack()));
  });

  it("threads custom compliance packs", () => {
    expect(
      buildErpConstructionPack({ compliancePacks: ["osha", "iso45001"] }).meta.compliancePacks,
    ).toEqual(["osha", "iso45001"]);
  });
});
