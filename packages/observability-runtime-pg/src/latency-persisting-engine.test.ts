import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildPersistentLatencySloEngine } from "./latency-persisting-engine.js";

const SURFACE = "GET /v1/catalog";
const TENANT = "00000000-0000-4000-8000-000000000001";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000009";
const BASE = new Date("2026-06-03T12:00:00.000Z");

function mockConnection(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  const result: PgQueryResult = { rows: [], rowCount: 1 };
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      return result;
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

const slo = {
  surface: SURFACE,
  id: "catalog-latency",
  targets: [{ kind: "latency" as const, p95: "300ms", window: "30d" }],
};

const policy = {
  id: "default",
  routes: [
    { severity: "P1" as const, channels: [{ kind: "pagerduty_phone" as const, serviceKey: "svc" }] },
  ],
};

function build(capture: Array<{ sql: string; params: readonly unknown[] | undefined }>) {
  const clock = new FixedClock(BASE);
  const persistent = buildPersistentLatencySloEngine(mockConnection(capture), {
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations: [{ slo, tenantId: TENANT, rollback: { flagId: "ff_catalogv2", safeValueJson: "false" } }],
    clock,
  });
  return { persistent, clock };
}

function recordLatencies(
  persistent: ReturnType<typeof build>["persistent"],
  ms: number,
  count: number,
  atMs: number,
): void {
  for (let i = 0; i < count; i += 1) {
    persistent.recordOutcome({
      surface: SURFACE,
      outcome: "ok",
      at: new Date(atMs - i * 1_000).toISOString(),
      latencyMs: ms,
    });
  }
}

describe("buildPersistentLatencySloEngine", () => {
  it("persists a latency-signal enforcement action + latency evaluation on a breach", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());

    const decisions = await persistent.evaluate(BASE);
    expect(decisions[0]?.kind).toBe("breach_opened");

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(actionInsert?.params?.[4]).toBe("latency");
    expect(actionInsert?.params?.[1]).toBe(TENANT);
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.slo_latency_evaluations"))).toBe(true);
  });

  it("records an action but no latency snapshot while ongoing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);

    capture.length = 0;
    clock.advance(60_000);
    recordLatencies(persistent, 700, 30, clock.nowMs());
    const decisions = await persistent.evaluate(clock.now());
    expect(decisions[0]?.kind).toBe("breach_ongoing");
    expect(capture.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(capture.some((c) => c.sql.includes("slo_latency_evaluations"))).toBe(false);
  });

  it("persists nothing when latency is within budget", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 120, 40, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    expect(decisions).toHaveLength(0);
    expect(capture.filter((c) => c.sql.includes("INSERT INTO"))).toHaveLength(0);
  });
});
