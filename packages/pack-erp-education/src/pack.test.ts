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

import { ERP_EDUCATION_PACK_SLUG, ERP_EDUCATION_PACK_VERSION, buildErpEducationPack } from "./pack.js";

function coreRegistry(): ManifestRegistry {
  const core = buildErpCorePack();
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      return parentId === ERP_CORE_PACK_SLUG ? core : null;
    },
  };
}

describe("buildErpEducationPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    expect(() => ManifestSchema.parse(buildErpEducationPack())).not.toThrow();
  });

  it("uses the documented slug, version, and extends lineage", () => {
    const m = buildErpEducationPack();
    expect(m.meta.slug).toBe(ERP_EDUCATION_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_EDUCATION_PACK_VERSION);
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("declares FERPA as the default compliance posture", () => {
    expect(buildErpEducationPack().meta.compliancePacks).toEqual(["ferpa"]);
  });

  it("ships four education entities", () => {
    expect(buildErpEducationPack().entities?.map((e) => e.name)).toEqual([
      "Course",
      "Student",
      "Enrollment",
      "Assignment",
    ]);
  });
});

describe("buildErpEducationPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    expect(tryValidateManifest(buildErpEducationPack()).ok).toBe(false);
  });
});

describe("buildErpEducationPack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in (regulated grade on an auditable entity)", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core + education entities (4 + 4 = 8)", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    expect((resolved.entities ?? []).map((e) => e.name).sort()).toEqual([
      "Account",
      "Assignment",
      "Contact",
      "Course",
      "Enrollment",
      "Invoice",
      "InvoiceLine",
      "Student",
    ]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual([
      "advisor",
      "education_admin",
      "erp_accountant",
      "erp_admin",
      "erp_viewer",
      "instructor",
      "registrar",
    ]);
  });

  it("concatenates relations across packs (3 core + 6 education)", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    expect(resolved.relations).toHaveLength(9);
  });

  it("keeps all three lifecycle workflows (core invoice + course + enrollment)", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual([
      "course_lifecycle",
      "enrollment_lifecycle",
      "invoice_lifecycle",
    ]);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries pii + regulated field classifications", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({ entity: "Student", field: "email", classification: "pii" });
    expect(classified).toContainEqual({ entity: "Student", field: "date_of_birth", classification: "pii" });
    expect(classified).toContainEqual({ entity: "Enrollment", field: "grade", classification: "regulated" });
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(resolveManifest(buildErpEducationPack(), { registry: empty })).rejects.toThrow();
  });
});

describe("buildErpEducationPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpEducationPack())).toBe(manifestHash(buildErpEducationPack()));
  });

  it("threads custom compliance packs", () => {
    expect(buildErpEducationPack({ compliancePacks: ["ferpa", "soc2"] }).meta.compliancePacks).toEqual([
      "ferpa",
      "soc2",
    ]);
  });
});
