import type { Manifest } from "@crossengin/kernel";
import type { Entity } from "@crossengin/types/meta-schema";
import { buildErpConstructionPack } from "@crossengin/pack-erp-construction";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpEducationPack } from "@crossengin/pack-erp-education";
import { buildErpGovernmentPack } from "@crossengin/pack-erp-government";
import { buildErpGroceryPack } from "@crossengin/pack-erp-grocery";
import { buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import {
  CLASSIFIED_WRITE_MASK_FLAG,
  CLASSIFIED_WRITE_MASK_REFUSALS,
  EMPTY_SENSITIVE_FIELD_DECLARATION,
  SENSITIVE_FIELD_CLASS_FLAG,
  SENSITIVE_FIELD_ROLE_FLAG,
  buildSensitiveFieldPolicy,
  checkClassifiedWriteMask,
  formatSensitiveFieldSurvey,
  surveySensitiveFields,
  type SensitiveFieldDeclaration,
  type SensitiveFieldFinding,
  type SensitiveFieldSurvey,
} from "./sensitive-field-policy.js";

function manifest(parts: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture/pack", version: "1.0.0" },
    ...parts,
  };
}

function declaration(parts: Partial<SensitiveFieldDeclaration> = {}): SensitiveFieldDeclaration {
  return { ...EMPTY_SENSITIVE_FIELD_DECLARATION, ...parts };
}

/**
 * One entity carrying all four cases: a required `phi` field with no per-field grant
 * (`Patient.mrn`'s shape, which both live reproductions used), an optional sensitive field, a
 * classified-but-not-sensitive field, and an unclassified one.
 */
const PATIENT: Entity = {
  name: "Patient",
  fields: [
    { name: "mrn", type: { kind: "text" }, required: true, classification: "phi" },
    { name: "nickname", type: { kind: "text" }, classification: "pii" },
    { name: "chart_colour", type: { kind: "text" }, classification: "internal" },
    { name: "ward", type: { kind: "text" } },
  ],
};

const CLINICAL_ROLES: NonNullable<Manifest["roles"]> = {
  clinical_admin: { name: "clinical_admin" },
  clinician: { name: "clinician" },
  front_desk: { name: "front_desk" },
};

const CLINICAL_PERMS: NonNullable<Manifest["permissions"]> = {
  Patient: {
    read: { roles: ["clinical_admin", "clinician", "front_desk"] },
    create: { roles: ["clinical_admin", "clinician", "front_desk"] },
    update: { roles: ["clinical_admin", "clinician", "front_desk"] },
  },
};

function clinicalManifest(parts: Partial<Manifest> = {}): Manifest {
  return manifest({
    entities: [PATIENT],
    roles: CLINICAL_ROLES,
    permissions: CLINICAL_PERMS,
    ...parts,
  });
}

/** The manifest's declared roles are the universe, which is what `node.ts` passes. */
function survey(input: {
  readonly manifest?: Manifest;
  readonly declaration?: SensitiveFieldDeclaration;
  readonly roles?: readonly string[];
  readonly classifiedWriteMask?: boolean;
}): SensitiveFieldSurvey {
  const m = input.manifest ?? clinicalManifest();
  return surveySensitiveFields({
    manifest: m,
    declaration: input.declaration ?? EMPTY_SENSITIVE_FIELD_DECLARATION,
    roles: input.roles ?? Object.keys(m.roles ?? {}),
    classifiedWriteMask: input.classifiedWriteMask ?? true,
  });
}

function find(s: SensitiveFieldSurvey, entity: string, field: string): SensitiveFieldFinding {
  const f = s.findings.find((x) => x.entity === entity && x.field === field);
  if (f === undefined) throw new Error(`no finding for ${entity}.${field}`);
  return f;
}

const SEVEN_PACKS: readonly Manifest[] = [
  buildErpCorePack(),
  buildErpRetailPack(),
  buildErpHealthcarePack(),
  buildErpGroceryPack(),
  buildErpConstructionPack(),
  buildErpEducationPack(),
  buildErpGovernmentPack(),
];

