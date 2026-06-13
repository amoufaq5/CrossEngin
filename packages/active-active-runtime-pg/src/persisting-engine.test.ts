import { ReplicationEngine, type ConcurrentResolution, type PNCounter, type ReplicationEvent } from "@crossengin/active-active-runtime";
import { describe, expect, it } from "vitest";

import type { PostgresReplicationConflictStore } from "./conflict-store.js";
import type { PostgresReplicationEventStore } from "./event-store.js";
import { PersistingReplicationEngine } from "./persisting-engine.js";

function pn(positive: Record<string, number>): PNCounter {
  return { kind: "pn_counter", positive, negative: {} };
}

/** Fake stores recording what was persisted. */
function fakes(): {
  eventStore: PostgresReplicationEventStore;
  conflictStore: PostgresReplicationConflictStore;
  events: ReplicationEvent[];
  conflicts: ConcurrentResolution[];
} {
  const events: ReplicationEvent[] = [];
  const conflicts: ConcurrentResolution[] = [];
  return {
    events,
    conflicts,
    eventStore: { record: async (e: ReplicationEvent) => void events.push(e) } as unknown as PostgresReplicationEventStore,
    conflictStore: { record: async (c: ConcurrentResolution) => void conflicts.push(c) } as unknown as PostgresReplicationConflictStore,
  };
}

describe("PersistingReplicationEngine", () => {
  it("persists each local write's event as it runs", async () => {
    const f = fakes();
    const eng = new PersistingReplicationEngine(new ReplicationEngine({ region: "us-east" }), f);
    await eng.localWrite("votes", pn({ "us-east": 1 }));
    expect(f.events.map((e) => e.kind)).toEqual(["local_write"]);
    expect(f.conflicts).toHaveLength(0);
  });

  it("persists a concurrent receive's event + its resolution", async () => {
    const f = fakes();
    const a = new PersistingReplicationEngine(new ReplicationEngine({ region: "us-east" }), f);
    const b = new ReplicationEngine({ region: "eu-west" });
    await a.localWrite("votes", pn({ "us-east": 1 }));
    const msgB = b.localWrite("votes", pn({ "eu-west": 1 }));
    await a.receive(msgB);
    expect(f.events.at(-1)?.kind).toBe("concurrent_merged");
    expect(f.conflicts).toHaveLength(1);
    expect(f.conflicts[0]).toMatchObject({ key: "votes", kind: "concurrent_write", autoResolved: true });
  });

  it("only flushes the delta — re-running an op doesn't re-persist history", async () => {
    const f = fakes();
    const eng = new PersistingReplicationEngine(new ReplicationEngine({ region: "us-east" }), f);
    await eng.localWrite("a", pn({ "us-east": 1 }));
    await eng.localWrite("b", pn({ "us-east": 1 }));
    await eng.localWrite("c", pn({ "us-east": 1 }));
    // three ops → exactly three events, no duplicates
    expect(f.events).toHaveLength(3);
    expect(f.events.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });
});
