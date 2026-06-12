import type { ConcurrentResolution, ReplicationEvent } from "@crossengin/active-active-runtime";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { PostgresReplicationConflictStore } from "./conflict-store.js";
import { PostgresReplicationEventStore } from "./event-store.js";
import { replicationConflictInsertParams, replicationEventInsertParams, rowToReplicationConflict } from "./records.js";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeConn(rows: Record<string, unknown>[] = []): { conn: PgConnection; calls: Call[] } {
  const calls: Call[] = [];
  const conn = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> {
      calls.push({ sql, params });
      return { rows: rows as readonly T[], rowCount: rows.length };
    },
    async transaction() {
      throw new Error("unused");
    },
    async withAdvisoryLock() {
      throw new Error("unused");
    },
    async close() {
      /* no-op */
    },
  } as unknown as PgConnection;
  return { conn, calls };
}

const EVENT: ReplicationEvent = {
  kind: "concurrent_merged",
  key: "votes",
  region: "us-east",
  fromRegion: "eu-west",
  relation: "concurrent",
  at: "2026-06-12T00:00:00.000Z",
};

const RESOLUTION: ConcurrentResolution = {
  key: "votes",
  kind: "concurrent_write",
  strategy: "vector_clock_merge",
  autoResolved: true,
  regions: ["us-east", "eu-west"],
  resolved: { key: "votes", crdt: { kind: "pn_counter", positive: { "us-east": 1 }, negative: {} }, clock: [], lastWriter: "us-east", updatedAt: "2026-06-12T00:00:00.000Z" },
  at: "2026-06-12T00:00:01.000Z",
};

describe("insert param projection", () => {
  it("projects a replication event to its column tuple", () => {
    expect(replicationEventInsertParams(EVENT)).toEqual([
      "concurrent_merged",
      "votes",
      "us-east",
      "eu-west",
      "concurrent",
      "2026-06-12T00:00:00.000Z",
    ]);
  });

  it("projects a concurrent resolution (resolved value JSON-stringified)", () => {
    const params = replicationConflictInsertParams(RESOLUTION);
    expect(params.slice(0, 6)).toEqual(["votes", "concurrent_write", "vector_clock_merge", true, "us-east", "eu-west"]);
    expect(JSON.parse(params[6] as string)).toMatchObject({ key: "votes" });
    expect(params[7]).toBe("2026-06-12T00:00:01.000Z");
  });
});

describe("PostgresReplicationEventStore", () => {
  it("records an event with an INSERT into replication_events", async () => {
    const { conn, calls } = fakeConn();
    await new PostgresReplicationEventStore(conn).record(EVENT);
    expect(calls[0]!.sql).toContain("INSERT INTO meta.replication_events");
    expect(calls[0]!.params).toEqual(replicationEventInsertParams(EVENT));
  });

  it("listForKey queries by record_key with a bounded limit", async () => {
    const { conn, calls } = fakeConn([
      { id: "1", event_kind: "remote_applied", record_key: "votes", region: "us-east", from_region: "eu-west", causal_relation: "after", occurred_at: "2026-06-12T00:00:00.000Z", recorded_at: "2026-06-12T00:00:00.000Z" },
    ]);
    const rows = await new PostgresReplicationEventStore(conn).listForKey("votes", { limit: 5 });
    expect(calls[0]!.sql).toContain("WHERE record_key = $1");
    expect(calls[0]!.params).toEqual(["votes", 5]);
    expect(rows[0]).toMatchObject({ recordKey: "votes", eventKind: "remote_applied", fromRegion: "eu-west" });
  });

  it("rejects an invalid schema name", () => {
    const { conn } = fakeConn();
    expect(() => new PostgresReplicationEventStore(conn, { schema: "evil; drop" })).toThrow(/invalid schema/);
  });
});

describe("PostgresReplicationConflictStore", () => {
  it("records a resolution with a jsonb resolved_value", async () => {
    const { conn, calls } = fakeConn();
    await new PostgresReplicationConflictStore(conn).record(RESOLUTION);
    expect(calls[0]!.sql).toContain("INSERT INTO meta.replication_conflicts");
    expect(calls[0]!.sql).toContain("$7::jsonb");
  });

  it("listRecent maps rows (parsing a JSON-string resolved_value)", async () => {
    const { conn } = fakeConn([
      { id: "c1", record_key: "votes", conflict_kind: "concurrent_write", resolution_strategy: "vector_clock_merge", auto_resolved: true, region_a: "us-east", region_b: "eu-west", resolved_value: JSON.stringify({ key: "votes" }), occurred_at: "2026-06-12T00:00:01.000Z", recorded_at: "2026-06-12T00:00:01.000Z" },
    ]);
    const rows = await new PostgresReplicationConflictStore(conn).listRecent({ limit: 10 });
    expect(rows[0]).toMatchObject({ recordKey: "votes", autoResolved: true, regionA: "us-east", regionB: "eu-west" });
    expect(rows[0]!.resolvedValue).toMatchObject({ key: "votes" });
  });

  it("rowToReplicationConflict passes through an already-parsed object resolved_value", () => {
    const rec = rowToReplicationConflict({ id: "c1", record_key: "k", conflict_kind: "concurrent_write", resolution_strategy: "vector_clock_merge", auto_resolved: false, region_a: "us-east", region_b: "us-west", resolved_value: { key: "k" }, occurred_at: new Date("2026-06-12T00:00:00.000Z"), recorded_at: new Date("2026-06-12T00:00:00.000Z") });
    expect(rec.resolvedValue).toMatchObject({ key: "k" });
    expect(rec.occurredAt).toBe("2026-06-12T00:00:00.000Z");
  });
});
