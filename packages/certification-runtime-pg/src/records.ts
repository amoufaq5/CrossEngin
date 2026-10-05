import { z } from "zod";
import {
  assertScopeTenantId,
  setPlatformWriteSql,
  type PgConnection,
} from "@crossengin/kernel-pg";
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
 * Reads were left unwrapped when this comment was written, on the ground that scoping them is "a
 * separate change about owner-independence". That change is `scopeFilter` + `scopedRead` below.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

export const SET_PLATFORM_RECORD_WRITE_SQL = setPlatformWriteSql("record");

/**
 * `scopeFilter` lives in `kernel-pg` beside `setPlatformWriteSql` and `isoInstant` — eight packages
 * held a verbatim copy and `kernel-pg` is the only dependency all eight share. The rule that chooses
 * between the strict and the inclusive spelling, and the two measurements behind the branch, are
 * written down there once.
 *
 * **Which this package reads: the strict form**, and it is the loudest member of the class. A
 * certification report is a compliance claim, not telemetry, and `latestForFramework` answers it
 * with a single `LIMIT 1` row. Observed live as the owner, with a tenant's `soc2_type2` report
 * generated after the platform's: `latestForFramework("soc2_type2")` returned the **tenant's**
 * report, `certifiable: false`, where the platform's own was `certifiable: true`. The same call as a
 * non-owner returned the platform's. One `ORDER BY … LIMIT 1` over two scopes inverted the answer to
 * "are we certifiable" — no error, no empty result, just the wrong row.
 */
export { scopeFilter, type ScopeFilter } from "@crossengin/kernel-pg";

function assertTenantId(tenantId: string): void {
  assertScopeTenantId(tenantId);
}

/**
 * A **read**'s scope: a tenant context, or nothing at all.
 *
 * Nothing for the platform scope, because the platform read arm is `SELECT`-scoped on
 * `tenant_id IS NULL` and demands no grant. A read does not claim the write elevation.
 */
export async function scopedRead<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null) assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}

// `async` rather than returning `conn.transaction(...)` directly, so a rejected tenant id arrives
// as a rejection like every other failure here. A synchronous throw out of a `Promise`-returning
// function is a trap for a caller that only writes `.catch`.
export async function scopedWrite<T>(
  conn: PgConnection,
  tenantId: string | null,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (tenantId !== null) assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    if (tenantId === null) await tx.query(SET_PLATFORM_RECORD_WRITE_SQL);
    else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
