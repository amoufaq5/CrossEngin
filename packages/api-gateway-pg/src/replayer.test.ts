import {
  PipelineExecutionSchema,
  type PipelineExecution,
  type StageResult,
} from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_DRIFT_CODES,
  GatewayReplayer,
  UNSCOPED_READ_IS_OWNER_ONLY,
  verifyPipelineExecutionShape,
} from "./replayer.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";

function stage(opts: Partial<StageResult> & { stage: StageResult["stage"]; outcome: StageResult["outcome"] }): StageResult {
  return {
    stage: opts.stage,
    outcome: opts.outcome,
    startedAt: opts.startedAt ?? "2026-05-16T12:00:00.000Z",
    completedAt: opts.completedAt ?? "2026-05-16T12:00:00.001Z",
    durationMs: opts.durationMs ?? 1,
    reason: opts.reason ?? "ok",
    appliedHeaders: opts.appliedHeaders ?? {},
    problemTypeUri: opts.problemTypeUri ?? null,
    responseStatus: opts.responseStatus ?? null,
  };
}

function fixtureExecution(overrides: Partial<PipelineExecution> = {}): PipelineExecution {
  return {
    requestId: "req_test00000001",
    tenantId: TENANT,
    startedAt: "2026-05-16T12:00:00.000Z",
    completedAt: "2026-05-16T12:00:00.025Z",
    totalDurationMs: 25,
    finalStage: "emit_audit",
    finalOutcome: "pass",
    finalResponseStatus: 200,
    stages: [
      stage({ stage: "receive", outcome: "pass" }),
      stage({
        stage: "emit_audit",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.020Z",
        completedAt: "2026-05-16T12:00:00.025Z",
        durationMs: 5,
      }),
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: USER,
    routeOperationId: "tenants.create",
    resolvedApiVersion: "v1",
    correlationId: "corr-1",
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 200,
    ...overrides,
  };
}

interface MockState {
  readonly executions: Map<string, PipelineExecution>;
  readonly decisionIds: Set<string>;
  readonly recentIds: string[];
  /**
   * Hand `started_at` / `completed_at` back as `Date`s, which is what node-postgres actually does
   * for a `TIMESTAMPTZ`. Default off so the existing cases keep exercising the libpq-text path.
   */
  readonly timestampsAsDates?: boolean;
}

function buildMock(state: MockState): PgConnection {
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM meta.gateway_pipeline_executions") && sql.includes("WHERE request_id")) {
        const id = params?.[0] as string;
        const ex = state.executions.get(id);
        if (ex === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              request_id: ex.requestId,
              tenant_id: ex.tenantId,
              started_at: state.timestampsAsDates === true ? new Date(ex.startedAt) : ex.startedAt,
              completed_at:
                state.timestampsAsDates === true ? new Date(ex.completedAt) : ex.completedAt,
              total_duration_ms: ex.totalDurationMs,
              final_stage: ex.finalStage,
              final_outcome: ex.finalOutcome,
              final_response_status: ex.finalResponseStatus,
              stages: ex.stages,
              auth_outcome: ex.authOutcome,
              route_match_outcome: ex.routeMatchOutcome,
              idempotency_outcome: ex.idempotencyOutcome,
              principal_id: ex.principalId,
              route_operation_id: ex.routeOperationId,
              resolved_api_version: ex.resolvedApiVersion,
              correlation_id: ex.correlationId,
              rate_limit_decision_id: ex.rateLimitDecisionId,
              bytes_in: ex.bytesIn,
              bytes_out: ex.bytesOut,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT request_id FROM meta.gateway_pipeline_executions")) {
        return {
          rows: state.recentIds.map((id) => ({ request_id: id })),
          rowCount: state.recentIds.length,
        };
      }
      if (sql.includes("SELECT final_outcome, total_duration_ms")) {
        const rows = [...state.executions.values()].map((ex) => ({
          final_outcome: ex.finalOutcome,
          total_duration_ms: ex.totalDurationMs,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM meta.rate_limit_decisions") && sql.includes("COUNT")) {
        const id = params?.[0] as string;
        const exists = state.decisionIds.has(id);
        return { rows: [{ exists_count: exists ? "1" : "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    // Every read runs inside `scopedRead` now, so the fake has to actually run the callback — a
    // `vi.fn()` returning undefined made each read throw on `result.rows`, which is itself a small
    // demonstration of why ADR-0307 typechecks the tests.
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

function emptyState(): MockState {
  return {
    executions: new Map(),
    decisionIds: new Set(),
    recentIds: [],
  };
}

describe("verifyPipelineExecutionShape", () => {
  it("returns no issues for a well-formed execution", () => {
    const issues = verifyPipelineExecutionShape(fixtureExecution());
    expect(issues).toEqual([]);
  });

  it("flags empty_stages", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({ stages: [] }) as PipelineExecution,
    );
    expect(issues.some((i) => i.code === "empty_stages")).toBe(true);
  });

  it("flags stages_out_of_order", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        stages: [
          stage({ stage: "emit_audit", outcome: "pass" }),
          stage({ stage: "receive", outcome: "pass" }),
        ],
        finalStage: "receive",
        finalOutcome: "pass",
      }),
    );
    expect(issues.some((i) => i.code === "stages_out_of_order")).toBe(true);
  });

  it("flags stage_repeated", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        stages: [
          stage({ stage: "receive", outcome: "pass" }),
          stage({ stage: "receive", outcome: "pass" }),
          stage({ stage: "emit_audit", outcome: "pass" }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "stage_repeated")).toBe(true);
  });

  it("flags final_stage_mismatch", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        finalStage: "receive",
        stages: [
          stage({ stage: "receive", outcome: "pass" }),
          stage({ stage: "emit_audit", outcome: "pass" }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "final_stage_mismatch")).toBe(true);
  });

  it("flags final_outcome_mismatch", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        finalOutcome: "deny",
        finalResponseStatus: 401,
        stages: [
          stage({ stage: "receive", outcome: "pass" }),
          stage({ stage: "emit_audit", outcome: "pass" }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "final_outcome_mismatch")).toBe(true);
  });

  it("flags pass_with_4xx_or_5xx", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        finalResponseStatus: 503,
      }),
    );
    expect(issues.some((i) => i.code === "pass_with_4xx_or_5xx")).toBe(true);
  });

  it("flags deny_without_4xx_or_5xx", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        finalStage: "authenticate",
        finalOutcome: "deny",
        finalResponseStatus: 200,
        stages: [
          stage({ stage: "receive", outcome: "pass" }),
          stage({
            stage: "authenticate",
            outcome: "deny",
            problemTypeUri: "https://crossengin.io/errors/authentication-required",
            responseStatus: 200,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "deny_without_4xx_or_5xx")).toBe(true);
  });

  it("flags terminating_not_last when a deny stage is followed by another", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        finalStage: "emit_audit",
        finalOutcome: "pass",
        stages: [
          stage({
            stage: "authenticate",
            outcome: "deny",
            problemTypeUri: "https://crossengin.io/errors/authentication-required",
            responseStatus: 401,
          }),
          stage({ stage: "emit_audit", outcome: "pass" }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "terminating_not_last")).toBe(true);
  });

  it("flags duration_inconsistent when stage durations exceed totalDurationMs", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        totalDurationMs: 5,
        stages: [
          stage({ stage: "receive", outcome: "pass", durationMs: 100 }),
          stage({ stage: "emit_audit", outcome: "pass", durationMs: 100 }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === "duration_inconsistent")).toBe(true);
  });

  it("respects the durationToleranceMs option", () => {
    const issues = verifyPipelineExecutionShape(
      fixtureExecution({
        totalDurationMs: 5,
        stages: [
          stage({ stage: "receive", outcome: "pass", durationMs: 10 }),
        ],
      }),
      { durationToleranceMs: 50 },
    );
    expect(issues.some((i) => i.code === "duration_inconsistent")).toBe(false);
  });
});

