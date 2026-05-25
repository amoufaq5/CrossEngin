import {
  ManifestSchema,
  computeManifestDiff,
  manifestHash,
  resolveManifest,
  tryValidateManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import {
  buildErpHealthcarePack,
  ERP_HEALTHCARE_DEFAULT_COMPLIANCE_PACKS,
  ERP_HEALTHCARE_PACK_SLUG,
  ERP_HEALTHCARE_PACK_VERSION,
} from "./pack.js";

function makeRegistry(): ManifestRegistry {
  const map: Record<string, Manifest> = {
    [ERP_CORE_PACK_SLUG]: buildErpCorePack(),
  };
  return {
    async getManifest(slug: string): Promise<Manifest | null> {
      return map[slug] ?? null;
    },
  };
}

async function buildResolvedHealthcare(): Promise<Manifest> {
  return resolveManifest(buildErpHealthcarePack(), { registry: makeRegistry() });
}

describe("buildErpHealthcarePack — manifest shape (child-only)", () => {
  it("parses against the kernel ManifestSchema", () => {
    const m = buildErpHealthcarePack();
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("uses the documented slug + version", () => {
    const m = buildErpHealthcarePack();
    expect(m.meta.slug).toBe(ERP_HEALTHCARE_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_HEALTHCARE_PACK_VERSION);
  });

  it("declares extends: ['operate-erp/core']", () => {
    const m = buildErpHealthcarePack();
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("defaults compliancePacks to HIPAA + 21 CFR 11", () => {
    const m = buildErpHealthcarePack();
    expect(m.meta.compliancePacks).toEqual(["hipaa", "21_cfr_11"]);
    expect(ERP_HEALTHCARE_DEFAULT_COMPLIANCE_PACKS).toEqual(["hipaa", "21_cfr_11"]);
  });

  it("threads compliancePacks + description overrides", () => {
    const m = buildErpHealthcarePack({
      description: "custom",
      compliancePacks: ["hipaa"],
    });
    expect(m.meta.description).toBe("custom");
    expect(m.meta.compliancePacks).toEqual(["hipaa"]);
  });

  it("child manifest carries only healthcare additions (3 entities, 3 relations)", () => {
    const m = buildErpHealthcarePack();
    expect(m.entities).toHaveLength(3);
    expect(m.entities?.map((e) => e.name)).toEqual(["Patient", "Encounter", "Observation"]);
    expect(m.relations).toHaveLength(3);
  });
});

describe("buildErpHealthcarePack — full kernel cross-validation (resolved)", () => {
  it("passes tryValidateManifest with the merged core + healthcare manifest", async () => {
    const m = await buildResolvedHealthcare();
    const result = tryValidateManifest(m);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("returns deterministic hash across resolved builds", async () => {
    expect(manifestHash(await buildResolvedHealthcare())).toBe(
      manifestHash(await buildResolvedHealthcare()),
    );
  });

  it("differs from the core pack hash (extends adds entities)", async () => {
    expect(manifestHash(await buildResolvedHealthcare())).not.toBe(
      manifestHash(buildErpCorePack()),
    );
  });

  it("diff from core to resolved healthcare adds exactly Patient + Encounter + Observation", async () => {
    const diff = computeManifestDiff(buildErpCorePack(), await buildResolvedHealthcare());
    expect(diff.addedEntities.map((e) => e.name).sort()).toEqual([
      "Encounter",
      "Observation",
      "Patient",
    ]);
    expect(diff.removedEntities).toHaveLength(0);
  });

  it("self-diff returns no changes", async () => {
    const diff = computeManifestDiff(
      await buildResolvedHealthcare(),
      await buildResolvedHealthcare(),
    );
    expect(diff.addedEntities).toHaveLength(0);
    expect(diff.removedEntities).toHaveLength(0);
    expect(diff.modifiedEntities).toHaveLength(0);
  });
});

describe("buildErpHealthcarePack — composition counts (resolved)", () => {
  it("has 7 entities (4 from core + Patient/Encounter/Observation)", async () => {
    const m = await buildResolvedHealthcare();
    expect(m.entities).toHaveLength(7);
  });

  it("has 6 relations (3 from core + Account→Patients / Patient→Encounters / Encounter→Observations)", async () => {
    const m = await buildResolvedHealthcare();
    expect(m.relations).toHaveLength(6);
  });

  it("has 5 roles (core's 3 + erp_clinician + erp_front_desk)", async () => {
    const m = await buildResolvedHealthcare();
    expect(Object.keys(m.roles ?? {}).sort()).toEqual([
      "erp_accountant",
      "erp_admin",
      "erp_clinician",
      "erp_front_desk",
      "erp_viewer",
    ]);
  });

  it("has 7 permission entries (core's 4 + healthcare's 3)", async () => {
    const m = await buildResolvedHealthcare();
    expect(Object.keys(m.permissions ?? {})).toHaveLength(7);
  });

  it("has 3 workflows (invoice_lifecycle + encounter_lifecycle + observation_lifecycle)", async () => {
    const m = await buildResolvedHealthcare();
    expect(Object.keys(m.workflows ?? {}).sort()).toEqual([
      "encounter_lifecycle",
      "invoice_lifecycle",
      "observation_lifecycle",
    ]);
  });

  it("has 5 jobs (core's 2 + healthcare's 3)", async () => {
    const m = await buildResolvedHealthcare();
    expect(Object.keys(m.jobs ?? {})).toHaveLength(5);
  });

  it("has 5 views (core's 2 + healthcare's 3)", async () => {
    const m = await buildResolvedHealthcare();
    expect(Object.keys(m.views ?? {})).toHaveLength(5);
  });
});

describe("Patient + Encounter + Observation composition (resolved)", () => {
  it("Patient.contact_id resolves to the core Contact entity via the merged manifest", async () => {
    const m = await buildResolvedHealthcare();
    const patient = (m.entities ?? []).find((e) => e.name === "Patient");
    const contact = (m.entities ?? []).find((e) => e.name === "Contact");
    expect(patient).toBeDefined();
    expect(contact).toBeDefined();
    const contactRef = patient?.fields.find((f) => f.name === "contact_id");
    if (contactRef?.type.kind !== "reference") {
      throw new Error("contact_id is not a reference");
    }
    expect(contactRef.type.target).toBe("Contact");
  });

  it("Patient.account_id resolves to the core Account entity", async () => {
    const m = await buildResolvedHealthcare();
    const patient = (m.entities ?? []).find((e) => e.name === "Patient");
    const acctRef = patient?.fields.find((f) => f.name === "account_id");
    if (acctRef?.type.kind !== "reference") {
      throw new Error("account_id is not a reference");
    }
    expect(acctRef.type.target).toBe("Account");
  });

  it("encounter_lifecycle has 6 states with 3 terminals (completed / cancelled / no_show)", async () => {
    const m = await buildResolvedHealthcare();
    const wf = m.workflows?.["encounter_lifecycle"];
    if (wf?.kind !== "entityLifecycle") return;
    expect(wf.states).toHaveLength(6);
    const terminals = wf.states
      .filter((s) => s.category === "terminal")
      .map((s) => s.name)
      .sort();
    expect(terminals).toEqual(["cancelled", "completed", "no_show"]);
  });

  it("Encounter permissions cover all 5 named lifecycle transitions", async () => {
    const m = await buildResolvedHealthcare();
    const perms = m.permissions?.["Encounter"];
    expect(Object.keys(perms?.transitions ?? {}).sort()).toEqual([
      "cancel",
      "check_in",
      "complete",
      "mark_no_show",
      "start",
    ]);
  });

  it("Observation permissions only let admins flag entered_in_error (FHIR amendment discipline)", async () => {
    const m = await buildResolvedHealthcare();
    const perms = m.permissions?.["Observation"];
    expect(perms?.transitions?.["mark_in_error"]?.roles).toEqual(["erp_admin"]);
  });
});
