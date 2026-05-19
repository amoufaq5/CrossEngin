import { isModerationError } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { AnthropicError } from "./errors.js";
import {
  ANTHROPIC_REFUSAL_STOP_REASON,
  AnthropicRefusalError,
  isRefusalResponse,
  isRefusalStopReason,
} from "./moderation.js";

describe("isRefusalStopReason", () => {
  it("returns true only for 'refusal'", () => {
    expect(isRefusalStopReason("refusal")).toBe(true);
  });

  it("returns false for normal stop reasons", () => {
    expect(isRefusalStopReason("end_turn")).toBe(false);
    expect(isRefusalStopReason("max_tokens")).toBe(false);
    expect(isRefusalStopReason("stop_sequence")).toBe(false);
    expect(isRefusalStopReason("tool_use")).toBe(false);
    expect(isRefusalStopReason(null)).toBe(false);
    expect(isRefusalStopReason(undefined)).toBe(false);
  });
});

describe("isRefusalResponse", () => {
  it("returns true when stop_reason is 'refusal'", () => {
    expect(isRefusalResponse({ stop_reason: "refusal" })).toBe(true);
  });

  it("returns false for normal stop_reason values", () => {
    expect(isRefusalResponse({ stop_reason: "end_turn" })).toBe(false);
    expect(isRefusalResponse({ stop_reason: "tool_use" })).toBe(false);
  });
});

describe("AnthropicRefusalError", () => {
  it("extends AnthropicError with kind='refusal'", () => {
    const err = new AnthropicRefusalError();
    expect(err).toBeInstanceOf(AnthropicError);
    expect(err.kind).toBe("refusal");
    expect(err.name).toBe("AnthropicRefusalError");
    expect(err.stopReason).toBe(ANTHROPIC_REFUSAL_STOP_REASON);
  });

  it("isRetryable returns false (model refusal is terminal)", () => {
    expect(new AnthropicRefusalError().isRetryable()).toBe(false);
  });

  it("default message references stop_reason='refusal'", () => {
    expect(new AnthropicRefusalError().message).toContain("refusal");
  });

  it("custom message is preserved", () => {
    const err = new AnthropicRefusalError({ message: "model declined the request" });
    expect(err.message).toBe("model declined the request");
  });

  it("kernel isModerationError recognizes it (M2.X.6.x cross-provider)", () => {
    expect(isModerationError(new AnthropicRefusalError())).toBe(true);
  });
});
