import { describe, expect, it } from "vitest";
import {
  HEALING_STRATEGIES,
  PartitionGroupSchema,
  SPLIT_BRAIN_KINDS,
  SPLIT_BRAIN_STATUSES,
  SplitBrainEventSchema,
  affectedRegions,
  canTransitionSplitBrain,
  isActive,
  meanTimeToHealSeconds,
  minorityGroups,
  quorumGroup,
  type SplitBrainEvent,
} from "./split-brain.js";

describe("constants", () => {
  it("SPLIT_BRAIN_KINDS has 5 entries", () => {
    expect(SPLIT_BRAIN_KINDS).toContain("network_partition");
    expect(SPLIT_BRAIN_KINDS).toContain("clock_skew");
    expect(SPLIT_BRAIN_KINDS).toContain("replication_lag_critical");
  });

  it("SPLIT_BRAIN_STATUSES has 5 entries", () => {
    expect(SPLIT_BRAIN_STATUSES).toContain("isolating");
    expect(SPLIT_BRAIN_STATUSES).toContain("permanent_partition");
  });

  it("HEALING_STRATEGIES has 5 entries", () => {
    expect(HEALING_STRATEGIES).toContain("auto_merge_concurrent");
    expect(HEALING_STRATEGIES).toContain("freeze_and_audit");
  });
});

describe("canTransitionSplitBrain", () => {
  it("detected -> isolating", () => {
    expect(canTransitionSplitBrain("detected", "isolating")).toBe(true);
  });

  it("healing -> healed", () => {
    expect(canTransitionSplitBrain("healing", "healed")).toBe(true);
  });

  it("healed is terminal", () => {
    expect(canTransitionSplitBrain("healed", "detected")).toBe(false);
  });

  it("permanent_partition -> healing (recovery)", () => {
    expect(canTransitionSplitBrain("permanent_partition", "healing")).toBe(true);
  });
});

describe("PartitionGroupSchema", () => {
  it("rejects duplicate regions in group", () => {
    expect(() =>
      PartitionGroupSchema.parse({
        groupId: "g1",
        regions: ["eu-central", "eu-central"],
        hadQuorum: true,
        acceptedWritesDuringPartition: false,
        writeCountDuringPartition: 0,
      }),
    ).toThrow(/duplicate region/);
  });

  it("rejects acceptedWritesDuringPartition=false with writeCount>0", () => {
    expect(() =>
      PartitionGroupSchema.parse({
        groupId: "g1",
        regions: ["eu-central"],
        hadQuorum: false,
        acceptedWritesDuringPartition: false,
        writeCountDuringPartition: 5,
      }),
    ).toThrow(/writeCountDuringPartition=0/);
  });
});

