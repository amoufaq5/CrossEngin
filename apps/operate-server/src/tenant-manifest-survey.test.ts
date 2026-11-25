import type { Manifest } from "@crossengin/kernel/manifest";
import type { ReportSurface } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  CURSOR_DISCLOSURE_MAY_SERVE,
  type CursorDisclosureDecision,
} from "./cursor-encryption.js";
import type { SensitiveFieldFinding, SensitiveFieldSurvey } from "./sensitive-field-policy.js";
import {
  formatTenantManifestSurvey,
  servedFromOf,
  surveyTenantManifest,
  TENANT_SERVED_FROM,
  TENANT_SURVEY_FINDING_KINDS,
  tenantSurveyFindings,
  tenantSurveyHasFinding,
  type TenantManifestSurveyReport,
  type TenantSurveyBase,
  type TenantSurveyContext,
  type TenantSurveyFindingKind,
} from "./tenant-manifest-survey.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function finding(over: Partial<SensitiveFieldFinding> = {}): SensitiveFieldFinding {
  return {
    entity: "Patient",
    field: "mrn",
    classification: "phi",
    required: false,
    readableBy: ["clinician"],
    writableBy: ["clinician"],
    ...over,
  };
}

function survey(over: Partial<SensitiveFieldSurvey> = {}): SensitiveFieldSurvey {
  return { totalSensitive: 1, classifiedWriteMask: true, findings: [finding()], uncreatable: [], ...over };
}

function cursor(verdict: CursorDisclosureDecision["verdict"]): CursorDisclosureDecision {
  // `mayServe` read from the real map rather than hardcoded `true`, so a flip is visible here.
  return { verdict, detail: `detail for ${verdict}`, fields: [], mayServe: CURSOR_DISCLOSURE_MAY_SERVE[verdict] };
}

const VENDOR = { name: "Vendor", fields: [{ name: "name", type: { kind: "text" } }] };

/** The deployment's own manifest: one plain entity, no views, no jobs, no workflows. */
function deployment(over: Record<string, unknown> = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { slug: "t/deploy", name: "Deploy", version: "1.0.0" },
    roles: { clerk: { label: { en: "Clerk" } } },
    entities: [VENDOR],
    ...over,
  } as unknown as Manifest;
}

/** A tenant manifest, identical to the deployment's unless a case adds something. */
function tenant(over: Record<string, unknown> = {}): Manifest {
  return deployment({ meta: { slug: "t/tenant", name: "Tenant", version: "1.0.0" }, ...over });
}

function base(over: Partial<TenantSurveyBase> = {}): TenantSurveyBase {
  return { sensitive: survey(), cursorDisclosure: cursor("sealed"), reportSurfaces: [], ...over };
}

function ctx(over: Partial<TenantSurveyContext> = {}): TenantSurveyContext {
  return {
    deploymentManifest: deployment(),
    storeKind: "pg",
    servedFrom: "shared",
    segregationOfDuties: { enabled: true, removalsRead: true },
    phi: { keyConfigured: true, allowPlaintextPhi: false },
    allowDanglingReferences: false,
    ...over,
  };
}

function reportOf(
  manifest: Manifest = tenant(),
  b: Partial<TenantSurveyBase> = {},
  c: Partial<TenantSurveyContext> = {},
): TenantManifestSurveyReport {
  return surveyTenantManifest(manifest, base(b), ctx(c));
}

const PHI_ENTITY = {
  name: "Patient",
  traits: ["auditable"],
  fields: [{ name: "mrn", type: { kind: "text" }, classification: "phi" }],
};

