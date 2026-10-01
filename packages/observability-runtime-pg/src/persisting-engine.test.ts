import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildPersistentSloEnforcementEngine } from "./persisting-engine.js";
import { SLO_ENFORCEMENT_ACTION_COLUMNS } from "./enforcement-action-store.js";

/** Derived from the stored column order so a new column cannot shift a literal index out from under. */
function bound(
  capture: { params: readonly unknown[] | undefined } | undefined,
  column: string,
): unknown {
  if (capture === undefined) throw new Error("no statement recorded");
  const index = SLO_ENFORCEMENT_ACTION_COLUMNS.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return capture.params?.[index];
}

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
    expect(bound(actionInsert, "tenant_id")).toBe(TENANT);
  });

  it("writes no close-out on the opening action", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "decision")).toBe("breach_opened");
    expect(bound(actionInsert, "close_out")).toBeNull();
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

  it("stores the recovery's close-out on the action row", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(2 * 3_600_000);
    const recovered = await persistent.evaluate(clock.now());
    if (recovered[0]?.kind !== "recovered") throw new Error("expected recovery");

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "decision")).toBe("recovered");
    // The decision's close-out and the stored one are the same value by construction, so "was the
    // recovery clean?" is answerable from the action row and not only from meta.incidents.
    expect(bound(actionInsert, "close_out")).toBe(recovered[0].closeOut);
    expect(bound(actionInsert, "close_out")).toBe("failed");
  });

  it("records a recovery action but no evaluation snapshot", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(2 * 3_600_000);
    await persistent.evaluate(clock.now());
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.some((c) => c.sql.includes("slo_enforcement_actions"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("slo_evaluations"))).toBe(false);
  });

  it("names the opened incident on the recovery action too", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    burst(persistent, 25, BASE.getTime());
    const opened = await persistent.evaluate(BASE);
    const incidentId = opened[0]?.kind === "breach_opened" ? opened[0].plan.incident.id : null;
    capture.length = 0;

    clock.advance(2 * 3_600_000);
    await persistent.evaluate(clock.now());
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "incident_id")).toBe(incidentId);
  });

  it("keeps recordOutcome off the database", async () => {
    // The hot path is an in-memory window append; only evaluate() talks to the store.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    expect(capture).toHaveLength(0);
  });

  it("stamps the evaluation time on the action row", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "occurred_at")).toBe(BASE.toISOString());
  });

  it("records the threshold that fired", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "threshold_id")).toBe("fast-burn");
    expect(bound(actionInsert, "severity")).toBe("sev2");
  });

  it("writes the kill switch it activated, so a restart can learn which flag it rolled back", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    if (decisions[0]?.kind !== "breach_opened") throw new Error("expected breach");
    const switchId = decisions[0].plan.killSwitch?.id;
    expect(switchId).toBeDefined();
    const insert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.feature_flag_kill_switches"),
    );
    expect(insert?.params).toContain(switchId);
  });

  it("writes the kill switch before the action row that names it", async () => {
    // Otherwise a reader can see a kill_switch_id with no switch behind it.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    const switchAt = capture.findIndex((c) => c.sql.includes("feature_flag_kill_switches"));
    const actionAt = capture.findIndex((c) => c.sql.includes("slo_enforcement_actions"));
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(switchAt).toBeLessThan(actionAt);
  });

  it("writes no kill switch for a registration with no rollback configured", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const clock = new FixedClock(BASE);
    const persistent = buildPersistentSloEnforcementEngine(mockConnection(capture), {
      alertPolicy: policy,
      systemActorUserId: SYSTEM_ACTOR,
      registrations: [{ slo, category: "availability", tenantId: TENANT }],
      clock,
    });
    burst(persistent, 25, BASE.getTime());
    await persistent.evaluate(BASE);
    expect(capture.some((c) => c.sql.includes("feature_flag_kill_switches"))).toBe(false);
  });

  it("exposes the kill-switch store it writes through", () => {
    const { persistent } = build([]);
    expect(persistent.killSwitchStore).toBeDefined();
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
