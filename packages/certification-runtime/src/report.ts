import { z } from "zod";
import { sha256 } from "@crossengin/crypto";
import {
  COMPLIANCE_FRAMEWORKS,
  type ComplianceFramework,
} from "@crossengin/access-reviews";
import {
  DEFAULT_CONTROL_CATALOG,
  type ControlDefinition,
} from "./controls.js";
import type { ControlEvidence } from "./evidence.js";
import {
  assessFramework,
  FrameworkAssessmentSchema,
  type FrameworkAssessment,
} from "./assessment.js";
import {
  RandomIdGenerator,
  SystemClock,
  type Clock,
  type IdGenerator,
} from "./clock.js";

export const CERTIFICATION_REPORT_SEAL_DOMAIN =
  "crossengin.certification.report.v1";

export const CertificationReportSchema = z
  .object({
    reportId: z.string().regex(/^cert_[a-z0-9]{8,40}$/),
    framework: z.enum(COMPLIANCE_FRAMEWORKS),
    tenantId: z.string().uuid().nullable(),
    generatedAt: z.string().datetime(),
    assessment: FrameworkAssessmentSchema,
    certifiable: z.boolean(),
    sealedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CertificationReport = z.infer<typeof CertificationReportSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

export function certificationReportSealSha256(input: {
  readonly framework: ComplianceFramework;
  readonly tenantId: string | null;
  readonly generatedAt: string;
  readonly assessment: FrameworkAssessment;
}): string {
  const canonical = JSON.stringify(
    canonicalize({
      domain: CERTIFICATION_REPORT_SEAL_DOMAIN,
      framework: input.framework,
      tenantId: input.tenantId,
      generatedAt: input.generatedAt,
      assessment: input.assessment,
    }),
  );
  return sha256(canonical);
}

export interface BuildCertificationReportInput {
  readonly framework: ComplianceFramework;
  readonly evidence: readonly ControlEvidence[];
  readonly tenantId?: string | null;
  readonly catalog?: readonly ControlDefinition[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export function buildCertificationReport(
  input: BuildCertificationReportInput,
): CertificationReport {
  const clock = input.clock ?? new SystemClock();
  const ids = input.ids ?? new RandomIdGenerator();
  const tenantId = input.tenantId ?? null;
  const generatedAt = clock.nowIso();
  const assessment = assessFramework(
    input.framework,
    input.evidence,
    input.catalog ?? DEFAULT_CONTROL_CATALOG,
  );
  const sealedSha256 = certificationReportSealSha256({
    framework: input.framework,
    tenantId,
    generatedAt,
    assessment,
  });
  return CertificationReportSchema.parse({
    reportId: ids.next("cert"),
    framework: input.framework,
    tenantId,
    generatedAt,
    assessment,
    certifiable: assessment.certifiable,
    sealedSha256,
  });
}

export function verifyCertificationReportSeal(
  report: CertificationReport,
): boolean {
  const expected = certificationReportSealSha256({
    framework: report.framework,
    tenantId: report.tenantId,
    generatedAt: report.generatedAt,
    assessment: report.assessment,
  });
  return expected === report.sealedSha256;
}

export function formatCertificationReport(report: CertificationReport): string {
  const lines: string[] = [];
  const c = report.assessment.counts;
  lines.push(
    `Certification: ${report.framework} — ${report.certifiable ? "CERTIFIABLE" : "NOT CERTIFIABLE"}`,
  );
  lines.push(
    `  controls: ${c.total.toString()} (satisfied ${c.satisfied.toString()}, deficient ${c.deficient.toString()}, not assessed ${c.notAssessed.toString()})`,
  );
  for (const ctl of report.assessment.controls) {
    const mark =
      ctl.status === "satisfied" ? "PASS" : ctl.status === "deficient" ? "FAIL" : "MISS";
    lines.push(
      `  [${mark}] ${ctl.controlId} (${ctl.frameworkRefs.join(", ")})`,
    );
    for (const f of ctl.findings) lines.push(`         - ${f}`);
  }
  lines.push(`  seal: ${report.sealedSha256}`);
  return lines.join("\n");
}

export interface CertificationEngineOptions {
  readonly catalog?: readonly ControlDefinition[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly tenantId?: string | null;
}

export class CertificationEngine {
  private readonly catalog: readonly ControlDefinition[];
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly tenantId: string | null;

  constructor(options: CertificationEngineOptions = {}) {
    this.catalog = options.catalog ?? DEFAULT_CONTROL_CATALOG;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new RandomIdGenerator();
    this.tenantId = options.tenantId ?? null;
  }

  certify(
    framework: ComplianceFramework,
    evidence: readonly ControlEvidence[],
  ): CertificationReport {
    return buildCertificationReport({
      framework,
      evidence,
      tenantId: this.tenantId,
      catalog: this.catalog,
      clock: this.clock,
      ids: this.ids,
    });
  }

  certifyAll(
    frameworks: readonly ComplianceFramework[],
    evidence: readonly ControlEvidence[],
  ): CertificationReport[] {
    return frameworks.map((f) => this.certify(f, evidence));
  }
}
