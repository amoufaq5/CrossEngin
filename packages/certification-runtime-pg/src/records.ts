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
 * Reads were left unwrapped when this comment was written, on the ground that scoping them is "a
 * separate change about owner-independence". That change is `scopeFilter` + `scopedRead` below.
 */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

export const SET_PLATFORM_RECORD_WRITE_SQL = setPlatformWriteSql("record");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped read must carry, **beside** RLS rather than instead of it.
 *
 * `meta.certification_reports` is `tenant_id`-nullable with a `SELECT`-scoped platform read arm, and
 * **a table's owner bypasses its policies** (ADR-0331). This is the loudest member of the class: a
 * certification report is a compliance claim, not telemetry, and `latestForFramework` answers it
 * with a single `LIMIT 1` row. Observed live as the owner, with a tenant's `soc2_type2` report
 * generated after the platform's: `latestForFramework("soc2_type2")` returned the **tenant's**
 * report, `certifiable: false`, where the platform's own was `certifiable: true`. The same call as a
 * non-owner returned the platform's. One `ORDER BY … LIMIT 1` over two scopes inverted the answer to
 * "are we certifiable" — no error, no empty result, just the wrong row.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL: ADR-0331 measured it at 16 ms sequential scan against 45k entries where
 * `tenant_id = $1` is a 0.09 ms index scan, because it is not indexable. `tenant_id IS NULL` is, so
 * both arms keep `idx_certification_reports_tenant_at`.
 *
 * Verbatim from `forensics-pg`'s `scopeFilter`; it belongs in `kernel-pg` beside
 * `setPlatformWriteSql`, which this module already imports.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
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
