import { describe, expect, it } from "vitest";

import { DEFAULT_WORKFLOW_TICK_NAMESPACE, advisoryLockKey } from "./lock-key.js";

describe("advisoryLockKey", () => {
  it("is deterministic for a namespace", () => {
    expect(advisoryLockKey("a")).toBe(advisoryLockKey("a"));
  });

  it("differs across namespaces", () => {
    expect(advisoryLockKey("a")).not.toBe(advisoryLockKey("b"));
  });

  it("is a signed 64-bit bigint (valid pg advisory-lock key)", () => {
    const k = advisoryLockKey(DEFAULT_WORKFLOW_TICK_NAMESPACE);
    expect(typeof k).toBe("bigint");
    expect(k).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(k).toBeLessThanOrEqual(2n ** 63n - 1n);
  });
});
