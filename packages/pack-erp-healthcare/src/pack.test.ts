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
  ERP_HEALTHCARE_PACK_SLUG,
  ERP_HEALTHCARE_PACK_VERSION,
  buildErpHealthcarePack,
} from "./pack.js";

function coreRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      return parentId === ERP_CORE_PACK_SLUG ? core : null;
    },
  };
}

describe("buildErpHealthcarePack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpHealthcarePack())).not.toThrow();
  });

  it("uses the documented slug, version, and extends lineage", () => {
    const m = buildErpHealthcarePack();
    expect(m.meta.slug).toBe(ERP_HEALTHCARE_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_HEALTHCARE_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("declares HIPAA as the default compliance posture", () => {
    expect(buildErpHealthcarePack().meta.compliancePacks).toEqual(["hipaa"]);
  });

  it("threads extra compliance packs when supplied", () => {
    const m = buildErpHealthcarePack({ compliancePacks: ["hipaa", "soc2"] });
    expect(m.meta.compliancePacks).toEqual(["hipaa", "soc2"]);
  });

  it("ships three healthcare entities", () => {
    expect(buildErpHealthcarePack().entities?.map((e) => e.name)).toEqual([
      "Patient",
      "Encounter",
      "Observation",
    ]);
  });
});

describe("buildErpHealthcarePack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    const result = tryValidateManifest(buildErpHealthcarePack());
    expect(result.ok).toBe(false);
  });
});

describe("buildErpHealthcarePack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core + healthcare entities (4 + 3 = 7)", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    const names = (resolved.entities ?? []).map((e) => e.name).sort();
    expect(names).toEqual([
      "Account",
      "Contact",
      "Encounter",
      "Invoice",
      "InvoiceLine",
      "Observation",
      "Patient",
    ]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual([
      "clinical_admin",
      "clinician",
      "erp_accountant",
      "erp_admin",
      "erp_viewer",
      "front_desk",
      "hipaa_auditor",
    ]);
  });

  it("concatenates relations across packs (3 core + 4 healthcare)", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    expect(resolved.relations).toHaveLength(7);
  });

  it("keeps both lifecycle workflows", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual([
      "encounter_lifecycle",
      "invoice_lifecycle",
    ]);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("strips extends from the resolved manifest", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    expect(resolved.meta.extends).toBeUndefined();
  });

  it("carries PHI/PII field classifications through resolution", async () => {
    const resolved = await resolveManifest(buildErpHealthcarePack(), {
      registry: coreRegistry(),
    });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({ entity: "Patient", field: "mrn", classification: "phi" });
    expect(classified).toContainEqual({
      entity: "Observation",
      field: "value_text",
      classification: "phi",
    });
    // all PHI fields land on auditable entities, so validation still passes
    const result = tryValidateManifest(resolved);
    expect(result.ok).toBe(true);
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(
      resolveManifest(buildErpHealthcarePack(), { registry: empty }),
    ).rejects.toThrow();
  });
});

describe("buildErpHealthcarePack — determinism", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpHealthcarePack())).toBe(
      manifestHash(buildErpHealthcarePack()),
    );
  });
});
