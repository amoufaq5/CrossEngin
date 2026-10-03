import { describe, expect, it } from "vitest";

import { SessionCostTracker } from "./state.js";

const S = "sess-1";
const T = "tenant-1";

describe("SessionCostTracker", () => {
  it("defaults an unseen session + tenant to zero", () => {
    const t = new SessionCostTracker();
    expect(t.session(S)).toEqual({ tokensUsed: 0, toolCallsThisTurn: 0, toolCallsBySession: {} });
    expect(t.tenant(T)).toEqual({ monthlyDollarsUsed: 0 });
  });

  it("accumulates tokens and tenant dollars", () => {
    const t = new SessionCostTracker();
    t.recordTokens(S, 100);
    t.recordTokens(S, 250);
    t.recordDollars(T, 1.5);
    t.recordDollars(T, 2.5);
    expect(t.session(S).tokensUsed).toBe(350);
    expect(t.tenant(T).monthlyDollarsUsed).toBe(4);
  });

  it("counts tool calls per-turn and per-tool", () => {
    const t = new SessionCostTracker();
    t.recordToolCall(S, "read_file");
    t.recordToolCall(S, "read_file");
    t.recordToolCall(S, "validate");
    expect(t.session(S).toolCallsThisTurn).toBe(3);
    expect(t.session(S).toolCallsBySession).toEqual({ read_file: 2, validate: 1 });
  });

  it("beginTurn resets the per-turn counter but keeps the per-tool tallies", () => {
    const t = new SessionCostTracker();
    t.recordToolCall(S, "read_file");
    t.recordToolCall(S, "read_file");
    t.beginTurn(S);
    expect(t.session(S).toolCallsThisTurn).toBe(0);
    expect(t.session(S).toolCallsBySession).toEqual({ read_file: 2 });
  });

  it("resetSession drops all session state", () => {
    const t = new SessionCostTracker();
    t.recordTokens(S, 500);
    t.recordToolCall(S, "x");
    t.resetSession(S);
    expect(t.session(S)).toEqual({ tokensUsed: 0, toolCallsThisTurn: 0, toolCallsBySession: {} });
  });

  it("defaults estimate inflation to 1 and leaves a session unsealed", () => {
    const t = new SessionCostTracker();
    expect(t.estimateInflation(S)).toBe(1);
    expect(t.sealedReason(S)).toBeNull();
  });

  it("raises estimate inflation only on a worse ratio, and ignores non-positive ones", () => {
    const t = new SessionCostTracker();
    t.observeEstimateRatio(S, 2.5);
    t.observeEstimateRatio(S, 1.2);
    expect(t.estimateInflation(S)).toBe(2.5);
    t.observeEstimateRatio(S, 0.5);
    t.observeEstimateRatio(S, Number.POSITIVE_INFINITY);
    t.observeEstimateRatio(S, Number.NaN);
    expect(t.estimateInflation(S)).toBe(2.5);
  });

  it("keeps the first seal reason — a seal is never re-explained or lifted", () => {
    const t = new SessionCostTracker();
    t.seal(S, "first");
    t.seal(S, "second");
    expect(t.sealedReason(S)).toBe("first");
  });

  it("resetSession clears a seal, because the session identity is gone", () => {
    const t = new SessionCostTracker();
    t.seal(S, "over ceiling");
    t.observeEstimateRatio(S, 4);
    t.resetSession(S);
    expect(t.sealedReason(S)).toBeNull();
    expect(t.estimateInflation(S)).toBe(1);
  });

  it("returns a frozen snapshot (mutating it doesn't affect the tracker)", () => {
    const t = new SessionCostTracker();
    t.recordToolCall(S, "x");
    const snap = t.session(S);
    (snap.toolCallsBySession as Record<string, number>)["x"] = 99;
    expect(t.session(S).toolCallsBySession).toEqual({ x: 1 });
  });
});
