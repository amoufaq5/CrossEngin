import { z } from "zod";
import {
  CertificationReportSchema,
  COMPLIANCE_FRAMEWORKS,
  type CertificationReport,
} from "@crossengin/certification-runtime";

const Iso8601 = z.string().datetime({ offset: true });

export const CertificationReportRecordSchema = z
  .object({
    reportId: z.string().regex(/^cert_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid().nullable(),
    framework: z.enum(COMPLIANCE_FRAMEWORKS),
    certifiable: z.boolean(),
    controlsTotal: z.number().int().nonnegative(),
    controlsSatisfied: z.number().int().nonnegative(),
    controlsDeficient: z.number().int().nonnegative(),
    controlsNotAssessed: z.number().int().nonnegative(),
    sealedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    report: CertificationReportSchema,
    generatedAt: Iso8601,
  })
  .strict();
export type CertificationReportRecord = z.infer<
  typeof CertificationReportRecordSchema
>;

export interface CertificationReportRecordInput {
  readonly tenantId?: string | null;
}

export function certificationReportRecordFrom(
  report: CertificationReport,
  input: CertificationReportRecordInput = {},
): CertificationReportRecord {
  const counts = report.assessment.counts;
  return CertificationReportRecordSchema.parse({
    reportId: report.reportId,
    tenantId: input.tenantId !== undefined ? input.tenantId : report.tenantId,
    framework: report.framework,
    certifiable: report.certifiable,
    controlsTotal: counts.total,
    controlsSatisfied: counts.satisfied,
    controlsDeficient: counts.deficient,
    controlsNotAssessed: counts.notAssessed,
    sealedSha256: report.sealedSha256,
    report,
    generatedAt: report.generatedAt,
  });
}
