import { describe, expect, it } from "vitest";
import {
  ActiveActiveTopologySchema,
  PARTITION_STRATEGIES,
  REGION_ROLES,
  RegionParticipationSchema,
  TOPOLOGY_KINDS,
  isMultiWriter,
  readerRegionsFor,
  writerRegionsFor,
  type ActiveActiveTopology,
  type RegionParticipation,
} from "./topology.js";

describe("constants", () => {
  it("TOPOLOGY_KINDS has 4 entries", () => {
    expect(TOPOLOGY_KINDS).toEqual([
      "single_primary",
      "active_passive",
      "active_active",
      "multi_master_partitioned",
    ]);
  });

  it("REGION_ROLES has 5 entries", () => {
    expect(REGION_ROLES).toContain("writer_primary");
    expect(REGION_ROLES).toContain("isolated");
  });

  it("PARTITION_STRATEGIES has 5 entries", () => {
    expect(PARTITION_STRATEGIES).toContain("tenant_residency");
    expect(PARTITION_STRATEGIES).toContain("entity_class");
  });
});

describe("RegionParticipationSchema", () => {
  const base: RegionParticipation = {
    region: "eu-central",
    role: "writer_primary",
    acceptedEntityClasses: ["tenants", "manifests"],
    acceptsWritesFor: ["tenants", "manifests"],
    weight: 50,
    healthCheckSeconds: 15,
  };

  it("accepts a valid writer participation", () => {
    expect(() => RegionParticipationSchema.parse(base)).not.toThrow();
  });

  it("rejects writer role without acceptsWritesFor", () => {
    expect(() =>
      RegionParticipationSchema.parse({
        ...base,
        acceptsWritesFor: [],
      }),
    ).toThrow(/must declare at least one acceptsWritesFor/);
  });

  it("rejects non-writer role with acceptsWritesFor", () => {
    expect(() =>
      RegionParticipationSchema.parse({
        ...base,
        role: "reader_only",
      }),
    ).toThrow(/cannot declare acceptsWritesFor/);
  });

  it("rejects acceptsWritesFor entity class not in acceptedEntityClasses", () => {
    expect(() =>
      RegionParticipationSchema.parse({
        ...base,
        acceptsWritesFor: ["nonexistent"],
      }),
    ).toThrow(/must also be in acceptedEntityClasses/);
  });

  it("rejects isolated region with entity classes", () => {
    expect(() =>
      RegionParticipationSchema.parse({
        ...base,
        role: "isolated",
        acceptedEntityClasses: ["tenants"],
        acceptsWritesFor: [],
      }),
    ).toThrow(/isolated regions cannot accept entity classes/);
  });
});

describe("ActiveActiveTopologySchema", () => {
  const base: ActiveActiveTopology = {
    id: "topo-1",
    kind: "active_active",
    partitionStrategy: "tenant_residency",
    participations: [
      {
        region: "eu-central",
        role: "writer_primary",
        acceptedEntityClasses: ["tenants"],
        acceptsWritesFor: ["tenants"],
        weight: 50,
        healthCheckSeconds: 15,
      },
      {
        region: "us-east",
        role: "writer_secondary",
        acceptedEntityClasses: ["tenants"],
        acceptsWritesFor: ["tenants"],
        weight: 50,
        healthCheckSeconds: 15,
      },
    ],
    description: "EU/US active-active",
    activatedAt: "2026-05-15T10:00:00Z",
    activatedBy: "u-admin",
  };

  it("accepts a valid active_active topology", () => {
    expect(() => ActiveActiveTopologySchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate regions", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        participations: [base.participations[0]!, base.participations[0]!],
      }),
    ).toThrow(/duplicate region/);
  });

  it("rejects single_primary with multiple writers", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        kind: "single_primary",
      }),
    ).toThrow();
  });

  it("rejects active_passive with no secondary", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        kind: "active_passive",
        participations: [base.participations[0]!],
      }),
    ).toThrow();
  });

  it("rejects active_active with only one writer", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        participations: [
          base.participations[0]!,
          { ...base.participations[1]!, role: "reader_only", acceptsWritesFor: [] },
        ],
      }),
    ).toThrow(/at least 2 writer regions/);
  });

  it("rejects active_active with > 1 writer_primary", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        participations: [
          base.participations[0]!,
          { ...base.participations[1]!, role: "writer_primary" },
        ],
      }),
    ).toThrow(/cannot have more than one writer_primary/);
  });

  it("rejects multi_master_partitioned with overlapping writers for same entity class", () => {
    expect(() =>
      ActiveActiveTopologySchema.parse({
        ...base,
        kind: "multi_master_partitioned",
        participations: [
          {
            ...base.participations[0]!,
            role: "writer_primary",
            acceptsWritesFor: ["tenants"],
          },
          {
            ...base.participations[1]!,
            role: "writer_primary",
            acceptsWritesFor: ["tenants"],
          },
        ],
      }),
    ).toThrow(/multiple writer_primary regions/);
  });
});

describe("helpers", () => {
  const topo: ActiveActiveTopology = {
    id: "t",
    kind: "active_active",
    partitionStrategy: "tenant_residency",
    participations: [
      {
        region: "eu-central",
        role: "writer_primary",
        acceptedEntityClasses: ["tenants", "manifests"],
        acceptsWritesFor: ["tenants"],
        weight: 50,
        healthCheckSeconds: 15,
      },
      {
        region: "us-east",
        role: "writer_secondary",
        acceptedEntityClasses: ["tenants"],
        acceptsWritesFor: ["tenants"],
        weight: 50,
        healthCheckSeconds: 15,
      },
    ],
    description: "x",
    activatedAt: "2026-05-15T10:00:00Z",
    activatedBy: "u",
  };

  it("writerRegionsFor returns writer regions for entity class", () => {
    expect([...writerRegionsFor(topo, "tenants")].sort()).toEqual([
      "eu-central",
      "us-east",
    ]);
  });

  it("readerRegionsFor returns all regions that accept the class", () => {
    expect([...readerRegionsFor(topo, "manifests")].sort()).toEqual([
      "eu-central",
    ]);
  });

  it("isMultiWriter true when >=2 writers", () => {
    expect(isMultiWriter(topo)).toBe(true);
  });
});
