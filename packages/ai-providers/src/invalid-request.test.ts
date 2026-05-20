import { describe, expect, it } from "vitest";

import {
  INVALID_REQUEST_ERROR_KINDS,
  isInvalidRequestError,
  isInvalidRequestErrorKind,
} from "./invalid-request.js";

describe("INVALID_REQUEST_ERROR_KINDS", () => {
  it("includes invalid_request_error (HTTP 400 across all three providers)", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).toContain("invalid_request_error");
  });

  it("has exactly 1 kind today", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).toHaveLength(1);
  });

  it("excludes retryable kinds (terminal — fix the request)", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("rate_limit_error");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("network_error");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("api_error");
  });

  it("excludes moderation kinds", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("guardrail_intervened");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("content_filtered");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("refusal");
  });

  it("excludes input-too-large kinds (separate 413 category)", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("request_too_large");
  });

  it("excludes auth + permission + not-found + conflict kinds", () => {
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("authentication_error");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("permission_error");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("not_found_error");
    expect(INVALID_REQUEST_ERROR_KINDS).not.toContain("conflict_error");
  });
});

describe("isInvalidRequestErrorKind", () => {
  it("returns true for each kind in INVALID_REQUEST_ERROR_KINDS", () => {
    for (const kind of INVALID_REQUEST_ERROR_KINDS) {
      expect(isInvalidRequestErrorKind(kind)).toBe(true);
    }
  });

  it("returns false for unrelated kinds", () => {
    expect(isInvalidRequestErrorKind("authentication_error")).toBe(false);
    expect(isInvalidRequestErrorKind("permission_error")).toBe(false);
    expect(isInvalidRequestErrorKind("not_found_error")).toBe(false);
    expect(isInvalidRequestErrorKind("conflict_error")).toBe(false);
    expect(isInvalidRequestErrorKind("rate_limit_error")).toBe(false);
    expect(isInvalidRequestErrorKind("guardrail_intervened")).toBe(false);
    expect(isInvalidRequestErrorKind("request_too_large")).toBe(false);
    expect(isInvalidRequestErrorKind("unknown_error")).toBe(false);
    expect(isInvalidRequestErrorKind("")).toBe(false);
  });
});

describe("isInvalidRequestError — non-error inputs", () => {
  it("returns false for null", () => {
    expect(isInvalidRequestError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isInvalidRequestError(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isInvalidRequestError("invalid_request_error")).toBe(false);
    expect(isInvalidRequestError(42)).toBe(false);
    expect(isInvalidRequestError(true)).toBe(false);
  });

  it("returns false for plain objects with no kind", () => {
    expect(isInvalidRequestError({})).toBe(false);
    expect(isInvalidRequestError({ message: "bad shape" })).toBe(false);
  });

  it("returns false for objects whose kind isn't a string", () => {
    expect(isInvalidRequestError({ kind: 7 })).toBe(false);
    expect(isInvalidRequestError({ kind: null })).toBe(false);
  });
});

describe("isInvalidRequestError — Error-shaped inputs", () => {
  function fakeProviderError(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("returns true for invalid_request_error (HTTP 400)", () => {
    expect(isInvalidRequestError(fakeProviderError("invalid_request_error"))).toBe(
      true,
    );
  });

  it("returns false for request_too_large (separate 413 category)", () => {
    expect(isInvalidRequestError(fakeProviderError("request_too_large"))).toBe(
      false,
    );
  });

  it("returns false for authentication_error", () => {
    expect(isInvalidRequestError(fakeProviderError("authentication_error"))).toBe(
      false,
    );
  });

  it("returns false for permission_error", () => {
    expect(isInvalidRequestError(fakeProviderError("permission_error"))).toBe(
      false,
    );
  });

  it("returns false for not_found_error", () => {
    expect(isInvalidRequestError(fakeProviderError("not_found_error"))).toBe(
      false,
    );
  });

  it("returns false for conflict_error", () => {
    expect(isInvalidRequestError(fakeProviderError("conflict_error"))).toBe(false);
  });

  it("returns false for retryable kinds", () => {
    expect(isInvalidRequestError(fakeProviderError("rate_limit_error"))).toBe(
      false,
    );
    expect(isInvalidRequestError(fakeProviderError("network_error"))).toBe(false);
  });

  it("returns false for moderation kinds", () => {
    expect(isInvalidRequestError(fakeProviderError("guardrail_intervened"))).toBe(
      false,
    );
    expect(isInvalidRequestError(fakeProviderError("content_filtered"))).toBe(
      false,
    );
  });

  it("returns false for an Error with no kind field", () => {
    expect(isInvalidRequestError(new Error("boom"))).toBe(false);
  });

  it("narrows the type so accessing err.kind is type-safe in TS", () => {
    const err: unknown = fakeProviderError("invalid_request_error");
    if (isInvalidRequestError(err)) {
      const k: "invalid_request_error" = err.kind;
      expect(k).toBe("invalid_request_error");
    } else {
      throw new Error("expected isInvalidRequestError to narrow");
    }
  });
});

describe("8-classifier mutual exclusivity (canonical 4xx/5xx sweep)", () => {
  function fake(kind: string): Error & { kind: string } {
    const err = new Error("test") as Error & { kind: string };
    err.kind = kind;
    return err;
  }

  it("invalid_request_error matches exactly one classifier", async () => {
    const { isModerationError } = await import("./moderation.js");
    const { isRetryableError } = await import("./retryable.js");
    const { isInputTooLargeError } = await import("./input-too-large.js");
    const { isConflictError } = await import("./conflict.js");
    const { isNotFoundError } = await import("./not-found.js");
    const { isAuthenticationError } = await import("./authentication.js");
    const { isPermissionError } = await import("./permission.js");
    const err = fake("invalid_request_error");
    const matches = [
      isModerationError(err),
      isRetryableError(err),
      isInputTooLargeError(err),
      isConflictError(err),
      isNotFoundError(err),
      isAuthenticationError(err),
      isPermissionError(err),
      isInvalidRequestError(err),
    ];
    expect(matches.filter((b) => b)).toHaveLength(1);
    expect(matches[7]).toBe(true);
  });
});
