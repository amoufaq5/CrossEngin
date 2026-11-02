import { describe, expect, it } from "vitest";

import {
  CURSOR_DISCLOSURE_MAY_SERVE,
  type CursorDisclosureDecision,
} from "./cursor-encryption.js";
import type { SensitiveFieldFinding, SensitiveFieldSurvey } from "./sensitive-field-policy.js";
import {
  formatTenantManifestSurvey,
  tenantSurveyHasFinding,
  type TenantManifestSurveyReport,
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
  return {
    totalSensitive: 1,
    classifiedWriteMask: true,
    findings: [finding()],
    uncreatable: [],
    ...over,
  };
}

function cursor(verdict: CursorDisclosureDecision["verdict"]): CursorDisclosureDecision {
  // `mayServe` read from the real map rather than hardcoded `true`: every member is true today, so
  // a literal would be right and would stop being right silently if one ever flipped — and this
  // module's whole job is to report rather than refuse, so that flip is the thing it would want to
  // know about. (It is also required, which `tsc` caught and `vitest` did not: ADR-0307's split.)
  return {
    verdict,
    detail: `detail for ${verdict}`,
    fields: [],
    mayServe: CURSOR_DISCLOSURE_MAY_SERVE[verdict],
  };
}

function report(over: Partial<TenantManifestSurveyReport> = {}): TenantManifestSurveyReport {
  return { sensitive: survey(), cursorDisclosure: cursor("sealed"), ...over };
}

describe("tenantSurveyHasFinding", () => {
  it("is false for a manifest whose classified fields are readable and writable", () => {
    // Deliberately NOT `totalSensitive > 0`: a manifest declaring classified fields that the roles
    // it intends can read and write is the healthy state, and reporting it is how a warning becomes
    // noise an operator mutes — taking the real findings with it.
    expect(tenantSurveyHasFinding(report())).toBe(false);
  });

  it("is true for a field no role can read", () => {
    // ADR-0339's measured state on 39 of 46 fields: the policy had no producer, so an empty policy
    // refused everyone and total redaction looked exactly like classification working.
    const s = survey({ findings: [finding({ readableBy: [] })] });
    expect(tenantSurveyHasFinding(report({ sensitive: s }))).toBe(true);
  });

  it("is true for a field no role can write", () => {
    const s = survey({ findings: [finding({ writableBy: [] })] });
    expect(tenantSurveyHasFinding(report({ sensitive: s }))).toBe(true);
  });

  it("is true for a blind overwrite — writable by a role that cannot read it", () => {
    // The sharpest member: `front_desk` replacing a medical record identifier it cannot read
    // before or after. Per role and not by comparing list lengths, which would call a field
    // readable by one role and writable by another a defect.
    const s = survey({
      findings: [finding({ readableBy: ["clinician"], writableBy: ["front_desk"] })],
    });
    expect(tenantSurveyHasFinding(report({ sensitive: s }))).toBe(true);
  });

  it("is false when the writer can also read, even though the two lists differ", () => {
    const s = survey({
      findings: [finding({ readableBy: ["clinician", "auditor"], writableBy: ["clinician"] })],
    });
    expect(tenantSurveyHasFinding(report({ sensitive: s }))).toBe(false);
  });

  it("is true for an uncreatable entity", () => {
    const s = survey({ uncreatable: [finding({ required: true, writableBy: [] })] });
    expect(tenantSurveyHasFinding(report({ sensitive: s }))).toBe(true);
  });

  it("is true for a plaintext-disclosing cursor and false for the other three verdicts", () => {
    expect(tenantSurveyHasFinding(report({ cursorDisclosure: cursor("plaintext_disclosing") }))).toBe(
      true,
    );
    for (const v of ["sealed", "plaintext_accepted", "no_sortable_classified_field"] as const) {
      expect(tenantSurveyHasFinding(report({ cursorDisclosure: cursor(v) })), v).toBe(false);
    }
  });
});

describe("formatTenantManifestSurvey", () => {
  it("is silent when there is nothing to report", () => {
    // The one place this departs from the boot lines' say-it-either-way rule, and the reason is
    // scale: a line per tenant per activation means an affirmative clean line grows with the
    // tenant count and is the thing that gets filtered out, taking the findings with it.
    expect(formatTenantManifestSurvey(TENANT, report())).toEqual({ lines: [], level: "info" });
  });

  it("names the tenant on EVERY line, not just the first", () => {
    // `formatSensitiveFieldSurvey` returns a `\n`-joined block of already-prefixed lines, so
    // tagging the block would attribute only line 1 — and lines 2..N would reach a multi-tenant
    // log reading `[fields] …` with no tenant on them, which is unattributable and worse than not
    // reporting at all. This test is the fence for that, and the first draft failed it.
    const s = survey({
      totalSensitive: 2,
      findings: [finding({ readableBy: [] }), finding({ field: "dob", writableBy: [] })],
    });
    const reading = formatTenantManifestSurvey(TENANT, report({ sensitive: s }));
    expect(reading.lines.length).toBeGreaterThan(1);
    for (const line of reading.lines) expect(line).toContain(`tenant ${TENANT}`);
    expect(reading.level).toBe("warn");
  });

  it("borrows the boot formatters rather than restating their sentences", () => {
    // One producer per sentence, so the boot line and the per-tenant line cannot come to describe
    // one finding differently — the recurring defect this repository keeps finding in its own
    // prose. Checked by content rather than by reading the source: the `[fields]` prefix and the
    // `cursor disclosure:` phrase are the other formatters' own, not this module's.
    const s = survey({ findings: [finding({ readableBy: [] })] });
    const reading = formatTenantManifestSurvey(TENANT, {
      sensitive: s,
      cursorDisclosure: cursor("plaintext_disclosing"),
    });
    expect(reading.lines.join("\n")).toContain("[fields]");
    expect(reading.lines.join("\n")).toContain("cursor disclosure: plaintext_disclosing");
  });

  it("names the DEPLOYMENT's secret as the cursor remedy, not anything the tenant can change", () => {
    // ADR-0334's rule: a remedy that cannot work is worse than none. One secret seals every tenant
    // because the key is derived per tenant inside the sealer, so a per-tenant report implying a
    // per-tenant remedy would send a reader to a setting that does not exist.
    const reading = formatTenantManifestSurvey(TENANT, {
      sensitive: survey(),
      cursorDisclosure: cursor("plaintext_disclosing"),
    });
    const text = reading.lines.join("\n");
    expect(text).toContain("CURSOR_ENCRYPTION_SECRET");
    expect(text).toMatch(/DEPLOYMENT/);
  });

  it("reports the cursor finding even when the sensitive survey is clean", () => {
    // The two halves are independent: a manifest with no classified-field defect can still sort a
    // classified field into a plaintext cursor, which is ADR-0357's live member on `erp-core`.
    const reading = formatTenantManifestSurvey(TENANT, {
      sensitive: survey(),
      cursorDisclosure: cursor("plaintext_disclosing"),
    });
    expect(reading.lines.length).toBeGreaterThan(0);
    expect(reading.level).toBe("warn");
  });
});
