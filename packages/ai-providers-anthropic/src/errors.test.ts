import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_ERROR_KINDS,
  AnthropicError,
  RETRYABLE_KINDS,
  classifyHttpStatus,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";

describe("ANTHROPIC_ERROR_KINDS", () => {
  it("includes the documented Anthropic error types", () => {
    expect(ANTHROPIC_ERROR_KINDS).toContain("invalid_request_error");
    expect(ANTHROPIC_ERROR_KINDS).toContain("rate_limit_error");
    expect(ANTHROPIC_ERROR_KINDS).toContain("overloaded_error");
  });
});

describe("classifyHttpStatus", () => {
  it("maps known statuses", () => {
    expect(classifyHttpStatus(400)).toBe("invalid_request_error");
    expect(classifyHttpStatus(401)).toBe("authentication_error");
    expect(classifyHttpStatus(403)).toBe("permission_error");
    expect(classifyHttpStatus(404)).toBe("not_found_error");
    expect(classifyHttpStatus(408)).toBe("timeout_error");
    expect(classifyHttpStatus(413)).toBe("request_too_large");
    expect(classifyHttpStatus(429)).toBe("rate_limit_error");
    expect(classifyHttpStatus(529)).toBe("overloaded_error");
    expect(classifyHttpStatus(500)).toBe("api_error");
    expect(classifyHttpStatus(503)).toBe("api_error");
  });

  it("returns unknown_error for unrecognized status", () => {
    expect(classifyHttpStatus(418)).toBe("unknown_error");
  });
});

describe("AnthropicError.isRetryable", () => {
  it("returns true for rate_limit / overloaded / network / timeout / api_error", () => {
    for (const kind of RETRYABLE_KINDS) {
      const err = new AnthropicError({ kind, message: "x" });
      expect(err.isRetryable()).toBe(true);
    }
  });

  it("returns false for authentication / permission / invalid_request", () => {
    for (const kind of ["authentication_error", "permission_error", "invalid_request_error"] as const) {
      const err = new AnthropicError({ kind, message: "x" });
      expect(err.isRetryable()).toBe(false);
    }
  });

  it("returns false for refusal (M2.X.6 — terminal)", () => {
    expect(
      new AnthropicError({ kind: "refusal", message: "x" }).isRetryable(),
    ).toBe(false);
  });
});

describe("fromHttpResponse", () => {
  it("parses Anthropic error envelope when body is JSON", () => {
    const err = fromHttpResponse({
      status: 429,
      body: JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests" } }),
    });
    expect(err.kind).toBe("rate_limit_error");
    expect(err.message).toBe("Too many requests");
    expect(err.status).toBe(429);
  });

  it("falls back to the status-based classification when body is non-JSON", () => {
    const err = fromHttpResponse({ status: 401, body: "<html>" });
    expect(err.kind).toBe("authentication_error");
    expect(err.message).toContain("401");
  });

  it("uses the body type even when it does not match the status classification", () => {
    const err = fromHttpResponse({
      status: 500,
      body: JSON.stringify({ error: { type: "overloaded_error", message: "Backend overloaded" } }),
    });
    expect(err.kind).toBe("overloaded_error");
  });

  it("ignores unrecognized body type fields", () => {
    const err = fromHttpResponse({
      status: 500,
      body: JSON.stringify({ error: { type: "made_up_kind", message: "x" } }),
    });
    expect(err.kind).toBe("api_error");
  });
});

describe("fromNetworkError", () => {
  it("returns timeout_error for AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(fromNetworkError(e).kind).toBe("timeout_error");
  });

  it("returns network_error otherwise", () => {
    expect(fromNetworkError(new Error("connect ECONNRESET")).kind).toBe("network_error");
  });

  it("handles non-Error throwables", () => {
    expect(fromNetworkError("string").kind).toBe("network_error");
  });
});
