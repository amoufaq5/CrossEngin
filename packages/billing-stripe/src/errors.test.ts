import { describe, expect, it } from "vitest";

import {
  STRIPE_ERROR_TYPES,
  StripeError,
  classifyStripeHttpStatus,
  stripeErrorFromHttpResponse,
  stripeErrorFromNetworkError,
} from "./errors.js";

describe("STRIPE_ERROR_TYPES", () => {
  it("includes the documented Stripe error types", () => {
    expect(STRIPE_ERROR_TYPES).toContain("invalid_request_error");
    expect(STRIPE_ERROR_TYPES).toContain("card_error");
    expect(STRIPE_ERROR_TYPES).toContain("rate_limit_error");
  });
});

describe("classifyStripeHttpStatus", () => {
  it("maps known statuses", () => {
    expect(classifyStripeHttpStatus(400)).toBe("invalid_request_error");
    expect(classifyStripeHttpStatus(401)).toBe("authentication_error");
    expect(classifyStripeHttpStatus(402)).toBe("card_error");
    expect(classifyStripeHttpStatus(403)).toBe("authentication_error");
    expect(classifyStripeHttpStatus(404)).toBe("invalid_request_error");
    expect(classifyStripeHttpStatus(409)).toBe("idempotency_error");
    expect(classifyStripeHttpStatus(429)).toBe("rate_limit_error");
    expect(classifyStripeHttpStatus(500)).toBe("api_error");
    expect(classifyStripeHttpStatus(503)).toBe("api_error");
  });

  it("returns unknown_error for unrecognized status", () => {
    expect(classifyStripeHttpStatus(418)).toBe("unknown_error");
  });
});

describe("StripeError.isRetryable", () => {
  it("is true for 429 and 5xx", () => {
    expect(new StripeError({ type: "rate_limit_error", message: "x", httpStatus: 429 }).isRetryable()).toBe(true);
    expect(new StripeError({ type: "api_error", message: "x", httpStatus: 500 }).isRetryable()).toBe(true);
    expect(new StripeError({ type: "api_error", message: "x", httpStatus: 503 }).isRetryable()).toBe(true);
  });

  it("is true for network and timeout types", () => {
    expect(new StripeError({ type: "network_error", message: "x" }).isRetryable()).toBe(true);
    expect(new StripeError({ type: "timeout_error", message: "x" }).isRetryable()).toBe(true);
  });

  it("is false for 4xx client errors other than 429", () => {
    expect(new StripeError({ type: "invalid_request_error", message: "x", httpStatus: 400 }).isRetryable()).toBe(false);
    expect(new StripeError({ type: "authentication_error", message: "x", httpStatus: 401 }).isRetryable()).toBe(false);
    expect(new StripeError({ type: "card_error", message: "x", httpStatus: 402 }).isRetryable()).toBe(false);
  });
});

describe("stripeErrorFromHttpResponse", () => {
  it("parses the Stripe error envelope when body is JSON", () => {
    const err = stripeErrorFromHttpResponse({
      status: 402,
      body: JSON.stringify({
        error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
      }),
    });
    expect(err.type).toBe("card_error");
    expect(err.code).toBe("card_declined");
    expect(err.message).toBe("Your card was declined.");
    expect(err.httpStatus).toBe(402);
    expect(err.isRetryable()).toBe(false);
  });

  it("falls back to status classification when the body is non-JSON", () => {
    const err = stripeErrorFromHttpResponse({ status: 400, body: "<html>" });
    expect(err.type).toBe("invalid_request_error");
    expect(err.code).toBeNull();
    expect(err.message).toContain("400");
  });

  it("classifies a 500 as a retryable api_error", () => {
    const err = stripeErrorFromHttpResponse({ status: 500, body: "" });
    expect(err.type).toBe("api_error");
    expect(err.isRetryable()).toBe(true);
  });

  it("ignores unrecognized body type fields", () => {
    const err = stripeErrorFromHttpResponse({
      status: 500,
      body: JSON.stringify({ error: { type: "made_up_kind", message: "x" } }),
    });
    expect(err.type).toBe("api_error");
  });
});

describe("stripeErrorFromNetworkError", () => {
  it("returns timeout_error for AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(stripeErrorFromNetworkError(e).type).toBe("timeout_error");
  });

  it("returns network_error otherwise", () => {
    const err = stripeErrorFromNetworkError(new Error("connect ECONNRESET"));
    expect(err.type).toBe("network_error");
    expect(err.isRetryable()).toBe(true);
  });

  it("handles non-Error throwables", () => {
    expect(stripeErrorFromNetworkError("boom").type).toBe("network_error");
  });
});
