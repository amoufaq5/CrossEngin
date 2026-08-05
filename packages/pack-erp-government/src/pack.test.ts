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
  ERP_GOVERNMENT_PACK_SLUG,
  ERP_GOVERNMENT_PACK_VERSION,
  buildErpGovernmentPack,
} from "./pack.js";

function coreRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      return parentId === ERP_CORE_PACK_SLUG ? core : null;
    },
  };
}

describe("buildErpGovernmentPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpGovernmentPack())).not.toThrow();
  });

  it("uses the documented slug, version, and extends lineage", () => {
    const m = buildErpGovernmentPack();
    expect(m.meta.slug).toBe(ERP_GOVERNMENT_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_GOVERNMENT_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("declares NIST 800-53 as the default compliance posture", () => {
    expect(buildErpGovernmentPack().meta.compliancePacks).toEqual(["nist-800-53"]);
  });

  it("ships three government entities", () => {
    expect(buildErpGovernmentPack().entities?.map((e) => e.name)).toEqual([
      "Citizen",
      "Case",
      "Permit",
    ]);
  });
});

describe("buildErpGovernmentPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    expect(tryValidateManifest(buildErpGovernmentPack()).ok).toBe(false);
  });
});

describe("buildErpGovernmentPack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core entities with government's own (3 entities)", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const names = (resolved.entities ?? []).map((e) => e.name);
    for (const core of ["Account", "Invoice", "Item", "Employee"]) expect(names).toContain(core);
    const coreNames = new Set(buildErpCorePack().entities.map((e) => e.name));
    const own = names.filter((n) => !coreNames.has(n)).sort();
    expect(own).toEqual(["Case", "Citizen", "Permit"]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const coreRoles = new Set(Object.keys(buildErpCorePack().roles ?? {}));
    const own = Object.keys(resolved.roles ?? {}).filter((r) => !coreRoles.has(r)).sort();
    expect(own).toEqual(["case_worker", "gov_admin", "gov_auditor", "permit_officer"]);
    expect(Object.keys(resolved.roles ?? {})).toEqual(
      expect.arrayContaining(["erp_admin", "controller"]),
    );
  });

  it("concatenates relations across packs (core + 3 government)", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    expect(resolved.relations).toHaveLength((buildErpCorePack().relations ?? []).length + 3);
  });

  it("keeps all lifecycle workflows (adds case_lifecycle)", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const coreWf = new Set(Object.keys(buildErpCorePack().workflows ?? {}));
    const own = Object.keys(resolved.workflows ?? {}).filter((w) => !coreWf.has(w)).sort();
    expect(own).toEqual(["case_lifecycle"]);
    expect(Object.keys(resolved.workflows ?? {})).toContain("invoice_lifecycle");
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries regulated + pii field classifications through resolution", async () => {
    const resolved = await resolveManifest(buildErpGovernmentPack(), {
      registry: coreRegistry(),
    });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "Citizen",
      field: "national_id",
      classification: "regulated",
    });
    expect(classified).toContainEqual({
      entity: "Citizen",
      field: "contact_email",
      classification: "pii",
    });
    // the regulated field lands on an auditable entity, so validation still passes
    const result = tryValidateManifest(resolved);
    expect(result.ok).toBe(true);
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(
      resolveManifest(buildErpGovernmentPack(), { registry: empty }),
    ).rejects.toThrow();
  });
});

describe("buildErpGovernmentPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpGovernmentPack())).toBe(manifestHash(buildErpGovernmentPack()));
  });

  it("threads custom compliance packs", () => {
    expect(
      buildErpGovernmentPack({ compliancePacks: ["nist-800-53", "fedramp"] }).meta.compliancePacks,
    ).toEqual(["nist-800-53", "fedramp"]);
  });
});
