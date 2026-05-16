import type { IncomingRequest } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  PipelineRecorder,
  buildStageResult,
  isTerminatingStageOutcome,
  pipelineStageIndex,
} from "./pipeline-runner.js";

const REQUEST_ID = "req_test00000001";

function fixtureRequest(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    id: REQUEST_ID,
    receivedAt: "2026-05-16T12:00:00.000Z",
    method: "POST",
    path: "/v1/tenants",
    query: {},
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: 100,
    bodySha256: null,
    clientIp: "203.0.113.1",
    forwardedFor: [],
    forwardedProto: null,
    forwardedHost: null,
    userAgent: null,
    tlsVersion: null,
    tlsCipher: null,
    clientCertSha256: null,
    correlationId: null,
    traceparent: null,
    tenantHint: null,
    edgeRegion: null,
    ...overrides,
  };
}

describe("buildStageResult", () => {
  it("computes durationMs from start + end", () => {
    const r = buildStageResult({
      stage: "receive",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.025Z"),
      reason: "ok",
    });
    expect(r.durationMs).toBe(25);
  });

  it("attaches problemTypeUri + responseStatus on deny", () => {
    const r = buildStageResult({
      stage: "authenticate",
      outcome: "deny",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.010Z"),
      reason: "missing_token",
      problemTypeUri: "https://crossengin.io/errors/authentication-required",
      responseStatus: 401,
    });
    expect(r.problemTypeUri).toContain("authentication-required");
    expect(r.responseStatus).toBe(401);
  });
});

describe("PipelineRecorder", () => {
  function recorder() {
    return new PipelineRecorder({ requestId: REQUEST_ID, startedAt: new Date("2026-05-16T12:00:00.000Z") });
  }

  it("starts empty", () => {
    const r = recorder();
    expect(r.count()).toBe(0);
    expect(r.lastStage()).toBeNull();
    expect(r.hasTerminating()).toBe(false);
  });

  it("records sequential stages", () => {
    const r = recorder();
    r.record({
      stage: "receive",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.001Z"),
      reason: "ok",
    });
    r.record({
      stage: "parse_request",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.001Z"),
      completedAt: new Date("2026-05-16T12:00:00.002Z"),
      reason: "ok",
    });
    expect(r.count()).toBe(2);
    expect(r.lastStage()?.stage).toBe("parse_request");
  });

  it("rejects out-of-order stages", () => {
    const r = recorder();
    r.record({
      stage: "parse_request",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.001Z"),
      reason: "ok",
    });
    expect(() =>
      r.record({
        stage: "receive",
        outcome: "pass",
        startedAt: new Date("2026-05-16T12:00:00.001Z"),
        completedAt: new Date("2026-05-16T12:00:00.002Z"),
        reason: "ok",
      }),
    ).toThrow(/out-of-order/);
  });

  it("hasTerminating returns true for deny / redirect / short_circuit_replay / error", () => {
    const r = recorder();
    r.record({
      stage: "authenticate",
      outcome: "deny",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.001Z"),
      reason: "x",
      problemTypeUri: "https://example.com/x",
      responseStatus: 401,
    });
    expect(r.hasTerminating()).toBe(true);
  });

  it("build() produces a schema-valid PipelineExecution", () => {
    const r = recorder();
    r.record({
      stage: "receive",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
      completedAt: new Date("2026-05-16T12:00:00.001Z"),
      reason: "ok",
    });
    r.record({
      stage: "emit_audit",
      outcome: "pass",
      startedAt: new Date("2026-05-16T12:00:00.020Z"),
      completedAt: new Date("2026-05-16T12:00:00.025Z"),
      reason: "audit_emitted",
    });
    const execution = r.build({
      request: fixtureRequest(),
      completedAt: new Date("2026-05-16T12:00:00.030Z"),
      finalResponseStatus: 200,
      tenantId: "00000000-0000-4000-8000-000000000001",
      authOutcome: "authenticated",
      routeMatchOutcome: "matched",
      idempotencyOutcome: "first_seen",
      principalId: "00000000-0000-4000-8000-000000000010",
      routeOperationId: "tenants.create",
      resolvedApiVersion: "v1",
      rateLimitDecisionId: null,
      bytesOut: 250,
    });
    expect(execution.requestId).toBe(REQUEST_ID);
    expect(execution.totalDurationMs).toBe(30);
    expect(execution.finalStage).toBe("emit_audit");
    expect(execution.bytesIn).toBe(100);
    expect(execution.bytesOut).toBe(250);
    expect(execution.stages).toHaveLength(2);
  });

  it("build() rejects when no stages have been recorded", () => {
    const r = recorder();
    expect(() =>
      r.build({
        request: fixtureRequest(),
        completedAt: new Date(),
        finalResponseStatus: 200,
        tenantId: null,
        authOutcome: "anonymous",
        routeMatchOutcome: null,
        idempotencyOutcome: null,
        principalId: null,
        routeOperationId: null,
        resolvedApiVersion: null,
        rateLimitDecisionId: null,
        bytesOut: 0,
      }),
    ).toThrow(/no stages/);
  });
});

describe("pipelineStageIndex", () => {
  it("returns the declared order index", () => {
    expect(pipelineStageIndex("receive")).toBe(0);
    expect(pipelineStageIndex("emit_audit")).toBe(16);
  });
});

describe("isTerminatingStageOutcome", () => {
  it("returns true for deny / redirect / short_circuit_replay / error", () => {
    expect(isTerminatingStageOutcome("deny")).toBe(true);
    expect(isTerminatingStageOutcome("redirect")).toBe(true);
    expect(isTerminatingStageOutcome("short_circuit_replay")).toBe(true);
    expect(isTerminatingStageOutcome("error")).toBe(true);
  });

  it("returns false for pass / fallthrough", () => {
    expect(isTerminatingStageOutcome("pass")).toBe(false);
    expect(isTerminatingStageOutcome("fallthrough")).toBe(false);
  });
});
