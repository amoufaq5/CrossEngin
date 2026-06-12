import { pnCounterValue, type Crdt, type PNCounter, type VectorClock } from "@crossengin/active-active";
import { describe, expect, it } from "vitest";

import {
  CrdtKindMismatchError,
  mergeCrdt,
  mergeReplicatedValues,
  type ReplicatedValue,
} from "./replicated-value.js";

function pn(positive: Record<string, number>, negative: Record<string, number> = {}): PNCounter {
  return { kind: "pn_counter", positive, negative };
}

function clock(entries: Record<string, number>): VectorClock {
  return Object.entries(entries).map(([region, counter]) => ({ region: region as never, counter }));
}

function value(over: Partial<ReplicatedValue> & { crdt: Crdt; clock: VectorClock }): ReplicatedValue {
  return {
    key: "votes",
    lastWriter: "us-east",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...over,
  };
}

describe("mergeCrdt", () => {
  it("merges two pn_counters by per-region max (sums distinct-region increments)", () => {
    const merged = mergeCrdt(pn({ "us-east": 1 }), pn({ "eu-west": 1 })) as PNCounter;
    expect(pnCounterValue(merged)).toBe(2);
  });

  it("is idempotent — merging the same state twice changes nothing", () => {
    const a = pn({ "us-east": 3 });
    expect(pnCounterValue(mergeCrdt(a, a) as PNCounter)).toBe(3);
  });

  it("throws on a CRDT kind mismatch", () => {
    expect(() => mergeCrdt(pn({ "us-east": 1 }), { kind: "g_counter", perRegion: {} })).toThrow(CrdtKindMismatchError);
  });
});

describe("mergeReplicatedValues", () => {
  it("reports `concurrent` when the clocks are concurrent and merges the CRDT", () => {
    const existing = value({ crdt: pn({ "us-east": 1 }), clock: clock({ "us-east": 1 }), lastWriter: "us-east" });
    const incoming = value({ crdt: pn({ "eu-west": 1 }), clock: clock({ "eu-west": 1 }), lastWriter: "eu-west" });
    const { value: merged, relation } = mergeReplicatedValues(existing, incoming);
    expect(relation).toBe("concurrent");
    expect(pnCounterValue(merged.crdt as PNCounter)).toBe(2);
  });

  it("reports `after` when the incoming clock dominates", () => {
    const existing = value({ crdt: pn({ "us-east": 1 }), clock: clock({ "us-east": 1 }) });
    const incoming = value({ crdt: pn({ "us-east": 2 }), clock: clock({ "us-east": 2 }) });
    const { relation } = mergeReplicatedValues(existing, incoming);
    expect(relation).toBe("after");
  });

  it("keeps the wall-clock-newer lastWriter as the tiebreak", () => {
    const existing = value({ crdt: pn({ "us-east": 1 }), clock: clock({ "us-east": 1 }), lastWriter: "us-east", updatedAt: "2026-06-12T00:00:00.000Z" });
    const incoming = value({ crdt: pn({ "eu-west": 1 }), clock: clock({ "eu-west": 1 }), lastWriter: "eu-west", updatedAt: "2026-06-12T00:00:05.000Z" });
    expect(mergeReplicatedValues(existing, incoming).value.lastWriter).toBe("eu-west");
  });
});
