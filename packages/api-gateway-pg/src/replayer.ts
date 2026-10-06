import {
  PIPELINE_STAGES,
  type PipelineExecution,
  type PipelineStage,
  type StageOutcome,
  type StageResult,
} from "@crossengin/api-gateway";
import { requireIsoInstant, type PgConnection } from "@crossengin/kernel-pg";

import {
  optionalScopeFilter,
  scopeFilter,
  scopedRead,
  type ReadScope,
} from "./pipeline-execution-store.js";

const SCHEMA = "meta";
const EXECUTIONS_TABLE = "gateway_pipeline_executions";
const DECISIONS_TABLE = "rate_limit_decisions";

const TERMINATING_OUTCOMES: ReadonlySet<StageOutcome> = new Set([
  "deny",
  "redirect",
  "short_circuit_replay",
  "error",
]);

/**
 * Every code this module can report, as a value rather than a type alone, so a test and a caller
 * can both iterate it. `DR_DRIFT_ISSUE_KINDS` and the SLO replayer's `DRIFT_ISSUE_KINDS` were
 * already consts; this was the odd one out, and a findings vocabulary that is not a value cannot be
 * asserted against anything.
 *
 * `unknown_stage` and `stages_unreadable` are new and they close the same hole from two sides. The
 * order walk did `if (stageIdx === -1) continue`, so a `stages` entry naming something that is not
 * a `PipelineStage` was **skipped in silence**: it could not be out of order, could not be a repeat,
 * and did not stop the row being reported clean — in the one module whose job is to say whether the
 * stored record of a request is coherent. And `parseStages` returned `[]` for a `stages` value it
 * could not read, which the walk then reported as `empty_stages` — a different and much milder
 * claim than "this row's stage log is unreadable". ADR-0333's rule, that an unparsed statement is
 * reported and never skipped, read on the other side of the same boundary.
 */
export const GATEWAY_DRIFT_CODES = [
  "stages_out_of_order",
  "stage_repeated",
  "final_stage_mismatch",
  "final_outcome_mismatch",
  "pass_with_4xx_or_5xx",
  "deny_without_4xx_or_5xx",
  "duration_inconsistent",
  "rate_limit_decision_not_found",
  "empty_stages",
  "stages_unreadable",
  "unknown_stage",
  "terminating_not_last",
] as const;
export type GatewayDriftCode = (typeof GATEWAY_DRIFT_CODES)[number];

export interface GatewayDriftIssue {
  readonly code: GatewayDriftCode;
  readonly detail: string;
}

export interface ExecutionVerifyReport {
  readonly requestId: string;
  /**
   * The scope the row itself declares, which is a recorded fact and not what the caller asked for.
   *
   * It is here because a cross-scope sweep is a **loop over tenants** (see
   * `UNSCOPED_READ_IS_OWNER_ONLY`), and findings from two tenants landing in one report with no way
   * to tell them apart make the sweep unusable. `null` is the platform scope; `null` also when
   * there is no row, where the honest answer is that no scope was established.
   */
  readonly tenantId: string | null;
  readonly hasExecution: boolean;
  readonly drifted: boolean;
  readonly issues: readonly GatewayDriftIssue[];
}

/**
 * `ReadScope`'s third member — `undefined`, "every scope" — is **owner-only by construction**, and
 * that is a fact about RLS rather than about this query.
 *
 * `scopedRead(conn, undefined, …)` deliberately sets no tenant context, and `optionalScopeFilter`
 * deliberately adds no predicate, so the statement is correct and unrestricted. What restricts it is
 * the table: `meta.gateway_pipeline_executions` carries an isolation policy plus a `SELECT`-scoped
 * platform arm on `tenant_id IS NULL`, so a session with no tenant context sees **only the platform
 * scope**. Measured on a live cluster with 6 tenant executions beside 1 platform one, same code:
 *
 *   listRecentExecutions({tenantId: "…"})   non-owner 6   owner 6
 *   listRecentExecutions({tenantId: null})  non-owner 1   owner 1
 *   listRecentExecutions({})                non-owner 1   owner 7
 *
 * So in any deployment that does not connect as the table's owner, "every scope" silently means
 * "the platform scope", and a sweep built on it reports the other six rows clean **by never having
 * looked at them**. That is ADR-0329's `rls_would_confine_this_session` shape, where a statement
 * matched 0 rows, reported 0, and the confirming count also saw 0 because both read through the
 * same policy.
 *
 * It is kept rather than removed, because as the owner it is a genuinely useful diagnostic and
 * `getExecution`'s point lookup by request id honestly does not know the scope in advance. What
 * changes is that `bulkVerify` can no longer *default* into it: the scope is a required field there
 * with no default, so reading every scope is a deliberate act that was written down. ADR-0328's
 * rule — a default is applied to silence, and silence must not decide this.
 *
 * A complete cross-scope sweep is a loop over `meta.tenants` calling `bulkVerify({scope: tenantId})`
 * per tenant plus one `{scope: null}` pass, which is the pattern `drainAllTenants` and the
 * checkpoint scheduler already use for exactly this reason.
 */
