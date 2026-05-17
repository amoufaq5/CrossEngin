import { describe, expect, it } from "vitest";

import {
  BRIDGE_AUTH_FAILURE_KINDS,
  BRIDGE_CLIENT_ERROR_KINDS,
  BRIDGE_OUTCOME_KINDS,
  BRIDGE_SUCCESS_KINDS,
  bridgeStatusFor,
  isBridgeSuccess,
  type BridgeOutcome,
} from "./outcomes.js";

describe("BRIDGE_OUTCOME_KINDS", () => {
  it("lists 10 kinds", () => {
    expect(BRIDGE_OUTCOME_KINDS).toHaveLength(10);
  });

  it("includes the three success cases", () => {
    expect(BRIDGE_SUCCESS_KINDS.has("advanced")).toBe(true);
    expect(BRIDGE_SUCCESS_KINDS.has("deduplicated")).toBe(true);
    expect(BRIDGE_SUCCESS_KINDS.has("no_matching_instance")).toBe(true);
  });

  it("partitions success / auth / client / engine without overlap", () => {
    for (const kind of BRIDGE_OUTCOME_KINDS) {
      const inSuccess = BRIDGE_SUCCESS_KINDS.has(kind);
      const inAuth = BRIDGE_AUTH_FAILURE_KINDS.has(kind);
      const inClient = BRIDGE_CLIENT_ERROR_KINDS.has(kind);
      const inEngine = kind === "engine_error";
      const sum = (inSuccess ? 1 : 0) + (inAuth ? 1 : 0) + (inClient ? 1 : 0) + (inEngine ? 1 : 0);
      expect(sum).toBe(1);
    }
  });
});

describe("bridgeStatusFor", () => {
  it("returns 202 for success kinds", () => {
    expect(bridgeStatusFor("advanced")).toBe(202);
    expect(bridgeStatusFor("deduplicated")).toBe(202);
    expect(bridgeStatusFor("no_matching_instance")).toBe(202);
  });

  it("returns 401 for auth failures", () => {
    expect(bridgeStatusFor("signature_invalid")).toBe(401);
    expect(bridgeStatusFor("secret_not_found")).toBe(401);
    expect(bridgeStatusFor("timestamp_outside_tolerance")).toBe(401);
    expect(bridgeStatusFor("signature_malformed")).toBe(401);
  });

  it("returns 400 for client errors", () => {
    expect(bridgeStatusFor("body_not_json")).toBe(400);
    expect(bridgeStatusFor("correlation_missing")).toBe(400);
  });

  it("returns 503 for engine errors", () => {
    expect(bridgeStatusFor("engine_error")).toBe(503);
  });
});

describe("isBridgeSuccess", () => {
  function outcome(kind: BridgeOutcome["kind"]): BridgeOutcome {
    return {
      kind,
      reason: "x",
      signalId: null,
      matchedInstanceIds: [],
      deduplicated: false,
    };
  }

  it("returns true for advanced / deduplicated / no_matching_instance", () => {
    expect(isBridgeSuccess(outcome("advanced"))).toBe(true);
    expect(isBridgeSuccess(outcome("deduplicated"))).toBe(true);
    expect(isBridgeSuccess(outcome("no_matching_instance"))).toBe(true);
  });

  it("returns false for failure kinds", () => {
    expect(isBridgeSuccess(outcome("signature_invalid"))).toBe(false);
    expect(isBridgeSuccess(outcome("engine_error"))).toBe(false);
  });
});
