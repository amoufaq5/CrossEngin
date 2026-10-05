import type { PipelineExecution } from "@crossengin/api-gateway";
import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const TABLE = "gateway_pipeline_executions";

/**
 * The two session settings a scoped **write** needs, declared here and shared with
 * `rate-limit-checker.ts` — this package has no `records.ts` to hold them, and the two writers want
 * one copy rather than two strings that can drift.
 *
 * `app.platform_record_write`, because both tables are the deployment's own observational record: a
 * pipeline execution and a rate-limit decision say what the gateway *did*, never what it should do.
 * The grant deliberately does not reach `meta.rate_limit_policies` or `meta.quota_definitions`,
 * which say the latter and sit on `app.platform_config_write` instead.
 *
 * Until the policy split neither writer set anything at all, which worked only because a table's
 * owner bypasses its policies. As a non-owner, the old single `ALL`-scope policy admitted a
 * *platform* row unconditionally (the defect) while refusing a tenant row, since with no context
 * `current_setting('app.current_tenant_id', true)` answers NULL and the comparison is never true.
 * Both arms are needed for that reason: one because the split now demands a grant, the other
 * because nothing ever supplied the context a tenant row has always needed.
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
 * Both tables this package reads are `tenant_id`-nullable with a `SELECT`-scoped platform read arm,
 * and **a table's owner bypasses its policies** (ADR-0331) — so a read with no predicate answers
 * from every scope in a deployment that connects as the owner, and from the platform's alone in one
 * that does not. Measured live on this schema with three tenant executions beside one platform one:
 * `countSince` answered **4** as the owner and **1** as a non-owner, for the same call. An aggregate
 * is the sharp case, because the caller receives a plausible scalar rather than a long list.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL and the one that would give a single code path: ADR-0331 measured it at
 * 16 ms sequential scan against 45k entries where `tenant_id = $1` is a 0.09 ms index scan, because
 * it is not an indexable operator. `tenant_id IS NULL` is indexable, so both arms keep
 * `idx_gateway_pipeline_tenant_started` / `idx_rate_limit_decisions_tenant_decided`.
 *
 * Verbatim from `forensics-pg`'s `scopeFilter`; it belongs in `kernel-pg` beside
 * `setPlatformWriteSql`, which this module already imports, and lives here only because the rest
 * of this package's scope plumbing does.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * The scope an *optionally*-scoped read names: a tenant id, the platform scope (`null`), or every
 * scope (`undefined`).
 *
 * The third member exists only for the replayer, whose `tenantId?: string` has always meant "every
 * scope" when absent — a deliberately cross-scope diagnostic, and the one read here whose answer is
 * *meant* to span tenants. What it could not express before was the platform scope: `undefined` was
 * "all" and there was no way to say "the deployment's own rows". `null` says it now.
 */
export type ReadScope = string | null | undefined;

/** `null` when the scope is every scope, so a caller can omit the predicate rather than write TRUE. */
export function optionalScopeFilter(scope: ReadScope, firstParam = 1): ScopeFilter | null {
  if (scope === undefined) return null;
  return scopeFilter(scope, firstParam);
}

/**
 * A **read**'s scope: a tenant context, or nothing at all.
 *
 * Nothing for the platform scope, because the platform read arm is `SELECT`-scoped on
 * `tenant_id IS NULL` and demands no grant. A read deliberately does not claim the write elevation
 * — it does not need it, and a privilege claimed for no reason is one the next statement in the
 * same transaction inherits. Mirrors `PostgresKeyRegistry.scoped`.
 */
export async function scopedRead<T>(
  conn: PgConnection,
  tenantId: ReadScope,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (typeof tenantId === "string") assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    if (typeof tenantId === "string") await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}

/** A tenant context, or the platform record-write elevation, never both. */
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

export class PostgresPipelineExecutionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async record(execution: PipelineExecution): Promise<void> {
    await scopedWrite(this.conn, execution.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           request_id, tenant_id, started_at, completed_at, total_duration_ms,
           final_stage, final_outcome, final_response_status, stages,
           auth_outcome, route_match_outcome, idempotency_outcome,
           principal_id, route_operation_id, resolved_api_version,
           correlation_id, rate_limit_decision_id, bytes_in, bytes_out
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          execution.requestId,
          execution.tenantId,
          execution.startedAt,
          execution.completedAt,
          execution.totalDurationMs,
          execution.finalStage,
          execution.finalOutcome,
          execution.finalResponseStatus,
          JSON.stringify(execution.stages),
          execution.authOutcome,
          execution.routeMatchOutcome,
          execution.idempotencyOutcome,
          execution.principalId,
          execution.routeOperationId,
          execution.resolvedApiVersion,
          execution.correlationId,
          execution.rateLimitDecisionId,
          execution.bytesIn,
          execution.bytesOut,
        ],
    
      ),
    );
  }

  /**
   * How many executions one scope recorded since `since`.
   *
   * `tenantId` defaults to the platform scope, which is what a non-owner connection with no tenant
   * context has always been given — the default makes the owner agree with it rather than changing
   * what either was asked for. A count is not a list: a caller cannot inspect a scalar and notice
   * that three of its four are another scope's.
   */
  async countSince(since: Date, tenantId: string | null = null): Promise<number> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}
         WHERE started_at >= $1 AND ${scope.sql}`,
        [since.toISOString(), ...scope.params],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}
