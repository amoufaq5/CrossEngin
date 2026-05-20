import { describe, expect, it } from "vitest";

import {
  NOT_FOUND_ERROR_KINDS,
  isNotFoundError,
  isNotFoundErrorKind,
} from "./not-found.js";

describe("NOT_FOUND_ERROR_KINDS", () => {
  it("includes not_found_error (HTTP 404 across all three providers)", () => {
    expect(NOT_FOUND_ERROR_KINDS).toContain("not_found_error");
  });

  it("has exactly 1 kind today", () => {
    expect(NOT_FOUND_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes retryable kinds (terminal — resource doesn't exist)", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("network_error");
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("content_filtered");
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes input-too-large kinds", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("request_too_large");
  });

  it("excludes conflict kinds (separate category — state vs absence)", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("conflict_error");
  });

  it("excludes invalid_request_error (separate category — request shape vs resource absence)", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("invalid_request_error");
  });

  it("excludes authentication_error (separate category — credentials vs resource absence)", () => {
    expect(NOT_FOUND_ERROR_KINDS).not.toContain("authentication_error");
  });
});

describe("isNotFoundErrorKind", () => {
  it("returns true for each kind in NOT_FOUND_ERROR_KINDS", () => {
    for (const kind of NOT_FOUND_ERROR_KINDS) {
      expect(isNotFoundErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isNotFoundErrorKind("rate_limit_error")).toBe(false);
    expect(isNotFoundErrorKind("authentication_error")).toBe(false);
    expect(isNotFoundErrorKind("invalid_request_error")).toBe(false);
    expect(isNotFoundErrorKind("conflict_error")).toBe(false);
    expect(isNotFoundErrorKind("permission_error")).toBe(false);
    expect(isNotFoundErrorKind("guardrail_intervened")).toBe(false);
    expect(isNotFoundErrorKind("request_too_large")).toBe(false);
    expect(isNotFoundErrorKind("unknown_error")).toBe(false);
    expect(isNotFoundErrorKind("")).toBe(false);
  });
});

describe("isNotFoundError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isNotFoundError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isNotFoundError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isNotFoundError("not_found_error")).toBe(false);
    expect(isNotFoundError(42)).toBe(false);
    expect(isNotFoundError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isNotFoundError({})).toBe(false);
    expect(isNotFoundError({ message: "missing" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isNotFoundError({ kind: 7 })).toBe(false);
    expect(isNotFoundError({ kind: null })).toBe(false);
  });
});

describe("isNotFoundError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for not_found_error (HTTP 404)", () => {
    expect(isNotFoundError(fakeProviderError("not_found_error"))).toBe(true);
  });

  it("returns false for permission_error (adjacent but distinct — 403 vs 404)", () => {
    expect(isNotFoundError(fakeProviderError("permission_error"))).toBe(false);
  });

  it("returns false for invalid_request_error (separate category)", () => {
    expect(isNotFoundError(fakeProviderError("invalid_request_error"))).toBe(false);
  });

  it("returns false for conflict_error (state conflict, not absence)", () => {
    expect(isNotFoundError(fakeProviderError("conflict_error"))).toBe(false);
  });

  it("returns false for retryable kinds", () => {
    expect(isNotFoundError(fakeProviderError("rate_limit_error"))).toBe(false);
    expect(isNotFoundError(fakeProviderError("network_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isNotFoundError(fakeProviderError("guardrail_intervened"))).toBe(false);
    expect(isNotFoundError(fakeProviderError("content_filtered"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isNotFoundError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("not_found_error");
    if (isNotFoundError(err)) {
      const k: "not_found_error" = err.kind;
      expect(k).toBe("not_found_error");
    } else {
      throw new Error("expected isNotFoundError to narrow");
    }
  });
});
