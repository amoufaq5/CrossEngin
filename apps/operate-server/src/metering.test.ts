import { describe, expect, it } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import { CountingUuidGenerator } from "@crossengin/billing-runtime";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  MeteringFlushScheduler,
  RequestMeteringObserver,
  buildRequestMetering,
  flushUsage,
  meteredEventFromExecution,
  parseMeteringConfig,
  policyFromConfig,
} from "./metering.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";

const config = parseMeteringConfig({ tenantSubscriptions: { [TENANT]: SUB } });
const policy = policyFromConfig(config);

function fakePg(): { conn: PgConnection; calls: string[] } {
  const calls: string[] = [];
  const conn: PgConnection = {
    query: (async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return { conn, calls };
}

function execution(overrides: {
  readonly tenantId?: string | null;
  readonly status?: number;
  readonly requestId?: string;
}): PipelineExecution {
  const status = overrides.status ?? 200;
  const stage = status >= 400 ? "dispatch_handler" : "emit_audit";
  const outcome = status >= 500 ? "error" : status >= 400 ? "deny" : "pass";
  return PipelineExecutionSchema.parse({
    requestId: overrides.requestId ?? "req_abcdefgh12345",
    tenantId: overrides.tenantId === undefined ? TENANT : overrides.tenantId,
    startedAt: "2026-06-15T12:00:00.000Z",
    completedAt: "2026-06-15T12:00:00.040Z",
    totalDurationMs: 40,
    finalStage: stage,
    finalOutcome: outcome,
    finalResponseStatus: status,
    stages: [
      {
        stage,
        outcome,
        startedAt: "2026-06-15T12:00:00.000Z",
        completedAt: "2026-06-15T12:00:00.040Z",
        durationMs: 40,
        reason: "test",
        appliedHeaders: {},
        problemTypeUri: status >= 400 ? "https://crossengin.io/problems/test" : null,
        responseStatus: status,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: "product.list",
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 0,
  });
}

describe("parseMeteringConfig", () => {
  it("applies meter/source/quantity defaults", () => {
    expect(config.meter).toBe("integration_call");
    expect(config.source).toBe("integration_calls");
    expect(config.quantityPerRequest).toBe(1);
  });

  it("rejects unknown keys + a non-uuid subscription", () => {
    expect(() => parseMeteringConfig({ tenantSubscriptions: {}, bogus: 1 })).toThrow();
    expect(() => parseMeteringConfig({ tenantSubscriptions: { [TENANT]: "not-uuid" } })).toThrow();
  });
});

describe("meteredEventFromExecution", () => {
  it("meters a 2xx request for a mapped tenant, keyed by request id", () => {
    const event = meteredEventFromExecution(execution({ requestId: "req_req000001" }), policy);
    expect(event?.subscriptionId).toBe(SUB);
    expect(event?.meter).toBe("integration_call");
    expect(event?.idempotencyKey).toBe("req_req000001");
  });

  it("skips an unauthenticated request (no tenant)", () => {
    expect(meteredEventFromExecution(execution({ tenantId: null }), policy)).toBeNull();
  });

  it("skips a 4xx/5xx response by default", () => {
    expect(meteredEventFromExecution(execution({ status: 404 }), policy)).toBeNull();
    expect(meteredEventFromExecution(execution({ status: 503 }), policy)).toBeNull();
  });

  it("skips a tenant with no mapped subscription", () => {
    expect(
      meteredEventFromExecution(execution({ tenantId: "99999999-9999-9999-9999-999999999999" }), policy),
    ).toBeNull();
  });

  it("honours an explicit countStatuses list", () => {
    const p = policyFromConfig(parseMeteringConfig({ tenantSubscriptions: { [TENANT]: SUB }, countStatuses: [201] }));
    expect(meteredEventFromExecution(execution({ status: 200 }), p)).toBeNull();
    expect(meteredEventFromExecution(execution({ status: 201 }), p)).not.toBeNull();
  });
});

describe("RequestMeteringObserver + flushUsage", () => {
  it("accumulates billable requests and flushes them as usage records", async () => {
    const { conn, calls } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    for (let i = 0; i < 5; i += 1) {
      observer.observe(execution({ requestId: `req_r${i.toString().padStart(8, "0")}` }));
    }
    observer.observe(execution({ tenantId: null })); // not billable
    expect(observer.meteredSubscriptions()).toEqual([SUB]);
    expect(engine.engine.usage(SUB)[0]?.quantity).toBe(5);

    const written = await flushUsage(engine, observer.meteredSubscriptions(), {
      period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
      source: "integration_calls",
      recordedAt: "2026-07-01T00:00:00.000Z",
      ids: new CountingUuidGenerator(),
    });
    expect(written).toBe(1);
    expect(calls.some((s) => s.includes("billing_usage_records"))).toBe(true);
    // Cleared after flush.
    expect(engine.engine.usage(SUB)).toEqual([]);
  });

  it("de-duplicates a repeated request id (no double-count)", () => {
    const { conn } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    observer.observe(execution({ requestId: "req_dup00001" }));
    observer.observe(execution({ requestId: "req_dup00001" }));
    expect(engine.engine.usage(SUB)[0]?.quantity).toBe(1);
  });
});

describe("MeteringFlushScheduler", () => {
  it("flushes the window since the previous tick", async () => {
    const { conn } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    observer.observe(execution({ requestId: "req_flush0001" }));
    let t = new Date("2026-06-15T12:00:00.000Z");
    const flushes: number[] = [];
    const scheduler = new MeteringFlushScheduler({
      observer,
      engine,
      source: "integration_calls",
      intervalMs: 1_000,
      ids: new CountingUuidGenerator(),
      clock: () => t,
      onFlush: (n) => flushes.push(n),
    });
    t = new Date("2026-06-15T12:05:00.000Z");
    const written = await scheduler.flushOnce();
    expect(written).toBe(1);
    expect(flushes).toEqual([1]);
  });

  it("no-ops when no time has elapsed", async () => {
    const { conn } = fakePg();
    const { engine, observer } = buildRequestMetering(conn, config);
    const scheduler = new MeteringFlushScheduler({
      observer,
      engine,
      source: "integration_calls",
      intervalMs: 1_000,
      clock: () => new Date("2026-06-15T12:00:00.000Z"),
    });
    expect(await scheduler.flushOnce()).toBe(0);
  });
});
