import { describe, expect, it } from "vitest";
import {
  RUNBOOK_KINDS,
  RUNBOOK_STATUSES,
  RunbookSpecSchema,
  approvedRunbooksFor,
  runbookFreshness,
  staleRunbooks,
  type RunbookSpec,
} from "./runbooks.js";

describe("constants", () => {
  it("RUNBOOK_KINDS has 6 entries", () => {
    expect(RUNBOOK_KINDS).toContain("failover");
    expect(RUNBOOK_KINDS).toContain("regional_evacuation");
    expect(RUNBOOK_KINDS).toContain("key_rotation_emergency");
  });

  it("RUNBOOK_STATUSES has 4 entries", () => {
    expect(RUNBOOK_STATUSES).toEqual(["draft", "approved", "deprecated", "broken"]);
  });
});

describe("RunbookSpecSchema", () => {
  const base: RunbookSpec = {
    id: "RB-0001",
    kind: "failover",
    appliesToTiers: ["tier_1_business_critical"],
    title: "Failover from EU to US",
    version: "1.0.0",
    owner: "infra-team",
    storageUri: "https://runbooks.crossengin.io/RB-0001",
    estimatedExecutionMinutes: 30,
    requiresIncidentCommander: true,
    requiredApprovers: ["sre-oncall"],
    lastReviewedAt: "2026-05-01T00:00:00Z",
    lastTestedAt: "2026-04-01T00:00:00Z",
    lastTestedBy: "drill-runner",
    status: "approved",
  };

  it("accepts a valid approved runbook", () => {
    expect(() => RunbookSpecSchema.parse(base)).not.toThrow();
  });

  it("rejects malformed id", () => {
    expect(() => RunbookSpecSchema.parse({ ...base, id: "RB-1" })).toThrow();
  });

  it("rejects approved runbook without lastTestedAt", () => {
    expect(() =>
      RunbookSpecSchema.parse({ ...base, lastTestedAt: null, lastTestedBy: null }),
    ).toThrow(/lastTestedAt/);
  });

  it("rejects failover runbook without requiresIncidentCommander", () => {
    expect(() => RunbookSpecSchema.parse({ ...base, requiresIncidentCommander: false })).toThrow(
      /incident commander/,
    );
  });

  it("rejects regional_evacuation without incident commander", () => {
    expect(() =>
      RunbookSpecSchema.parse({
        ...base,
        kind: "regional_evacuation",
        requiresIncidentCommander: false,
      }),
    ).toThrow(/incident commander/);
  });

  it("rejects tier-0 runbook with fewer than 2 approvers (four-eyes)", () => {
    expect(() =>
      RunbookSpecSchema.parse({
        ...base,
        appliesToTiers: ["tier_0_mission_critical"],
        requiredApprovers: ["sre-oncall"],
      }),
    ).toThrow(/two required approvers/);
  });

  it("accepts a tier-0 runbook with 2+ approvers", () => {
    expect(() =>
      RunbookSpecSchema.parse({
        ...base,
        appliesToTiers: ["tier_0_mission_critical"],
        requiredApprovers: ["sre-oncall", "security-lead"],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate approvers", () => {
    expect(() =>
      RunbookSpecSchema.parse({
        ...base,
        requiredApprovers: ["sre-oncall", "sre-oncall"],
      }),
    ).toThrow(/duplicate approver/);
  });

  it("rejects an invalid semver version", () => {
    expect(() => RunbookSpecSchema.parse({ ...base, version: "1.0" })).toThrow();
  });
});

describe("runbookFreshness", () => {
  const base: RunbookSpec = {
    id: "RB-0001",
    kind: "failover",
    appliesToTiers: ["tier_1_business_critical"],
    title: "Failover from EU to US",
    version: "1.0.0",
    owner: "infra-team",
    storageUri: "https://runbooks.crossengin.io/RB-0001",
    estimatedExecutionMinutes: 30,
    requiresIncidentCommander: true,
    requiredApprovers: ["sre-oncall"],
    lastReviewedAt: "2026-05-01T00:00:00Z",
    lastTestedAt: "2026-04-01T00:00:00Z",
    lastTestedBy: "drill-runner",
    status: "approved",
  };

  it("returns daysSinceReview correctly", () => {
    const r = runbookFreshness(base, 365, 365, new Date("2026-06-01T00:00:00Z"));
    expect(r.daysSinceReview).toBe(31);
  });

  it("returns daysSinceTest correctly", () => {
    const r = runbookFreshness(base, 365, 365, new Date("2026-06-01T00:00:00Z"));
    expect(r.daysSinceTest).toBe(61);
  });

  it("flags stale when review is too old", () => {
    const r = runbookFreshness(base, 10, 365, new Date("2026-06-01T00:00:00Z"));
    expect(r.stale).toBe(true);
  });

  it("flags stale when test is too old", () => {
    const r = runbookFreshness(base, 365, 30, new Date("2026-06-01T00:00:00Z"));
    expect(r.stale).toBe(true);
  });

  it("flags stale when lastTestedAt is null", () => {
    const r = runbookFreshness(
      { ...base, lastTestedAt: null, lastTestedBy: null, status: "draft" },
      365,
      365,
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(r.stale).toBe(true);
    expect(r.daysSinceTest).toBeNull();
  });

  it("is not stale when within review and test windows", () => {
    const r = runbookFreshness(base, 365, 365, new Date("2026-05-15T00:00:00Z"));
    expect(r.stale).toBe(false);
  });
});

describe("staleRunbooks / approvedRunbooksFor", () => {
  const fresh: RunbookSpec = {
    id: "RB-0001",
    kind: "failover",
    appliesToTiers: ["tier_1_business_critical"],
    title: "x",
    version: "1.0.0",
    owner: "infra",
    storageUri: "https://x.io/1",
    estimatedExecutionMinutes: 30,
    requiresIncidentCommander: true,
    requiredApprovers: ["sre"],
    lastReviewedAt: "2026-05-01T00:00:00Z",
    lastTestedAt: "2026-04-01T00:00:00Z",
    lastTestedBy: "ci",
    status: "approved",
  };

  const stale: RunbookSpec = {
    ...fresh,
    id: "RB-0002",
    lastReviewedAt: "2024-01-01T00:00:00Z",
    lastTestedAt: "2024-01-01T00:00:00Z",
  };

  const draft: RunbookSpec = {
    ...fresh,
    id: "RB-0003",
    status: "draft",
    lastTestedAt: null,
    lastTestedBy: null,
  };

  it("staleRunbooks returns runbooks past their freshness window", () => {
    const result = staleRunbooks([fresh, stale, draft], 365, 365, new Date("2026-05-15T00:00:00Z"));
    expect(result.map((r) => r.id).sort()).toEqual(["RB-0002", "RB-0003"]);
  });

  it("approvedRunbooksFor filters by kind + status", () => {
    expect(approvedRunbooksFor([fresh, draft], "failover").map((r) => r.id)).toEqual(["RB-0001"]);
  });
});