/**
 * The two halves of a stage log that could not be checked, and were reported as if it had been.
 */
describe("an unreadable or unknown stage is reported, never skipped", () => {
  it("names an entry whose stage is not a pipeline stage", () => {
    const issues = verifyPipelineExecutionShape({
      ...fixtureExecution(),
      stages: [
        { stage: "receive", outcome: "pass", durationMs: 1 },
        // A hand-written UPDATE, or a future version's stage name. The walk used to `continue`.
        { stage: "frobnicate", outcome: "pass", durationMs: 1 },
      ] as unknown as PipelineExecution["stages"],
      finalStage: "receive",
      finalOutcome: "pass",
    });
    const unknown = issues.filter((i) => i.code === "unknown_stage");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.detail).toContain("frobnicate");
    expect(unknown[0]?.detail).toContain("position 1");
  });

  it("reports every unknown entry rather than stopping at the first", () => {
    const issues = verifyPipelineExecutionShape({
      ...fixtureExecution(),
      stages: [
        { stage: "nope_one", outcome: "pass", durationMs: 1 },
        { stage: "nope_two", outcome: "pass", durationMs: 1 },
      ] as unknown as PipelineExecution["stages"],
    });
    expect(issues.filter((i) => i.code === "unknown_stage")).toHaveLength(2);
  });

  it("no longer reports an all-unknown stage array as clean", () => {
    // The regression this closes: every entry skipped, so order, repeats and the terminating check
    // all had nothing to look at, and `empty_stages` did not fire because length was non-zero.
    const issues = verifyPipelineExecutionShape({
      ...fixtureExecution(),
      stages: [{ stage: "invented", outcome: "pass", durationMs: 0 }] as unknown as
        PipelineExecution["stages"],
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("still orders the stages it does recognise around an unknown one", () => {
    const issues = verifyPipelineExecutionShape({
      ...fixtureExecution(),
      stages: [
        { stage: "emit_audit", outcome: "pass", durationMs: 1 },
        { stage: "invented", outcome: "pass", durationMs: 1 },
        { stage: "receive", outcome: "pass", durationMs: 1 },
      ] as unknown as PipelineExecution["stages"],
      finalStage: "receive",
      finalOutcome: "pass",
    });
    expect(issues.map((i) => i.code)).toContain("unknown_stage");
    expect(issues.map((i) => i.code)).toContain("stages_out_of_order");
  });

  it("reports stages_unreadable rather than empty_stages, and nothing else", () => {
    // "This request recorded no stages" is a claim about the gateway; "this row's stage log is
    // unreadable" is a claim about the row, and it sends an operator somewhere else entirely.
    const issues = verifyPipelineExecutionShape(
      { ...fixtureExecution(), stages: [] },
      { stagesUnreadable: true },
    );
    expect(issues.map((i) => i.code)).toEqual(["stages_unreadable"]);
  });

  it("still reports empty_stages for a readable but empty array", () => {
    const issues = verifyPipelineExecutionShape({ ...fixtureExecution(), stages: [] });
    expect(issues.map((i) => i.code)).toEqual(["empty_stages"]);
  });

  it("verifyExecution reports stages_unreadable for a stages column that is not an array", async () => {
    const state = emptyState();
    state.executions.set("req_test00000001", fixtureExecution());
    const conn = buildMock(state);
    const original = conn.query as (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<PgQueryResult>;
    conn.query = (async (sql: string, params?: readonly unknown[]) => {
      const result = await original(sql, params);
      if (sql.includes("FROM meta.gateway_pipeline_executions") && sql.includes("WHERE request_id")) {
        return {
          rows: result.rows.map((r) => ({ ...r, stages: "{not json" })),
          rowCount: result.rowCount,
        };
      }
      return result;
    }) as PgConnection["query"];
    const report = await new GatewayReplayer({ conn }).verifyExecution("req_test00000001");
    expect(report.drifted).toBe(true);
    expect(report.issues.map((i) => i.code)).toEqual(["stages_unreadable"]);
  });
});

describe("GATEWAY_DRIFT_CODES", () => {
  it("names every code the module can report", () => {
    expect([...GATEWAY_DRIFT_CODES]).toEqual([
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
    ]);
  });

  it("has no duplicate member", () => {
    expect(new Set(GATEWAY_DRIFT_CODES).size).toBe(GATEWAY_DRIFT_CODES.length);
  });
});

/**
 * Every report names the scope of the row it is about, which is what makes a per-tenant sweep
 * composable: findings from two tenants in one list with no way to tell them apart are unusable.
 */
describe("a report names its scope", () => {
  it("carries the row's own tenant id", async () => {
    const state = emptyState();
    state.executions.set("req_test00000001", fixtureExecution());
    const report = await new GatewayReplayer({ conn: buildMock(state) }).verifyExecution(
      "req_test00000001",
    );
    expect(report.tenantId).toBe(TENANT);
  });

  it("carries null for a platform-scope execution", async () => {
    const state = emptyState();
    state.executions.set("req_platform0001", fixtureExecution({
      requestId: "req_platform0001",
      tenantId: null,
    }));
    const report = await new GatewayReplayer({ conn: buildMock(state) }).verifyExecution(
      "req_platform0001",
    );
    expect(report.tenantId).toBeNull();
    expect(report.hasExecution).toBe(true);
  });

  it("carries null with hasExecution=false when no row established a scope", async () => {
    const report = await new GatewayReplayer({ conn: buildMock(emptyState()) }).verifyExecution(
      "req_missing",
    );
    expect(report).toMatchObject({ tenantId: null, hasExecution: false });
  });

  it("bulkVerify names the scope on every report it returns", async () => {
    const state = emptyState();
    state.recentIds.push("req_test00000001");
    state.executions.set("req_test00000001", fixtureExecution());
    const reports = await new GatewayReplayer({ conn: buildMock(state) }).bulkVerify({
      scope: TENANT,
    });
    expect(reports.map((r) => r.tenantId)).toEqual([TENANT]);
  });

  it("states that an unscoped read is owner-only rather than leaving it implied", () => {
    // A sweep that reads one of seven rows and reports six clean by never looking is the
    // `rls_would_confine_this_session` shape; the constant is what a caller is pointed at.
    expect(UNSCOPED_READ_IS_OWNER_ONLY).toContain("owner");
    expect(UNSCOPED_READ_IS_OWNER_ONLY).toContain("per tenant");
  });
});

describe("GatewayReplayer.getExecution", () => {
  it("returns null when execution does not exist", async () => {
    const replayer = new GatewayReplayer({ conn: buildMock(emptyState()) });
    expect(await replayer.getExecution("req_missing")).toBeNull();
  });

  it("parses a row back into a PipelineExecution", async () => {
    const state = emptyState();
    state.executions.set("req_test00000001", fixtureExecution());
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const ex = await replayer.getExecution("req_test00000001");
    expect(ex?.requestId).toBe("req_test00000001");
    expect(ex?.stages).toHaveLength(2);
    expect(ex?.tenantId).toBe(TENANT);
  });

  // `started_at` / `completed_at` arrive as `Date`s from a real connection, and this read hands them
  // straight out inside a `PipelineExecution`, whose schema declares ISO text.
  it("renders Date timestamps as ISO text a PipelineExecution can hold", async () => {
    const state: MockState = { ...emptyState(), timestampsAsDates: true };
    state.executions.set("req_test00000001", fixtureExecution());
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const ex = await replayer.getExecution("req_test00000001");
    expect(typeof ex?.startedAt).toBe("string");
    expect(ex?.startedAt).toBe(fixtureExecution().startedAt);
    expect(ex?.completedAt).toBe(fixtureExecution().completedAt);
    expect(PipelineExecutionSchema.safeParse(ex).success).toBe(true);
  });

  it("converts numeric strings for bytesIn/bytesOut", async () => {
    const state = emptyState();
    state.executions.set("req_test00000001", fixtureExecution());
    const conn = buildMock(state);
    // Override to simulate libpq returning bigints as strings
    const original = conn.query as (sql: string, params?: readonly unknown[]) => Promise<PgQueryResult>;
    conn.query = (async (sql: string, params?: readonly unknown[]) => {
      const result = await original(sql, params);
      if (sql.includes("FROM meta.gateway_pipeline_executions") && sql.includes("WHERE request_id")) {
        return {
          rows: result.rows.map((r) => ({ ...r, bytes_in: "100", bytes_out: "200" })),
          rowCount: result.rowCount,
        };
      }
      return result;
    }) as PgConnection["query"];
    const replayer = new GatewayReplayer({ conn });
    const ex = await replayer.getExecution("req_test00000001");
    expect(ex?.bytesIn).toBe(100);
    expect(ex?.bytesOut).toBe(200);
  });
});

describe("GatewayReplayer.verifyExecution", () => {
  it("returns hasExecution=false when missing", async () => {
    const replayer = new GatewayReplayer({ conn: buildMock(emptyState()) });
    const report = await replayer.verifyExecution("req_missing");
    expect(report.hasExecution).toBe(false);
    expect(report.drifted).toBe(false);
  });

  it("returns drifted=false for a well-formed execution", async () => {
    const state = emptyState();
    state.executions.set("req_test00000001", fixtureExecution());
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const report = await replayer.verifyExecution("req_test00000001");
    expect(report.hasExecution).toBe(true);
    expect(report.drifted).toBe(false);
  });

  it("flags rate_limit_decision_not_found when decision id is missing from rate_limit_decisions", async () => {
    const state = emptyState();
    state.executions.set("req_with_rl", fixtureExecution({
      requestId: "req_with_rl",
      rateLimitDecisionId: "rld_orphan0001",
    }));
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const report = await replayer.verifyExecution("req_with_rl");
    expect(report.drifted).toBe(true);
    expect(report.issues.some((i) => i.code === "rate_limit_decision_not_found")).toBe(true);
  });

  it("does not flag rate_limit_decision_not_found when the decision exists", async () => {
    const state = emptyState();
    state.decisionIds.add("rld_exists00001");
    state.executions.set("req_with_rl", fixtureExecution({
      requestId: "req_with_rl",
      rateLimitDecisionId: "rld_exists00001",
    }));
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const report = await replayer.verifyExecution("req_with_rl");
    expect(report.issues.some((i) => i.code === "rate_limit_decision_not_found")).toBe(false);
  });
});

describe("GatewayReplayer.listRecentExecutions", () => {
  it("returns the request ids from the result set", async () => {
    const state = emptyState();
    state.recentIds.push("req_a", "req_b", "req_c");
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const ids = await replayer.listRecentExecutions();
    expect(ids).toEqual(["req_a", "req_b", "req_c"]);
  });

  it("returns [] when no rows match", async () => {
    const replayer = new GatewayReplayer({ conn: buildMock(emptyState()) });
    expect(await replayer.listRecentExecutions()).toEqual([]);
  });
});

describe("GatewayReplayer.bulkVerify", () => {
  it("returns [] when no executions match", async () => {
    const replayer = new GatewayReplayer({ conn: buildMock(emptyState()) });
    expect(await replayer.bulkVerify({ scope: undefined })).toEqual([]);
  });

  it("verifies each execution returned by listRecentExecutions", async () => {
    const state = emptyState();
    state.recentIds.push("req_test00000001");
    state.executions.set("req_test00000001", fixtureExecution());
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const reports = await replayer.bulkVerify({
      scope: undefined,
      batchSize: 10,
      maxExecutions: 5,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.drifted).toBe(false);
  });

  it("respects maxExecutions", async () => {
    const state = emptyState();
    state.recentIds.push("req_a", "req_b", "req_c", "req_d");
    for (const id of state.recentIds) {
      state.executions.set(id, fixtureExecution({ requestId: id }));
    }
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const reports = await replayer.bulkVerify({
      scope: undefined,
      batchSize: 10,
      maxExecutions: 2,
    });
    expect(reports.length).toBeLessThanOrEqual(2);
  });
});

describe("GatewayReplayer.summarize", () => {
  it("returns zero-totals for an empty execution table", async () => {
    const replayer = new GatewayReplayer({ conn: buildMock(emptyState()) });
    const summary = await replayer.summarize();
    expect(summary.totalExecutions).toBe(0);
    expect(summary.successRate).toBe(1);
  });

  it("counts outcomes correctly", async () => {
    const state = emptyState();
    state.executions.set("req_a", fixtureExecution({ requestId: "req_a", finalOutcome: "pass", totalDurationMs: 10 }));
    state.executions.set("req_b", fixtureExecution({ requestId: "req_b", finalOutcome: "deny", totalDurationMs: 5 }));
    state.executions.set("req_c", fixtureExecution({ requestId: "req_c", finalOutcome: "short_circuit_replay", totalDurationMs: 2 }));
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const summary = await replayer.summarize();
    expect(summary.totalExecutions).toBe(3);
    expect(summary.passCount).toBe(1);
    expect(summary.denyCount).toBe(1);
    expect(summary.replayCount).toBe(1);
    expect(summary.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("computes p50 + p95 latency", async () => {
    const state = emptyState();
    for (let i = 0; i < 20; i++) {
      state.executions.set(`req_${i.toString()}`, fixtureExecution({
        requestId: `req_${i.toString().padStart(8, "0")}`,
        totalDurationMs: i * 10,
      }));
    }
    const replayer = new GatewayReplayer({ conn: buildMock(state) });
    const summary = await replayer.summarize();
    expect(summary.p50LatencyMs).toBeGreaterThanOrEqual(80);
    expect(summary.p95LatencyMs).toBeGreaterThanOrEqual(180);
  });
});

describe("the scope a read names, and the three things it can be", () => {
  /** Every statement the replayer issued, bar the session setting. */
  function reads(conn: PgConnection): { sql: string; params: readonly unknown[] | undefined }[] {
    const mock = conn.query as unknown as {
      mock: { calls: [string, readonly unknown[] | undefined][] };
    };
    return mock.mock.calls
      .map(([sql, params]) => ({ sql, params }))
      .filter((c) => !c.sql.includes("set_config"));
  }

  function settings(conn: PgConnection): readonly unknown[][] {
    const mock = conn.query as unknown as {
      mock: { calls: [string, readonly unknown[] | undefined][] };
    };
    return mock.mock.calls
      .filter(([sql]) => sql.includes("set_config"))
      .map(([, params]) => [...(params ?? [])]);
  }

  it("leaves getExecution unscoped when no scope is named, because absent has always meant every scope", async () => {
    // `bulkVerify` collects ids across scopes and asks for each in turn, so a platform default here
    // would report every tenant execution as `hasExecution: false`.
    const conn = buildMock(emptyState());
    await new GatewayReplayer({ conn }).getExecution("req_anything");
    // `tenant_id` is in the projection either way, so the assertion has to be about the predicate.
    const where = reads(conn)[0]?.sql.slice(reads(conn)[0]?.sql.indexOf("WHERE") ?? 0) ?? "";
    expect(where).not.toContain("tenant_id");
    expect(settings(conn)).toEqual([]);
  });

  it("asks for the platform scope with null, which was previously inexpressible", async () => {
    const conn = buildMock(emptyState());
    await new GatewayReplayer({ conn }).getExecution("req_anything", null);
    expect(reads(conn)[0]?.sql).toContain("tenant_id IS NULL");
    expect(settings(conn)).toEqual([]);
  });

  it("branches to equality plus a tenant context for a tenant", async () => {
    const conn = buildMock(emptyState());
    await new GatewayReplayer({ conn }).getExecution("req_anything", TENANT);
    const read = reads(conn)[0];
    expect(read?.sql).toContain("tenant_id = $2");
    expect(read?.sql).not.toContain("IS NOT DISTINCT FROM");
    expect(read?.params).toEqual(["req_anything", TENANT]);
    expect(settings(conn)).toEqual([[TENANT]]);
  });

  it("scopes listRecentExecutions before the LIMIT, so another scope cannot displace the page", async () => {
    const conn = buildMock(emptyState());
    await new GatewayReplayer({ conn }).listRecentExecutions({ tenantId: null, limit: 10 });
    const read = reads(conn)[0];
    expect(read?.sql).toContain("WHERE tenant_id IS NULL");
    expect(read?.params).toEqual([10, 0]);

    const tenantConn = buildMock(emptyState());
    await new GatewayReplayer({ conn: tenantConn }).listRecentExecutions({
      tenantId: TENANT,
      limit: 10,
    });
    const tenantRead = reads(tenantConn)[0];
    expect(tenantRead?.sql).toContain("WHERE tenant_id = $1");
    expect(tenantRead?.params).toEqual([TENANT, 10, 0]);
  });

  it("scopes summarize, whose every field is an aggregate", async () => {
    const conn = buildMock(emptyState());
    await new GatewayReplayer({ conn }).summarize({ tenantId: null });
    expect(reads(conn)[0]?.sql).toContain("WHERE tenant_id IS NULL");

    const bothConn = buildMock(emptyState());
    await new GatewayReplayer({ conn: bothConn }).summarize({
      since: new Date("2026-01-01T00:00:00.000Z"),
      tenantId: TENANT,
    });
    const read = reads(bothConn)[0];
    expect(read?.sql).toContain("started_at >= $1");
    expect(read?.sql).toContain("tenant_id = $2");
  });

  it("takes the rate-limit decision's scope from the execution that names it, not from the caller", async () => {
    // A gateway writes both rows in one request, so the execution's own `tenant_id` is a recorded
    // fact about where its decision is — stronger than anything the caller could supply.
    const state = emptyState();
    const execution = fixtureExecution({
      requestId: "req_tenantscoped",
      tenantId: TENANT,
      rateLimitDecisionId: "rld_abc12345",
    });
    state.executions.set(execution.requestId, execution);
    state.decisionIds.add("rld_abc12345");
    const conn = buildMock(state);
    const report = await new GatewayReplayer({ conn }).verifyExecution(execution.requestId);
    expect(report.hasExecution).toBe(true);
    const decisionRead = reads(conn).find((c) => c.sql.includes("meta.rate_limit_decisions"));
    expect(decisionRead?.sql).toContain("tenant_id = $2");
    expect(decisionRead?.params).toEqual(["rld_abc12345", TENANT]);
  });

  it("asks for a platform execution's decision in the platform scope", async () => {
    const state = emptyState();
    const execution = fixtureExecution({
      requestId: "req_platformrow",
      tenantId: null,
      rateLimitDecisionId: "rld_abc12345",
    });
    state.executions.set(execution.requestId, execution);
    state.decisionIds.add("rld_abc12345");
    const conn = buildMock(state);
    await new GatewayReplayer({ conn }).verifyExecution(execution.requestId);
    const decisionRead = reads(conn).find((c) => c.sql.includes("meta.rate_limit_decisions"));
    expect(decisionRead?.sql).toContain("tenant_id IS NULL");
    expect(decisionRead?.params).toEqual(["rld_abc12345"]);
  });
});
