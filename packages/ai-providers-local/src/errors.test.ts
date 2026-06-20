import { describe, expect, it } from "vitest";

import {
  LocalProviderError,
  classifyHttpStatus,
  fromHttpResponse,
  fromNetworkError,
} from "./errors.js";

describe("classifyHttpStatus", () => {
  it("maps common statuses", () => {
    expect(classifyHttpStatus(400)).toBe("invalid_request_error");
    expect(classifyHttpStatus(401)).toBe("authentication_error");
    expect(classifyHttpStatus(403)).toBe("authentication_error");
    expect(classifyHttpStatus(404)).toBe("not_found_error");
    expect(classifyHttpStatus(408)).toBe("timeout_error");
    expect(classifyHttpStatus(429)).toBe("rate_limit_error");
    expect(classifyHttpStatus(503)).toBe("service_unavailable");
    expect(classifyHttpStatus(500)).toBe("server_error");
    expect(classifyHttpStatus(418)).toBe("unknown_error");
  });
});

describe("LocalProviderError.isRetryable", () => {
  it("treats transient kinds as retryable", () => {
    for (const kind of ["rate_limit_error", "server_error", "service_unavailable", "network_error", "timeout_error", "model_not_loaded"] as const) {
      expect(new LocalProviderError({ kind, message: "x" }).isRetryable()).toBe(true);
    }
  });

  it("treats client errors as non-retryable", () => {
    for (const kind of ["invalid_request_error", "authentication_error", "not_found_error", "unknown_error"] as const) {
      expect(new LocalProviderError({ kind, message: "x" }).isRetryable()).toBe(false);
    }
  });
});

describe("fromHttpResponse", () => {
  it("extracts a string error body", () => {
    const err = fromHttpResponse({ status: 400, body: JSON.stringify({ error: "bad prompt" }) });
    expect(err.message).toBe("bad prompt");
    expect(err.status).toBe(400);
  });

  it("extracts a structured error body", () => {
    const err = fromHttpResponse({
      status: 500,
      body: JSON.stringify({ error: { message: "boom" } }),
    });
    expect(err.message).toBe("boom");
    expect(err.kind).toBe("server_error");
  });

  it("upgrades a 'model not found' message to model_not_loaded", () => {
    const err = fromHttpResponse({
      status: 404,
      body: JSON.stringify({ error: 'model "llama3.1" not found, try pulling it' }),
    });
    expect(err.kind).toBe("model_not_loaded");
    expect(err.isRetryable()).toBe(true);
  });

  it("falls back to a default message on non-JSON bodies", () => {
    const err = fromHttpResponse({ status: 503, body: "<html>down</html>" });
    expect(err.kind).toBe("service_unavailable");
    expect(err.message).toContain("503");
  });
});

describe("fromNetworkError", () => {
  it("classifies aborts as timeouts", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(fromNetworkError(abort).kind).toBe("timeout_error");
  });

  it("classifies other errors as network errors", () => {
    expect(fromNetworkError(new Error("ECONNREFUSED")).kind).toBe("network_error");
  });
});
