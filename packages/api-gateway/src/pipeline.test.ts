import { describe, expect, it } from "vitest";
import {
  PIPELINE_STAGES,
  PipelineExecutionSchema,
  STAGE_OUTCOMES,
  StageResultSchema,
  TERMINATING_STAGE_OUTCOMES,
  expectedStageOrder,
  isTerminatingOutcome,
  summarizePipeline,
  type PipelineExecution,
  type StageResult,
} from "./pipeline.js";

const stageReceive: StageResult = {
  stage: "receive",
  outcome: "pass",
  startedAt: "2026-05-16T10:00:00.000Z",
  completedAt: "2026-05-16T10:00:00.001Z",
  durationMs: 1,
  reason: "request_received",
  appliedHeaders: {},
  problemTypeUri: null,
  responseStatus: null,
};

const stageAuth: StageResult = {
  stage: "authenticate",
  outcome: "pass",
  startedAt: "2026-05-16T10:00:00.001Z",
  completedAt: "2026-05-16T10:00:00.005Z",
  durationMs: 4,
  reason: "jwt_valid",
  appliedHeaders: {},
  problemTypeUri: null,
  responseStatus: null,
};

const stageRoute: StageResult = {
  stage: "match_route",
  outcome: "pass",
  startedAt: "2026-05-16T10:00:00.005Z",
  completedAt: "2026-05-16T10:00:00.006Z",
  durationMs: 1,
  reason: "matched_tenants_get",
  appliedHeaders: {},
  problemTypeUri: null,
  responseStatus: null,
};

const stageDispatch: StageResult = {
  stage: "dispatch_handler",
  outcome: "pass",
  startedAt: "2026-05-16T10:00:00.006Z",
  completedAt: "2026-05-16T10:00:00.050Z",
  durationMs: 44,
  reason: "handler_returned_200",
  appliedHeaders: {},
  problemTypeUri: null,
  responseStatus: 200,
};

const baseExecution: PipelineExecution = {
  requestId: "req_abc12345",
  tenantId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-05-16T10:00:00.000Z",
  completedAt: "2026-05-16T10:00:00.050Z",
  totalDurationMs: 50,
  finalStage: "dispatch_handler",
  finalOutcome: "pass",
  finalResponseStatus: 200,
  stages: [stageReceive, stageAuth, stageRoute, stageDispatch],
  authOutcome: "authenticated",
  routeMatchOutcome: "matched",
  idempotencyOutcome: "no_key_required",
  principalId: "22222222-2222-2222-2222-222222222222",
  routeOperationId: "tenants.get",
  resolvedApiVersion: "v1",
  correlationId: null,
  rateLimitDecisionId: null,
  bytesIn: 0,
  bytesOut: 1024,
};

describe("constants", () => {
  it("has 17 pipeline stages", () => {
    expect(PIPELINE_STAGES).toHaveLength(17);
  });
  it("has 6 stage outcomes", () => {
    expect(STAGE_OUTCOMES).toHaveLength(6);
  });
  it("TERMINATING outcomes include deny, short_circuit_replay, redirect, error", () => {
    expect(TERMINATING_STAGE_OUTCOMES.size).toBe(4);
  });
});

describe("StageResultSchema", () => {
  it("accepts a valid pass stage", () => {
    expect(() => StageResultSchema.parse(stageReceive)).not.toThrow();
  });

  it("rejects completedAt before startedAt", () => {
    expect(() =>
      StageResultSchema.parse({
        ...stageReceive,
        completedAt: "2026-05-16T09:00:00.000Z",
      }),
    ).toThrow(/cannot precede/);
  });

  it("rejects durationMs mismatch", () => {
    expect(() => StageResultSchema.parse({ ...stageReceive, durationMs: 999 })).toThrow(
      /does not match/,
    );
  });

  it("rejects deny without problemTypeUri + responseStatus", () => {
    expect(() => StageResultSchema.parse({ ...stageReceive, outcome: "deny" })).toThrow(
      /deny outcome requires/,
    );
  });

  it("rejects redirect without 3xx responseStatus", () => {
    expect(() =>
      StageResultSchema.parse({
        ...stageReceive,
        outcome: "redirect",
        responseStatus: 200,
      }),
    ).toThrow(/3xx responseStatus/);
  });
});

describe("PipelineExecutionSchema", () => {
  it("accepts a valid pipeline run", () => {
    expect(() => PipelineExecutionSchema.parse(baseExecution)).not.toThrow();
  });

  it("rejects out-of-order stages", () => {
    expect(() =>
      PipelineExecutionSchema.parse({
        ...baseExecution,
        stages: [stageAuth, stageReceive, stageRoute, stageDispatch],
      }),
    ).toThrow(/out of order/);
  });

  it("rejects duplicate stages", () => {
    expect(() =>
      PipelineExecutionSchema.parse({
        ...baseExecution,
        stages: [stageReceive, stageReceive, stageAuth],
      }),
    ).toThrow(/out of order|appears twice/);
  });

  it("rejects mismatched finalStage", () => {
    expect(() =>
      PipelineExecutionSchema.parse({
        ...baseExecution,
        finalStage: "receive",
      }),
    ).toThrow(/finalStage must equal/);
  });

  it("rejects pass outcome with 4xx status", () => {
    expect(() =>
      PipelineExecutionSchema.parse({
        ...baseExecution,
        finalResponseStatus: 404,
      }),
    ).toThrow(/cannot have 4xx/);
  });

  it("rejects totalDurationMs mismatch", () => {
    expect(() =>
      PipelineExecutionSchema.parse({
        ...baseExecution,
        totalDurationMs: 999,
      }),
    ).toThrow(/does not match/);
  });
});

describe("isTerminatingOutcome", () => {
  it("deny terminates", () => {
    expect(isTerminatingOutcome("deny")).toBe(true);
  });
  it("pass does not terminate", () => {
    expect(isTerminatingOutcome("pass")).toBe(false);
  });
});

describe("expectedStageOrder", () => {
  it("returns canonical PIPELINE_STAGES", () => {
    expect(expectedStageOrder()).toEqual(PIPELINE_STAGES);
  });
});

describe("summarizePipeline", () => {
  it("returns zeros for empty", () => {
    const s = summarizePipeline([]);
    expect(s.totalRequests).toBe(0);
    expect(s.successRate).toBe(0);
  });

  it("aggregates pass/deny/error/replay", () => {
    const passed = baseExecution;
    const denied: PipelineExecution = {
      ...baseExecution,
      requestId: "req_def00000",
      stages: [
        stageReceive,
        {
          ...stageAuth,
          outcome: "deny",
          problemTypeUri: "https://crossengin.io/errors/authentication-required",
          responseStatus: 401,
        },
      ],
      finalStage: "authenticate",
      finalOutcome: "deny",
      finalResponseStatus: 401,
      authOutcome: "expired_token",
      routeMatchOutcome: null,
      idempotencyOutcome: null,
      principalId: null,
      routeOperationId: null,
      resolvedApiVersion: null,
      completedAt: "2026-05-16T10:00:00.005Z",
      totalDurationMs: 5,
    };
    const s = summarizePipeline([passed, denied]);
    expect(s.totalRequests).toBe(2);
    expect(s.passedRequests).toBe(1);
    expect(s.deniedRequests).toBe(1);
    expect(s.successRate).toBe(0.5);
    expect(s.denialsByStage.authenticate).toBe(1);
  });
});
