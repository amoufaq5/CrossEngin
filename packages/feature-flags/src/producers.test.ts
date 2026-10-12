import { describe, expect, it } from "vitest";

import { EVALUATION_REASONS, type EvaluationReason } from "./evaluations.js";
import {
  FLAG_EVALUATION_REASON_PRODUCERS,
  flagEvaluationIsImplemented,
  unproducibleEvaluationReasons,
  type FlagEvaluationProducer,
} from "./producers.js";

describe("FLAG_EVALUATION_REASON_PRODUCERS", () => {
  it("is total over EVALUATION_REASONS", () => {
    expect(Object.keys(FLAG_EVALUATION_REASON_PRODUCERS).sort()).toEqual(
      [...EVALUATION_REASONS].sort(),
    );
  });

  it("names no key EVALUATION_REASONS does not declare", () => {
    const declared = new Set<string>(EVALUATION_REASONS);
    for (const key of Object.keys(FLAG_EVALUATION_REASON_PRODUCERS)) {
      expect(declared.has(key)).toBe(true);
    }
  });

  it("holds only values the producer union permits", () => {
    const permitted: ReadonlySet<FlagEvaluationProducer> = new Set<FlagEvaluationProducer>([
      "none",
      "stored_flags",
      "declared_flags",
    ]);
    for (const reason of EVALUATION_REASONS) {
      expect(permitted.has(FLAG_EVALUATION_REASON_PRODUCERS[reason])).toBe(true);
    }
  });

  it("is frozen, so a reader cannot be handed a mutated map", () => {
    expect(Object.isFrozen(FLAG_EVALUATION_REASON_PRODUCERS)).toBe(true);
  });

  /**
   * The declaration, asserted rather than written in a comment: nothing evaluates a flag.
   *
   * This test is **expected to fail** the day an evaluator lands, and that is its job — it is the
   * forcing function that makes whoever builds one update the map instead of leaving seventeen
   * reasons reading as produced by something. Not a vacuity guard in the usual direction: the
   * dangerous outcome here is the map quietly claiming a producer that does not exist.
   */
  it("reports every reason unproducible, because nothing evaluates a flag", () => {
    expect(unproducibleEvaluationReasons()).toEqual(EVALUATION_REASONS);
    expect(flagEvaluationIsImplemented()).toBe(false);
  });

  it("derives the unproducible list from the map rather than restating it", () => {
    const fromMap = EVALUATION_REASONS.filter(
      (r: EvaluationReason) => FLAG_EVALUATION_REASON_PRODUCERS[r] === "none",
    );
    expect(unproducibleEvaluationReasons()).toEqual(fromMap);
  });

  it("preserves EVALUATION_REASONS order", () => {
    const order = unproducibleEvaluationReasons();
    expect(order[0]).toBe("default_returned");
    expect(order[1]).toBe("kill_switch_active");
    expect(order[order.length - 1]).toBe("expired_returned_default");
  });

  it("covers the seventeen reasons the catalog's CHECK constrains", () => {
    expect(EVALUATION_REASONS).toHaveLength(17);
    expect(Object.keys(FLAG_EVALUATION_REASON_PRODUCERS)).toHaveLength(17);
  });
});