describe("SplitBrainEventSchema", () => {
  const base: SplitBrainEvent = {
    id: "SB-2026-0001",
    kind: "network_partition",
    status: "healed",
    detectedAt: "2026-05-15T10:00:00Z",
    detectedBy: "health-monitor",
    detectorEvidence: "Cross-region heartbeat timeout > 30s for 5 minutes",
    partitionGroups: [
      {
        groupId: "majority",
        regions: ["eu-central", "us-east"],
        hadQuorum: true,
        acceptedWritesDuringPartition: true,
        writeCountDuringPartition: 100,
      },
      {
        groupId: "minority",
        regions: ["apac-sg"],
        hadQuorum: false,
        acceptedWritesDuringPartition: true,
        writeCountDuringPartition: 5,
      },
    ],
    isolatedAt: "2026-05-15T10:01:00Z",
    healingStartedAt: "2026-05-15T10:10:00Z",
    healedAt: "2026-05-15T10:30:00Z",
    healingStrategy: "auto_merge_concurrent",
    conflictRecordIds: ["CFL-2026-0001"],
    permanentPartitionAt: null,
    requiresIncidentResponse: true,
    incidentRecordId: "INC-2026-0042",
    durationSeconds: 1800,
  };

  it("accepts a valid healed event", () => {
    expect(() => SplitBrainEventSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate group ids", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        partitionGroups: [base.partitionGroups[0]!, base.partitionGroups[0]!],
      }),
    ).toThrow(/duplicate group id/);
  });

  it("rejects region in multiple partition groups", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        partitionGroups: [
          base.partitionGroups[0]!,
          { ...base.partitionGroups[1]!, regions: ["us-east"] },
        ],
      }),
    ).toThrow(/multiple partition groups/);
  });

  it("rejects more than one quorum group", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        partitionGroups: [
          base.partitionGroups[0]!,
          { ...base.partitionGroups[1]!, hadQuorum: true },
        ],
      }),
    ).toThrow(/at most one partition group can claim quorum/);
  });

  it("rejects healed without healedAt", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        healedAt: null,
      }),
    ).toThrow(/healedAt/);
  });

  it("rejects healed without durationSeconds", () => {
    expect(() =>
      SplitBrainEventSchema.parse({ ...base, durationSeconds: null }),
    ).toThrow(/durationSeconds/);
  });

  it("rejects permanent_partition without reason", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        status: "permanent_partition",
        permanentPartitionAt: "2026-05-15T11:00:00Z",
        healedAt: null,
        durationSeconds: null,
      }),
    ).toThrow(/permanentPartitionReason/);
  });

  it("rejects healed network_partition with minority writes but no conflicts recorded", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        conflictRecordIds: [],
      }),
    ).toThrow(/conflict records during healing/);
  });

  it("rejects active event with requiresIncidentResponse but no incidentRecordId", () => {
    expect(() =>
      SplitBrainEventSchema.parse({
        ...base,
        status: "isolating",
        healedAt: null,
        durationSeconds: null,
        incidentRecordId: undefined,
      }),
    ).toThrow(/incidentRecordId/);
  });
});

describe("helpers", () => {
  const event: SplitBrainEvent = {
    id: "SB-2026-0001",
    kind: "network_partition",
    status: "healed",
    detectedAt: "2026-05-15T10:00:00Z",
    detectedBy: "x",
    detectorEvidence: "x",
    partitionGroups: [
      {
        groupId: "majority",
        regions: ["eu-central", "us-east"],
        hadQuorum: true,
        acceptedWritesDuringPartition: true,
        writeCountDuringPartition: 100,
      },
      {
        groupId: "minority",
        regions: ["apac-sg"],
        hadQuorum: false,
        acceptedWritesDuringPartition: false,
        writeCountDuringPartition: 0,
      },
    ],
    isolatedAt: "2026-05-15T10:01:00Z",
    healingStartedAt: "2026-05-15T10:10:00Z",
    healedAt: "2026-05-15T10:30:00Z",
    healingStrategy: "auto_merge_concurrent",
    conflictRecordIds: [],
    permanentPartitionAt: null,
    requiresIncidentResponse: true,
    incidentRecordId: "INC-2026-0042",
    durationSeconds: 1800,
  };

  it("affectedRegions returns union of all groups", () => {
    expect([...affectedRegions(event)].sort()).toEqual([
      "apac-sg",
      "eu-central",
      "us-east",
    ]);
  });

  it("quorumGroup returns the quorum-holding group", () => {
    expect(quorumGroup(event)?.groupId).toBe("majority");
  });

  it("minorityGroups returns non-quorum groups", () => {
    expect(minorityGroups(event).map((g) => g.groupId)).toEqual(["minority"]);
  });

  it("isActive false for healed", () => {
    expect(isActive(event)).toBe(false);
  });

  it("isActive true for detected/isolating/healing", () => {
    expect(isActive({ ...event, status: "isolating" })).toBe(true);
  });

  it("meanTimeToHealSeconds averages healed events", () => {
    const events = [
      event,
      { ...event, id: "SB-2026-0002", durationSeconds: 600 },
    ];
    expect(meanTimeToHealSeconds(events)).toBe(1200);
  });

  it("meanTimeToHealSeconds returns null for no healed events", () => {
    expect(meanTimeToHealSeconds([])).toBeNull();
  });
});
