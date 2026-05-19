import { describe, expect, it } from "vitest";

import {
  OPENAI_ERROR_KINDS,
  OpenAIError,
  RETRYABLE_KINDS,
  classifyHttpStatus,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";

describe("OPENAI_ERROR_KINDS", () => {
  it("covers the documented OpenAI error envelope kinds", () => {
    expect(OPENAI_ERROR_KINDS).toContain("invalid_request_error");
    expect(OPENAI_ERROR_KINDS).toContain("rate_limit_error");
    expect(OPENAI_ERROR_KINDS).toContain("authentication_error");
  });
});

describe("classifyHttpStatus", () => {
  it("maps the standard HTTP status codes", () => {
    expect(classifyHttpStatus(400)).toBe("invalid_request_error");
    expect(classifyHttpStatus(401)).toBe("authentication_error");
    expect(classifyHttpStatus(403)).toBe("permission_error");
    expect(classifyHttpStatus(404)).toBe("not_found_error");
    expect(classifyHttpStatus(408)).toBe("timeout_error");
    expect(classifyHttpStatus(413)).toBe("request_too_large");
    expect(classifyHttpStatus(429)).toBe("rate_limit_error");
    expect(classifyHttpStatus(500)).toBe("api_error");
    expect(classifyHttpStatus(503)).toBe("api_error");
  });

  it("returns unknown_error for unrecognized status", () => {
    expect(classifyHttpStatus(418)).toBe("unknown_error");
  });
});

describe("OpenAIError.isRetryable", () => {
  it("returns true for retryable kinds", () => {
    for (const kind of RETRYABLE_KINDS) {
      const err = new OpenAIError({ kind, message: "x" });
      expect(err.isRetryable()).toBe(true);
    }
  });

  it("returns false for non-retryable kinds", () => {
    for (const kind of [
      "authentication_error",
      "permission_error",
      "invalid_request_error",
    ] as const) {
      const err = new OpenAIError({ kind, message: "x" });
      expect(err.isRetryable()).toBe(false);
    }
  });

  it("returns false for content_filtered (M2.X.6 — terminal)", () => {
    expect(
      new OpenAIError({ kind: "content_filtered", message: "x" }).isRetryable(),
    ).toBe(false);
  });
});

describe("OpenAIError x kernel isRetryableError (M2.X.7)", () => {
  it("kernel isRetryableError matches OpenAI.isRetryable() for the shared retryable kinds", async () => {
    const { isRetryableError } = await import("@crossengin/ai-providers");
    for (const kind of [
      "rate_limit_error",
      "overloaded_error",
      "network_error",
      "timeout_error",
      "api_error",
    ] as const) {
      const err = new OpenAIError({ kind, message: "x" });
      expect(isRetryableError(err)).toBe(true);
      expect(err.isRetryable()).toBe(true);
    }
  });

  it("kernel isRetryableError returns false for content_filtered + authentication_error", async () => {
    const { isRetryableError } = await import("@crossengin/ai-providers");
    expect(
      isRetryableError(new OpenAIError({ kind: "content_filtered", message: "" })),
    ).toBe(false);
    expect(
      isRetryableError(new OpenAIError({ kind: "authentication_error", message: "" })),
    ).toBe(false);
  });
});

describe("OpenAIError x kernel isInputTooLargeError (M2.X.9)", () => {
  it("kernel isInputTooLargeError recognizes request_too_large", async () => {
    const { isInputTooLargeError } = await import("@crossengin/ai-providers");
    const err = new OpenAIError({ kind: "request_too_large", message: "" });
    expect(isInputTooLargeError(err)).toBe(true);
    expect(err.isRetryable()).toBe(false);
  });

  it("kernel isInputTooLargeError returns false for other kinds", async () => {
    const { isInputTooLargeError } = await import("@crossengin/ai-providers");
    expect(
      isInputTooLargeError(new OpenAIError({ kind: "rate_limit_error", message: "" })),
    ).toBe(false);
    expect(
      isInputTooLargeError(new OpenAIError({ kind: "content_filtered", message: "" })),
    ).toBe(false);
  });
});

describe("fromHttpResponse", () => {
  it("parses OpenAI's error envelope when body is JSON", () => {
    const err = fromHttpResponse({
      status: 429,
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "slow down", code: "rate_limit" },
      }),
    });
    expect(err.kind).toBe("rate_limit_error");
    expect(err.message).toBe("slow down");
    expect(err.code).toBe("rate_limit");
    expect(err.status).toBe(429);
  });

  it("maps rate_limit_exceeded type → rate_limit_error kind", () => {
    const err = fromHttpResponse({
      status: 429,
      body: JSON.stringify({
        error: { type: "rate_limit_exceeded", message: "too fast" },
      }),
    });
    expect(err.kind).toBe("rate_limit_error");
  });

  it("falls back to status-based classification when body is non-JSON", () => {
    const err = fromHttpResponse({ status: 401, body: "<html>" });
    expect(err.kind).toBe("authentication_error");
    expect(err.message).toContain("401");
  });

  it("ignores unknown body type fields and keeps status mapping", () => {
    const err = fromHttpResponse({
      status: 500,
      body: JSON.stringify({ error: { type: "made_up", message: "x" } }),
    });
    expect(err.kind).toBe("api_error");
    expect(err.message).toBe("x");
  });
});

describe("fromNetworkError", () => {
  it("returns timeout_error for AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(fromNetworkError(e).kind).toBe("timeout_error");
  });

  it("returns network_error otherwise", () => {
    expect(fromNetworkError(new Error("ECONNRESET")).kind).toBe("network_error");
  });

  it("handles non-Error throwables", () => {
    expect(fromNetworkError("string").kind).toBe("network_error");
  });
});
