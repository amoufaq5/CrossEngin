import { describe, expect, it } from "vitest";

import type { ReplicationConflictRecord, ReplicationEventRecord } from "./records.js";
import {
  CliUsageError,
  parseReplicationArgs,
  runReplicationQuery,
  verifyReplicationLedger,
  type ReplicationQuerySource,
} from "./query.js";

function evt(over: Partial<ReplicationEventRecord>): ReplicationEventRecord {
  return {
    id: "e1",
    eventKind: "local_write",
    recordKey: "votes",
    region: "us-east",
    fromRegion: null,
    causalRelation: null,
    occurredAt: "2026-06-12T00:00:00.000Z",
    recordedAt: "2026-06-12T00:00:00.000Z",
    ...over,
  };
}

function conf(over: Partial<ReplicationConflictRecord>): ReplicationConflictRecord {
  return {
    id: "c1",
    recordKey: "votes",
    conflictKind: "concurrent_write",
    resolutionStrategy: "vector_clock_merge",
    autoResolved: true,
    regionA: "us-east",
    regionB: "eu-west",
    resolvedValue: { key: "votes" },
    occurredAt: "2026-06-12T00:00:01.000Z",
    recordedAt: "2026-06-12T00:00:01.000Z",
    ...over,
  };
}

describe("verifyReplicationLedger", () => {
  it("reports no drift on a consistent ledger", () => {
    const events = [evt({ eventKind: "concurrent_merged", causalRelation: "concurrent" })];
    expect(verifyReplicationLedger(events, [conf({})])).toEqual([]);
  });

  it("flags a concurrent_merged event with the wrong relation", () => {
    const issues = verifyReplicationLedger([evt({ eventKind: "concurrent_merged", causalRelation: "after" })], [conf({})]);
    expect(issues.map((i) => i.kind)).toContain("concurrent_event_wrong_relation");
  });

  it("flags a non-auto-resolved / same-region conflict", () => {
    const issues = verifyReplicationLedger(
      [evt({ eventKind: "concurrent_merged", causalRelation: "concurrent" })],
      [conf({ autoResolved: false, regionB: "us-east" })],
    );
    expect(issues.map((i) => i.kind)).toEqual(expect.arrayContaining(["conflict_not_auto_resolved", "conflict_same_region"]));
  });

  it("flags an orphaned concurrent event and an orphaned conflict", () => {
    const orphanEvent = verifyReplicationLedger([evt({ eventKind: "concurrent_merged", causalRelation: "concurrent" })], []);
    expect(orphanEvent.map((i) => i.kind)).toContain("concurrent_event_without_conflict");
    const orphanConflict = verifyReplicationLedger([], [conf({})]);
    expect(orphanConflict.map((i) => i.kind)).toContain("conflict_without_concurrent_event");
  });
});

describe("parseReplicationArgs", () => {
  it("parses a command + flags", () => {
    const o = parseReplicationArgs(["events", "--key", "votes", "--limit", "5", "--format", "json"]);
    expect(o).toMatchObject({ command: "events", key: "votes", limit: 5, format: "json" });
  });

  it("rejects an unknown command / bad limit / unknown flag", () => {
    expect(() => parseReplicationArgs(["nope"])).toThrow(CliUsageError);
    expect(() => parseReplicationArgs(["events", "--limit", "0"])).toThrow(CliUsageError);
    expect(() => parseReplicationArgs(["events", "--bogus"])).toThrow(CliUsageError);
  });
});

describe("runReplicationQuery", () => {
  const source: ReplicationQuerySource = {
    async listEvents() {
      return [evt({ eventKind: "concurrent_merged", causalRelation: "concurrent" })];
    },
    async listConflicts() {
      return [conf({})];
    },
  };

  it("verify exits 0 on a clean ledger", async () => {
    const lines: string[] = [];
    const { exitCode } = await runReplicationQuery({ command: "verify", since: null, key: null, limit: null, format: "human" }, source, (l) => lines.push(l));
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("no drift");
  });

  it("verify exits 1 on drift", async () => {
    const drifting: ReplicationQuerySource = {
      async listEvents() {
        return [evt({ eventKind: "concurrent_merged", causalRelation: "concurrent" })];
      },
      async listConflicts() {
        return []; // orphaned concurrent event
      },
    };
    const { exitCode } = await runReplicationQuery({ command: "verify", since: null, key: null, limit: null, format: "human" }, drifting, () => {});
    expect(exitCode).toBe(1);
  });

  it("events lists rows", async () => {
    const lines: string[] = [];
    await runReplicationQuery({ command: "events", since: null, key: "votes", limit: null, format: "human" }, source, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("concurrent_merged");
  });
});