describe("flag constants", () => {
  it("spells both grants as the entity-route counterparts of the audit pair", () => {
    expect([SENSITIVE_FIELD_ROLE_FLAG, SENSITIVE_FIELD_CLASS_FLAG]).toEqual([
      "--sensitive-field-role",
      "--sensitive-field-class",
    ]);
  });

  it("has exactly one write-mask refusal", () => {
    expect(CLASSIFIED_WRITE_MASK_REFUSALS).toEqual(["would_make_entity_uncreatable"]);
  });

  it("grants nothing from the empty declaration", () => {
    expect(EMPTY_SENSITIVE_FIELD_DECLARATION).toEqual({
      privilegedRoles: [],
      privilegedRolesByClass: {},
    });
  });
});

describe("buildSensitiveFieldPolicy", () => {
  const decl = declaration({
    privilegedRoles: ["clinical_admin"],
    privilegedRolesByClass: { phi: ["clinician"] },
  });

  it("returns the same policy for every entity", () => {
    const policyFor = buildSensitiveFieldPolicy(decl);
    expect(policyFor("Patient")).toBe(policyFor("Invoice"));
  });

  it("never answers undefined, so no entity follows a different rule", () => {
    const policyFor = buildSensitiveFieldPolicy(EMPTY_SENSITIVE_FIELD_DECLARATION);
    expect(policyFor("AnythingAtAll")).not.toBeUndefined();
  });

  it("carries both halves of the declaration through unchanged", () => {
    expect(buildSensitiveFieldPolicy(decl)("Patient")).toMatchObject({
      privilegedRoles: ["clinical_admin"],
      privilegedRolesByClass: { phi: ["clinician"] },
    });
  });

  it("leaves redactByDefault unset so the sensitive set stays isSensitiveDataClass'", () => {
    expect(buildSensitiveFieldPolicy(decl)("Patient")?.redactByDefault).toBeUndefined();
  });
});

describe("per-class authority (ADR-0329)", () => {
  it("lets a wholesale grantee read a class with no entry", () => {
    const s = survey({ declaration: declaration({ privilegedRoles: ["clinical_admin"] }) });
    expect(find(s, "Patient", "mrn").readableBy).toContain("clinical_admin");
  });

  it("withholds a class with an entry from a wholesale grantee", () => {
    const s = survey({
      declaration: declaration({
        privilegedRoles: ["clinical_admin"],
        privilegedRolesByClass: { phi: ["clinician"] },
      }),
    });
    expect(find(s, "Patient", "mrn").readableBy).toEqual(["clinician"]);
  });

  it("still lets the wholesale grantee reach a class the entry does not name", () => {
    const s = survey({
      declaration: declaration({
        privilegedRoles: ["clinical_admin"],
        privilegedRolesByClass: { phi: ["clinician"] },
      }),
    });
    // `nickname` is pii, which has no entry, so the wholesale grant reaches it.
    expect(find(s, "Patient", "nickname").readableBy).toContain("clinical_admin");
  });

  it("treats {phi: []} as a refusal rather than a fall-through to the wholesale grant", () => {
    const s = survey({
      declaration: declaration({
        privilegedRoles: ["clinical_admin"],
        privilegedRolesByClass: { phi: [] },
      }),
    });
    expect(find(s, "Patient", "mrn").readableBy).toEqual([]);
  });

  it("withholds {phi: []} from the write mask too, through the same function", () => {
    const s = survey({
      declaration: declaration({
        privilegedRoles: ["clinical_admin"],
        privilegedRolesByClass: { phi: [] },
      }),
    });
    expect(find(s, "Patient", "mrn").writableBy).toEqual([]);
  });

  it("grants read and write to the same roles from one declaration", () => {
    const s = survey({
      declaration: declaration({ privilegedRolesByClass: { phi: ["clinician"] } }),
    });
    const f = find(s, "Patient", "mrn");
    expect(f.readableBy).toEqual(f.writableBy);
  });
});

