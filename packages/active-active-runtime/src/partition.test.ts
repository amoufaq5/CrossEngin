import { pnCounterValue, type PNCounter } from "@crossengin/active-active";
import { describe, expect, it } from "vitest";

import { ReplicationEngine } from "./engine.js";
import { PartitionMonitor, reconcileEngines } from "./partition.js";

function pn(positive: Record<string, number>): PNCounter {
  return { kind: "pn_counter", positive, negative: {} };
}

describe("PartitionMonitor", () => {
  it("reports `healed` (healthy) when all regions are in one group", () => {
    const m = new PartitionMonitor({ totalRegions: 3 });
    const r = m.observe({ groups: [["us-east", "us-west", "eu-west"]] });
    expect(r.status).toBe("healed");
    expect(r.quorum).toEqual(["us-east", "us-west", "eu-west"]);
    expect(m.current()).toBeNull();
  });

  it("opens a `detected` incident on a split, naming the quorum + minority", () => {
    const m = new PartitionMonitor({ totalRegions: 3 });
    const r = m.observe({ groups: [["us-east", "us-west"], ["eu-west"]] });
    expect(r.status).toBe("detected");
    expect(r.quorum).toEqual(["us-east", "us-west"]); // strict majority (2 of 3)
    expect(r.minorities).toEqual([["eu-west"]]);
    expect(r.healingStrategy).toBe("prefer_quorum_side");
  });

  it("freezes-and-audits a split with no majority group", () => {
    const m = new PartitionMonitor({ totalRegions: 4 });
    const r = m.observe({ groups: [["us-east", "us-west"], ["eu-west", "eu-central"]] });
    expect(r.status).toBe("detected");
    expect(r.quorum).toBeNull();
    expect(r.healingStrategy).toBe("freeze_and_audit");
  });

  it("advances detected → healing → healed once connectivity is restored, then re-arms", () => {
    const m = new PartitionMonitor({ totalRegions: 3 });
    m.observe({ groups: [["us-east", "us-west"], ["eu-west"]] }); // detected
    const healing = m.observe({ groups: [["us-east", "us-west", "eu-west"]] });
    expect(healing.status).toBe("healing");
    expect(healing.healingStrategy).toBe("auto_merge_concurrent");
    const healed = m.observe({ groups: [["us-east", "us-west", "eu-west"]] });
    expect(healed.status).toBe("healed");
    expect(m.current()).toBeNull();
    // a later split opens a fresh incident
    expect(m.observe({ groups: [["us-east"], ["us-west", "eu-west"]] }).status).toBe("detected");
  });
});

describe("reconcileEngines", () => {
  it("converges divergent per-region engines after a partition heals", () => {
    const a = new ReplicationEngine({ region: "us-east" });
    const b = new ReplicationEngine({ region: "eu-west" });
    // during the partition each region writes independently (no exchange)
    a.localWrite("votes", pn({ "us-east": 5 }));
    b.localWrite("votes", pn({ "eu-west": 7 }));
    a.localWrite("flag", pn({ "us-east": 1 }));

    reconcileEngines([a, b]);

    // both engines now hold identical state for every key
    expect(a.keys()).toEqual(b.keys());
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(12);
    expect(pnCounterValue(b.value("votes")!.crdt as PNCounter)).toBe(12);
    expect(pnCounterValue(b.value("flag")!.crdt as PNCounter)).toBe(1);
  });

  it("is idempotent — reconciling again is a no-op", () => {
    const a = new ReplicationEngine({ region: "us-east" });
    const b = new ReplicationEngine({ region: "eu-west" });
    a.localWrite("votes", pn({ "us-east": 5 }));
    b.localWrite("votes", pn({ "eu-west": 7 }));
    reconcileEngines([a, b]);
    const first = pnCounterValue(a.value("votes")!.crdt as PNCounter);
    reconcileEngines([a, b]);
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(first);
  });
});
