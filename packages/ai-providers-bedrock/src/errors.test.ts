import { describe, expect, it } from "vitest";

import {
  BedrockError,
  RETRYABLE_KINDS,
  classifyHttpStatus,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";

describe("BedrockError", () => {
  it("captures kind + status + code + message", () => {
    const err = new BedrockError({
      kind: "rate_limit_error",
      message: "slow down",
      status: 429,
      code: "ThrottlingException",
    });
    expect(err.kind).toBe("rate_limit_error");
    expect(err.status).toBe(429);
    expect(err.code).toBe("ThrottlingException");
    expect(err.message).toBe("slow down");
    expect(err.name).toBe("BedrockError");
  });

  it("isRetryable returns true for transient kinds", () => {
    expect(new BedrockError({ kind: "rate_limit_error", message: "" }).isRetryable()).toBe(true);
    expect(new BedrockError({ kind: "overloaded_error", message: "" }).isRetryable()).toBe(true);
    expect(new BedrockError({ kind: "network_error", message: "" }).isRetryable()).toBe(true);
    expect(new BedrockError({ kind: "timeout_error", message: "" }).isRetryable()).toBe(true);
    expect(new BedrockError({ kind: "api_error", message: "" }).isRetryable()).toBe(true);
    expect(new BedrockError({ kind: "model_stream_error", message: "" }).isRetryable()).toBe(true);
  });

  it("isRetryable returns false for permanent kinds", () => {
    expect(new BedrockError({ kind: "authentication_error", message: "" }).isRetryable()).toBe(
      false,
    );
    expect(new BedrockError({ kind: "invalid_request_error", message: "" }).isRetryable()).toBe(
      false,
    );
    expect(new BedrockError({ kind: "not_found_error", message: "" }).isRetryable()).toBe(false);
    expect(new BedrockError({ kind: "permission_error", message: "" }).isRetryable()).toBe(false);
  });

  it("isRetryable returns false for guardrail_intervened + content_filtered (M2.9.8)", () => {
    expect(new BedrockError({ kind: "guardrail_intervened", message: "" }).isRetryable()).toBe(
      false,
    );
    expect(new BedrockError({ kind: "content_filtered", message: "" }).isRetryable()).toBe(false);
  });
});

describe("BedrockError x kernel isRetryableError (M2.X.7)", () => {
  it("kernel isRetryableError matches Bedrock.isRetryable() for retryable kinds", async () => {
    const { isRetryableError } = await import("@crossengin/ai-providers");
    for (const kind of [
      "rate_limit_error",
      "overloaded_error",
      "network_error",
      "timeout_error",
      "api_error",
      "model_stream_error",
    ] as const) {
      const err = new BedrockError({ kind, message: "x" });
      expect(isRetryableError(err)).toBe(true);
      expect(err.isRetryable()).toBe(true);
    }
  });

  it("kernel isRetryableError returns false for moderation + auth kinds", async () => {
    const { isRetryableError } = await import("@crossengin/ai-providers");
    expect(isRetryableError(new BedrockError({ kind: "guardrail_intervened", message: "" }))).toBe(
      false,
    );
    expect(isRetryableError(new BedrockError({ kind: "authentication_error", message: "" }))).toBe(
      false,
    );
  });
});

describe("BedrockError x kernel isInputTooLargeError (M2.X.9)", () => {
  it("kernel isInputTooLargeError recognizes request_too_large", async () => {
    const { isInputTooLargeError } = await import("@crossengin/ai-providers");
    const err = new BedrockError({ kind: "request_too_large", message: "" });
    expect(isInputTooLargeError(err)).toBe(true);
    expect(err.isRetryable()).toBe(false);
  });

  it("kernel isInputTooLargeError returns false for other kinds", async () => {
    const { isInputTooLargeError } = await import("@crossengin/ai-providers");
    expect(isInputTooLargeError(new BedrockError({ kind: "rate_limit_error", message: "" }))).toBe(
      false,
    );
    expect(
      isInputTooLargeError(new BedrockError({ kind: "invalid_request_error", message: "" })),
    ).toBe(false);
  });
});

describe("RETRYABLE_KINDS", () => {
  it("excludes auth + invalid + not_found + permission", () => {
    expect(RETRYABLE_KINDS.has("authentication_error")).toBe(false);
    expect(RETRYABLE_KINDS.has("invalid_request_error")).toBe(false);
    expect(RETRYABLE_KINDS.has("not_found_error")).toBe(false);
    expect(RETRYABLE_KINDS.has("permission_error")).toBe(false);
  });
});

describe("classifyHttpStatus", () => {
  it("maps the documented status codes", () => {
    expect(classifyHttpStatus(400)).toBe("invalid_request_error");
    expect(classifyHttpStatus(401)).toBe("authentication_error");
    expect(classifyHttpStatus(403)).toBe("authentication_error");
    expect(classifyHttpStatus(404)).toBe("not_found_error");
    expect(classifyHttpStatus(408)).toBe("timeout_error");
    expect(classifyHttpStatus(413)).toBe("request_too_large");
    expect(classifyHttpStatus(424)).toBe("model_stream_error");
    expect(classifyHttpStatus(429)).toBe("rate_limit_error");
    expect(classifyHttpStatus(500)).toBe("api_error");
    expect(classifyHttpStatus(503)).toBe("overloaded_error");
    expect(classifyHttpStatus(599)).toBe("api_error");
    expect(classifyHttpStatus(200)).toBe("unknown_error");
  });
});

describe("fromHttpResponse", () => {
  it("parses AWS __type + message + maps to kind", () => {
    const err = fromHttpResponse({
      status: 429,
      body: JSON.stringify({
        __type: "com.amazon.bedrock#ThrottlingException",
        message: "Too many requests for tenant",
      }),
    });
    expect(err.kind).toBe("rate_limit_error");
    expect(err.code).toBe("ThrottlingException");
    expect(err.message).toContain("Too many requests");
    expect(err.status).toBe(429);
  });

  it("maps ValidationException → invalid_request_error", () => {
    const err = fromHttpResponse({
      status: 400,
      body: JSON.stringify({
        __type: "ValidationException",
        message: "messages array is required",
      }),
    });
    expect(err.kind).toBe("invalid_request_error");
    expect(err.code).toBe("ValidationException");
  });

  it("maps ServiceUnavailableException → overloaded_error", () => {
    const err = fromHttpResponse({
      status: 503,
      body: JSON.stringify({
        __type: "ServiceUnavailableException",
        message: "Bedrock service is overloaded",
      }),
    });
    expect(err.kind).toBe("overloaded_error");
    expect(err.code).toBe("ServiceUnavailableException");
  });

  it("maps ExpiredTokenException → authentication_error", () => {
    const err = fromHttpResponse({
      status: 403,
      body: JSON.stringify({
        __type: "ExpiredTokenException",
        message: "credentials expired",
      }),
    });
    expect(err.kind).toBe("authentication_error");
  });

  it("accepts Message (capital M) form too", () => {
    const err = fromHttpResponse({
      status: 400,
      body: JSON.stringify({
        Message: "capital-M message",
      }),
    });
    expect(err.message).toBe("capital-M message");
  });

  it("falls back to status-based classification when body isn't JSON", () => {
    const err = fromHttpResponse({ status: 500, body: "<html>oops</html>" });
    expect(err.kind).toBe("api_error");
    expect(err.message).toContain("status 500");
  });
});

describe("fromNetworkError", () => {
  it("detects AbortError as timeout", () => {
    const err = fromNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(err.kind).toBe("timeout_error");
  });

  it("detects 'timeout' in message as timeout", () => {
    const err = fromNetworkError(new Error("Connection Timeout"));
    expect(err.kind).toBe("timeout_error");
  });

  it("falls back to network_error for other failures", () => {
    const err = fromNetworkError(new Error("ECONNRESET"));
    expect(err.kind).toBe("network_error");
  });

  it("handles non-Error throws", () => {
    const err = fromNetworkError("just a string");
    expect(err.kind).toBe("network_error");
  });
});

describe("BedrockError — conflict_error (M2.X.12)", () => {
  it("classifyHttpStatus(409) returns conflict_error", () => {
    expect(classifyHttpStatus(409)).toBe("conflict_error");
  });

  it("fromHttpResponse maps ConflictException → conflict_error", () => {
    const err = fromHttpResponse({
      status: 409,
      body: JSON.stringify({
        __type: "ConflictException",
        message: "already exists",
      }),
    });
    expect(err.kind).toBe("conflict_error");
    expect(err.status).toBe(409);
    expect(err.code).toBe("ConflictException");
  });

  it("fromHttpResponse maps 409 with unknown __type to conflict_error", () => {
    const err = fromHttpResponse({
      status: 409,
      body: JSON.stringify({ __type: "SomeOtherException", message: "x" }),
    });
    expect(err.kind).toBe("conflict_error");
  });

  it("conflict_error is NOT in RETRYABLE_KINDS", () => {
    expect(RETRYABLE_KINDS.has("conflict_error")).toBe(false);
  });

  it("isRetryable returns false for conflict_error", () => {
    expect(new BedrockError({ kind: "conflict_error", message: "" }).isRetryable()).toBe(false);
  });
});