describe("surveySensitiveFields", () => {
  it("counts only the sensitive classes, not every classified field", () => {
    const s = survey({});
    // mrn (phi) + nickname (pii); chart_colour is `internal` and `ward` carries no class.
    expect(s.totalSensitive).toBe(2);
    expect(s.findings.map((f) => f.field)).toEqual(["mrn", "nickname"]);
  });

  it("reads `required` off the resolved field rather than guessing", () => {
    const s = survey({});
    expect(find(s, "Patient", "mrn").required).toBe(true);
    expect(find(s, "Patient", "nickname").required).toBe(false);
  });

  it("finds a classified field arriving through a custom trait", () => {
    const m = manifest({
      traits: [
        {
          name: "contactable",
          fields: [
            {
              name: "contact_email",
              type: { kind: "text" },
              required: true,
              classification: "pii",
            },
          ],
        },
      ],
      entities: [
        {
          name: "Supplier",
          fields: [{ name: "label", type: { kind: "text" } }],
          traits: ["contactable"],
        },
      ],
      roles: { ops: { name: "ops" } },
      permissions: { Supplier: { create: { roles: ["ops"] } } },
    });
    const s = survey({ manifest: m });
    expect(s.findings).toHaveLength(1);
    expect(find(s, "Supplier", "contact_email")).toMatchObject({
      classification: "pii",
      required: true,
      writableBy: [],
    });
  });

  it("is open to every role with the write mask off — the live defect", () => {
    const s = survey({ classifiedWriteMask: false });
    expect(find(s, "Patient", "mrn").writableBy).toEqual([
      "clinical_admin",
      "clinician",
      "front_desk",
    ]);
  });

  it("keeps the read side closed regardless of the write mask", () => {
    const s = survey({ classifiedWriteMask: false });
    expect(find(s, "Patient", "mrn").readableBy).toEqual([]);
  });

  it("lets an explicit per-field read grant win over the absent policy", () => {
    const m = clinicalManifest({
      permissions: {
        Patient: {
          ...CLINICAL_PERMS["Patient"],
          fields: { mrn: { read: { roles: ["front_desk"] } } },
        },
      },
    });
    expect(find(survey({ manifest: m }), "Patient", "mrn").readableBy).toEqual(["front_desk"]);
  });

  it("lets an explicit per-field update grant win over a wider declaration", () => {
    const m = clinicalManifest({
      permissions: {
        Patient: {
          ...CLINICAL_PERMS["Patient"],
          fields: { mrn: { update: { roles: ["clinical_admin"] } } },
        },
      },
    });
    const s = survey({
      manifest: m,
      declaration: declaration({ privilegedRoles: ["front_desk"] }),
    });
    expect(find(s, "Patient", "mrn").writableBy).toEqual(["clinical_admin"]);
  });

  it("names a role that inherits a privileged one, because resolveEffectiveRoles is asked", () => {
    const m = clinicalManifest({
      roles: { ...CLINICAL_ROLES, chief: { name: "chief", inherits: ["clinician"] } },
    });
    const s = survey({
      manifest: m,
      declaration: declaration({ privilegedRolesByClass: { phi: ["clinician"] } }),
    });
    // `chief` is never named by the declaration and is privileged all the same.
    expect(find(s, "Patient", "mrn").writableBy).toEqual(["clinician", "chief"]);
    expect(find(s, "Patient", "mrn").readableBy).toEqual(["clinician", "chief"]);
  });

  it("answers false for a role the manifest does not define, rather than throwing", () => {
    const s = survey({
      roles: ["clinical_admin", "ghost_role"],
      declaration: declaration({ privilegedRoles: ["ghost_role"] }),
    });
    expect(find(s, "Patient", "mrn")).toMatchObject({ writableBy: [], readableBy: [] });
  });

  it("does not throw on an inheritance cycle", () => {
    const m = clinicalManifest({
      roles: { a: { name: "a", inherits: ["b"] }, b: { name: "b", inherits: ["a"] } },
    });
    expect(() =>
      survey({ manifest: m, declaration: declaration({ privilegedRoles: ["a"] }) }),
    ).not.toThrow();
  });

  it("dedupes a role presented twice so writableBy cannot double it", () => {
    const s = survey({
      roles: ["clinical_admin", "clinical_admin"],
      declaration: declaration({ privilegedRoles: ["clinical_admin"] }),
    });
    expect(find(s, "Patient", "mrn").writableBy).toEqual(["clinical_admin"]);
  });

  it("carries no slot a field value could travel in", () => {
    expect(Object.keys(find(survey({}), "Patient", "mrn")).sort()).toEqual([
      "classification",
      "entity",
      "field",
      "readableBy",
      "required",
      "writableBy",
    ]);
  });
});

