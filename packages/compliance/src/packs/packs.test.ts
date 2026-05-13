import { describe, expect, it } from "vitest";
import { CompliancePackSchema } from "../types.js";
import { pack as hipaaPack } from "./hipaa/pack.js";
import { pack as gdprPack } from "./gdpr/pack.js";
import { pack as uaeMohPack } from "./uae-moh/pack.js";

describe("hipaa pack", () => {
  it("validates against CompliancePackSchema", () => {
    expect(() => CompliancePackSchema.parse(hipaaPack)).not.toThrow();
  });

  it("declares the covered-entity, retention, privacy/security-officer parameters", () => {
    const params = hipaaPack.meta.parameters ?? {};
    expect(Object.keys(params).sort()).toEqual([
      "allowPhiInNotifications",
      "auditRetentionYears",
      "breachNotificationDays",
      "coveredEntityType",
      "minimumNecessaryStandard",
      "privacyOfficerName",
      "requireMfaForPhiAccess",
      "securityOfficerName",
    ]);
  });

  it("defaults audit retention to 6 years (§164.316(b)(2)(i))", () => {
    const p = hipaaPack.meta.parameters?.auditRetentionYears;
    expect(p?.type).toBe("integer");
    if (p?.type === "integer") {
      expect(p.min).toBe(6);
      expect(p.default).toBe(6);
    }
  });

  it("caps breach notification at 60 days (§164.404(b))", () => {
    const p = hipaaPack.meta.parameters?.breachNotificationDays;
    expect(p?.type).toBe("integer");
    if (p?.type === "integer") {
      expect(p.max).toBe(60);
      expect(p.default).toBe(60);
    }
  });

  it("requires privacy and security officer names", () => {
    expect(hipaaPack.meta.parameters?.privacyOfficerName?.required).toBe(true);
    expect(hipaaPack.meta.parameters?.securityOfficerName?.required).toBe(true);
  });

  it("contributes PhiAccessLog, BreachIncident, BusinessAssociateAgreement", () => {
    const names = (hipaaPack.contributions.entities ?? []).map((e) => e.name).sort();
    expect(names).toEqual(["BreachIncident", "BusinessAssociateAgreement", "PhiAccessLog"]);
  });

  it("contributes the phi trait with encryption_at_rest_required defaulting true", () => {
    const phi = (hipaaPack.contributions.traits ?? []).find((t) => t.name === "phi");
    expect(phi).toBeDefined();
    const enc = phi?.fields.find((f) => f.name === "encryption_at_rest_required");
    expect(enc?.default).toEqual({ kind: "literal", value: true });
  });
});

describe("gdpr pack", () => {
  it("validates against CompliancePackSchema", () => {
    expect(() => CompliancePackSchema.parse(gdprPack)).not.toThrow();
  });

  it("declares DPO + lawful basis + breach + DSR parameters", () => {
    const params = gdprPack.meta.parameters ?? {};
    expect(Object.keys(params).sort()).toEqual([
      "allowInternationalTransfers",
      "breachNotificationHours",
      "dataSubjectRequestResponseDays",
      "defaultRetentionMonths",
      "dpoEmail",
      "dpoName",
      "legalBasis",
      "requireConsentForCookies",
    ]);
  });

  it("requires dpoName + dpoEmail (Article 13(1)(b))", () => {
    expect(gdprPack.meta.parameters?.dpoName?.required).toBe(true);
    expect(gdprPack.meta.parameters?.dpoEmail?.required).toBe(true);
  });

  it("caps breach notification at 72 hours (Article 33(1))", () => {
    const p = gdprPack.meta.parameters?.breachNotificationHours;
    expect(p?.type).toBe("integer");
    if (p?.type === "integer") {
      expect(p.max).toBe(72);
      expect(p.default).toBe(72);
    }
  });

  it("caps DSR response window at 30 days (Article 12(3))", () => {
    const p = gdprPack.meta.parameters?.dataSubjectRequestResponseDays;
    expect(p?.type).toBe("integer");
    if (p?.type === "integer") {
      expect(p.max).toBe(30);
    }
  });

  it("offers the six Article 6(1) lawful bases", () => {
    const p = gdprPack.meta.parameters?.legalBasis;
    expect(p?.type).toBe("enum");
    if (p?.type === "enum") {
      expect(p.values.sort()).toEqual([
        "consent",
        "contract",
        "legal_obligation",
        "legitimate_interests",
        "public_task",
        "vital_interests",
      ]);
    }
  });

  it("contributes DataSubjectRequest, Consent, DataProcessingActivity, PersonalDataBreach", () => {
    const names = (gdprPack.contributions.entities ?? []).map((e) => e.name).sort();
    expect(names).toEqual([
      "Consent",
      "DataProcessingActivity",
      "DataSubjectRequest",
      "PersonalDataBreach",
    ]);
  });

  it("contributes the personal_data trait requiring legal_basis on each tagged entity", () => {
    const pd = (gdprPack.contributions.traits ?? []).find((t) => t.name === "personal_data");
    expect(pd).toBeDefined();
    const lb = pd?.fields.find((f) => f.name === "legal_basis");
    expect(lb?.required).toBe(true);
  });
});

