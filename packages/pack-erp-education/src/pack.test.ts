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
  ERP_EDUCATION_PACK_SLUG,
  ERP_EDUCATION_PACK_VERSION,
  buildErpEducationPack,
} from "./pack.js";

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

  it("ships three education entities", () => {
    expect(buildErpEducationPack().entities?.map((e) => e.name)).toEqual([
      "Student",
      "Course",
      "Enrollment",
    ]);
  });
});

describe("buildErpEducationPack — standalone cross-validation", () => {
  it("does NOT cross-validate alone (it references core entities)", () => {
    expect(tryValidateManifest(buildErpEducationPack()).ok).toBe(false);
  });
});

describe("buildErpEducationPack — resolved against core", () => {
  it("resolves and cross-validates once core is merged in", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const result = tryValidateManifest(resolved);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("merges core entities with education's own", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const names = (resolved.entities ?? []).map((e) => e.name);
    for (const core of ["Account", "Invoice", "Item", "Employee"]) expect(names).toContain(core);
    const coreNames = new Set(buildErpCorePack().entities.map((e) => e.name));
    const educationOwn = names.filter((n) => !coreNames.has(n)).sort();
    expect(educationOwn).toEqual(["Course", "Enrollment", "Student"]);
  });

  it("merges roles from both packs", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const coreRoles = new Set(Object.keys(buildErpCorePack().roles ?? {}));
    const own = Object.keys(resolved.roles ?? {}).filter((r) => !coreRoles.has(r)).sort();
    expect(own).toEqual(["edu_admin", "ferpa_auditor", "instructor", "registrar"]);
    expect(Object.keys(resolved.roles ?? {})).toEqual(
      expect.arrayContaining(["erp_admin", "controller"]),
    );
  });

  it("concatenates relations across packs (core + 3 education)", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    expect(resolved.relations).toHaveLength((buildErpCorePack().relations ?? []).length + 3);
  });

  it("adds the enrollment lifecycle workflow alongside the core workflows", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const keys = Object.keys(resolved.workflows ?? {});
    expect(keys).toContain("enrollment_lifecycle");
    expect(keys).toContain("invoice_lifecycle");
    // education's workflow is a new key, so it grows the core count by one
    expect(keys).toHaveLength(Object.keys(buildErpCorePack().workflows ?? {}).length + 1);
  });

  it("records the core pack in the resolution lineage", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const parents = resolved.meta.manifestResolution?.parents ?? [];
    expect(parents.map((p) => p.slug)).toContain(ERP_CORE_PACK_SLUG);
    expect(parents[0]?.hash).toBe(manifestHash(buildErpCorePack()));
  });

  it("carries the FERPA PII field classifications", async () => {
    const resolved = await resolveManifest(buildErpEducationPack(), { registry: coreRegistry() });
    const classified = manifestClassifiedFields(resolved);
    expect(classified).toContainEqual({
      entity: "Student",
      field: "student_email",
      classification: "pii",
    });
    expect(classified).toContainEqual({
      entity: "Enrollment",
      field: "grade",
      classification: "pii",
    });
  });

  it("throws when the parent pack is missing from the registry", async () => {
    const empty: ManifestRegistry = { async getManifest() { return null; } };
    await expect(
      resolveManifest(buildErpEducationPack(), { registry: empty }),
    ).rejects.toThrow();
  });
});

describe("buildErpEducationPack — determinism + options", () => {
  it("hashes identically across two builds", () => {
    expect(manifestHash(buildErpEducationPack())).toBe(manifestHash(buildErpEducationPack()));
  });

  it("threads custom compliance packs", () => {
    expect(
      buildErpEducationPack({ compliancePacks: ["ferpa", "soc2"] }).meta.compliancePacks,
    ).toEqual(["ferpa", "soc2"]);
  });
});
