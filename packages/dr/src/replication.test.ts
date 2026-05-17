import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS } from "./tiers.js";
import {
  REPLICA_ROLES,
  ReplicationEdgeSchema,
  ReplicationLagRecordSchema,
  ReplicationTopologySchema,
  isLagAcceptable,
  sourcesFor,
  targetsFor,
  violatesTier,
  type ReplicationEdge,
  type ReplicationLagRecord,
} from "./replication.js";

describe("REPLICA_ROLES", () => {
  it("has 5 entries", () => {
    expect(REPLICA_ROLES).toEqual([
      "primary",
      "standby_sync",
      "standby_async",
      "snapshot_only",
      "cold",
    ]);
  });
});

describe("ReplicationEdgeSchema", () => {
  const base: ReplicationEdge = {
    source: "eu-central",
    target: "eu-west",
    kind: "async",
    tier: "tier_1_business_critical",
    laggingThresholdSeconds: 30,
    targetRole: "standby_async",
  };

  it("accepts a valid async edge", () => {
    expect(() => ReplicationEdgeSchema.parse(base)).not.toThrow();
  });

  it("rejects same source and target", () => {
    expect(() =>
      ReplicationEdgeSchema.parse({ ...base, target: "eu-central" }),
    ).toThrow(/different regions/);
  });

  it("rejects kind='none' edges", () => {
    expect(() =>
      ReplicationEdgeSchema.parse({ ...base, kind: "none" }),
    ).toThrow(/remove the edge/);
  });

  it("rejects sync replication without standby_sync target role", () => {
    expect(() =>
      ReplicationEdgeSchema.parse({
        ...base,
        kind: "sync",
        targetRole: "standby_async",
      }),
    ).toThrow(/sync replication requires/);
  });

  it("rejects snapshot replication with mismatched target role", () => {
    expect(() =>
      ReplicationEdgeSchema.parse({
        ...base,
        kind: "snapshot",
        targetRole: "standby_async",
      }),
    ).toThrow(/snapshot replication requires/);
  });
});

describe("ReplicationTopologySchema", () => {
  const edge = (
    source: "eu-central" | "eu-west" | "us-east",
    target: "eu-central" | "eu-west" | "us-east",
    kind: "sync" | "async" = "async",
  ): ReplicationEdge => ({
    source,
    target,
    kind,
    tier: "tier_1_business_critical",
    laggingThresholdSeconds: 30,
    targetRole: kind === "sync" ? "standby_sync" : "standby_async",
  });

  it("accepts a fan-out topology (1 source, 2 targets)", () => {
    expect(() =>
      ReplicationTopologySchema.parse([
        edge("eu-central", "eu-west"),
        edge("eu-central", "us-east"),
      ]),
    ).not.toThrow();
  });

  it("rejects a duplicate edge", () => {
    expect(() =>
      ReplicationTopologySchema.parse([
        edge("eu-central", "eu-west"),
        edge("eu-central", "eu-west"),
      ]),
    ).toThrow(/duplicate replication edge/);
  });

  it("rejects bidirectional sync (write loop)", () => {
    expect(() =>
      ReplicationTopologySchema.parse([
        edge("eu-central", "eu-west", "sync"),
        edge("eu-west", "eu-central", "sync"),
      ]),
    ).toThrow(/write loop/);
  });

  it("rejects bidirectional async (write loop)", () => {
    expect(() =>
      ReplicationTopologySchema.parse([
        edge("eu-central", "eu-west", "async"),
        edge("eu-west", "eu-central", "async"),
      ]),
    ).toThrow(/write loop/);
  });
});

describe("ReplicationLagRecordSchema", () => {
  const base: ReplicationLagRecord = {
    source: "eu-central",
    target: "eu-west",
    measuredAt: "2026-05-14T10:00:00Z",
    lagBytes: 1024,
    lagSeconds: 5,
    status: "healthy",
  };

  it("accepts a healthy lag record", () => {
    expect(() => ReplicationLagRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects broken status without lastErrorMessage", () => {
    expect(() =>
      ReplicationLagRecordSchema.parse({ ...base, status: "broken" }),
    ).toThrow(/lastErrorMessage/);
  });
});

describe("helpers", () => {
  const edge = (
    source: "eu-central" | "eu-west" | "us-east",
    target: "eu-central" | "eu-west" | "us-east",
  ): ReplicationEdge => ({
    source,
    target,
    kind: "async",
    tier: "tier_1_business_critical",
    laggingThresholdSeconds: 60,
    targetRole: "standby_async",
  });

  const topology = [edge("eu-central", "eu-west"), edge("eu-central", "us-east")];

  it("targetsFor returns all replication targets for a source", () => {
    expect(targetsFor(topology, "eu-central").sort()).toEqual(["eu-west", "us-east"]);
  });

  it("sourcesFor returns all sources for a target", () => {
    expect(sourcesFor(topology, "eu-west")).toEqual(["eu-central"]);
  });

  it("isLagAcceptable returns true under threshold", () => {
    const rec: ReplicationLagRecord = {
      source: "eu-central",
      target: "eu-west",
      measuredAt: "2026-05-14T10:00:00Z",
      lagBytes: 1024,
      lagSeconds: 30,
      status: "healthy",
    };
    expect(isLagAcceptable(rec, edge("eu-central", "eu-west"))).toBe(true);
  });

  it("isLagAcceptable returns false when broken", () => {
    const rec: ReplicationLagRecord = {
      source: "eu-central",
      target: "eu-west",
      measuredAt: "2026-05-14T10:00:00Z",
      lagBytes: 1024,
      lagSeconds: 5,
      status: "broken",
      lastErrorMessage: "connection refused",
    };
    expect(isLagAcceptable(rec, edge("eu-central", "eu-west"))).toBe(false);
  });

  it("violatesTier returns true when lag exceeds tier RPO", () => {
    const rec: ReplicationLagRecord = {
      source: "eu-central",
      target: "eu-west",
      measuredAt: "2026-05-14T10:00:00Z",
      lagBytes: 1024,
      lagSeconds: 120,
      status: "healthy",
    };
    expect(violatesTier(rec, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(true);
  });

  it("violatesTier returns false when lag is within tier RPO", () => {
    const rec: ReplicationLagRecord = {
      source: "eu-central",
      target: "eu-west",
      measuredAt: "2026-05-14T10:00:00Z",
      lagBytes: 1024,
      lagSeconds: 30,
      status: "healthy",
    };
    expect(violatesTier(rec, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(false);
  });
});
