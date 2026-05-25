import { describe, expect, it } from "vitest";

import { MODERATION_ERROR_KINDS, isModerationError, isModerationErrorKind } from "./moderation.js";

describe("MODERATION_ERROR_KINDS", () => {
  it("includes guardrail_intervened (Bedrock guardrail input/output block)", () => {
    expect(MODERATION_ERROR_KINDS).toContain("guardrail_intervened");
  });

  it("includes content_filtered (Bedrock guardrail OR OpenAI finish_reason='content_filter')", () => {
    expect(MODERATION_ERROR_KINDS).toContain("content_filtered");
  });

  it("includes refusal (Anthropic stop_reason='refusal')", () => {
    expect(MODERATION_ERROR_KINDS).toContain("refusal");
  });

  it("has exactly 3 kinds today (one per real provider's distinct moderation outcome)", () => {
    expect(MODERATION_ERROR_KINDS).toHaveLength(3);
  });
});

describe("isModerationErrorKind", () => {
  it("returns true for each kind in MODERATION_ERROR_KINDS", () => {
    for (const kind of MODERATION_ERROR_KINDS) {
      expect(isModerationErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isModerationErrorKind("rate_limit_error")).toBe(false);
    expect(isModerationErrorKind("authentication_error")).toBe(false);
    expect(isModerationErrorKind("api_error")).toBe(false);
    expect(isModerationErrorKind("")).toBe(false);
  });
});

describe("isModerationError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isModerationError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isModerationError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isModerationError("guardrail_intervened")).toBe(false);
    expect(isModerationError(42)).toBe(false);
    expect(isModerationError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isModerationError({})).toBe(false);
    expect(isModerationError({ message: "foo" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isModerationError({ kind: 7 })).toBe(false);
    expect(isModerationError({ kind: null })).toBe(false);
  });
});

describe("isModerationError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for an Error with kind='guardrail_intervened' (Bedrock guardrail)", () => {
    expect(isModerationError(fakeProviderError("guardrail_intervened"))).toBe(true);
  });

  it("returns true for an Error with kind='content_filtered' (Bedrock content filter OR OpenAI content_filter)", () => {
    expect(isModerationError(fakeProviderError("content_filtered"))).toBe(true);
  });

  it("returns true for an Error with kind='refusal' (Anthropic refusal)", () => {
    expect(isModerationError(fakeProviderError("refusal"))).toBe(true);
  });

  it("returns false for an Error with an unrelated kind", () => {
    expect(isModerationError(fakeProviderError("rate_limit_error"))).toBe(false);
    expect(isModerationError(fakeProviderError("api_error"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isModerationError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("refusal");
    if (isModerationError(err)) {
      // Type narrowing: err.kind is ModerationErrorKind here
      const k: "guardrail_intervened" | "content_filtered" | "refusal" = err.kind;
      expect(k).toBe("refusal");
    } else {
      throw new Error("expected isModerationError to narrow");
    }
  });
});
