import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";
import { CycleDetectedError } from "./errors.js";
import { topologicalSort } from "./topology.js";

function entity(name: string, refs: string[] = []): Entity {
  return {
    name,
    fields: refs.length
      ? refs.map((target) => ({
          name: target.toLowerCase(),
          type: { kind: "reference", target },
        }))
      : [{ name: "x", type: { kind: "text" } }],
  };
}

describe("topologicalSort", () => {
  it("returns independent entities unchanged in count", () => {
    const a = entity("A");
    const b = entity("B");
    const sorted = topologicalSort([a, b]);
    expect(sorted).toHaveLength(2);
    expect(new Set(sorted.map((e) => e.name))).toEqual(new Set(["A", "B"]));
  });

  it("places a dependency before its dependent", () => {
    const a = entity("A", ["B"]);
    const b = entity("B");
    const sorted = topologicalSort([a, b]);
    expect(sorted.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("handles linear chain C -> B -> A", () => {
    const a = entity("A", ["B"]);
    const b = entity("B", ["C"]);
    const c = entity("C");
    const sorted = topologicalSort([a, b, c]);
    expect(sorted.map((e) => e.name)).toEqual(["C", "B", "A"]);
  });

  it("handles diamond dependency", () => {
    // A -> B, A -> C, B -> D, C -> D
    const a = entity("A", ["B", "C"]);
    const b = entity("B", ["D"]);
    const c = entity("C", ["D"]);
    const d = entity("D");
    const sorted = topologicalSort([a, b, c, d]);
    const order = sorted.map((e) => e.name);
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("A"));
  });

  it("allows self-reference (skipped in topology)", () => {
    const user: Entity = {
      name: "User",
      fields: [
        { name: "manager", type: { kind: "reference", target: "User" } },
        { name: "name", type: { kind: "text" } },
      ],
    };
    const sorted = topologicalSort([user]);
    expect(sorted.map((e) => e.name)).toEqual(["User"]);
  });

  it("skips references to entities not in the input set", () => {
    // A refs B but only A is passed - B assumed to exist already
    const a = entity("A", ["B"]);
    const sorted = topologicalSort([a]);
    expect(sorted.map((e) => e.name)).toEqual(["A"]);
  });

  it("throws on a simple cycle A -> B -> A", () => {
    const a = entity("A", ["B"]);
    const b = entity("B", ["A"]);
    expect(() => topologicalSort([a, b])).toThrow(CycleDetectedError);
  });

  it("throws on a longer cycle A -> B -> C -> A", () => {
    const a = entity("A", ["B"]);
    const b = entity("B", ["C"]);
    const c = entity("C", ["A"]);
    expect(() => topologicalSort([a, b, c])).toThrow(CycleDetectedError);
  });
});