const SCHEDULED_JOB = {
  id: "tenant-own-sweep",
  name: "Tenant sweep",
  description: "A job only this tenant declares.",
  trigger: { kind: "scheduled", cron: "0 6 * * *", timezone: "UTC" },
  concurrency: { limit: 1 },
  retry: {
    maxAttempts: 3,
    backoff: { kind: "exponential", initialDelay: "PT1M", maxDelay: "PT30M", jitter: true },
  },
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

const REPORT_SURFACE = {
  operationId: "reports.vendor_aging",
  reads: ["Vendor"],
  viewerRoles: new Set(["clerk"]),
} as unknown as ReportSurface;

const lifecycle = (transition: string): Record<string, unknown> => ({
  vendor_lifecycle: {
    kind: "entityLifecycle",
    entity: "Vendor",
    stateField: "state",
    initialState: "draft",
    states: [{ name: "draft" }, { name: "done" }],
    transitions: [{ name: transition, from: "draft", to: "done" }],
  },
});

describe("servedFromOf", () => {
  it("maps every non-throwing serving arm, and a deployment with no registry to `shared`", () => {
    expect(servedFromOf("applied")).toBe("own_schema");
    expect(servedFromOf("retained")).toBe("own_schema_retained");
    expect(servedFromOf("refused")).toBe("fallback");
    expect(servedFromOf(null)).toBe("shared");
  });
});

describe("tenantSurveyHasFinding", () => {
  it("is false for a tenant manifest identical to the deployment's", () => {
    expect(tenantSurveyFindings(reportOf())).toEqual([]);
    expect(tenantSurveyHasFinding(reportOf())).toBe(false);
  });

  it("keeps the sensitive-field conditions: unreadable, unwritable, blind overwrite, uncreatable", () => {
    for (const s of [
      survey({ findings: [finding({ readableBy: [] })] }),
      survey({ findings: [finding({ writableBy: [] })] }),
      survey({ findings: [finding({ readableBy: ["clinician"], writableBy: ["front_desk"] })] }),
      survey({ uncreatable: [finding({ required: true, writableBy: [] })] }),
    ]) {
      expect(tenantSurveyFindings(reportOf(tenant(), { sensitive: s }))).toEqual(["sensitive_fields"]);
    }
    const reader = survey({ findings: [finding({ readableBy: ["clinician", "auditor"] })] });
    expect(tenantSurveyHasFinding(reportOf(tenant(), { sensitive: reader }))).toBe(false);
  });

  it("is a finding for a plaintext-disclosing cursor and for no other cursor verdict", () => {
    expect(tenantSurveyFindings(reportOf(tenant(), { cursorDisclosure: cursor("plaintext_disclosing") }))).toEqual([
      "cursor_disclosure",
    ]);
    for (const v of ["sealed", "plaintext_accepted", "no_sortable_classified_field"] as const) {
      expect(tenantSurveyHasFinding(reportOf(tenant(), { cursorDisclosure: cursor(v) })), v).toBe(false);
    }
  });

  it("reports a retained or a fallback serving and is silent for the two coherent ones", () => {
    const answers = Object.fromEntries(
      TENANT_SERVED_FROM.map((s) => [s, tenantSurveyFindings(reportOf(tenant(), {}, { servedFrom: s })).includes("served_from")]),
    );
    expect(answers).toEqual({ own_schema: false, own_schema_retained: true, fallback: true, shared: false });
  });

  it("reports a declared list surface the tenant's store refuses", () => {
    const m = tenant({
      entities: [VENDOR, PHI_ENTITY],
      views: {
        "patient.list": {
          kind: "list",
          entity: "Patient",
          label: { en: "Patients" },
          permissions: "inherit",
          columns: [{ field: "mrn", label: { en: "MRN" } }],
        },
      },
    });
    const kinds = tenantSurveyFindings(reportOf(m, {}, { servedFrom: "own_schema" }));
    expect(kinds).toContain("list_surfaces");
  });

  it("reports a declared unique the tenant's store does not enforce", () => {
    // `--store memory` enforces none: a shared in-memory store is the cheapest member to construct.
    const m = tenant({
      entities: [{ name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] }],
    });
    expect(tenantSurveyFindings(reportOf(m, {}, { storeKind: "memory" }))).toContain("unique_enforcement");
  });

  it("reports a tenant-only unique or reference the shared document store enforces nothing of", () => {
    // The document store builds its indexes and checks its references from the DEPLOYMENT's
    // manifest, so the pure survey's "enforced" would be a falsely-true control here.
    const m = tenant({
      entities: [
        { name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] },
        {
          name: "Bill",
          fields: [{ name: "vendor_id", type: { kind: "reference", target: "Vendor" } }],
        },
      ],
    });
    const r = reportOf(m);
    expect(r.uniqueEnforcement).toBeNull();
    expect(r.documentStoreGap).toEqual({
      unindexedUnique: ["Vendor.name"],
      uncheckedReferences: ["Bill.vendor_id"],
      referencesCheckedBy: "deployment_plan",
    });
    expect(tenantSurveyFindings(r)).toEqual(["document_store_gap"]);
    // A declaration the deployment shares is enforced, so it is not a gap.
    expect(reportOf(m, {}, { deploymentManifest: m }).documentStoreGap).toEqual({
      unindexedUnique: [],
      uncheckedReferences: [],
      referencesCheckedBy: "deployment_plan",
    });
  });

  it("counts even an inherited reference unchecked on the fallback, whose store is built with no manifest", () => {
    // `node.ts` builds the pg-columns fallback as `new PostgresEntityStore(conn, schemaOpt)` — no
    // manifest — so it checks no reference at all. Comparing against the deployment's plan there
    // would call the shared `Bill.vendor_id` checked while nothing checks it.
    const m = tenant({
      entities: [VENDOR, { name: "Bill", fields: [{ name: "vendor_id", type: { kind: "reference", target: "Vendor" } }] }],
    });
    const r = reportOf(m, {}, { deploymentManifest: m, storeKind: "pg-columns", servedFrom: "fallback" });
    expect(r.documentStoreGap).toEqual({
      unindexedUnique: [],
      uncheckedReferences: ["Bill.vendor_id"],
      referencesCheckedBy: "nothing",
    });
    const text = formatTenantManifestSurvey(TENANT, r).lines.join("\n");
    expect(text).toContain("built with no manifest and checks no reference");
    expect(text).not.toContain("checks the references of the deployment's manifest");
  });

  it("raises no reference finding where --allow-dangling-references turned the check off deployment-wide", () => {
    const m = tenant({
      entities: [VENDOR, { name: "Bill", fields: [{ name: "vendor_id", type: { kind: "reference", target: "Vendor" } }] }],
    });
    const r = reportOf(m, {}, { allowDanglingReferences: true });
    expect(r.documentStoreGap).toEqual({ unindexedUnique: [], uncheckedReferences: [], referencesCheckedBy: "off_by_flag" });
    expect(tenantSurveyFindings(r)).not.toContain("document_store_gap");
    // The control: the same manifest with the check on is a finding.
    expect(tenantSurveyFindings(reportOf(m))).toContain("document_store_gap");
  });

  it("reports a declared member in a section no request path reads", () => {
    const m = tenant({ theme: { brandColor: "#123456" } });
    expect(tenantSurveyFindings(reportOf(m))).toEqual(["unserved_sections"]);
  });

  it("reports a view role override nothing enforces", () => {
    const m = tenant({
      views: {
        "vendor.list": {
          kind: "list",
          entity: "Vendor",
          label: { en: "Vendors" },
          permissions: { roles: ["clerk"] },
          columns: [{ field: "name", label: { en: "Name" } }],
        },
      },
    });
    expect(tenantSurveyFindings(reportOf(m))).toEqual(["view_permissions"]);
  });

  it("reports a report surface whose admitted role the TENANT's grants stopped letting list", () => {
    // The surfaces are compiled routes with a role set fixed by the deployment, so a gap the
    // deployment's own grants already have is the boot line's, and only one the tenant's manifest
    // contributes is this line's.
    const surface = REPORT_SURFACE;
    const granted = deployment({ permissions: { Vendor: { list: { roles: ["clerk"] } } } });
    expect(tenantSurveyFindings(reportOf(tenant(), { reportSurfaces: [surface] }, { deploymentManifest: granted }))).toEqual([
      "report_surfaces",
    ]);
    // The same gap inherited from the deployment is not repeated per tenant.
    expect(tenantSurveyHasFinding(reportOf(tenant(), { reportSurfaces: [surface] }))).toBe(false);
  });

  it("does not repeat a finding the tenant inherits from the deployment's own manifest", () => {
    // ADR-0397's scale rule read against inheritance: a tenant extending the deployment carries
    // every boot finding, and the boot line already said those.
    const carrying = tenant({
      entities: [{ name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] }],
      theme: { brandColor: "#123456" },
      views: {
        "vendor.list": {
          kind: "list",
          entity: "Vendor",
          label: { en: "Vendors" },
          permissions: { roles: ["clerk"] },
          columns: [{ field: "name", label: { en: "Name" } }],
        },
      },
    });
    expect(tenantSurveyFindings(reportOf(carrying, {}, { storeKind: "memory", deploymentManifest: carrying }))).toEqual([]);
    // And the control: the same manifest against a plain deployment contributes all three.
    expect(tenantSurveyFindings(reportOf(carrying, {}, { storeKind: "memory" }))).toEqual([
      "unique_enforcement",
      "unserved_sections",
      "view_permissions",
    ]);
  });

  it("reports approve-class transitions that differ from the deployment's", () => {
    const m = tenant({ workflows: lifecycle("approve") });
    expect(tenantSurveyFindings(reportOf(m))).toEqual(["segregation_of_duties"]);
    // The same set as the deployment's is not a finding: the boot line already said it.
    expect(tenantSurveyHasFinding(reportOf(m, {}, { deploymentManifest: m }))).toBe(false);
    // A transition outside the class is not either.
    expect(tenantSurveyHasFinding(reportOf(tenant({ workflows: lifecycle("finish") })))).toBe(false);
  });

  it("reports a job no producer of this deployment reads, and one the deployment declares differently", () => {
    const m = tenant({ jobs: { [SCHEDULED_JOB.id]: SCHEDULED_JOB } });
    const r = reportOf(m);
    expect(r.jobs).toEqual({ unserved: [SCHEDULED_JOB.id], divergent: [] });
    expect(tenantSurveyFindings(r)).toEqual(["jobs"]);
    const theirs = deployment({
      jobs: { [SCHEDULED_JOB.id]: { ...SCHEDULED_JOB, trigger: { kind: "scheduled", cron: "0 7 * * *", timezone: "UTC" } } },
    });
    expect(reportOf(m, {}, { deploymentManifest: theirs }).jobs).toEqual({ unserved: [], divergent: [SCHEDULED_JOB.id] });
    // Declared identically is served by the deployment's own producers, so it is silent.
    expect(reportOf(m, {}, { deploymentManifest: m }).jobs).toEqual({ unserved: [], divergent: [] });
  });

  it("reports PHI the tenant's store would hold in the clear, and is silent where it is encrypted", () => {
    const m = tenant({ entities: [VENDOR, PHI_ENTITY] });
    expect(reportOf(m).atRest.verdict).toBe("refused_plaintext_store");
    expect(tenantSurveyFindings(reportOf(m))).toContain("at_rest");
    expect(tenantSurveyFindings(reportOf(m, {}, { servedFrom: "own_schema" }))).not.toContain("at_rest");
    expect(
      tenantSurveyFindings(reportOf(m, {}, { servedFrom: "own_schema", phi: { keyConfigured: false, allowPlaintextPhi: false } })),
    ).toContain("at_rest");
    // Acknowledged deployment-wide, so not repeated per tenant.
    expect(
      tenantSurveyFindings(reportOf(m, {}, { phi: { keyConfigured: false, allowPlaintextPhi: true } })),
    ).not.toContain("at_rest");
  });

  it("can produce every finding kind (no kind is vacuous)", () => {
    // A kind no fixture can reach is a branch nothing tests and a sentence nobody has read.
    const reached = new Set<TenantSurveyFindingKind>();
    const cases: TenantManifestSurveyReport[] = [
      reportOf(tenant(), { sensitive: survey({ findings: [finding({ readableBy: [] })] }) }),
      reportOf(tenant(), { cursorDisclosure: cursor("plaintext_disclosing") }),
      reportOf(tenant(), {}, { servedFrom: "fallback" }),
      reportOf(
        tenant({
          entities: [VENDOR, PHI_ENTITY],
          views: {
            "patient.list": {
              kind: "list",
              entity: "Patient",
              label: { en: "Patients" },
              permissions: "inherit",
              columns: [{ field: "mrn", label: { en: "MRN" } }],
            },
          },
        }),
        {},
        { servedFrom: "own_schema" },
      ),
      reportOf(
        tenant({ entities: [{ name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] }] }),
        {},
        { storeKind: "memory" },
      ),
      reportOf(tenant({ entities: [{ name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] }] })),
      reportOf(tenant({ theme: { brandColor: "#123456" } })),
      reportOf(
        tenant({
          views: {
            "vendor.list": {
              kind: "list",
              entity: "Vendor",
              label: { en: "Vendors" },
              permissions: { roles: ["clerk"] },
              columns: [{ field: "name", label: { en: "Name" } }],
            },
          },
        }),
      ),
      reportOf(
        tenant(),
        { reportSurfaces: [REPORT_SURFACE] },
        { deploymentManifest: deployment({ permissions: { Vendor: { list: { roles: ["clerk"] } } } }) },
      ),
      reportOf(tenant({ workflows: lifecycle("approve") })),
      reportOf(tenant({ jobs: { [SCHEDULED_JOB.id]: SCHEDULED_JOB } })),
      reportOf(tenant({ entities: [VENDOR, PHI_ENTITY] })),
    ];
    for (const r of cases) for (const k of tenantSurveyFindings(r)) reached.add(k);
    expect([...reached].sort()).toEqual([...TENANT_SURVEY_FINDING_KINDS].sort());
  });
});

