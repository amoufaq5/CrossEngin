import { isModerationError } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { OpenAIError } from "./errors.js";
import {
  OPENAI_CONTENT_FILTER_FINISH_REASON,
  OpenAIContentFilteredError,
  isContentFilterFinishReason,
  isContentFilteredResponse,
} from "./moderation.js";

describe("isContentFilterFinishReason", () => {
  it("returns true only for 'content_filter'", () => {
    expect(isContentFilterFinishReason("content_filter")).toBe(true);
  });

  it("returns false for normal finish reasons", () => {
    expect(isContentFilterFinishReason("stop")).toBe(false);
    expect(isContentFilterFinishReason("length")).toBe(false);
    expect(isContentFilterFinishReason("tool_calls")).toBe(false);
    expect(isContentFilterFinishReason(null)).toBe(false);
  });
});

describe("isContentFilteredResponse", () => {
  it("returns true when any choice has finish_reason='content_filter'", () => {
    expect(
      isContentFilteredResponse({
        choices: [{ finish_reason: "content_filter" } as unknown as never],
      }),
    ).toBe(true);
  });

  it("returns false when no choice has 'content_filter'", () => {
    expect(
      isContentFilteredResponse({
        choices: [{ finish_reason: "stop" } as unknown as never],
      }),
    ).toBe(false);
  });

  it("returns false on empty choices", () => {
    expect(isContentFilteredResponse({ choices: [] })).toBe(false);
  });
});

describe("OpenAIContentFilteredError", () => {
  it("extends OpenAIError with kind='content_filtered'", () => {
    const err = new OpenAIContentFilteredError();
    expect(err).toBeInstanceOf(OpenAIError);
    expect(err.kind).toBe("content_filtered");
    expect(err.name).toBe("OpenAIContentFilteredError");
    expect(err.finishReason).toBe(OPENAI_CONTENT_FILTER_FINISH_REASON);
  });

  it("isRetryable returns false (content filtering is terminal)", () => {
    expect(new OpenAIContentFilteredError().isRetryable()).toBe(false);
  });

  it("default message references finish_reason='content_filter'", () => {
    expect(new OpenAIContentFilteredError().message).toContain("content_filter");
  });

  it("custom message is preserved", () => {
    const err = new OpenAIContentFilteredError({ message: "blocked by policy XYZ" });
    expect(err.message).toBe("blocked by policy XYZ");
  });

  it("kernel isModerationError recognizes it (M2.X.6.x cross-provider)", () => {
    expect(isModerationError(new OpenAIContentFilteredError())).toBe(true);
  });
});
