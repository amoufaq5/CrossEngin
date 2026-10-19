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
import {
  assessDrReadiness,
  formatDrReadiness,
  formatUnevidencedAxes,
  DR_AXIS_EMPTY_MEANS,
  DR_EVIDENCE_AXES,
  DrEvidenceAxisSchema,
  DrReadinessReportSchema,
  type DrReadinessInput,
} from "./readiness.js";

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

/**
 * An estate that carried a record on every evidence axis, and **no failover at all**.
 *
 * The empty `failovers` is the point rather than an omission: it is the claim that nothing failed
 * over, which is the healthy case, so this fixture is what proves the asymmetry in
 * `DR_AXIS_EMPTY_MEANS` is the right way round. If `failovers` were treated as an evidence axis,
 * every green estate would report a finding here.
 */
function fullyEvidenced(): DrReadinessInput {
  return {
    now: NOW,
    drills: [healthyDrillFixture()],
    runbooks: [FRESH_RUNBOOK],
    backups: [VERIFIED_BACKUP],
    replication: [{ record: HEALTHY_LAG, tier: "tier_1_business_critical" }],
    failovers: [],
  };
}

describe("assessDrReadiness", () => {
  it("reports ready with an all-green estate", () => {
    const report = assessDrReadiness(fullyEvidenced());
    expect(report.ready).toBe(true);
    expect(report.counts.totalIssues).toBe(0);
    expect(report.unevidencedAxes).toEqual([]);
  });

  it("an empty failover list is the claim that nothing failed over, not an absence of evidence", () => {
    // The asymmetry read backwards would make every healthy estate report a finding, so it is
    // pinned from the map as well as from the report: `failovers` is the only `nothing_happened`.
    expect(DR_AXIS_EMPTY_MEANS.failovers).toBe("nothing_happened");
    expect(DR_EVIDENCE_AXES).not.toContain("failovers");
    expect(assessDrReadiness({ ...fullyEvidenced(), failovers: [] }).unevidencedAxes).toEqual([]);
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

  it("is NOT ready on an empty estate, and names every axis that carried no record", () => {
    // The defect this closes, measured on the committed tree: `assessDrReadiness({now})` answered
    // `ready: true, totalIssues: 0`, and `evidenceFromDrReadiness` turned that into
    // `satisfied: true` with the summary "DR readiness: READY (0 issues)" — so a deployment that
    // has recorded no backup, no drill and no runbook was certified DR-ready in a SOC 2 evidence
    // pack. The cause is structural: every count is derived by *filtering* a supplied list, so an
    // empty list contributes zero issues on every axis. Measured, this was every deployment and
    // not a misconfiguration: of the four evidence axes only `drills` has a durable source, while
    // `runbooks`, `backups` and `replication` are `--dr-readiness-config` fields that default to
    // `[]`, and `meta.backup_records` has no store, no reader and no writer anywhere.
    const report = assessDrReadiness({ now: NOW });
    expect(report.ready).toBe(false);
    expect(report.unevidencedAxes).toEqual(["drills", "runbooks", "backups", "replication"]);
  });

  it("leaves totalIssues at 0 on that empty estate, because an absence is not an issue", () => {
    // A5, and load-bearing rather than tidy: `meta.dr_readiness_snapshots` projects the seven
    // counts as their own INTEGER columns and a reader sums them, so folding an absence into the
    // total would make the stored figure disagree with the columns beside it. `ready = false` with
    // `totalIssues = 0` is exactly "nothing wrong was found because nothing was looked at".
    const report = assessDrReadiness({ now: NOW });
    expect(report.counts.totalIssues).toBe(0);
    expect(report.ready).toBe(false);
  });

  it("narrows unevidencedAxes to the axes still missing when some are supplied", () => {
    const report = assessDrReadiness({
      now: NOW,
      drills: [overdueDrillFixture()],
      backups: [VERIFIED_BACKUP],
    });
    expect(report.unevidencedAxes).toEqual(["runbooks", "replication"]);
    // A real issue and an unevidenced axis are independent facts and both survive.
    expect(report.counts.overdueDrills).toBe(1);
  });
});

describe("the evidence-axis map", () => {
  it("is total over the five list inputs, with exactly one nothing_happened", () => {
    expect(Object.keys(DR_AXIS_EMPTY_MEANS).sort()).toEqual([
      "backups",
      "drills",
      "failovers",
      "replication",
      "runbooks",
    ]);
    const nothingHappened = Object.entries(DR_AXIS_EMPTY_MEANS)
      .filter(([, meaning]) => meaning === "nothing_happened")
      .map(([axis]) => axis);
    expect(nothingHappened).toEqual(["failovers"]);
  });

  it("lists exactly the unevidenced axes, recomputed from the map and not from the list", () => {
    // `satisfies readonly DrEvidenceAxis[]` is the compile-time half and refuses a member the map
    // calls `nothing_happened`. This is the other half: an `unevidenced` axis *missing* from the
    // tuple, which no type can catch, so the expectation is derived from the map here.
    const expected = Object.entries(DR_AXIS_EMPTY_MEANS)
      .filter(([, meaning]) => meaning === "unevidenced")
      .map(([axis]) => axis);
    expect([...DR_EVIDENCE_AXES].sort()).toEqual([...expected].sort());
    for (const axis of DR_EVIDENCE_AXES) expect(DR_AXIS_EMPTY_MEANS[axis]).toBe("unevidenced");
  });

  it("is what the schema enumerates, so the two cannot drift", () => {
    expect(DR_EVIDENCE_AXES.length).toBeGreaterThan(0);
    expect([...DrEvidenceAxisSchema.options]).toEqual([...DR_EVIDENCE_AXES]);
  });

  it("refuses failovers and an unknown axis as an evidence axis", () => {
    expect(DrEvidenceAxisSchema.safeParse("backups").success).toBe(true);
    expect(DrEvidenceAxisSchema.safeParse("failovers").success).toBe(false);
    expect(DrEvidenceAxisSchema.safeParse("restores").success).toBe(false);
  });
});

describe("unevidencedAxes keeps absent apart from empty", () => {
  it("parses a report stored before this check as null, never as []", () => {
    // A stored `report` JSONB written before this increment carries no such key. A `[]` default
    // would retro-assert "every axis carried a record" over every such row, which is the
    // falsely-true direction; `null` asserts nothing. Measured: a bare `.nullable()` refuses the
    // row `invalid_type: Required` instead, and the only reader propagates the throw.
    const stored = { ...assessDrReadiness(fullyEvidenced()) };
    const withoutKey: Record<string, unknown> = { ...stored };
    delete withoutKey["unevidencedAxes"];
    const parsed = DrReadinessReportSchema.parse(withoutKey);
    expect(parsed.unevidencedAxes).toBeNull();
    expect(parsed.unevidencedAxes).not.toEqual([]);
  });

  it("preserves an explicit [] as the claim it is", () => {
    const parsed = DrReadinessReportSchema.parse({
      ...assessDrReadiness(fullyEvidenced()),
      unevidencedAxes: [],
    });
    expect(parsed.unevidencedAxes).toEqual([]);
  });

  it("refuses a stored axis this binary does not recognise rather than coercing it", () => {
    // ADR-0371's rule: coercing an unknown value would read a *newer* claim as the gap that means
    // "predates the column", laundering an unknown claim into a known one.
    expect(
      DrReadinessReportSchema.safeParse({
        ...assessDrReadiness(fullyEvidenced()),
        unevidencedAxes: ["restores"],
      }).success,
    ).toBe(false);
  });
});

describe("formatDrReadiness", () => {
  it("summarizes a genuinely ready report", () => {
    // The fixture is `fullyEvidenced()` and not `{now}`, because the old test here read
    // `toContain("READY")` over an empty estate — and "NOT READY" contains "READY", so it would
    // have gone on passing against the inverted verdict. `not.toContain("NOT READY")` is what
    // makes the assertion about the verdict rather than about a substring.
    const text = formatDrReadiness(assessDrReadiness(fullyEvidenced()));
    expect(text).toContain("DR readiness: READY (0 issue(s))");
    expect(text).not.toContain("NOT READY");
    expect(text).toContain("overdue drills:");
  });

  it("summarizes a not-ready report", () => {
    const text = formatDrReadiness(
      assessDrReadiness({ ...fullyEvidenced(), drills: [overdueDrillFixture()] }),
    );
    expect(text).toContain("NOT READY");
  });

  it("names the unevidenced count on the headline and the axes below it", () => {
    const text = formatDrReadiness(assessDrReadiness({ now: NOW }));
    expect(text).toContain("DR readiness: NOT READY (0 issue(s), 4 axis(es) unevidenced)");
    expect(text).toContain("unevidenced axes:       drills, runbooks, backups, replication");
  });
});

describe("formatUnevidencedAxes", () => {
  it("does not print null as none, which would restate the defect in the reporting line", () => {
    expect(formatUnevidencedAxes(null)).toContain("predates the check");
    expect(formatUnevidencedAxes(null)).not.toContain("none");
  });

  it("distinguishes the empty claim from a non-empty list", () => {
    expect(formatUnevidencedAxes([])).toContain("none");
    expect(formatUnevidencedAxes(["backups", "drills"])).toBe("backups, drills");
  });

  it("renders all three states differently", () => {
    const rendered = [
      formatUnevidencedAxes(null),
      formatUnevidencedAxes([]),
      formatUnevidencedAxes(["backups"]),
    ];
    expect(new Set(rendered).size).toBe(3);
  });
});