describe("uncreatable", () => {
  it("names a required sensitive field no declared role may write", () => {
    expect(survey({}).uncreatable.map((f) => `${f.entity}.${f.field}`)).toEqual(["Patient.mrn"]);
  });

  it("leaves an optional field writable by nobody out — that is a legitimate posture", () => {
    const s = survey({
      declaration: declaration({ privilegedRolesByClass: { phi: ["clinician"] } }),
    });
    // `nickname` (pii, optional) is writable by nobody here and must not be uncreatable.
    expect(find(s, "Patient", "nickname").writableBy).toEqual([]);
    expect(s.uncreatable).toEqual([]);
  });

  it("clears from a wholesale grant too", () => {
    expect(
      survey({ declaration: declaration({ privilegedRoles: ["clinical_admin"] }) }).uncreatable,
    ).toEqual([]);
  });

  it("is measured with the mask on even when the survey was taken with it off", () => {
    // Surveyed with the mask off, every role may write `mrn` — and the check that gates turning
    // the mask on must not be fooled by the regime it is leaving.
    const s = survey({ classifiedWriteMask: false });
    expect(find(s, "Patient", "mrn").writableBy).not.toEqual([]);
    expect(s.uncreatable.map((f) => f.field)).toEqual(["mrn"]);
  });

  it("stays silent for an entity no role may create anyway", () => {
    const m = clinicalManifest({ permissions: { Patient: { read: { roles: ["clinician"] } } } });
    expect(survey({ manifest: m }).uncreatable).toEqual([]);
  });

  it("names exactly the required-and-unwritable set across two entities", () => {
    const m = manifest({
      entities: [
        PATIENT,
        {
          name: "Student",
          fields: [
            {
              name: "student_email",
              type: { kind: "text" },
              required: true,
              classification: "pii",
            },
            { name: "note", type: { kind: "text" }, classification: "pii" },
          ],
        },
      ],
      roles: CLINICAL_ROLES,
      permissions: { ...CLINICAL_PERMS, Student: { create: { roles: ["clinical_admin"] } } },
    });
    expect(survey({ manifest: m }).uncreatable.map((f) => `${f.entity}.${f.field}`)).toEqual([
      "Patient.mrn",
      "Student.student_email",
    ]);
  });
});

