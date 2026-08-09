import { describe, expect, it } from "vitest";
import {
  BackupRecordSchema,
  DEFAULT_DR_TIERS,
  ReplicationLagRecordSchema,
  RunbookSpecSchema,
  type BackupRecord,
  type ReplicationLagRecord,
  type RunbookSpec,
} from "@crossengin/dr";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { DrillExecutor } from "./drills.js";
import { FailoverExecutor } from "./failover.js";
import { assessDrReadiness, formatDrReadiness } from "./readiness.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const TIER1 = DEFAULT_DR_TIERS.tier_1_business_critical;
const SHA = "a".repeat(64);

function clockedFailover(): FailoverExecutor {
  return new FailoverExecutor({
    clock: new FixedClock(NOW),
    ids: new CountingIdGenerator(),
  });
}
function clockedDrill(): DrillExecutor {
  return new DrillExecutor({ clock: new FixedClock(NOW), ids: new CountingIdGenerator() });
}

const FRESH_RUNBOOK: RunbookSpec = RunbookSpecSchema.parse({
  id: "RB-0001",
  kind: "restore_from_backup",
  appliesToTiers: ["tier_2_important"],
  title: "Restore from backup",
  version: "1.0.0",
  owner: "sre",
  storageUri: "https://runbooks.example.com/rb-0001",
  estimatedExecutionMinutes: 30,
  lastReviewedAt: "2026-05-20T00:00:00.000Z",
  lastTestedAt: "2026-05-20T00:00:00.000Z",
  lastTestedBy: "sre-lead",
  status: "approved",
});

const STALE_RUNBOOK: RunbookSpec = RunbookSpecSchema.parse({
  id: "RB-0002",
  kind: "partial_outage",
  appliesToTiers: ["tier_2_important"],
  title: "Partial outage",
  version: "1.0.0",
  owner: "sre",
  storageUri: "https://runbooks.example.com/rb-0002",
  estimatedExecutionMinutes: 15,
  lastReviewedAt: "2020-01-01T00:00:00.000Z",
  status: "draft",
});

const VERIFIED_BACKUP: BackupRecord = BackupRecordSchema.parse({
  id: "bk-verified",
  policyId: "pol-1",
  kind: "full",
  startedAt: "2026-05-31T00:00:00.000Z",
  completedAt: "2026-05-31T00:10:00.000Z",
  status: "verified",
  sizeBytes: 1024,
  sha256: SHA,
  storageRegion: "us-east",
  verifiedAt: "2026-05-31T01:00:00.000Z",
  verifiedBy: "sre",
  expiresAt: "2027-05-31T00:00:00.000Z",
});

const EXPIRED_BACKUP: BackupRecord = BackupRecordSchema.parse({
  id: "bk-expired",
  policyId: "pol-1",
  kind: "full",
  startedAt: "2025-01-01T00:00:00.000Z",
  completedAt: "2025-01-01T00:10:00.000Z",
  status: "verified",
  sizeBytes: 1024,
  sha256: SHA,
  storageRegion: "us-east",
  verifiedAt: "2025-01-01T01:00:00.000Z",
  verifiedBy: "sre",
  expiresAt: "2025-06-01T00:00:00.000Z",
});

const UNVERIFIED_BACKUP: BackupRecord = BackupRecordSchema.parse({
  id: "bk-succeeded",
  policyId: "pol-1",
  kind: "incremental",
  startedAt: "2026-05-31T00:00:00.000Z",
  completedAt: "2026-05-31T00:05:00.000Z",
  status: "succeeded",
  sizeBytes: 512,
  sha256: SHA,
  storageRegion: "us-east",
  expiresAt: "2027-05-31T00:00:00.000Z",
});

const HEALTHY_LAG: ReplicationLagRecord = ReplicationLagRecordSchema.parse({
  source: "us-east",
  target: "us-west",
  measuredAt: "2026-06-01T00:00:00.000Z",
  lagBytes: 100,
  lagSeconds: 10,
  status: "healthy",
});

const OVER_BUDGET_LAG: ReplicationLagRecord = ReplicationLagRecordSchema.parse({
  source: "us-east",
  target: "eu-west",
  measuredAt: "2026-06-01T00:00:00.000Z",
  lagBytes: 100_000,
  lagSeconds: 120,
  status: "lagging",
});

function overdueDrillFixture() {
  const exec = clockedDrill();
  return exec.recordDrillResult(
    exec.planDrill({
      kind: "failover_test",
      tier: "tier_1_business_critical",
      scopeRegions: ["us-east"],
      scopeApps: ["billing"],
      scheduledFor: "2026-01-01T00:00:00.000Z",
      nextDrillDueAt: "2026-03-01T00:00:00.000Z",
    }),
    { outcome: "passed", executedBy: "sre", measuredRpoSeconds: 40, measuredRtoSeconds: 400 },
  );
}

