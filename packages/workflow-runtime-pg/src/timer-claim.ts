import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/** A timer claimed by a worker for firing — the fields a worker needs to advance the instance. */
export interface ClaimedTimer {
  readonly timerId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly timerName: string;
  readonly fireAt: string;
  readonly transitionToTrigger: string | null;
  readonly claimExpiresAt: string;
}

export interface ClaimDueTimersOptions {
  /** Stable id of the claiming worker (recorded on the row for observability + lease ownership). */
  readonly workerId: string;
  /** "Now" as an ISO 8601 instant — a timer is due when `fire_at <= now`. */
  readonly now: string;
  /** Max timers to claim in one batch (default 20). */
  readonly limit?: number;
  /** Lease duration in ms; another worker may re-claim after it lapses (default 30s). */
  readonly leaseMs?: number;
  readonly schema?: string;
}

interface ClaimRow {
  readonly timer_id: unknown;
  readonly instance_id: unknown;
  readonly tenant_id: unknown;
  readonly timer_name: unknown;
  readonly fire_at: unknown;
  readonly transition_to_trigger: unknown;
  readonly claim_expires_at: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v ?? "");
}

/**
 * Atomically claims up to `limit` due `scheduled` timers for a worker, leasing each for `leaseMs`.
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never claim the same timer — each gets a
 * disjoint batch, and locked rows are skipped rather than blocked on. A timer is claimable when it
 * is unclaimed **or** its previous claim's lease has expired (so a crashed worker's timers are
 * recovered). The lease is advisory: firing the timer flips its status to `fired`, which removes it
 * from the `scheduled` claim set entirely. The worker connection is platform-scoped (RLS-bypassing),
 * so one fleet serves every tenant; `tenant_id` rides back on each claimed row.
 */
export async function claimDueTimers(
  conn: PgConnection,
  options: ClaimDueTimersOptions,
): Promise<readonly ClaimedTimer[]> {
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
         FROM ${schema}.workflow_timers
        WHERE status = 'scheduled'
          AND fire_at <= $1::timestamptz
          AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at < $1::timestamptz)
        ORDER BY fire_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${schema}.workflow_timers t
        SET claimed_by = $3, claim_expires_at = $4::timestamptz
       FROM due
      WHERE t.id = due.id
     RETURNING t.timer_id, t.instance_id, t.tenant_id, t.timer_name, t.fire_at,
               t.transition_to_trigger, t.claim_expires_at`,
    [options.now, limit, options.workerId, claimExpiresAt],
  );

  return result.rows.map((r) => ({
    timerId: str(r.timer_id),
    instanceId: str(r.instance_id),
    tenantId: str(r.tenant_id),
    timerName: str(r.timer_name),
    fireAt: str(r.fire_at),
    transitionToTrigger: typeof r.transition_to_trigger === "string" ? r.transition_to_trigger : null,
    claimExpiresAt: str(r.claim_expires_at),
  }));
}

/**
 * Releases a worker's claim on a timer (clears `claimed_by` / `claim_expires_at`) without firing
 * it — so a worker that fails to process a claimed timer can hand it straight back for immediate
 * re-claim rather than waiting for the lease to lapse. No-op if the timer is no longer claimed by
 * this worker.
 */
export async function releaseTimerClaim(
  conn: PgConnection,
  options: { readonly timerId: string; readonly workerId: string; readonly schema?: string },
): Promise<void> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  await conn.query(
    `UPDATE ${schema}.workflow_timers
        SET claimed_by = NULL, claim_expires_at = NULL
      WHERE timer_id = $1 AND claimed_by = $2 AND status = 'scheduled'`,
    [options.timerId, options.workerId],
  );
}
