import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildPersistentSloEnforcementEngine } from "./persisting-engine.js";

const SURFACE = "POST /v1/orders";
const TENANT = "00000000-0000-4000-8000-000000000001";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000009";
const BASE = new Date("2026-06-02T12:00:00.000Z");

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
  id: "orders-availability",
  targets: [{ kind: "availability" as const, target: 0.99, window: "30d" }],
};

const policy = {
  id: "default",
  routes: [
    { severity: "P1" as const, channels: [{ kind: "pagerduty_phone" as const, serviceKey: "svc" }] },
  ],
};

function build(capture: Array<{ sql: string; params: readonly unknown[] | undefined }>) {
  const clock = new FixedClock(BASE);
  const persistent = buildPersistentSloEnforcementEngine(mockConnection(capture), {
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations: [
      {
        slo,
        category: "availability",
        tenantId: TENANT,
        rollback: { flagId: "ff_checkout01", safeValueJson: "false" },
      },
    ],
    clock,
  });
  return { persistent, clock };
}

function burst(
  persistent: ReturnType<typeof build>["persistent"],
  count: number,
  atMs: number,
): void {
  for (let i = 0; i < count; i += 1) {
    persistent.recordOutcome({
      surface: SURFACE,
      outcome: "error",
      at: new Date(atMs - i * 1_000).toISOString(),
      statusCode: 503,
    });
  }
}

describe("buildPersistentSloEnforcementEngine", () => {
  it("persists an enforcement action + evaluation snapshot on a breach", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());

    const decisions = await persistent.evaluate(BASE);
    expect(decisions[0]?.kind).toBe("breach_opened");

    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("slo_evaluations"))).toBe(true);
  });

  it("threads the registration tenant id into the persisted action", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(actionInsert?.params?.[1]).toBe(TENANT);
  });

  it("records an enforcement action but no evaluation snapshot while ongoing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);

    capture.length = 0;
    clock.advance(60_000);
    burst(persistent, 25, clock.nowMs());
    const decisions = await persistent.evaluate(clock.now());
    expect(decisions[0]?.kind).toBe("breach_ongoing");

    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("slo_evaluations"))).toBe(false);
  });

  it("persists nothing when traffic is healthy", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    for (let i = 0; i < 50; i += 1) {
      persistent.recordOutcome({
        surface: SURFACE,
        outcome: "ok",
        at: new Date(BASE.getTime() - i * 1_000).toISOString(),
      });
    }
    const decisions = await persistent.evaluate(BASE);
    expect(decisions).toHaveLength(0);
    expect(capture.filter((c) => c.sql.includes("INSERT INTO"))).toHaveLength(0);
  });
});