function healthyDrillFixture() {
  const exec = clockedDrill();
  return exec.recordDrillResult(
    exec.planDrill({
      kind: "failover_test",
      tier: "tier_1_business_critical",
      scopeRegions: ["us-east"],
      scopeApps: ["billing"],
      nextDrillDueAt: "2026-12-01T00:00:00.000Z",
    }),
    { outcome: "passed", executedBy: "sre", measuredRpoSeconds: 40, measuredRtoSeconds: 400 },
  );
}

describe("assessDrReadiness", () => {
  it("reports ready with an all-green estate", () => {
    const report = assessDrReadiness({
      now: NOW,
      drills: [healthyDrillFixture()],
      runbooks: [FRESH_RUNBOOK],
      backups: [VERIFIED_BACKUP],
      replication: [{ record: HEALTHY_LAG, tier: "tier_1_business_critical" }],
      failovers: [],
    });
    expect(report.ready).toBe(true);
    expect(report.counts.totalIssues).toBe(0);
  });

  it("flags overdue drills", () => {
    const report = assessDrReadiness({ now: NOW, drills: [overdueDrillFixture()] });
    expect(report.ready).toBe(false);
    expect(report.overdueDrillIds).toHaveLength(1);
    expect(report.counts.overdueDrills).toBe(1);
  });

  it("flags stale runbooks", () => {
    const report = assessDrReadiness({ now: NOW, runbooks: [STALE_RUNBOOK, FRESH_RUNBOOK] });
    expect(report.staleRunbookIds).toEqual(["RB-0002"]);
    expect(report.ready).toBe(false);
  });

  it("flags expired backups", () => {
    const report = assessDrReadiness({ now: NOW, backups: [EXPIRED_BACKUP, VERIFIED_BACKUP] });
    expect(report.expiredBackupIds).toEqual(["bk-expired"]);
  });

  it("flags unverified succeeded backups", () => {
    const report = assessDrReadiness({ now: NOW, backups: [UNVERIFIED_BACKUP] });
    expect(report.unverifiedBackupIds).toEqual(["bk-succeeded"]);
    expect(report.ready).toBe(false);
  });

  it("flags replication tier violations", () => {
    const report = assessDrReadiness({
      now: NOW,
      replication: [
        { record: HEALTHY_LAG, tier: "tier_1_business_critical" },
        { record: OVER_BUDGET_LAG, tier: "tier_1_business_critical" },
      ],
    });
    expect(report.replicationViolations).toEqual(["us-east->eu-west"]);
  });

  it("flags a failover RPO breach", () => {
    const exec = clockedFailover();
    const record = exec.completeFailover(
      exec.startFailover(
        exec.planFailover({
          tier: "tier_1_business_critical",
          trigger: "planned_drill",
          triggeredBy: "sre",
          fromRegion: "us-east",
          toRegion: "us-west",
          affectedApps: ["billing"],
        }),
      ),
      { actualRpoSeconds: 300, actualRtoSeconds: 300 },
    );
    const report = assessDrReadiness({ now: NOW, failovers: [record] });
    expect(report.failoverBreaches).toHaveLength(1);
    expect(report.failoverBreaches[0]?.rpoBreached).toBe(true);
  });

  it("flags a drill RPO breach", () => {
    const exec = clockedDrill();
    const record = exec.recordDrillResult(
      exec.planDrill({
        kind: "failover_test",
        tier: "tier_1_business_critical",
        scopeRegions: ["us-east"],
        scopeApps: ["billing"],
        nextDrillDueAt: "2026-12-01T00:00:00.000Z",
      }),
      { outcome: "passed", executedBy: "sre", measuredRpoSeconds: 900, measuredRtoSeconds: 400 },
    );
    const report = assessDrReadiness({ now: NOW, drills: [record] });
    expect(report.drillBreaches).toHaveLength(1);
    expect(report.drillBreaches[0]?.rpoBreached).toBe(true);
  });

  it("uses a custom tier-spec table when provided", () => {
    const strict = {
      ...DEFAULT_DR_TIERS,
      tier_1_business_critical: { ...TIER1, maxRpoSeconds: 5 },
    };
    const report = assessDrReadiness({
      now: NOW,
      replication: [{ record: HEALTHY_LAG, tier: "tier_1_business_critical" }],
      tierSpecs: strict,
    });
    expect(report.replicationViolations).toEqual(["us-east->us-west"]);
  });

  it("treats an empty estate as ready", () => {
    const report = assessDrReadiness({ now: NOW });
    expect(report.ready).toBe(true);
  });
});

describe("formatDrReadiness", () => {
  it("summarizes a ready report", () => {
    const text = formatDrReadiness(assessDrReadiness({ now: NOW }));
    expect(text).toContain("READY");
    expect(text).toContain("overdue drills:");
  });

  it("summarizes a not-ready report", () => {
    const text = formatDrReadiness(
      assessDrReadiness({ now: NOW, drills: [overdueDrillFixture()] }),
    );
    expect(text).toContain("NOT READY");
  });
});
