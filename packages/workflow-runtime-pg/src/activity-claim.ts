import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/** A scheduled activity claimed by a worker for execution — what a worker needs to run its handler. */
export interface ClaimedActivity {
  readonly activityId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly definitionActivityKey: string;
  readonly kind: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly claimExpiresAt: string;
}

export interface ClaimDueActivitiesOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly schema?: string;
}

interface ClaimRow {
  readonly activity_id: unknown;
  readonly instance_id: unknown;
  readonly tenant_id: unknown;
  readonly definition_activity_key: unknown;
  readonly kind: unknown;
  readonly attempt_number: unknown;
  readonly max_attempts: unknown;
  readonly claim_expires_at: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v ?? "");
}
function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

/**
 * Atomically claims up to `limit` `scheduled` activities for a worker, leasing each for `leaseMs`,
 * using `FOR UPDATE SKIP LOCKED` — so concurrent workers get disjoint batches and never execute the
 * same activity twice. An activity is claimable when it is unclaimed **or** its lease lapsed (so a
 * crashed worker's activities are recovered). Executing an activity flips its status out of
 * `scheduled` (running → succeeded/failed), removing it from the claim set. The worker connection is
 * platform-scoped (RLS-bypassing), so one fleet serves every tenant; `tenant_id` rides back per row.
 * (The engine's deferred-scheduling mode — leaving activities `scheduled` for a worker rather than
 * running them inline — is the follow-up; this is the queue substrate it plugs into.)
 */
export async function claimDueActivities(
  conn: PgConnection,
  options: ClaimDueActivitiesOptions,
): Promise<readonly ClaimedActivity[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: ${String(limit)}`);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error(`invalid leaseMs: ${String(leaseMs)}`);
  const claimExpiresAt = new Date(new Date(options.now).getTime() + leaseMs).toISOString();

  const result = await conn.query<ClaimRow>(
    `WITH due AS (
       SELECT id
         FROM ${schema}.workflow_activities
        WHERE status = 'scheduled'
          AND scheduled_at <= $1::timestamptz
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1::timestamptz)
        ORDER BY scheduled_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${schema}.workflow_activities a
        SET claimed_by = $3, claim_expires_at = $4::timestamptz
       FROM due
      WHERE a.id = due.id
     RETURNING a.activity_id, a.instance_id, a.tenant_id, a.definition_activity_key, a.kind,
               a.attempt_number, a.max_attempts, a.claim_expires_at`,
    [options.now, limit, options.workerId, claimExpiresAt],
  );

  return result.rows.map((r) => ({
    activityId: str(r.activity_id),
    instanceId: str(r.instance_id),
    tenantId: str(r.tenant_id),
    definitionActivityKey: str(r.definition_activity_key),
    kind: str(r.kind),
    attemptNumber: int(r.attempt_number, 1),
    maxAttempts: int(r.max_attempts, 1),
    claimExpiresAt: str(r.claim_expires_at),
  }));
}

/** Hands a claimed-but-unexecuted activity back for immediate re-claim (scoped to the owning worker). */
export async function releaseActivityClaim(
  conn: PgConnection,
  options: { readonly activityId: string; readonly workerId: string; readonly schema?: string },
): Promise<void> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  await conn.query(
    `UPDATE ${schema}.workflow_activities
        SET claimed_by = NULL, claim_expires_at = NULL
      WHERE activity_id = $1 AND claimed_by = $2 AND status = 'scheduled'`,
    [options.activityId, options.workerId],
  );
}

/**
 * Extends the lease on an activity this worker still holds (for a slow handler). Returns `true`
 * only if the row updated — still `scheduled` AND still owned; `false` means the lease was lost.
 */
export async function renewActivityClaim(
  conn: PgConnection,
  options: {
    readonly activityId: string;
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs?: number;
    readonly schema?: string;
  },
): Promise<boolean> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error(`invalid leaseMs: ${String(leaseMs)}`);
  const claimExpiresAt = new Date(new Date(options.now).getTime() + leaseMs).toISOString();
  const result = await conn.query(
    `UPDATE ${schema}.workflow_activities
        SET claim_expires_at = $3::timestamptz
      WHERE activity_id = $1 AND claimed_by = $2 AND status = 'scheduled'`,
    [options.activityId, options.workerId, claimExpiresAt],
  );
  return (result.rowCount ?? 0) > 0;
}
