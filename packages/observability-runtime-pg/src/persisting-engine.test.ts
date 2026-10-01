import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildPersistentSloEnforcementEngine } from "./persisting-engine.js";

const SURFACE = "POST /v1/orders";
const TENANT = "00000000-0000-4000-8000-000000000001";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000009";
const BASE = new Date("2026-06-02T12:00:00.000Z");

/**
 * Records every statement. The allocation query answers with a high-water mark, so a declared
 * incident gets an id from "the database" rather than a counter, and `withAdvisoryLock` runs its
 * callback — the lock is what the real store holds across allocate-and-insert.
 */
function mockConnection(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  firstSequence = 31,
): PgConnection {
  const affected: PgQueryResult = { rows: [], rowCount: 1 };
  let next = firstSequence;
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      capture.push({ sql, params });
      if (sql.includes("MAX(sequence_number)")) {
        const row = { next: String(next) };
        next += 1;
        return { rows: [row], rowCount: 1 };
      }
      return affected;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as
      PgConnection["transaction"],
    withAdvisoryLock: vi.fn(async <T>(_key: bigint, fn: () => Promise<T>) => fn()) as
      PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
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

  it("writes the declared incident itself, under a database-allocated id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    if (decisions[0]?.kind !== "breach_opened") throw new Error("expected breach");

    expect(decisions[0].plan.incident.id).toBe("INC-2026-0031");
    const incidentInsert = capture.find((c) => c.sql.includes("INSERT INTO meta.incidents"));
    expect(incidentInsert?.params?.[0]).toBe("INC-2026-0031");
  });

  it("names the same incident in the record and in the enforcement action", async () => {
    // The gap ADR-0289 refused to close by persisting under a second id: a log line and a row
    // naming different incidents is worse than not persisting.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);

    const incidentInsert = capture.find((c) => c.sql.includes("INSERT INTO meta.incidents"));
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(actionInsert?.params).toContain(incidentInsert?.params?.[0]);
  });

  it("writes the incident before the action that refers to it", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    const incidentAt = capture.findIndex((c) => c.sql.includes("INSERT INTO meta.incidents"));
    const actionAt = capture.findIndex((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(incidentAt).toBeGreaterThanOrEqual(0);
    expect(incidentAt).toBeLessThan(actionAt);
  });

  it("declares once, not again while the breach is ongoing", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(60_000);
    burst(persistent, 25, clock.nowMs());
    await persistent.evaluate(clock.now());
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.incidents"))).toBe(false);
  });

  it("cancels the stored incident when the burn clears", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    const opened = await persistent.evaluate(BASE);
    const incidentId = opened[0]?.kind === "breach_opened" ? opened[0].plan.incident.id : null;
    capture.length = 0;

    clock.advance(2 * 3_600_000);
    const recovered = await persistent.evaluate(clock.now());
    if (recovered[0]?.kind !== "recovered") throw new Error("expected recovery");
    expect(recovered[0].incidentId).toBe(incidentId);
    // The fake answers every SELECT with no rows, so the load finds nothing and the close-out is
    // reported as failed rather than silently succeeding — the row stays open for a human.
    expect(recovered[0].closeOut).toBe("failed");
    expect(capture.some((c) => c.sql.includes("SELECT") && c.sql.includes("meta.incidents"))).toBe(
      true,
    );
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
