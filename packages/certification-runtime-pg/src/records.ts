import { z } from "zod";
import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";
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

/**
 * The two session settings a scoped **write** needs, and the wrapper that picks exactly one.
 *
 * Until the policy split these stores set nothing at all, which worked only because a table's owner
 * bypasses its policies. As a non-owner the single `ALL`-scope policy admitted a platform row
 * (`tenant_id IS NULL` satisfied its `WITH CHECK` unconditionally — the defect) and refused a
 * tenant row outright, because with no context `current_setting('app.current_tenant_id', true)`
 * answers NULL or `''` and the comparison is never true. So both arms are needed: the platform one
 * because the split now demands a grant, and the tenant one because nothing ever supplied a context
 * for a row the store had always been able to write as the owner.
 *
 * Reads are deliberately left unwrapped. They behave the same before and after the split — the
 * platform read policy is `SELECT`-scoped on `tenant_id IS NULL` and demands no grant — so scoping
 * them is a separate change about owner-independence, not part of closing this hole.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

export const SET_PLATFORM_RECORD_WRITE_SQL = setPlatformWriteSql("record");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function scopedWrite<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null && !TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
  return conn.transaction(async (tx) => {
    if (tenantId === null) await tx.query(SET_PLATFORM_RECORD_WRITE_SQL);
    else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
