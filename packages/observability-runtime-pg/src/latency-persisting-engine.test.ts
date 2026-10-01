import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { describe, expect, it, vi } from "vitest";
import { CountingIncidentDeclarer } from "@crossengin/incident-response-runtime";
import { buildPersistentLatencySloEngine } from "./latency-persisting-engine.js";
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

const SURFACE = "GET /v1/catalog";
const TENANT = "00000000-0000-4000-8000-000000000001";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000009";
const BASE = new Date("2026-06-03T12:00:00.000Z");

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
  id: "catalog-latency",
  targets: [{ kind: "latency" as const, p95: "300ms", window: "30d" }],
};

const policy = {
  id: "default",
  routes: [
    { severity: "P1" as const, channels: [{ kind: "pagerduty_phone" as const, serviceKey: "svc" }] },
  ],
};

function build(
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  declarer?: CountingIncidentDeclarer,
) {
  const clock = new FixedClock(BASE);
  const persistent = buildPersistentLatencySloEngine(mockConnection(capture), {
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    registrations: [{ slo, tenantId: TENANT, rollback: { flagId: "ff_catalogv2", safeValueJson: "false" } }],
    clock,
    ...(declarer === undefined ? {} : { declarer }),
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
    expect(bound(actionInsert, "signal")).toBe("latency");
    expect(bound(actionInsert, "tenant_id")).toBe(TENANT);
    expect(bound(actionInsert, "close_out")).toBeNull();
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

  it("writes the declared incident under a database-allocated id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    if (decisions[0]?.kind !== "breach_opened") throw new Error("expected breach");

    expect(decisions[0].plan.incident.id).toBe("INC-2026-0031");
    const incidentInsert = capture.find((c) => c.sql.includes("INSERT INTO meta.incidents"));
    expect(incidentInsert?.params?.[0]).toBe("INC-2026-0031");
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "incident_id")).toBe("INC-2026-0031");
  });

  it("closes the stored incident out once latency recovers", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(600_000);
    recordLatencies(persistent, 120, 30, clock.nowMs());
    const recovered = await persistent.evaluate(clock.now());
    expect(recovered[0]?.kind).toBe("recovered");
    expect(capture.some((c) => c.sql.includes("SELECT") && c.sql.includes("meta.incidents"))).toBe(
      true,
    );
  });

  it("stores the recovery's close-out on the latency action row", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(600_000);
    recordLatencies(persistent, 120, 30, clock.nowMs());
    const recovered = await persistent.evaluate(clock.now());
    if (recovered[0]?.kind !== "recovered") throw new Error("expected recovery");

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "signal")).toBe("latency");
    expect(bound(actionInsert, "decision")).toBe("recovered");
    expect(bound(actionInsert, "close_out")).toBe(recovered[0].closeOut);
  });

  it("stores an unpersisted close-out when the declarer stored nothing", async () => {
    // Proves the stored value follows the declarer rather than being assumed from the recovery.
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const clock = new FixedClock(BASE);
    const { persistent } = build(capture, new CountingIncidentDeclarer({ clock }));
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    recordLatencies(persistent, 120, 30, BASE.getTime() + 600_000);
    const recovered = await persistent.evaluate(new Date(BASE.getTime() + 600_000));
    if (recovered[0]?.kind !== "recovered") throw new Error("expected recovery");
    expect(recovered[0].closeOut).toBe("unpersisted");

    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "close_out")).toBe("unpersisted");
  });

  it("records a recovery action but no latency snapshot", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(600_000);
    recordLatencies(persistent, 120, 30, clock.nowMs());
    await persistent.evaluate(clock.now());
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.slo_enforcement_actions"))).toBe(
      true,
    );
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.slo_latency_evaluations"))).toBe(
      false,
    );
  });

  it("names the opened incident on the recovery action too", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    const opened = await persistent.evaluate(BASE);
    const incidentId = opened[0]?.kind === "breach_opened" ? opened[0].plan.incident.id : null;
    capture.length = 0;

    clock.advance(600_000);
    recordLatencies(persistent, 120, 30, clock.nowMs());
    await persistent.evaluate(clock.now());
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "incident_id")).toBe(incidentId);
  });

  it("declares once, not again while latency is still breaching", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(60_000);
    recordLatencies(persistent, 700, 30, clock.nowMs());
    await persistent.evaluate(clock.now());
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.incidents"))).toBe(false);
  });

  it("keeps recordOutcome off the database", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    expect(capture).toHaveLength(0);
  });

  it("stamps the evaluation time on the action row", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "occurred_at")).toBe(BASE.toISOString());
  });

  it("writes the worst percentile onto the latency snapshot", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    const snapshot = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_latency_evaluations"),
    );
    expect(snapshot?.params).toContain("p95");
  });

  it("carries the breach severity onto the opening action", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    if (decisions[0]?.kind !== "breach_opened") throw new Error("expected breach");
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "severity")).toBe(decisions[0].severity);
  });

  it("leaves no close-out on an ongoing latency breach", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent, clock } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    await persistent.evaluate(BASE);
    capture.length = 0;

    clock.advance(60_000);
    recordLatencies(persistent, 700, 30, clock.nowMs());
    await persistent.evaluate(clock.now());
    const actionInsert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.slo_enforcement_actions"),
    );
    expect(bound(actionInsert, "decision")).toBe("breach_ongoing");
    expect(bound(actionInsert, "close_out")).toBeNull();
  });

  it("writes the kill switch it activated", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const { persistent } = build(capture);
    recordLatencies(persistent, 700, 30, BASE.getTime());
    const decisions = await persistent.evaluate(BASE);
    if (decisions[0]?.kind !== "breach_opened") throw new Error("expected breach");
    const insert = capture.find((c) =>
      c.sql.includes("INSERT INTO meta.feature_flag_kill_switches"),
    );
    expect(insert?.params).toContain(decisions[0].plan.killSwitch?.id);
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
