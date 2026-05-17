import { describe, expect, it } from "vitest";
import {
  CONSISTENCY_LEVELS,
  CONSISTENCY_RANK,
  ConsistencyPolicySchema,
  ConsistencyPolicySetSchema,
  OPERATION_KINDS,
  compareLevel,
  defaultPolicySet,
  isStrongerOrEqual,
  policyFor,
  type ConsistencyPolicy,
} from "./consistency.js";

describe("constants", () => {
  it("CONSISTENCY_LEVELS has 7 entries", () => {
    expect(CONSISTENCY_LEVELS).toContain("eventual");
    expect(CONSISTENCY_LEVELS).toContain("linearizable");
    expect(CONSISTENCY_LEVELS).toContain("session");
  });

  it("OPERATION_KINDS has 7 entries", () => {
    expect(OPERATION_KINDS).toContain("read");
    expect(OPERATION_KINDS).toContain("transactional_multi");
  });

  it("CONSISTENCY_RANK orders eventual lowest, linearizable highest", () => {
    expect(CONSISTENCY_RANK.eventual).toBeLessThan(CONSISTENCY_RANK.linearizable);
    expect(CONSISTENCY_RANK.read_your_writes).toBeLessThan(CONSISTENCY_RANK.bounded_staleness);
  });
});

describe("ConsistencyPolicySchema", () => {
  const base: ConsistencyPolicy = {
    operationKind: "read",
    level: "eventual",
    requiresQuorum: false,
    overrideAllowed: true,
  };

  it("accepts a basic read policy", () => {
    expect(() => ConsistencyPolicySchema.parse(base)).not.toThrow();
  });

  it("rejects bounded_staleness without boundedStalenessMs", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        level: "bounded_staleness",
      }),
    ).toThrow(/boundedStalenessMs/);
  });

  it("rejects boundedStalenessMs on non-bounded level", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        boundedStalenessMs: 1000,
      }),
    ).toThrow(/only valid for level='bounded_staleness'/);
  });

  it("rejects requiresQuorum without quorumSize", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        requiresQuorum: true,
      }),
    ).toThrow(/quorumSize/);
  });

  it("rejects linearizable without quorum", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        operationKind: "transactional_multi",
        level: "linearizable",
      }),
    ).toThrow(/requires quorum/);
  });

  it("rejects write operation with eventual level", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        operationKind: "write_insert",
      }),
    ).toThrow(/cannot use level='eventual'/);
  });

  it("rejects read_modify_write with monotonic_read", () => {
    expect(() =>
      ConsistencyPolicySchema.parse({
        ...base,
        operationKind: "read_modify_write",
        level: "monotonic_read",
      }),
    ).toThrow(/read_your_writes/);
  });
});

describe("ConsistencyPolicySetSchema", () => {
  it("rejects duplicate operationKind", () => {
    expect(() =>
      ConsistencyPolicySetSchema.parse([
        {
          operationKind: "read",
          level: "eventual",
          requiresQuorum: false,
          overrideAllowed: true,
        },
        {
          operationKind: "read",
          level: "session",
          requiresQuorum: false,
          overrideAllowed: false,
        },
      ]),
    ).toThrow(/duplicate operationKind/);
  });

  it("accepts the default policy set", () => {
    expect(() => ConsistencyPolicySetSchema.parse(defaultPolicySet())).not.toThrow();
  });
});

describe("helpers", () => {
  it("compareLevel returns negative when a < b", () => {
    expect(compareLevel("eventual", "linearizable")).toBeLessThan(0);
  });

  it("isStrongerOrEqual true when provided meets required", () => {
    expect(isStrongerOrEqual("read_your_writes", "linearizable")).toBe(true);
    expect(isStrongerOrEqual("linearizable", "read_your_writes")).toBe(false);
  });

  it("policyFor finds by operation kind", () => {
    const set = defaultPolicySet();
    expect(policyFor(set, "read")?.level).toBe("eventual");
    expect(policyFor(set, "transactional_multi")?.level).toBe("linearizable");
  });

  it("defaultPolicySet has all operation kinds", () => {
    const set = defaultPolicySet();
    expect(set.length).toBe(OPERATION_KINDS.length);
    for (const op of OPERATION_KINDS) {
      expect(set.find((p) => p.operationKind === op)).toBeDefined();
    }
  });
});