describe("checkClassifiedWriteMask", () => {
  it("permits a survey with nothing uncreatable", () => {
    const s = survey({ declaration: declaration({ privilegedRoles: ["clinical_admin"] }) });
    expect(checkClassifiedWriteMask(s)).toEqual({ ok: true });
  });

  it("refuses with the one declared reason", () => {
    const result = checkClassifiedWriteMask(survey({}));
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("would_make_entity_uncreatable");
  });

  it("names the entity and the field in the detail", () => {
    const result = checkClassifiedWriteMask(survey({}));
    if (result.ok) throw new Error("expected a refusal");
    expect(result.detail).toContain("Patient (mrn)");
  });

  it("names the flag it refuses and both grant flags, so the refusal is the migration guide", () => {
    const result = checkClassifiedWriteMask(survey({}));
    if (result.ok) throw new Error("expected a refusal");
    expect(result.detail).toContain(CLASSIFIED_WRITE_MASK_FLAG);
    expect(result.detail).toContain(SENSITIVE_FIELD_ROLE_FLAG);
    expect(result.detail).toContain(SENSITIVE_FIELD_CLASS_FLAG);
  });

  it("groups several fields under their entity and counts it once", () => {
    const m = manifest({
      entities: [
        {
          name: "Patient",
          fields: [
            { name: "mrn", type: { kind: "text" }, required: true, classification: "phi" },
            { name: "given_name", type: { kind: "text" }, required: true, classification: "pii" },
          ],
        },
      ],
      roles: CLINICAL_ROLES,
      permissions: { Patient: { create: { roles: ["clinical_admin"] } } },
    });
    const result = checkClassifiedWriteMask(survey({ manifest: m }));
    if (result.ok) throw new Error("expected a refusal");
    expect(result.detail).toContain("Patient (mrn, given_name)");
    expect(result.detail).toContain("1 entity ");
  });
});

describe("formatSensitiveFieldSurvey", () => {
  it("says so when the manifest has no sensitive field", () => {
    expect(formatSensitiveFieldSurvey(survey({ manifest: manifest() }))).toContain(
      "no sensitive-classified fields",
    );
  });

  it("counts the fields per class", () => {
    expect(formatSensitiveFieldSurvey(survey({}))).toContain(
      "2 sensitive-classified field(s): phi 1, pii 1",
    );
  });

  it("marks the write mask as off in capitals, because that is the open state", () => {
    expect(formatSensitiveFieldSurvey(survey({ classifiedWriteMask: false }))).toContain(
      "classified write mask OFF",
    );
  });

  it("reports the fields unreadable by every declared role", () => {
    expect(formatSensitiveFieldSurvey(survey({}))).toContain(
      "unreadable by every declared role: 2 — Patient.mrn, Patient.nickname",
    );
  });

  it("reports the writable-but-unreadable asymmetry, which is the finding", () => {
    // The mask off is the live state: every role writes `mrn` and none of them can read it.
    expect(formatSensitiveFieldSurvey(survey({ classifiedWriteMask: false }))).toContain(
      "writable by a role that cannot read it: 2 — Patient.mrn, Patient.nickname",
    );
  });

  it("omits the asymmetry line when read and write agree", () => {
    const out = formatSensitiveFieldSurvey(
      survey({ declaration: declaration({ privilegedRoles: ["clinical_admin"] }) }),
    );
    expect(out).not.toContain("cannot read it");
  });

  it("reports the uncreatable entities", () => {
    expect(formatSensitiveFieldSurvey(survey({}))).toContain(
      "so their entity is uncreatable: Patient.mrn",
    );
  });

  it("truncates a long list and keeps the count", () => {
    const fields = Array.from({ length: 12 }, (_v, i) => ({
      name: `f${i.toString()}`,
      type: { kind: "text" } as const,
      classification: "pii" as const,
    }));
    const m = manifest({ entities: [{ name: "Wide", fields }], roles: { ops: { name: "ops" } } });
    const out = formatSensitiveFieldSurvey(survey({ manifest: m }));
    expect(out).toContain("(+4 more)");
    expect(out).toContain("12 sensitive-classified field(s)");
  });

  it("emits names, classifications and role names only — no value can reach it", () => {
    // Every token comes from the manifest's *names* or the survey's own counts: the survey is
    // never handed a record, so there is nothing else for it to print.
    const out = formatSensitiveFieldSurvey(survey({ classifiedWriteMask: false }));
    for (const line of out.split("\n")) expect(line.startsWith("[fields] ")).toBe(true);
    expect(out).not.toContain("MRN-");
  });
});

