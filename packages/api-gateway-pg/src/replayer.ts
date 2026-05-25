import {
  PIPELINE_STAGES,
  type PipelineExecution,
  type PipelineStage,
  type StageOutcome,
  type StageResult,
} from "@crossengin/api-gateway";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";
const EXECUTIONS_TABLE = "gateway_pipeline_executions";
const DECISIONS_TABLE = "rate_limit_decisions";

const TERMINATING_OUTCOMES: ReadonlySet<StageOutcome> = new Set([
  "deny",
  "redirect",
  "short_circuit_replay",
  "error",
]);

export type DriftCode =
  | "stages_out_of_order"
  | "stage_repeated"
  | "final_stage_mismatch"
  | "final_outcome_mismatch"
  | "pass_with_4xx_or_5xx"
  | "deny_without_4xx_or_5xx"
  | "duration_inconsistent"
  | "rate_limit_decision_not_found"
  | "empty_stages"
  | "terminating_not_last";

export interface DriftIssue {
  readonly code: DriftCode;
  readonly detail: string;
}

export interface ExecutionVerifyReport {
  readonly requestId: string;
  readonly hasExecution: boolean;
  readonly drifted: boolean;
  readonly issues: readonly DriftIssue[];
}

interface ExecutionRow {
  readonly request_id: string;
  readonly tenant_id: string | null;
  readonly started_at: string;
  readonly completed_at: string;
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

function parseStages(value: unknown): readonly StageResult[] {
  if (Array.isArray(value)) return value as StageResult[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed as StageResult[];
    } catch {
      return [];
    }
  }
  return [];
}

function toNumber(value: number | string): number {
  if (typeof value === "number") return value;
  return Number.parseInt(value, 10);
}

export function verifyPipelineExecutionShape(
  execution: PipelineExecution,
  opts: { readonly durationToleranceMs?: number } = {},
): readonly DriftIssue[] {
  const issues: DriftIssue[] = [];
  const stages = execution.stages;

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
    if (stageIdx === -1) continue;
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

  async getExecution(requestId: string): Promise<PipelineExecution | null> {
    const result = await this.conn.query<ExecutionRow>(
      `SELECT request_id, tenant_id, started_at, completed_at, total_duration_ms,
              final_stage, final_outcome, final_response_status, stages,
              auth_outcome, route_match_outcome, idempotency_outcome,
              principal_id, route_operation_id, resolved_api_version,
              correlation_id, rate_limit_decision_id, bytes_in, bytes_out
         FROM ${SCHEMA}.${EXECUTIONS_TABLE}
        WHERE request_id = $1
        LIMIT 1`,
      [requestId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      requestId: row.request_id,
      tenantId: row.tenant_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      totalDurationMs: row.total_duration_ms,
      finalStage: row.final_stage as PipelineExecution["finalStage"],
      finalOutcome: row.final_outcome as PipelineExecution["finalOutcome"],
      finalResponseStatus: row.final_response_status,
      stages: [...parseStages(row.stages)],
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
  }

  async verifyExecution(requestId: string): Promise<ExecutionVerifyReport> {
    const execution = await this.getExecution(requestId);
    if (execution === null) {
      return { requestId, hasExecution: false, drifted: false, issues: [] };
    }
    const issues = [...verifyPipelineExecutionShape(execution)];
    if (execution.rateLimitDecisionId !== null) {
      const found = await this.rateLimitDecisionExists(execution.rateLimitDecisionId);
      if (!found) {
        issues.push({
          code: "rate_limit_decision_not_found",
          detail: `rateLimitDecisionId ${execution.rateLimitDecisionId} not in rate_limit_decisions`,
        });
      }
    }
    return {
      requestId,
      hasExecution: true,
      drifted: issues.length > 0,
      issues,
    };
  }

  async listRecentExecutions(
    opts: {
      readonly since?: Date;
      readonly tenantId?: string;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly string[]> {
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      params.push(opts.since.toISOString());
      filters.push(`started_at >= $${params.length.toString()}`);
    }
    if (opts.tenantId !== undefined) {
      params.push(opts.tenantId);
      filters.push(`tenant_id = $${params.length.toString()}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    params.push(offset);
    const result = await this.conn.query<{ request_id: string }>(
      `SELECT request_id FROM ${SCHEMA}.${EXECUTIONS_TABLE} ${where}
        ORDER BY started_at DESC
        LIMIT $${(params.length - 1).toString()} OFFSET $${params.length.toString()}`,
      params,
    );
    return result.rows.map((r) => r.request_id);
  }

  async bulkVerify(
    opts: {
      readonly since?: Date;
      readonly tenantId?: string;
      readonly batchSize?: number;
      readonly maxExecutions?: number;
    } = {},
  ): Promise<readonly ExecutionVerifyReport[]> {
    const batchSize = opts.batchSize ?? 100;
    const max = opts.maxExecutions ?? Number.POSITIVE_INFINITY;
    const reports: ExecutionVerifyReport[] = [];
    let offset = 0;
    while (reports.length < max) {
      const remaining = max - reports.length;
      const limit = Math.min(batchSize, remaining);
      const ids = await this.listRecentExecutions({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
        limit,
        offset,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        if (reports.length >= max) break;
        reports.push(await this.verifyExecution(id));
      }
      if (ids.length < limit) break;
      offset += ids.length;
    }
    return reports;
  }

  async summarize(
    opts: {
      readonly since?: Date;
      readonly tenantId?: string;
    } = {},
  ): Promise<ExecutionSummary> {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      params.push(opts.since.toISOString());
      filters.push(`started_at >= $${params.length.toString()}`);
    }
    if (opts.tenantId !== undefined) {
      params.push(opts.tenantId);
      filters.push(`tenant_id = $${params.length.toString()}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await this.conn.query<{
      final_outcome: string;
      total_duration_ms: number;
    }>(
      `SELECT final_outcome, total_duration_ms
         FROM ${SCHEMA}.${EXECUTIONS_TABLE} ${where}`,
      params,
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

  private async rateLimitDecisionExists(decisionId: string): Promise<boolean> {
    const result = await this.conn.query<{ exists_count: string }>(
      `SELECT COUNT(*)::TEXT AS exists_count
         FROM ${SCHEMA}.${DECISIONS_TABLE}
        WHERE decision_id = $1
        LIMIT 1`,
      [decisionId],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    return Number.parseInt(row.exists_count, 10) > 0;
  }
}
