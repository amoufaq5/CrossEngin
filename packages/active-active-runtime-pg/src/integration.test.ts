import { ReplicationEngine, type PNCounter } from "@crossengin/active-active-runtime";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresReplicationConflictStore } from "./conflict-store.js";
import { PostgresReplicationEventStore } from "./event-store.js";
import { verifyReplicationLedger } from "./query.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped
 * offline) for the replication persistence stores: drive a concurrent two-region
 * write through real `ReplicationEngine`s, persist the emitted events +
 * concurrent-resolution to `meta.replication_events` / `meta.replication_conflicts`,
 * and read them back.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

function pn(positive: Record<string, number>): PNCounter {
  return { kind: "pn_counter", positive, negative: {} };
}

suite("replication persistence (real Postgres)", () => {
  let conn: PgConnection;
  let key: string;

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
    key = `votes-${Math.random().toString(36).slice(2, 10)}`;
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("persists replication events + a concurrent resolution and reads them back", async () => {
    const a = new ReplicationEngine({ region: "us-east" });
    const b = new ReplicationEngine({ region: "eu-west" });
    const msgA = a.localWrite(key, pn({ "us-east": 1 }));
    const msgB = b.localWrite(key, pn({ "eu-west": 1 }));
    a.receive(msgB); // concurrent → concurrent_merged + a ConcurrentResolution

    const eventStore = new PostgresReplicationEventStore(conn);
    const conflictStore = new PostgresReplicationConflictStore(conn);
    await eventStore.recordMany(a.events());
    for (const res of a.concurrentResolutions()) await conflictStore.record(res);

    const events = await eventStore.listForKey(key);
    expect(events.length).toBe(a.events().length);
    expect(events.some((e) => e.eventKind === "concurrent_merged" && e.causalRelation === "concurrent")).toBe(true);
    expect(events.some((e) => e.eventKind === "local_write" && e.region === "us-east")).toBe(true);

    const conflicts = await conflictStore.listForKey(key);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatchObject({
      recordKey: key,
      conflictKind: "concurrent_write",
      resolutionStrategy: "vector_clock_merge",
      autoResolved: true,
    });
    expect(conflicts[0]!.resolvedValue).toMatchObject({ key });

    // the persisted ledger is internally consistent (the verify CI-gate contract)
    expect(verifyReplicationLedger(events, conflicts)).toEqual([]);
  });
});
