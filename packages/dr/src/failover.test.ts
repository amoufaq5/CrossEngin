import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS } from "./tiers.js";
import {
  FAILOVER_STATUSES,
  FAILOVER_TRIGGERS,
  FailoverRecordSchema,
  canTransitionFailover,
  exceededRpo,
  exceededRto,
  lastFailover,
  type FailoverRecord,
} from "./failover.js";

describe("constants", () => {
  it("FAILOVER_TRIGGERS has 5 entries", () => {
    expect(FAILOVER_TRIGGERS).toContain("planned_drill");
    expect(FAILOVER_TRIGGERS).toContain("regional_failure");
  });

  it("FAILOVER_STATUSES has 6 entries", () => {
    expect(FAILOVER_STATUSES).toContain("succeeded");
    expect(FAILOVER_STATUSES).toContain("reverted");
  });
});

describe("canTransitionFailover", () => {
  it("queued -> in_progress is valid", () => {
    expect(canTransitionFailover("queued", "in_progress")).toBe(true);
  });

  it("in_progress -> succeeded is valid", () => {
    expect(canTransitionFailover("in_progress", "succeeded")).toBe(true);
  });

  it("succeeded -> reverted is valid", () => {
    expect(canTransitionFailover("succeeded", "reverted")).toBe(true);
  });

  it("failed is terminal", () => {
    expect(canTransitionFailover("failed", "in_progress")).toBe(false);
  });

  it("reverted is terminal", () => {
    expect(canTransitionFailover("reverted", "in_progress")).toBe(false);
  });
});

describe("FailoverRecordSchema", () => {
  const base: FailoverRecord = {
    id: "fo-1",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "drill-runner",
    triggeredAt: "2026-05-14T10:00:00Z",
    fromRegion: "eu-central",
    toRegion: "eu-west",
    affectedApps: ["web"],
    status: "succeeded",
    startedAt: "2026-05-14T10:00:30Z",
    completedAt: "2026-05-14T10:05:00Z",
    durationSeconds: 270,
    actualRpoSeconds: 30,
    actualRtoSeconds: 270,
    revertedAt: null,
    revertedToFailoverId: null,
  };

  it("accepts a valid succeeded failover", () => {
    expect(() => FailoverRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects same fromRegion and toRegion", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, toRegion: "eu-central" })).toThrow(
      /must differ/,
    );
  });

  it("rejects succeeded without completedAt", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, completedAt: null })).toThrow(/completedAt/);
  });

  it("rejects succeeded without actualRpoSeconds", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, actualRpoSeconds: null })).toThrow(
      /actualRpoSeconds/,
    );
  });

  it("rejects succeeded without actualRtoSeconds", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, actualRtoSeconds: null })).toThrow(
      /actualRtoSeconds/,
    );
  });

  it("rejects primary_outage without incidentTicketId", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, trigger: "primary_outage" })).toThrow(
      /incidentTicketId/,
    );
  });

  it("rejects regional_failure without incidentTicketId", () => {
    expect(() => FailoverRecordSchema.parse({ ...base, trigger: "regional_failure" })).toThrow(
      /incidentTicketId/,
    );
  });

  it("rejects reverted without revertedAt", () => {
    expect(() =>
      FailoverRecordSchema.parse({
        ...base,
        status: "reverted",
        revertedToFailoverId: "fo-0",
      }),
    ).toThrow(/revertedAt/);
  });

  it("rejects reverted without revertedToFailoverId", () => {
    expect(() =>
      FailoverRecordSchema.parse({
        ...base,
        status: "reverted",
        revertedAt: "2026-05-14T11:00:00Z",
      }),
    ).toThrow(/revertedToFailoverId/);
  });
});

describe("helpers", () => {
  const base: FailoverRecord = {
    id: "fo-1",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "drill-runner",
    triggeredAt: "2026-05-14T10:00:00Z",
    fromRegion: "eu-central",
    toRegion: "eu-west",
    affectedApps: ["web"],
    status: "succeeded",
    startedAt: "2026-05-14T10:00:30Z",
    completedAt: "2026-05-14T10:05:00Z",
    durationSeconds: 270,
    actualRpoSeconds: 30,
    actualRtoSeconds: 270,
    revertedAt: null,
    revertedToFailoverId: null,
  };

  it("exceededRpo returns true when actualRpoSeconds > spec.maxRpoSeconds", () => {
    expect(
      exceededRpo({ ...base, actualRpoSeconds: 120 }, DEFAULT_DR_TIERS.tier_1_business_critical),
    ).toBe(true);
  });

  it("exceededRpo returns false within target", () => {
    expect(exceededRpo(base, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(false);
  });

  it("exceededRto returns true when actualRtoSeconds > spec.maxRtoSeconds", () => {
    expect(
      exceededRto({ ...base, actualRtoSeconds: 1800 }, DEFAULT_DR_TIERS.tier_1_business_critical),
    ).toBe(true);
  });

  it("exceededRto returns false within target", () => {
    expect(exceededRto(base, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(false);
  });

  it("lastFailover returns the most recent record", () => {
    const records: FailoverRecord[] = [
      base,
      { ...base, id: "fo-2", triggeredAt: "2026-06-14T10:00:00Z" },
    ];
    expect(lastFailover(records)?.id).toBe("fo-2");
  });

  it("lastFailover filters by fromRegion", () => {
    const records: FailoverRecord[] = [
      base,
      {
        ...base,
        id: "fo-2",
        triggeredAt: "2026-06-14T10:00:00Z",
        fromRegion: "us-east",
        toRegion: "us-west",
      },
    ];
    expect(lastFailover(records, "eu-central")?.id).toBe("fo-1");
  });

  it("lastFailover returns null for empty input", () => {
    expect(lastFailover([])).toBeNull();
  });
});
