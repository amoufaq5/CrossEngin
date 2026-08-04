import { describe, expect, it } from "vitest";

import { danglingLinkCount, planLinkPrune, type LinkPair } from "./link-integrity.js";

const LINKS: readonly LinkPair[] = [
  { leftId: "l1", rightId: "r1" },
  { leftId: "l2", rightId: "r2" },
  { leftId: "l3", rightId: "r3" },
];

describe("planLinkPrune", () => {
  it("keeps every link when both endpoints exist", () => {
    const plan = planLinkPrune({
      links: LINKS,
      existingLeftIds: new Set(["l1", "l2", "l3"]),
      existingRightIds: new Set(["r1", "r2", "r3"]),
    });
    expect(plan.keep).toEqual(LINKS);
    expect(plan.drop).toEqual([]);
  });

  it("drops a link whose left endpoint is gone", () => {
    const plan = planLinkPrune({
      links: LINKS,
      existingLeftIds: new Set(["l1", "l3"]),
      existingRightIds: new Set(["r1", "r2", "r3"]),
    });
    expect(plan.drop).toEqual([{ leftId: "l2", rightId: "r2" }]);
    expect(plan.keep).toEqual([
      { leftId: "l1", rightId: "r1" },
      { leftId: "l3", rightId: "r3" },
    ]);
  });

  it("drops a link whose right endpoint is gone", () => {
    const plan = planLinkPrune({
      links: LINKS,
      existingLeftIds: new Set(["l1", "l2", "l3"]),
      existingRightIds: new Set(["r1", "r3"]),
    });
    expect(plan.drop).toEqual([{ leftId: "l2", rightId: "r2" }]);
  });

  it("drops a link whose both endpoints are gone", () => {
    const plan = planLinkPrune({
      links: [{ leftId: "l1", rightId: "r1" }],
      existingLeftIds: new Set<string>(),
      existingRightIds: new Set<string>(),
    });
    expect(plan.drop).toEqual([{ leftId: "l1", rightId: "r1" }]);
    expect(plan.keep).toEqual([]);
  });

  it("preserves input order in both partitions", () => {
    const links: readonly LinkPair[] = [
      { leftId: "a", rightId: "z" },
      { leftId: "b", rightId: "y" },
      { leftId: "c", rightId: "x" },
      { leftId: "d", rightId: "w" },
    ];
    const plan = planLinkPrune({
      links,
      existingLeftIds: new Set(["a", "c"]),
      existingRightIds: new Set(["z", "y", "x", "w"]),
    });
    expect(plan.keep).toEqual([
      { leftId: "a", rightId: "z" },
      { leftId: "c", rightId: "x" },
    ]);
    expect(plan.drop).toEqual([
      { leftId: "b", rightId: "y" },
      { leftId: "d", rightId: "w" },
    ]);
  });

  it("handles an empty link set", () => {
    const plan = planLinkPrune({
      links: [],
      existingLeftIds: new Set(["l1"]),
      existingRightIds: new Set(["r1"]),
    });
    expect(plan.keep).toEqual([]);
    expect(plan.drop).toEqual([]);
  });
});

describe("danglingLinkCount", () => {
  it("counts only the dropped links", () => {
    expect(
      danglingLinkCount({
        links: LINKS,
        existingLeftIds: new Set(["l1"]),
        existingRightIds: new Set(["r1", "r2", "r3"]),
      }),
    ).toBe(2);
  });

  it("is zero when nothing dangles", () => {
    expect(
      danglingLinkCount({
        links: LINKS,
        existingLeftIds: new Set(["l1", "l2", "l3"]),
        existingRightIds: new Set(["r1", "r2", "r3"]),
      }),
    ).toBe(0);
  });
});
