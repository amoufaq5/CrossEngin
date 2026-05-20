import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_ERROR_KINDS,
  isAuthenticationError,
  isAuthenticationErrorKind,
} from "./authentication.js";

describe("AUTHENTICATION_ERROR_KINDS", () => {
  it("includes authentication_error (HTTP 401 across all three providers)", () => {
    expect(AUTHENTICATION_ERROR_KINDS).toContain("authentication_error");
  });

  it("has exactly 1 kind today", () => {
    expect(AUTHENTICATION_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes permission_error (separate category — 403 vs 401)", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("permission_error");
  });

  it("excludes retryable kinds (terminal — credentials must be fixed)", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("network_error");
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("content_filtered");
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes input-too-large kinds", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("request_too_large");
  });

  it("excludes conflict + not_found kinds", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("conflict_error");
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("not_found_error");
  });

  it("excludes invalid_request_error (request shape vs credentials)", () => {
    expect(AUTHENTICATION_ERROR_KINDS).not.toContain("invalid_request_error");
  });
});

describe("isAuthenticationErrorKind", () => {
  it("returns true for each kind in AUTHENTICATION_ERROR_KINDS", () => {
    for (const kind of AUTHENTICATION_ERROR_KINDS) {
      expect(isAuthenticationErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isAuthenticationErrorKind("permission_error")).toBe(false);
    expect(isAuthenticationErrorKind("not_found_error")).toBe(false);
    expect(isAuthenticationErrorKind("conflict_error")).toBe(false);
    expect(isAuthenticationErrorKind("rate_limit_error")).toBe(false);
    expect(isAuthenticationErrorKind("invalid_request_error")).toBe(false);
    expect(isAuthenticationErrorKind("guardrail_intervened")).toBe(false);
    expect(isAuthenticationErrorKind("request_too_large")).toBe(false);
    expect(isAuthenticationErrorKind("unknown_error")).toBe(false);
    expect(isAuthenticationErrorKind("")).toBe(false);
  });
});

describe("isAuthenticationError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isAuthenticationError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAuthenticationError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isAuthenticationError("authentication_error")).toBe(false);
    expect(isAuthenticationError(42)).toBe(false);
    expect(isAuthenticationError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isAuthenticationError({})).toBe(false);
    expect(isAuthenticationError({ message: "bad creds" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isAuthenticationError({ kind: 7 })).toBe(false);
    expect(isAuthenticationError({ kind: null })).toBe(false);
  });
});

describe("isAuthenticationError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for authentication_error (HTTP 401)", () => {
    expect(isAuthenticationError(fakeProviderError("authentication_error"))).toBe(
      true,
    );
  });

  it("returns false for permission_error (HTTP 403 — adjacent but distinct)", () => {
    expect(isAuthenticationError(fakeProviderError("permission_error"))).toBe(
      false,
    );
  });

  it("returns false for not_found_error", () => {
    expect(isAuthenticationError(fakeProviderError("not_found_error"))).toBe(false);
  });

  it("returns false for conflict_error", () => {
    expect(isAuthenticationError(fakeProviderError("conflict_error"))).toBe(false);
  });

  it("returns false for invalid_request_error", () => {
    expect(isAuthenticationError(fakeProviderError("invalid_request_error"))).toBe(
      false,
    );
  });

  it("returns false for retryable kinds", () => {
    expect(isAuthenticationError(fakeProviderError("rate_limit_error"))).toBe(false);
    expect(isAuthenticationError(fakeProviderError("network_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isAuthenticationError(fakeProviderError("guardrail_intervened"))).toBe(
      false,
    );
    expect(isAuthenticationError(fakeProviderError("content_filtered"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isAuthenticationError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("authentication_error");
    if (isAuthenticationError(err)) {
      const k: "authentication_error" = err.kind;
      expect(k).toBe("authentication_error");
    } else {
      throw new Error("expected isAuthenticationError to narrow");
    }
  });
});
