import { describe, expect, it } from "vitest";
import {
  OpenAiError,
  classifyHttpStatus,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";

describe("classifyHttpStatus", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [408, "timeout_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [503, "service_unavailable"],
    [500, "server_error"],
    [502, "server_error"],
    [418, "unknown_error"],
  ])("maps %s -> %s", (status, kind) => {
    expect(classifyHttpStatus(status as number)).toBe(kind);
  });
});

describe("OpenAiError.isRetryable", () => {
  it("retries transient kinds only", () => {
    expect(new OpenAiError({ kind: "rate_limit_error", message: "x" }).isRetryable()).toBe(true);
    expect(new OpenAiError({ kind: "server_error", message: "x" }).isRetryable()).toBe(true);
    expect(new OpenAiError({ kind: "service_unavailable", message: "x" }).isRetryable()).toBe(true);
    expect(new OpenAiError({ kind: "network_error", message: "x" }).isRetryable()).toBe(true);
    expect(new OpenAiError({ kind: "authentication_error", message: "x" }).isRetryable()).toBe(false);
    expect(new OpenAiError({ kind: "invalid_request_error", message: "x" }).isRetryable()).toBe(false);
  });
});

describe("fromHttpResponse", () => {
  it("lifts the API error message out of the body", () => {
    const err = fromHttpResponse({
      status: 429,
      body: JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
    });
    expect(err.kind).toBe("rate_limit_error");
    expect(err.message).toBe("slow down");
    expect(err.status).toBe(429);
  });

  it("keeps a default message for non-JSON bodies", () => {
    const err = fromHttpResponse({ status: 500, body: "<html>oops</html>" });
    expect(err.kind).toBe("server_error");
    expect(err.message).toContain("500");
  });
});

describe("fromNetworkError", () => {
  it("classifies aborts as timeouts", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(fromNetworkError(abort).kind).toBe("timeout_error");
  });
  it("classifies other failures as network errors", () => {
    expect(fromNetworkError(new Error("ECONNRESET")).kind).toBe("network_error");
  });
});