describe("formatTenantManifestSurvey", () => {
  it("is silent when there is nothing to report", () => {
    // ADR-0397's scale rule: a clean line per tenant per activation is the line that gets filtered.
    expect(formatTenantManifestSurvey(TENANT, reportOf())).toEqual({ lines: [], level: "info" });
  });

  it("names the tenant on EVERY line, across every finding at once", () => {
    const m = tenant({
      entities: [
        { name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] },
        PHI_ENTITY,
      ],
      theme: { brandColor: "#123456" },
      workflows: lifecycle("approve"),
      jobs: { [SCHEDULED_JOB.id]: SCHEDULED_JOB },
    });
    const r = reportOf(m, {
      sensitive: survey({ findings: [finding({ readableBy: [] }), finding({ field: "dob", writableBy: [] })] }),
      cursorDisclosure: cursor("plaintext_disclosing"),
    }, { servedFrom: "fallback" });
    const reading = formatTenantManifestSurvey(TENANT, r);
    expect(reading.level).toBe("warn");
    expect(reading.lines.length).toBeGreaterThan(6);
    for (const line of reading.lines) expect(line.startsWith(`[tenant-manifest] tenant ${TENANT}: `)).toBe(true);
  });

  it("borrows the boot formatters rather than restating their sentences", () => {
    const text = (r: TenantManifestSurveyReport): string => formatTenantManifestSurvey(TENANT, r).lines.join("\n");
    expect(text(reportOf(tenant(), { sensitive: survey({ findings: [finding({ readableBy: [] })] }) }))).toContain("[fields]");
    expect(text(reportOf(tenant(), { cursorDisclosure: cursor("plaintext_disclosing") }))).toContain(
      "cursor disclosure: plaintext_disclosing",
    );
    expect(text(reportOf(tenant({ theme: { brandColor: "#123456" } })))).toContain("[manifest]");
    expect(text(reportOf(tenant({ workflows: lifecycle("approve") })))).toContain("Vendor.approve");
  });

  it("names the DEPLOYMENT's secret as the cursor remedy", () => {
    const text = formatTenantManifestSurvey(TENANT, reportOf(tenant(), { cursorDisclosure: cursor("plaintext_disclosing") }))
      .lines.join("\n");
    expect(text).toContain("CURSOR_ENCRYPTION_SECRET");
    expect(text).toMatch(/DEPLOYMENT/);
  });

  it("says a tenant's own job is NOT served, naming the producers that read the deployment's manifest", () => {
    const text = formatTenantManifestSurvey(TENANT, reportOf(tenant({ jobs: { [SCHEDULED_JOB.id]: SCHEDULED_JOB } })))
      .lines.join("\n");
    expect(text).toContain("NOT served by this deployment");
    expect(text).toContain(SCHEDULED_JOB.id);
    expect(text).toMatch(/scheduler, the event emitter and the invoke route/);
  });

  it("says plaintext PHI on the shared store is stored in the clear, and on the fallback that it is refused", () => {
    const m = tenant({ entities: [VENDOR, PHI_ENTITY] });
    const shared = formatTenantManifestSurvey(TENANT, reportOf(m)).lines.join("\n");
    expect(shared).toContain("stored in the CLEAR");
    expect(shared).toContain("Patient.mrn");
    const fallback = formatTenantManifestSurvey(TENANT, reportOf(m, {}, { servedFrom: "fallback" })).lines.join("\n");
    expect(fallback).toContain("JSONB fallback");
    expect(fallback).not.toContain("stored in the CLEAR");
  });

  it("says which store holds no index for a tenant-only unique field", () => {
    const m = tenant({ entities: [{ name: "Vendor", fields: [{ name: "name", type: { kind: "text" }, unique: true }] }] });
    const text = formatTenantManifestSurvey(TENANT, reportOf(m)).lines.join("\n");
    expect(text).toContain("NO index on the shared document store: Vendor.name");
  });
});
