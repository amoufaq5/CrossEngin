import { z } from "zod";
import { AUTH_OUTCOMES } from "./auth-resolution.js";
import { IDEMPOTENCY_OUTCOMES } from "./idempotency.js";
import { ROUTE_MATCH_OUTCOMES } from "./routes.js";

export const PIPELINE_STAGES = [
  "receive",
  "parse_request",
  "validate_tls",
  "parse_auth_credential",
  "authenticate",
  "resolve_principal",
  "match_route",
  "negotiate_version",
  "negotiate_content",
  "check_idempotency",
  "check_rate_limit",
  "validate_request_signature",
  "validate_request_schema",
  "dispatch_handler",
  "transform_response",
  "apply_security_headers",
  "emit_audit",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_OUTCOMES = [
  "pass",
  "deny",
  "short_circuit_replay",
  "redirect",
  "fallthrough",
  "error",
] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const TERMINATING_STAGE_OUTCOMES: ReadonlySet<StageOutcome> = new Set([
  "deny",
  "short_circuit_replay",
  "redirect",
  "error",
]);

export const StageResultSchema = z
  .object({
    stage: z.enum(PIPELINE_STAGES),
    outcome: z.enum(STAGE_OUTCOMES),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().min(0).max(60_000),
    reason: z.string().max(500),
    appliedHeaders: z.record(z.string(), z.string()).default({}),
    problemTypeUri: z.string().url().nullable(),
    responseStatus: z.number().int().min(100).max(599).nullable(),
  })
  .superRefine((s, ctx) => {
    const start = Date.parse(s.startedAt);
    const end = Date.parse(s.completedAt);
    if (end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede startedAt",
      });
    }
    const expectedDuration = end - start;
    if (Math.abs(expectedDuration - s.durationMs) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: `durationMs ${s.durationMs} does not match completedAt - startedAt (${expectedDuration})`,
      });
    }
    if (s.outcome === "deny" && (s.problemTypeUri === null || s.responseStatus === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["problemTypeUri"],
        message: "deny outcome requires problemTypeUri + responseStatus",
      });
    }
    if (
      s.outcome === "redirect" &&
      (s.responseStatus === null || s.responseStatus < 300 || s.responseStatus >= 400)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["responseStatus"],
        message: "redirect outcome requires 3xx responseStatus",
      });
    }
  });
export type StageResult = z.infer<typeof StageResultSchema>;

export const PipelineExecutionSchema = z
  .object({
    requestId: z.string().regex(/^req_[A-Za-z0-9_-]{8,64}$/),
    tenantId: z.string().uuid().nullable(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    totalDurationMs: z.number().int().min(0).max(300_000),
    finalStage: z.enum(PIPELINE_STAGES),
    finalOutcome: z.enum(STAGE_OUTCOMES),
    finalResponseStatus: z.number().int().min(100).max(599),
    stages: z.array(StageResultSchema).min(1).max(PIPELINE_STAGES.length),
    authOutcome: z.enum(AUTH_OUTCOMES),
    routeMatchOutcome: z.enum(ROUTE_MATCH_OUTCOMES).nullable(),
    idempotencyOutcome: z.enum(IDEMPOTENCY_OUTCOMES).nullable(),
    principalId: z.string().uuid().nullable(),
    routeOperationId: z.string().max(120).nullable(),
    resolvedApiVersion: z
      .string()
      .regex(/^v[0-9]+$/)
      .nullable(),
    correlationId: z.string().max(200).nullable(),
    rateLimitDecisionId: z
      .string()
      .regex(/^rld_[a-z0-9]{8,40}$/)
      .nullable(),
    bytesIn: z.number().int().min(0),
    bytesOut: z.number().int().min(0),
  })
  .superRefine((p, ctx) => {
    const start = Date.parse(p.startedAt);
    const end = Date.parse(p.completedAt);
    if (end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede startedAt",
      });
    }
    const expectedDuration = end - start;
    if (Math.abs(expectedDuration - p.totalDurationMs) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalDurationMs"],
        message: `totalDurationMs does not match completedAt - startedAt (${expectedDuration})`,
      });
    }
    let prevSeq = -1;
    const seenStages = new Set<PipelineStage>();
    for (const stage of p.stages) {
      const stageIdx = PIPELINE_STAGES.indexOf(stage.stage);
      if (stageIdx <= prevSeq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages"],
          message: `stage ${stage.stage} is out of order or repeated`,
        });
        return;
      }
      if (seenStages.has(stage.stage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages"],
          message: `stage ${stage.stage} appears twice in pipeline`,
        });
        return;
      }
      seenStages.add(stage.stage);
      prevSeq = stageIdx;
    }
    const last = p.stages[p.stages.length - 1];
    if (last !== undefined && last.stage !== p.finalStage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalStage"],
        message: "finalStage must equal last entry in stages array",
      });
    }
    if (last !== undefined && last.outcome !== p.finalOutcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalOutcome"],
        message: "finalOutcome must equal last entry's outcome",
      });
    }
    if (p.finalOutcome === "pass" && p.finalResponseStatus >= 400) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalResponseStatus"],
        message: "pass outcome cannot have 4xx/5xx responseStatus",
      });
    }
  });
export type PipelineExecution = z.infer<typeof PipelineExecutionSchema>;

export const isTerminatingOutcome = (outcome: StageOutcome): boolean =>
  TERMINATING_STAGE_OUTCOMES.has(outcome);

export interface PipelineSummary {
  readonly totalRequests: number;
  readonly passedRequests: number;
  readonly deniedRequests: number;
  readonly errorRequests: number;
  readonly replayedRequests: number;
  readonly successRate: number;
  readonly p50LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly denialsByStage: Readonly<Partial<Record<PipelineStage, number>>>;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
};

export const summarizePipeline = (executions: readonly PipelineExecution[]): PipelineSummary => {
  if (executions.length === 0) {
    return {
      totalRequests: 0,
      passedRequests: 0,
      deniedRequests: 0,
      errorRequests: 0,
      replayedRequests: 0,
      successRate: 0,
      p50LatencyMs: 0,
      p99LatencyMs: 0,
      denialsByStage: {},
    };
  }
  let passed = 0;
  let denied = 0;
  let error = 0;
  let replayed = 0;
  const denialsByStage: Partial<Record<PipelineStage, number>> = {};
  const latencies: number[] = [];
  for (const e of executions) {
    latencies.push(e.totalDurationMs);
    if (e.finalOutcome === "pass") passed++;
    if (e.finalOutcome === "deny") {
      denied++;
      denialsByStage[e.finalStage] = (denialsByStage[e.finalStage] ?? 0) + 1;
    }
    if (e.finalOutcome === "error") error++;
    if (e.finalOutcome === "short_circuit_replay") replayed++;
  }
  latencies.sort((a, b) => a - b);
  return {
    totalRequests: executions.length,
    passedRequests: passed,
    deniedRequests: denied,
    errorRequests: error,
    replayedRequests: replayed,
    successRate: (passed + replayed) / executions.length,
    p50LatencyMs: percentile(latencies, 50),
    p99LatencyMs: percentile(latencies, 99),
    denialsByStage,
  };
};

export const expectedStageOrder = (): readonly PipelineStage[] => PIPELINE_STAGES;
