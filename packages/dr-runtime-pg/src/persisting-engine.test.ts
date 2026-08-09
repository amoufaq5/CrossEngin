import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS } from "@crossengin/dr";
import { CountingIdGenerator, FixedClock } from "@crossengin/dr-runtime";
import { buildPersistentDrRuntime } from "./persisting-engine.js";
import { mockConnection, type Captured } from "./test-fakes.js";

const BASE = new Date("2026-06-02T12:00:00.000Z");
const TENANT = "00000000-0000-4000-8000-000000000001";
const TIER = "tier_1_business_critical";

function build(capture: Captured[], tenantId: string | null = TENANT) {
  return buildPersistentDrRuntime(mockConnection(capture), {
    clock: new FixedClock(BASE),
    ids: new CountingIdGenerator(),
    tenantId,
  });
}

function inProgressFailover(rt: ReturnType<typeof build>) {
  const planned = rt.runtime.planFailover({
    tier: TIER,
    trigger: "planned_drill",
    triggeredBy: "operator-1",
    fromRegion: "eu-central",
    toRegion: "us-east",
    affectedApps: ["billing"],
  });
  return rt.runtime.startFailover(planned);
}

function plannedDrill(rt: ReturnType<typeof build>) {
  return rt.runtime.planDrill({
    kind: "restore_test",
    tier: TIER,
    scopeRegions: ["eu-central"],
    scopeApps: ["billing"],
    spec: DEFAULT_DR_TIERS[TIER],
  });
}

function inserts(capture: Captured[]): Captured[] {
  return capture.filter((c) => c.sql.includes("INSERT INTO"));
}

describe("buildPersistentDrRuntime.completeFailover", () => {
  it("persists a failover execution row on completion", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const started = inProgressFailover(rt);
    const done = await rt.completeFailover(started, {
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
    });
    expect(done.status).toBe("succeeded");
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_failover_executions"),
    );
    expect(row).toBeDefined();
    expect(row?.params?.[1]).toBe(TENANT);
    expect(row?.params?.[4]).toBe("succeeded");
  });

  it("computes the tier verdict and records a breach", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const started = inProgressFailover(rt);
    await rt.completeFailover(started, {
      actualRpoSeconds: 5000,
      actualRtoSeconds: 5000,
    });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_failover_executions"),
    );
    expect(row?.params?.[11]).toBe(true);
    expect(row?.params?.[12]).toBe(true);
  });

  it("records no breach when within the tier budget", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const started = inProgressFailover(rt);
    await rt.completeFailover(started, {
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
    });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_failover_executions"),
    );
    expect(row?.params?.[11]).toBe(false);
    expect(row?.params?.[12]).toBe(false);
  });
});

describe("buildPersistentDrRuntime.recordFailover", () => {
  it("persists an arbitrary failover record", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const started = inProgressFailover(rt);
    const aborted = rt.runtime.abortFailover(started);
    await rt.recordFailover(aborted);
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_failover_executions"),
    );
    expect(row?.params?.[4]).toBe("aborted");
  });

  it("honors a per-call tenant override", async () => {
    const capture: Captured[] = [];
    const rt = build(capture, TENANT);
    const started = inProgressFailover(rt);
    const done = rt.runtime.completeFailover(started, {
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
    });
    await rt.recordFailover(done, { tenantId: null });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_failover_executions"),
    );
    expect(row?.params?.[1]).toBeNull();
  });
});

describe("buildPersistentDrRuntime.recordDrillResult", () => {
  it("persists a drill execution row with a computed verdict", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const drill = plannedDrill(rt);
    const executed = await rt.recordDrillResult(drill, {
      outcome: "passed",
      executedBy: "operator-1",
      measuredRpoSeconds: 20,
      measuredRtoSeconds: 200,
    });
    expect(executed.outcome).toBe("passed");
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_drill_executions"),
    );
    expect(row).toBeDefined();
    expect(row?.params?.[1]).toBe(TENANT);
    expect(row?.params?.[4]).toBe("passed");
    expect(row?.params?.[5]).toBe(true);
  });

  it("flags a drill RPO breach in the persisted verdict", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const drill = plannedDrill(rt);
    await rt.recordDrillResult(drill, {
      outcome: "passed",
      executedBy: "operator-1",
      measuredRpoSeconds: 9000,
      measuredRtoSeconds: 9000,
    });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_drill_executions"),
    );
    expect(row?.params?.[6]).toBe(true);
  });
});

describe("buildPersistentDrRuntime.assess", () => {
  it("persists a readiness snapshot row", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const report = await rt.assess({});
    expect(report.ready).toBe(true);
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_readiness_snapshots"),
    );
    expect(row).toBeDefined();
    expect(row?.params?.[1]).toBe(TENANT);
    expect(row?.params?.[2]).toBe(true);
  });

  it("persists a not-ready snapshot with the breach count", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    const started = inProgressFailover(rt);
    const breached = rt.runtime.completeFailover(started, {
      actualRpoSeconds: 9000,
      actualRtoSeconds: 9000,
    });
    await rt.assess({ failovers: [breached] });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_readiness_snapshots"),
    );
    expect(row?.params?.[2]).toBe(false);
    expect(row?.params?.[9]).toBe(1);
  });

  it("honors an explicit snapshot id", async () => {
    const capture: Captured[] = [];
    const rt = build(capture);
    await rt.assess({}, { snapshotId: "drr_fixedaa" });
    const row = inserts(capture).find((c) =>
      c.sql.includes("dr_readiness_snapshots"),
    );
    expect(row?.params?.[0]).toBe("drr_fixedaa");
  });
});
