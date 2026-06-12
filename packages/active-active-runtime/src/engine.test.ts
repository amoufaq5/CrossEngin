import { pnCounterValue, type PNCounter } from "@crossengin/active-active";
import { describe, expect, it } from "vitest";

import { ReplicationEngine } from "./engine.js";

function pn(positive: Record<string, number>): PNCounter {
  return { kind: "pn_counter", positive, negative: {} };
}

function engine(region: "us-east" | "eu-west"): ReplicationEngine {
  return new ReplicationEngine({ region });
}

describe("ReplicationEngine", () => {
  it("localWrite stores the value, bumps this region's clock, and returns a broadcast message", () => {
    const e = engine("us-east");
    const msg = e.localWrite("votes", pn({ "us-east": 1 }));
    expect(msg.fromRegion).toBe("us-east");
    expect(msg.value.clock).toEqual([{ region: "us-east", counter: 1 }]);
    expect(e.value("votes")?.lastWriter).toBe("us-east");
    expect(e.events().map((ev) => ev.kind)).toEqual(["local_write"]);
  });

  it("applies a remote value for a brand-new key (remote_applied)", () => {
    const a = engine("us-east");
    const b = engine("eu-west");
    const msg = b.localWrite("votes", pn({ "eu-west": 1 }));
    a.receive(msg);
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(1);
    expect(a.events().at(-1)?.kind).toBe("remote_applied");
  });

  it("merges a concurrent two-region counter write conflict-free + logs the resolution", () => {
    const a = engine("us-east");
    const b = engine("eu-west");
    const msgA = a.localWrite("votes", pn({ "us-east": 1 }));
    const msgB = b.localWrite("votes", pn({ "eu-west": 1 }));

    // each region receives the other's concurrent write
    a.receive(msgB);
    b.receive(msgA);

    // both converge to the summed PN-counter value (2), independent of order
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(2);
    expect(pnCounterValue(b.value("votes")!.crdt as PNCounter)).toBe(2);

    const res = a.concurrentResolutions();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      key: "votes",
      kind: "concurrent_write",
      strategy: "vector_clock_merge",
      autoResolved: true,
      regions: ["us-east", "eu-west"],
    });
    expect(a.events().at(-1)?.kind).toBe("concurrent_merged");
  });

  it("ignores a causally stale re-delivery (stale_ignored, value unchanged)", () => {
    const a = engine("us-east");
    const b = engine("eu-west");
    const msgA = a.localWrite("votes", pn({ "us-east": 1 }));
    const msgB = b.localWrite("votes", pn({ "eu-west": 1 }));
    a.receive(msgB); // a now has clock {us-east:1, eu-west:1}
    const before = pnCounterValue(a.value("votes")!.crdt as PNCounter);

    a.receive(msgA); // re-deliver a's own older write (clock {us-east:1}, causally before)
    expect(a.events().at(-1)?.kind).toBe("stale_ignored");
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(before);
  });

  it("converges two regions to identical state after they exchange writes", () => {
    const a = engine("us-east");
    const b = engine("eu-west");
    a.receive(b.localWrite("votes", pn({ "eu-west": 2 })));
    b.receive(a.localWrite("votes", pn({ "us-east": 3 })));
    // re-exchange so both have both contributions
    const finalA = a.localWrite("votes", pn({ "us-east": 3 }));
    b.receive(finalA);
    expect(pnCounterValue(a.value("votes")!.crdt as PNCounter)).toBe(pnCounterValue(b.value("votes")!.crdt as PNCounter));
  });
});