export const UNSCOPED_READ_IS_OWNER_ONLY =
  "scope: undefined reads every scope only as the table's owner; a non-owner session with no " +
  "tenant context is shown the platform scope alone. Sweep per tenant instead.";

interface ExecutionRow {
  readonly request_id: string;
  readonly tenant_id: string | null;
  /**
   * `unknown`: node-postgres returns a `TIMESTAMPTZ` as a `Date`, and `getExecution` hands these
   * two out inside a `PipelineExecution` — whose schema declares them as ISO text — so the object
   * did not satisfy the contract it is typed as. Nothing compares them yet; the type was the lie.
   */
  readonly started_at: unknown;
  readonly completed_at: unknown;
  readonly total_duration_ms: number;
  readonly final_stage: string;
  readonly final_outcome: string;
  readonly final_response_status: number;
  readonly stages: unknown;
  readonly auth_outcome: string;
  readonly route_match_outcome: string | null;
  readonly idempotency_outcome: string | null;
  readonly principal_id: string | null;
  readonly route_operation_id: string | null;
  readonly resolved_api_version: string | null;
  readonly correlation_id: string | null;
  readonly rate_limit_decision_id: string | null;
  readonly bytes_in: number | string;
  readonly bytes_out: number | string;
}

/**
 * A `stages` JSONB value as an array, or `null` when it cannot be read as one.
 *
 * `null` rather than `[]` is the whole change: an unreadable `stages` column used to come back as an
 * empty array, which `verifyPipelineExecutionShape` then reported as `empty_stages` — "this request
 * recorded no stages", a claim about the gateway. The truth is "this row's stage log is unreadable",
 * a claim about the row, and conflating the two sends an operator to the wrong place. node-postgres
 * parses `JSONB` for us, so the string arm is for a driver or column type that hands back text.
 */
