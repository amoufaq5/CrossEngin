import { describe, expect, it } from "vitest";

import {
  RETRYABLE_ERROR_KINDS,
  isRetryableError,
  isRetryableErrorKind,
} from "./retryable.js";

describe("RETRYABLE_ERROR_KINDS", () => {
  it("includes the five kinds shared by all three providers", () => {
    expect(RETRYABLE_ERROR_KINDS).toContain("rate_limit_error");
    expect(RETRYABLE_ERROR_KINDS).toContain("overloaded_error");
    expect(RETRYABLE_ERROR_KINDS).toContain("network_error");
    expect(RETRYABLE_ERROR_KINDS).toContain("timeout_error");
    expect(RETRYABLE_ERROR_KINDS).toContain("api_error");
  });

  it("includes model_stream_error (Bedrock-specific but treated as retryable kernel-wide)", () => {
    expect(RETRYABLE_ERROR_KINDS).toContain("model_stream_error");
  });

  it("has exactly 6 retryable kinds today", () => {
    expect(RETRYABLE_ERROR_KINDS).toHaveLength(6);
  });

  it("excludes terminal moderation kinds", () => {
    expect(RETRYABLE_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("content_filtered");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes terminal auth / permission / not_found / invalid_request kinds", () => {
    expect(RETRYABLE_ERROR_KINDS).not.toContain("authentication_error");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("permission_error");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("not_found_error");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("invalid_request_error");
    expect(RETRYABLE_ERROR_KINDS).not.toContain("request_too_large");
  });
});

describe("isRetryableErrorKind", () => {
  it("returns true for each kind in RETRYABLE_ERROR_KINDS", () => {
    for (const kind of RETRYABLE_ERROR_KINDS) {
      expect(isRetryableErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for terminal kinds", () => {
    expect(isRetryableErrorKind("authentication_error")).toBe(false);
    expect(isRetryableErrorKind("invalid_request_error")).toBe(false);
    expect(isRetryableErrorKind("permission_error")).toBe(false);
    expect(isRetryableErrorKind("not_found_error")).toBe(false);
    expect(isRetryableErrorKind("content_filtered")).toBe(false);
    expect(isRetryableErrorKind("guardrail_intervened")).toBe(false);
    expect(isRetryableErrorKind("refusal")).toBe(false);
    expect(isRetryableErrorKind("unknown_error")).toBe(false);
    expect(isRetryableErrorKind("")).toBe(false);
  });
});

describe("isRetryableError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isRetryableError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRetryableError("rate_limit_error")).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isRetryableError({})).toBe(false);
    expect(isRetryableError({ message: "boom" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isRetryableError({ kind: 7 })).toBe(false);
    expect(isRetryableError({ kind: null })).toBe(false);
  });
});

describe("isRetryableError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for rate_limit_error", () => {
    expect(isRetryableError(fakeProviderError("rate_limit_error"))).toBe(true);
  });

  it("returns true for overloaded_error", () => {
    expect(isRetryableError(fakeProviderError("overloaded_error"))).toBe(true);
  });

  it("returns true for network_error", () => {
    expect(isRetryableError(fakeProviderError("network_error"))).toBe(true);
  });

  it("returns true for timeout_error", () => {
    expect(isRetryableError(fakeProviderError("timeout_error"))).toBe(true);
  });

  it("returns true for api_error", () => {
    expect(isRetryableError(fakeProviderError("api_error"))).toBe(true);
  });

  it("returns true for model_stream_error (Bedrock)", () => {
    expect(isRetryableError(fakeProviderError("model_stream_error"))).toBe(true);
  });

  it("returns false for authentication_error (terminal)", () => {
    expect(isRetryableError(fakeProviderError("authentication_error"))).toBe(false);
  });

  it("returns false for invalid_request_error (terminal)", () => {
    expect(isRetryableError(fakeProviderError("invalid_request_error"))).toBe(false);
  });

  it("returns false for moderation kinds (terminal)", () => {
    expect(isRetryableError(fakeProviderError("guardrail_intervened"))).toBe(false);
    expect(isRetryableError(fakeProviderError("content_filtered"))).toBe(false);
    expect(isRetryableError(fakeProviderError("refusal"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("rate_limit_error");
    if (isRetryableError(err)) {
      const k:
        | "rate_limit_error"
        | "overloaded_error"
        | "network_error"
        | "timeout_error"
        | "api_error"
        | "model_stream_error" = err.kind;
      expect(k).toBe("rate_limit_error");
    } else {
      throw new Error("expected isRetryableError to narrow");
    }
  });
});
