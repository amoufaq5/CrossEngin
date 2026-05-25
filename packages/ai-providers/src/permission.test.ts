import { describe, expect, it } from "vitest";

import { PERMISSION_ERROR_KINDS, isPermissionError, isPermissionErrorKind } from "./permission.js";

describe("PERMISSION_ERROR_KINDS", () => {
  it("includes permission_error (HTTP 403 across all three providers)", () => {
    expect(PERMISSION_ERROR_KINDS).toContain("permission_error");
  });

  it("has exactly 1 kind today", () => {
    expect(PERMISSION_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes authentication_error (separate category — 403 vs 401)", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("authentication_error");
  });

  it("excludes retryable kinds", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(PERMISSION_ERROR_KINDS).not.toContain("network_error");
    expect(PERMISSION_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(PERMISSION_ERROR_KINDS).not.toContain("content_filtered");
    expect(PERMISSION_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes input-too-large kinds", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("request_too_large");
  });

  it("excludes conflict + not_found kinds", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("conflict_error");
    expect(PERMISSION_ERROR_KINDS).not.toContain("not_found_error");
  });

  it("excludes invalid_request_error", () => {
    expect(PERMISSION_ERROR_KINDS).not.toContain("invalid_request_error");
  });
});

describe("isPermissionErrorKind", () => {
  it("returns true for each kind in PERMISSION_ERROR_KINDS", () => {
    for (const kind of PERMISSION_ERROR_KINDS) {
      expect(isPermissionErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isPermissionErrorKind("authentication_error")).toBe(false);
    expect(isPermissionErrorKind("not_found_error")).toBe(false);
    expect(isPermissionErrorKind("conflict_error")).toBe(false);
    expect(isPermissionErrorKind("rate_limit_error")).toBe(false);
    expect(isPermissionErrorKind("invalid_request_error")).toBe(false);
    expect(isPermissionErrorKind("guardrail_intervened")).toBe(false);
    expect(isPermissionErrorKind("request_too_large")).toBe(false);
    expect(isPermissionErrorKind("unknown_error")).toBe(false);
    expect(isPermissionErrorKind("")).toBe(false);
  });
});

describe("isPermissionError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isPermissionError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPermissionError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isPermissionError("permission_error")).toBe(false);
    expect(isPermissionError(42)).toBe(false);
    expect(isPermissionError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isPermissionError({})).toBe(false);
    expect(isPermissionError({ message: "denied" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isPermissionError({ kind: 7 })).toBe(false);
    expect(isPermissionError({ kind: null })).toBe(false);
  });
});

describe("isPermissionError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for permission_error (HTTP 403)", () => {
    expect(isPermissionError(fakeProviderError("permission_error"))).toBe(true);
  });

  it("returns false for authentication_error (HTTP 401 — adjacent but distinct)", () => {
    expect(isPermissionError(fakeProviderError("authentication_error"))).toBe(false);
  });

  it("returns false for not_found_error (HTTP 404)", () => {
    expect(isPermissionError(fakeProviderError("not_found_error"))).toBe(false);
  });

  it("returns false for conflict_error", () => {
    expect(isPermissionError(fakeProviderError("conflict_error"))).toBe(false);
  });

  it("returns false for invalid_request_error", () => {
    expect(isPermissionError(fakeProviderError("invalid_request_error"))).toBe(false);
  });

  it("returns false for retryable kinds", () => {
    expect(isPermissionError(fakeProviderError("rate_limit_error"))).toBe(false);
    expect(isPermissionError(fakeProviderError("network_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isPermissionError(fakeProviderError("guardrail_intervened"))).toBe(false);
    expect(isPermissionError(fakeProviderError("content_filtered"))).toBe(false);
  });

  it("returns false for an Error with no kind field", () => {
    expect(isPermissionError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("permission_error");
    if (isPermissionError(err)) {
      const k: "permission_error" = err.kind;
      expect(k).toBe("permission_error");
    } else {
      throw new Error("expected isPermissionError to narrow");
    }
  });
});

describe("isAuthenticationError + isPermissionError composition", () => {
  function fake(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("operators can compose for 'any auth-related issue' via inline OR", async () => {
    const { isAuthenticationError } = await import("./authentication.js");
    const auth = fake("authentication_error");
    const perm = fake("permission_error");
    const notFound = fake("not_found_error");
    const isAnyAuthIssue = (err: unknown): boolean =>
      isAuthenticationError(err) || isPermissionError(err);
    expect(isAnyAuthIssue(auth)).toBe(true);
    expect(isAnyAuthIssue(perm)).toBe(true);
    expect(isAnyAuthIssue(notFound)).toBe(false);
  });
});
