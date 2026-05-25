import {
  PIPELINE_STAGES,
  PipelineExecutionSchema,
  StageResultSchema,
  type AuthOutcome,
  type IdempotencyOutcome,
  type IncomingRequest,
  type PipelineExecution,
  type PipelineStage,
  type RouteMatchOutcome,
  type StageOutcome,
  type StageResult,
} from "@crossengin/api-gateway";

export interface StageRecordInput {
  readonly stage: PipelineStage;
  readonly outcome: StageOutcome;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly reason: string;
  readonly appliedHeaders?: Record<string, string>;
  readonly problemTypeUri?: string | null;
  readonly responseStatus?: number | null;
}

export function buildStageResult(input: StageRecordInput): StageResult {
  const startedAtIso = input.startedAt.toISOString();
  const completedAtIso = input.completedAt.toISOString();
  const durationMs = Math.max(0, input.completedAt.getTime() - input.startedAt.getTime());
  const result: StageResult = {
    stage: input.stage,
    outcome: input.outcome,
    startedAt: startedAtIso,
    completedAt: completedAtIso,
    durationMs,
    reason: input.reason,
    appliedHeaders: input.appliedHeaders ?? {},
    problemTypeUri: input.problemTypeUri ?? null,
    responseStatus: input.responseStatus ?? null,
  };
  return StageResultSchema.parse(result);
}

export class PipelineRecorder {
  private readonly stages: StageResult[] = [];
  private readonly requestId: string;
  private readonly startedAt: Date;
  private nextExpectedStageIndex = 0;

  constructor(opts: { readonly requestId: string; readonly startedAt: Date }) {
    this.requestId = opts.requestId;
    this.startedAt = opts.startedAt;
  }

  record(input: StageRecordInput): StageResult {
    const stageIdx = PIPELINE_STAGES.indexOf(input.stage);
    if (stageIdx < this.nextExpectedStageIndex) {
      throw new Error(
        `out-of-order stage ${input.stage} (expected index >= ${this.nextExpectedStageIndex.toString()}, got ${stageIdx.toString()})`,
      );
    }
    const result = buildStageResult(input);
    this.stages.push(result);
    this.nextExpectedStageIndex = stageIdx + 1;
    return result;
  }

  count(): number {
    return this.stages.length;
  }

  lastStage(): StageResult | null {
    return this.stages[this.stages.length - 1] ?? null;
  }

  hasTerminating(): boolean {
    const last = this.lastStage();
    if (last === null) return false;
    return (
      last.outcome === "deny" ||
      last.outcome === "redirect" ||
      last.outcome === "short_circuit_replay" ||
      last.outcome === "error"
    );
  }

  build(input: {
    readonly request: IncomingRequest;
    readonly completedAt: Date;
    readonly finalResponseStatus: number;
    readonly tenantId: string | null;
    readonly authOutcome: AuthOutcome;
    readonly routeMatchOutcome: RouteMatchOutcome | null;
    readonly idempotencyOutcome: IdempotencyOutcome | null;
    readonly principalId: string | null;
    readonly routeOperationId: string | null;
    readonly resolvedApiVersion: string | null;
    readonly rateLimitDecisionId: string | null;
    readonly bytesOut: number;
  }): PipelineExecution {
    const last = this.lastStage();
    if (last === null) {
      throw new Error("cannot build PipelineExecution with no stages recorded");
    }
    const totalDurationMs = Math.max(0, input.completedAt.getTime() - this.startedAt.getTime());
    const execution: PipelineExecution = {
      requestId: this.requestId,
      tenantId: input.tenantId,
      startedAt: this.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      totalDurationMs,
      finalStage: last.stage,
      finalOutcome: last.outcome,
      finalResponseStatus: input.finalResponseStatus,
      stages: this.stages,
      authOutcome: input.authOutcome,
      routeMatchOutcome: input.routeMatchOutcome,
      idempotencyOutcome: input.idempotencyOutcome,
      principalId: input.principalId,
      routeOperationId: input.routeOperationId,
      resolvedApiVersion: input.resolvedApiVersion,
      correlationId: input.request.correlationId,
      rateLimitDecisionId: input.rateLimitDecisionId,
      bytesIn: input.request.bodyBytes,
      bytesOut: input.bytesOut,
    };
    return PipelineExecutionSchema.parse(execution);
  }
}

export function pipelineStageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

export function isTerminatingStageOutcome(outcome: StageOutcome): boolean {
  return (
    outcome === "deny" ||
    outcome === "redirect" ||
    outcome === "short_circuit_replay" ||
    outcome === "error"
  );
}
