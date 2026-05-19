import { describe, expect, it } from "vitest";

import {
  INPUT_TOO_LARGE_ERROR_KINDS,
  isInputTooLargeError,
  isInputTooLargeErrorKind,
} from "./input-too-large.js";

describe("INPUT_TOO_LARGE_ERROR_KINDS", () => {
  it("includes request_too_large (HTTP 413 across all three providers)", () => {
    expect(INPUT_TOO_LARGE_ERROR_KINDS).toContain("request_too_large");
  });

  it("has exactly 1 kind today", () => {
    expect(INPUT_TOO_LARGE_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes retryable kinds (terminal — operator must reduce input)", () => {
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("network_error");
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("content_filtered");
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes invalid_request_error (separate category)", () => {
    expect(INPUT_TOO_LARGE_ERROR_KINDS).not.toContain("invalid_request_error");
  });
});

describe("isInputTooLargeErrorKind", () => {
  it("returns true for each kind in INPUT_TOO_LARGE_ERROR_KINDS", () => {
    for (const kind of INPUT_TOO_LARGE_ERROR_KINDS) {
      expect(isInputTooLargeErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isInputTooLargeErrorKind("rate_limit_error")).toBe(false);
    expect(isInputTooLargeErrorKind("authentication_error")).toBe(false);
    expect(isInputTooLargeErrorKind("invalid_request_error")).toBe(false);
    expect(isInputTooLargeErrorKind("guardrail_intervened")).toBe(false);
    expect(isInputTooLargeErrorKind("")).toBe(false);
  });
});

describe("isInputTooLargeError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isInputTooLargeError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isInputTooLargeError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isInputTooLargeError("request_too_large")).toBe(false);
    expect(isInputTooLargeError(42)).toBe(false);
    expect(isInputTooLargeError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isInputTooLargeError({})).toBe(false);
    expect(isInputTooLargeError({ message: "huge" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isInputTooLargeError({ kind: 7 })).toBe(false);
    expect(isInputTooLargeError({ kind: null })).toBe(false);
  });
});

describe("isInputTooLargeError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for request_too_large (HTTP 413)", () => {
    expect(isInputTooLargeError(fakeProviderError("request_too_large"))).toBe(true);
  });

  it("returns false for invalid_request_error (separate category)", () => {
    expect(isInputTooLargeError(fakeProviderError("invalid_request_error"))).toBe(
      false,
    );
  });

  it("returns false for retryable kinds (e.g. rate_limit)", () => {
    expect(isInputTooLargeError(fakeProviderError("rate_limit_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isInputTooLargeError(fakeProviderError("guardrail_intervened"))).toBe(false);
    expect(isInputTooLargeError(fakeProviderError("content_filtered"))).toBe(false);
    expect(isInputTooLargeError(fakeProviderError("refusal"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isInputTooLargeError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("request_too_large");
    if (isInputTooLargeError(err)) {
      const k: "request_too_large" = err.kind;
      expect(k).toBe("request_too_large");
    } else {
      throw new Error("expected isInputTooLargeError to narrow");
    }
  });
});