function parseStages(value: unknown): readonly StageResult[] | null {
  if (Array.isArray(value)) return value as StageResult[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as StageResult[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toNumber(value: number | string): number {
  if (typeof value === "number") return value;
  return Number.parseInt(value, 10);
}

export interface VerifyShapeOptions {
  readonly durationToleranceMs?: number;
  /**
   * Set by `verifyExecution` when the stored `stages` column could not be read as an array at all.
   *
   * It has to come in from outside, because by the time a `PipelineExecution` exists its `stages` is
   * typed `StageResult[]` and an unreadable column has already been flattened to `[]` — which is
   * exactly how "unreadable" used to be reported as `empty_stages`.
   */
  readonly stagesUnreadable?: boolean;
}

export function verifyPipelineExecutionShape(
  execution: PipelineExecution,
  opts: VerifyShapeOptions = {},
): readonly GatewayDriftIssue[] {
  const issues: GatewayDriftIssue[] = [];
  const stages = execution.stages;

  if (opts.stagesUnreadable === true) {
    issues.push({
      code: "stages_unreadable",
      detail: "the stored stages column is not a JSON array, so the stage log cannot be checked",
    });
    return issues;
  }

  if (stages.length === 0) {
    issues.push({
      code: "empty_stages",
      detail: "PipelineExecution must have at least one stage recorded",
    });
    return issues;
  }

  let lastIdx = -1;
  const seen = new Set<PipelineStage>();
  let firstTerminatingIdx = -1;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const stageIdx = PIPELINE_STAGES.indexOf(stage.stage);
    if (stageIdx === -1) {
      // Reported, never skipped. A `continue` here meant an entry naming something that is not a
      // `PipelineStage` could be neither out of order nor a repeat, and left the row reported clean
      // — so a `stages` array of invented names produced no findings at all.
      issues.push({
        code: "unknown_stage",
        detail: `stage entry at position ${i.toString()} names '${String(stage.stage)}', which is not a pipeline stage`,
      });
      continue;
    }
    if (stageIdx <= lastIdx) {
      issues.push({
        code: "stages_out_of_order",
        detail: `stage ${stage.stage} at position ${i.toString()} is out of declared order`,
      });
    }
    if (seen.has(stage.stage)) {
      issues.push({
        code: "stage_repeated",
        detail: `stage ${stage.stage} appears more than once`,
      });
    }
    seen.add(stage.stage);
    lastIdx = stageIdx;
    if (firstTerminatingIdx === -1 && TERMINATING_OUTCOMES.has(stage.outcome)) {
      firstTerminatingIdx = i;
    }
  }

  if (firstTerminatingIdx !== -1 && firstTerminatingIdx !== stages.length - 1) {
    issues.push({
      code: "terminating_not_last",
      detail: `terminating outcome at stage index ${firstTerminatingIdx.toString()} but stages continue afterward`,
    });
  }

  const lastStage = stages[stages.length - 1]!;
  if (lastStage.stage !== execution.finalStage) {
    issues.push({
      code: "final_stage_mismatch",
      detail: `finalStage=${execution.finalStage} but last stage entry is ${lastStage.stage}`,
    });
  }
  if (lastStage.outcome !== execution.finalOutcome) {
    issues.push({
      code: "final_outcome_mismatch",
      detail: `finalOutcome=${execution.finalOutcome} but last stage outcome is ${lastStage.outcome}`,
    });
  }

  if (execution.finalOutcome === "pass" && execution.finalResponseStatus >= 400) {
    issues.push({
      code: "pass_with_4xx_or_5xx",
      detail: `pass outcome has ${execution.finalResponseStatus.toString()} status`,
    });
  }
  if (execution.finalOutcome === "deny" && execution.finalResponseStatus < 400) {
    issues.push({
      code: "deny_without_4xx_or_5xx",
      detail: `deny outcome has ${execution.finalResponseStatus.toString()} status`,
    });
  }

  const tolerance = opts.durationToleranceMs ?? 50;
  const sumStageDurations = stages.reduce((acc, s) => acc + s.durationMs, 0);
  if (sumStageDurations > execution.totalDurationMs + tolerance) {
    issues.push({
      code: "duration_inconsistent",
      detail: `sum of stage durations (${sumStageDurations.toString()}) exceeds totalDurationMs (${execution.totalDurationMs.toString()})`,
    });
  }

  return issues;
}

export interface ExecutionSummary {
  readonly totalExecutions: number;
  readonly passCount: number;
  readonly denyCount: number;
  readonly errorCount: number;
  readonly redirectCount: number;
  readonly replayCount: number;
  readonly successRate: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[idx]!;
}

export class GatewayReplayer {
  private readonly conn: PgConnection;

  constructor(opts: { readonly conn: PgConnection }) {
    this.conn = opts.conn;
  }

  /**
   * One execution by request id, within `scope`.
   *
   * `scope` is `undefined` by default — every scope — because that is what this has always meant
   * here and what `bulkVerify` depends on: it collects ids across scopes and asks for each in turn,
   * so defaulting to the platform scope would report every tenant execution as `hasExecution:
   * false`. Pass `null` to ask for the platform's own rows, which was not expressible before.
   */
  async getExecution(
    requestId: string,
    scope: ReadScope = undefined,
  ): Promise<PipelineExecution | null> {
    return (await this.loadExecution(requestId, scope))?.execution ?? null;
  }

  /**
   * `getExecution` plus the one fact a `PipelineExecution` cannot carry: whether its `stages` column
   * was readable. The public shape stays as it was; `verifyExecution` needs the extra bit.
   */
  private async loadExecution(
    requestId: string,
    scope: ReadScope = undefined,
  ): Promise<{ readonly execution: PipelineExecution; readonly stagesUnreadable: boolean } | null> {
    const filter = optionalScopeFilter(scope, 2);
    const result = await scopedRead(this.conn, scope, (tx) =>
      tx.query<ExecutionRow>(
        `SELECT request_id, tenant_id, started_at, completed_at, total_duration_ms,
                final_stage, final_outcome, final_response_status, stages,
                auth_outcome, route_match_outcome, idempotency_outcome,
                principal_id, route_operation_id, resolved_api_version,
                correlation_id, rate_limit_decision_id, bytes_in, bytes_out
           FROM ${SCHEMA}.${EXECUTIONS_TABLE}
          WHERE request_id = $1${filter === null ? "" : ` AND ${filter.sql}`}
          LIMIT 1`,
        [requestId, ...(filter?.params ?? [])],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const stages = parseStages(row.stages);
    const execution: PipelineExecution = {
      requestId: row.request_id,
      tenantId: row.tenant_id,
      startedAt: requireIsoInstant(row.started_at, "started_at"),
      completedAt: requireIsoInstant(row.completed_at, "completed_at"),
      totalDurationMs: row.total_duration_ms,
      finalStage: row.final_stage as PipelineExecution["finalStage"],
      finalOutcome: row.final_outcome as PipelineExecution["finalOutcome"],
      finalResponseStatus: row.final_response_status,
      stages: [...(stages ?? [])],
      authOutcome: row.auth_outcome as PipelineExecution["authOutcome"],
      routeMatchOutcome:
        row.route_match_outcome === null
          ? null
          : (row.route_match_outcome as NonNullable<PipelineExecution["routeMatchOutcome"]>),
      idempotencyOutcome:
        row.idempotency_outcome === null
          ? null
          : (row.idempotency_outcome as NonNullable<PipelineExecution["idempotencyOutcome"]>),
      principalId: row.principal_id,
      routeOperationId: row.route_operation_id,
      resolvedApiVersion: row.resolved_api_version,
      correlationId: row.correlation_id,
      rateLimitDecisionId: row.rate_limit_decision_id,
      bytesIn: toNumber(row.bytes_in),
      bytesOut: toNumber(row.bytes_out),
    };
    return { execution, stagesUnreadable: stages === null };
  }

  async verifyExecution(
    requestId: string,
    scope: ReadScope = undefined,
  ): Promise<ExecutionVerifyReport> {
    const loaded = await this.loadExecution(requestId, scope);
    if (loaded === null) {
      // `tenantId: null` here is "no scope was established", not "the platform scope" — the row
      // that would have named one is absent, and `hasExecution` is what says which.
      return { requestId, tenantId: null, hasExecution: false, drifted: false, issues: [] };
    }
    const { execution, stagesUnreadable } = loaded;
    const issues = [...verifyPipelineExecutionShape(execution, { stagesUnreadable })];
    if (execution.rateLimitDecisionId !== null) {
      // The decision's scope comes from the execution that names it, not from the caller: a
      // gateway writes both rows in one request, so the execution's own `tenant_id` is a recorded
      // fact about where its decision is. Unscoped, the owner found a *tenant's* decision for a
      // platform execution and reported no drift, and a non-owner found none at all.
      const found = await this.rateLimitDecisionExists(
        execution.rateLimitDecisionId,
        execution.tenantId,
      );
      if (!found) {
        issues.push({
          code: "rate_limit_decision_not_found",
          detail: `rateLimitDecisionId ${execution.rateLimitDecisionId} not in rate_limit_decisions`,
        });
      }
    }
    return {
      requestId,
      tenantId: execution.tenantId,
      hasExecution: true,
      drifted: issues.length > 0,
      issues,
    };
  }

  /**
   * Recent request ids within `tenantId`'s scope, newest first.
   *
   * `tenantId` widens from `string | undefined` to `ReadScope`: a tenant id, `null` for the platform
   * scope, or absent for every scope. Absent keeps its meaning, so no existing caller changes — but
   * `null` was previously inexpressible, and under a `LIMIT` that was the expensive half. Another
   * scope's rows do not merely join this page, they *displace* the asked-for ones, and the caller
   * sees a short page rather than a wrong one.
   */
  async listRecentExecutions(opts: {
    readonly since?: Date;
    readonly tenantId?: ReadScope;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<readonly string[]> {
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      params.push(opts.since.toISOString());
      filters.push(`started_at >= $${params.length.toString()}`);
    }
    const scope = optionalScopeFilter(opts.tenantId, params.length + 1);
    if (scope !== null) {
      params.push(...scope.params);
      filters.push(scope.sql);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    params.push(offset);
    const result = await scopedRead(this.conn, opts.tenantId, (tx) =>
      tx.query<{ request_id: string }>(
        `SELECT request_id FROM ${SCHEMA}.${EXECUTIONS_TABLE} ${where}
          ORDER BY started_at DESC
          LIMIT $${(params.length - 1).toString()} OFFSET $${params.length.toString()}`,
        params,
      ),
    );
    return result.rows.map((r) => r.request_id);
  }

  /**
   * Every execution in **one** scope, which the caller has to name.
   *
   * `scope` is a required field with no default, and that is the fix rather than a style
   * preference: it used to be `tenantId?: ReadScope`, so omitting it fell into "every scope", which
   * `UNSCOPED_READ_IS_OWNER_ONLY` records is owner-only — a non-owner sweep read the platform scope
   * and reported every tenant row clean by never looking. A default is applied to silence
   * (ADR-0328), and whether a sweep covered one tenant or the whole deployment is not something
   * silence may decide. Passing `undefined` explicitly is still allowed and still means every scope
   * the role can see; it is now a written-down act.
   *
   * Each report names the scope of the row it is about, so the per-tenant passes of a
   * `meta.tenants` loop compose into one list without losing which tenant a finding belongs to.
   */
  async bulkVerify(opts: {
    readonly scope: ReadScope;
    readonly since?: Date;
    readonly batchSize?: number;
    readonly maxExecutions?: number;
  }): Promise<readonly ExecutionVerifyReport[]> {
    const batchSize = opts.batchSize ?? 100;
    const max = opts.maxExecutions ?? Number.POSITIVE_INFINITY;
    const reports: ExecutionVerifyReport[] = [];
    let offset = 0;
    while (reports.length < max) {
      const remaining = max - reports.length;
      const limit = Math.min(batchSize, remaining);
      const ids = await this.listRecentExecutions({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.scope !== undefined ? { tenantId: opts.scope } : {}),
        limit,
        offset,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        if (reports.length >= max) break;
        reports.push(await this.verifyExecution(id, opts.scope));
      }
      if (ids.length < limit) break;
      offset += ids.length;
    }
    return reports;
  }

  /**
   * Outcome counts and latency percentiles for one scope.
   *
   * Every number this returns is an aggregate, so an unasked-for scope does not show up as an extra
   * row — it moves `successRate` and `p95LatencyMs`. Measured live with three passing tenant
   * executions beside one 900 ms platform error: as the owner `summarize({})` answered
   * `successRate: 0.75, p95: 900`; as a non-owner, `successRate: 0, p95: 900`. Both are honest
   * answers to "every scope you can see", and neither is the platform's.
   */
  async summarize(opts: {
    readonly since?: Date;
    readonly tenantId?: ReadScope;
  } = {}): Promise<ExecutionSummary> {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      params.push(opts.since.toISOString());
      filters.push(`started_at >= $${params.length.toString()}`);
    }
    const scope = optionalScopeFilter(opts.tenantId, params.length + 1);
    if (scope !== null) {
      params.push(...scope.params);
      filters.push(scope.sql);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await scopedRead(this.conn, opts.tenantId, (tx) =>
      tx.query<{
        final_outcome: string;
        total_duration_ms: number;
      }>(
        `SELECT final_outcome, total_duration_ms
           FROM ${SCHEMA}.${EXECUTIONS_TABLE} ${where}`,
        params,
      ),
    );
    const rows = result.rows;
    if (rows.length === 0) {
      return {
        totalExecutions: 0,
        passCount: 0,
        denyCount: 0,
        errorCount: 0,
        redirectCount: 0,
        replayCount: 0,
        successRate: 1,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
      };
    }
    let passCount = 0;
    let denyCount = 0;
    let errorCount = 0;
    let redirectCount = 0;
    let replayCount = 0;
    const durations: number[] = [];
    for (const r of rows) {
      durations.push(r.total_duration_ms);
      switch (r.final_outcome) {
        case "pass":
          passCount++;
          break;
        case "deny":
          denyCount++;
          break;
        case "error":
          errorCount++;
          break;
        case "redirect":
          redirectCount++;
          break;
        case "short_circuit_replay":
          replayCount++;
          break;
      }
    }
    durations.sort((a, b) => a - b);
    return {
      totalExecutions: rows.length,
      passCount,
      denyCount,
      errorCount,
      redirectCount,
      replayCount,
      successRate: (passCount + replayCount + redirectCount) / rows.length,
      p50LatencyMs: percentile(durations, 0.5),
      p95LatencyMs: percentile(durations, 0.95),
    };
  }

  private async rateLimitDecisionExists(
    decisionId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    const scope = scopeFilter(tenantId, 2);
    const result = await scopedRead(this.conn, tenantId, (tx) =>
      tx.query<{ exists_count: string }>(
        `SELECT COUNT(*)::TEXT AS exists_count
           FROM ${SCHEMA}.${DECISIONS_TABLE}
          WHERE decision_id = $1 AND ${scope.sql}
          LIMIT 1`,
        [decisionId, ...scope.params],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    return Number.parseInt(row.exists_count, 10) > 0;
  }
}
