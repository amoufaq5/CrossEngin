import { describe, expect, it, vi } from "vitest";
import { BackupRecordSchema, DEFAULT_DR_TIERS } from "@crossengin/dr";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import {
  DrReadinessScheduler,
  DrRuntime,
  type IntervalHandle,
  type IntervalScheduler,
} from "./engine.js";
import { assessDrReadiness, type DrReadinessReport } from "./readiness.js";

const TIER1 = DEFAULT_DR_TIERS.tier_1_business_critical;

function makeRuntime(): DrRuntime {
  return new DrRuntime({
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    ids: new CountingIdGenerator(),
  });
}

describe("DrRuntime", () => {
  it("exposes shared executors backed by the same clock/ids", () => {
    const runtime = makeRuntime();
    const failover = runtime.planFailover({
      tier: "tier_1_business_critical",
      trigger: "planned_drill",
      triggeredBy: "sre",
      fromRegion: "us-east",
      toRegion: "us-west",
      affectedApps: ["billing"],
    });
    const drill = runtime.planDrill({
      kind: "failover_test",
      tier: "tier_1_business_critical",
      scopeRegions: ["us-east"],
      scopeApps: ["billing"],
      spec: TIER1,
    });
    expect(failover.id).toBe("fov_00000001");
    expect(drill.id).toBe("drl_00000001");
    expect(failover.triggeredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("drives an end-to-end failover and computes its tier verdict", () => {
    const runtime = makeRuntime();
    let record = runtime.planFailover({
      tier: "tier_1_business_critical",
      trigger: "primary_outage",
      triggeredBy: "sre",
      fromRegion: "us-east",
      toRegion: "us-west",
      affectedApps: ["billing"],
      incidentTicketId: "INC-2026-0007",
    });
    record = runtime.startFailover(record);
    record = runtime.completeFailover(record, { actualRpoSeconds: 300, actualRtoSeconds: 300 });
    expect(record.status).toBe("succeeded");
    expect(runtime.failoverTierVerdict(record, TIER1).rpoBreached).toBe(true);
  });

  it("records and verdicts a drill", () => {
    const runtime = makeRuntime();
    const drill = runtime.recordDrillResult(
      runtime.planDrill({
        kind: "failover_test",
        tier: "tier_1_business_critical",
        scopeRegions: ["us-east"],
        scopeApps: ["billing"],
        spec: TIER1,
      }),
      { outcome: "passed", executedBy: "sre", measuredRpoSeconds: 40, measuredRtoSeconds: 400 },
    );
    expect(runtime.drillTierVerdict(drill, TIER1).passing).toBe(true);
  });

  it("assess defaults now to the runtime clock", () => {
    const runtime = makeRuntime();
    // Dated so the verdict separates the two clocks: this backup expires *after* the runtime's
    // fixed 2026-01-01 and *before* any wall clock a test run can see, so `expiredBackups: 0` is
    // reachable only if `now` came from the injected clock. `ready` stood in for this before and
    // could not test it — it read `true` for an empty estate whatever the date, which is the
    // defect `unevidencedAxes` closes, so the assertion was pinning that rather than the clock.
    const backup = BackupRecordSchema.parse({
      id: "bk-engine",
      policyId: "pol-1",
      kind: "full",
      startedAt: "2025-12-01T00:00:00.000Z",
      completedAt: "2025-12-01T00:10:00.000Z",
      status: "verified",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      storageRegion: "us-east",
      verifiedAt: "2025-12-01T01:00:00.000Z",
      verifiedBy: "sre",
      expiresAt: "2026-03-01T00:00:00.000Z",
    });
    const report = runtime.assess({ backups: [backup] });
    expect(report.counts.expiredBackups).toBe(0);
  });
});

class ManualScheduler implements IntervalScheduler {
  handler: (() => void) | null = null;
  ms = 0;
  cleared = false;
  setInterval(handler: () => void, ms: number): IntervalHandle {
    this.handler = handler;
    this.ms = ms;
    return { id: 1 };
  }
  clearInterval(_handle: IntervalHandle): void {
    this.cleared = true;
  }
  tick(): void {
    this.handler?.();
  }
}

describe("DrReadinessScheduler", () => {
  it("runs an immediate assessment on start and reports", async () => {
    const scheduler = new ManualScheduler();
    const reports: DrReadinessReport[] = [];
    const sched = new DrReadinessScheduler({
      assess: () => assessDrReadiness({ now: new Date("2026-06-01T00:00:00.000Z") }),
      intervalMs: 60_000,
      scheduler,
      onReport: (r) => reports.push(r),
    });
    sched.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.ms).toBe(60_000);
  });

  it("reports again on each tick and stops cleanly", async () => {
    const scheduler = new ManualScheduler();
    let count = 0;
    const sched = new DrReadinessScheduler({
      assess: () => {
        count += 1;
        return assessDrReadiness({ now: new Date("2026-06-01T00:00:00.000Z") });
      },
      intervalMs: 1000,
      scheduler,
    });
    sched.start();
    scheduler.tick();
    await Promise.resolve();
    expect(count).toBeGreaterThanOrEqual(2);
    sched.stop();
    expect(scheduler.cleared).toBe(true);
  });

  it("routes an assessment error to onError instead of throwing", async () => {
    const scheduler = new ManualScheduler();
    const onError = vi.fn();
    const sched = new DrReadinessScheduler({
      assess: () => {
        throw new Error("boom");
      },
      intervalMs: 1000,
      scheduler,
      onError,
    });
    sched.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
  });

  it("is idempotent on repeated start", () => {
    const scheduler = new ManualScheduler();
    const setSpy = vi.spyOn(scheduler, "setInterval");
    const sched = new DrReadinessScheduler({
      assess: () => assessDrReadiness({ now: new Date("2026-06-01T00:00:00.000Z") }),
      intervalMs: 1000,
      scheduler,
    });
    sched.start();
    sched.start();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