describe("uae-moh pack", () => {
  it("validates against CompliancePackSchema", () => {
    expect(() => CompliancePackSchema.parse(uaeMohPack)).not.toThrow();
  });

  it("declares residency, registration, retention, bilingual, and officer parameters", () => {
    const params = uaeMohPack.meta.parameters ?? {};
    expect(Object.keys(params).sort()).toEqual([
      "bilingualClinicalDocumentation",
      "clinicalRecordRetentionYears",
      "dataResidency",
      "facilityType",
      "medicalDirectorName",
      "mohRegistrationNumber",
      "practitionerLicenseVerificationRequired",
      "qualityOfficerName",
    ]);
  });

  it("enforces UAE-only residency choices", () => {
    const p = uaeMohPack.meta.parameters?.dataResidency;
    expect(p?.type).toBe("enum");
    if (p?.type === "enum") {
      expect(p.values).toEqual(["uae-mainland", "difc", "adgm"]);
      expect(p.required).toBe(true);
    }
  });

  it("sets the 25-year clinical-record retention floor", () => {
    const p = uaeMohPack.meta.parameters?.clinicalRecordRetentionYears;
    expect(p?.type).toBe("integer");
    if (p?.type === "integer") {
      expect(p.min).toBe(25);
      expect(p.default).toBe(25);
    }
  });

  it("contributes PractitionerLicense, ClinicalEncounter, FacilityRegistration, AdverseEventReport", () => {
    const names = (uaeMohPack.contributions.entities ?? []).map((e) => e.name).sort();
    expect(names).toEqual([
      "AdverseEventReport",
      "ClinicalEncounter",
      "FacilityRegistration",
      "PractitionerLicense",
    ]);
  });

  it("makes ClinicalEncounter bilingual (Arabic + English chief complaint required)", () => {
    const encounter = (uaeMohPack.contributions.entities ?? []).find(
      (e) => e.name === "ClinicalEncounter",
    );
    const en = encounter?.fields.find((f) => f.name === "chief_complaint_en");
    const ar = encounter?.fields.find((f) => f.name === "chief_complaint_ar");
    expect(en?.required).toBe(true);
    expect(ar?.required).toBe(true);
  });

  it("contributes the uae_clinical_record trait defaulting to UAE residency + 25y retention", () => {
    const t = (uaeMohPack.contributions.traits ?? []).find((x) => x.name === "uae_clinical_record");
    const residency = t?.fields.find((f) => f.name === "residency_jurisdiction");
    const retention = t?.fields.find((f) => f.name === "retention_minimum_years");
    expect(residency?.default).toEqual({ kind: "literal", value: "uae-mainland" });
    expect(retention?.default).toEqual({ kind: "literal", value: 25 });
  });

  it("declares MoHAP as the regulator", () => {
    expect(uaeMohPack.meta.regulator).toContain("MoHAP");
  });
});

describe("v1 showcase packs — cross-pack invariants", () => {
  const allPacks = [hipaaPack, gdprPack, uaeMohPack];

  it("each pack has a unique id and semver version", () => {
    const ids = new Set<string>();
    for (const p of allPacks) {
      expect(ids.has(p.meta.id)).toBe(false);
      ids.add(p.meta.id);
      expect(p.meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("each pack contributes at least one auditable entity", () => {
    for (const p of allPacks) {
      const auditable = (p.contributions.entities ?? []).filter((e) =>
        (e.traits ?? []).includes("auditable"),
      );
      expect(auditable.length).toBeGreaterThan(0);
    }
  });

  it("each pack contributes a trait with a stable snake_case name", () => {
    for (const p of allPacks) {
      const traits = p.contributions.traits ?? [];
      expect(traits.length).toBeGreaterThan(0);
      for (const t of traits) {
        expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it("no two packs contribute an entity with the same name", () => {
    const seen = new Map<string, string>();
    for (const p of allPacks) {
      for (const e of p.contributions.entities ?? []) {
        const prior = seen.get(e.name);
        expect(prior).toBeUndefined();
        seen.set(e.name, p.meta.id);
      }
    }
  });
});
