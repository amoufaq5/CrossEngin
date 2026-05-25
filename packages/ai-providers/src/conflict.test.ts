import { describe, expect, it } from "vitest";

import { CONFLICT_ERROR_KINDS, isConflictError, isConflictErrorKind } from "./conflict.js";

describe("CONFLICT_ERROR_KINDS", () => {
  it("includes conflict_error (HTTP 409 across providers that surface state conflicts)", () => {
    expect(CONFLICT_ERROR_KINDS).toContain("conflict_error");
  });

  it("has exactly 1 kind today", () => {
    expect(CONFLICT_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes retryable kinds (terminal — operator must reconcile state)", () => {
    expect(CONFLICT_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(CONFLICT_ERROR_KINDS).not.toContain("network_error");
    expect(CONFLICT_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(CONFLICT_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(CONFLICT_ERROR_KINDS).not.toContain("content_filtered");
    expect(CONFLICT_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes input-too-large kinds", () => {
    expect(CONFLICT_ERROR_KINDS).not.toContain("request_too_large");
  });

  it("excludes invalid_request_error (separate category)", () => {
    expect(CONFLICT_ERROR_KINDS).not.toContain("invalid_request_error");
  });

  it("excludes not_found_error (separate category)", () => {
    expect(CONFLICT_ERROR_KINDS).not.toContain("not_found_error");
  });
});

describe("isConflictErrorKind", () => {
  it("returns true for each kind in CONFLICT_ERROR_KINDS", () => {
    for (const kind of CONFLICT_ERROR_KINDS) {
      expect(isConflictErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isConflictErrorKind("rate_limit_error")).toBe(false);
    expect(isConflictErrorKind("authentication_error")).toBe(false);
    expect(isConflictErrorKind("invalid_request_error")).toBe(false);
    expect(isConflictErrorKind("not_found_error")).toBe(false);
    expect(isConflictErrorKind("guardrail_intervened")).toBe(false);
    expect(isConflictErrorKind("request_too_large")).toBe(false);
    expect(isConflictErrorKind("unknown_error")).toBe(false);
    expect(isConflictErrorKind("")).toBe(false);
  });
});

describe("isConflictError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isConflictError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isConflictError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isConflictError("conflict_error")).toBe(false);
    expect(isConflictError(42)).toBe(false);
    expect(isConflictError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isConflictError({})).toBe(false);
    expect(isConflictError({ message: "conflict" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isConflictError({ kind: 7 })).toBe(false);
    expect(isConflictError({ kind: null })).toBe(false);
  });
});

describe("isConflictError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for conflict_error (HTTP 409)", () => {
    expect(isConflictError(fakeProviderError("conflict_error"))).toBe(true);
  });

  it("returns false for invalid_request_error (separate category)", () => {
    expect(isConflictError(fakeProviderError("invalid_request_error"))).toBe(false);
  });

  it("returns false for retryable kinds", () => {
    expect(isConflictError(fakeProviderError("rate_limit_error"))).toBe(false);
    expect(isConflictError(fakeProviderError("network_error"))).toBe(false);
  });

  it("returns false for not_found_error", () => {
    expect(isConflictError(fakeProviderError("not_found_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isConflictError(fakeProviderError("guardrail_intervened"))).toBe(false);
    expect(isConflictError(fakeProviderError("content_filtered"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isConflictError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("conflict_error");
    if (isConflictError(err)) {
      const k: "conflict_error" = err.kind;
      expect(k).toBe("conflict_error");
    } else {
      throw new Error("expected isConflictError to narrow");
    }
  });
});