describe("the real packs", () => {
  it("finds Patient.mrn in the healthcare pack, now granted in both directions", () => {
    // Both lists were **empty** until ADR-0348 authored the pack's grants: unreadable by every role
    // and writable by anybody holding entity `update`. The write set is narrower than the read set
    // by one role on purpose — `front_desk` sets the number at registration through the `create`
    // arm, which this survey does not report, and can neither read it back nor change it.
    const s = survey({ manifest: buildErpHealthcarePack() });
    expect(find(s, "Patient", "mrn")).toMatchObject({
      classification: "phi",
      required: true,
      readableBy: ["clinical_admin", "clinician", "hipaa_auditor"],
      writableBy: ["clinical_admin", "clinician"],
    });
  });

  it("leaves Patient creatable with no declaration at all, now that the pack grants its fields", () => {
    // These five required phi/pii fields were the healthcare half of the 12 that a bare
    // `--classified-write-mask` would have made uncreatable. The pack declares them now, so the
    // flag needs no deployment declaration to be safe here — which is what makes it a candidate for
    // becoming the default rather than opt-in.
    const hc = buildErpHealthcarePack();
    expect(survey({ manifest: hc }).uncreatable).toEqual([]);
    expect(
      survey({ manifest: hc, declaration: declaration({ privilegedRoles: ["clinical_admin"] }) })
        .uncreatable,
    ).toEqual([]);
  });

  it("finds Citizen.national_id in the government pack, whose read and update are unchanged", () => {
    const s = survey({ manifest: buildErpGovernmentPack() });
    expect(find(s, "Citizen", "national_id")).toMatchObject({
      classification: "regulated",
      required: true,
      // One of the 7 fields that always had explicit grants, and ADR-0348 changed **neither** of
      // these two lists — it added a `create` arm beside them. `writableBy` reports the `update`
      // grant, so a case worker still cannot change a national id; what the arm fixed is that they
      // can now **set** one, which is what registering a citizen requires.
      readableBy: ["gov_admin", "case_worker", "gov_auditor"],
      writableBy: ["gov_admin"],
    });
    // The fix itself, read off the declaration rather than the survey.
    expect(
      buildErpGovernmentPack().permissions?.Citizen?.fields?.national_id?.create?.roles,
    ).toEqual(["gov_admin", "case_worker"]);
  });

  it("counts 46 sensitive-classified fields across the seven packs", () => {
    // A **tripwire on the packs**, not a property of this module: the figure measured for this
    // increment is 24 pii + 17 commercial_sensitive + 4 phi + 1 regulated, and it is what makes
    // the read/write asymmetry's scale concrete. If a pack gains or loses a classified field this
    // number moves, and whoever moved it should see this test and re-read the survey it feeds.
    const total = SEVEN_PACKS.reduce((n, m) => n + survey({ manifest: m }).totalSensitive, 0);
    expect(total).toBe(46);
  });

  it("counts no uncreatable field across the seven packs, where there were 12", () => {
    // The same tripwire from the other side, and the one assertion that says this increment
    // landed. These twelve were the blocking subset of ADR-0339's boot refusal — `Employee`,
    // `Lead`, `Opportunity`, `FixedAsset`, `Patient`, `Student` and `Permit` uncreatable by every
    // role under a bare `--classified-write-mask`:
    //
    //   Employee.work_email, Lead.full_name, Opportunity.amount, FixedAsset.acquisition_cost,
    //   Patient.mrn, Patient.given_name, Patient.family_name, Patient.date_of_birth, Patient.sex,
    //   Student.student_email, Student.date_of_birth, Permit.fee_amount
    //
    // Every one is granted now, so the refusal has nothing left to name on the shipped packs. The
    // assertion is the empty list rather than a count, so a regression prints the field.
    const named = SEVEN_PACKS.flatMap((m) =>
      survey({ manifest: m }).uncreatable.map((f) => `${f.entity}.${f.field}`),
    );
    expect(named).toEqual([]);
  });
});
