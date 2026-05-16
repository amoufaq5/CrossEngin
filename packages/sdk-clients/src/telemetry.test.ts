import { describe, expect, it } from "vitest";
import {
  BREADCRUMB_KINDS,
  BreadcrumbSchema,
  ClientRequestRecordSchema,
  REQUEST_OUTCOMES,
  aggregateUsage,
  isRedactableHeader,
  redactSensitiveAttributes,
  type ClientRequestRecord,
} from "./telemetry.js";

describe("constants", () => {
  it("REQUEST_OUTCOMES has 7 entries", () => {
    expect(REQUEST_OUTCOMES).toContain("success");
    expect(REQUEST_OUTCOMES).toContain("client_error");
    expect(REQUEST_OUTCOMES).toContain("network_error");
    expect(REQUEST_OUTCOMES).toContain("auth_failure");
  });

  it("BREADCRUMB_KINDS has 8 entries", () => {
    expect(BREADCRUMB_KINDS).toContain("request_sent");
    expect(BREADCRUMB_KINDS).toContain("retry_scheduled");
    expect(BREADCRUMB_KINDS).toContain("cache_hit");
  });
});

describe("isRedactableHeader", () => {
  it("returns true for sensitive headers", () => {
    expect(isRedactableHeader("Authorization")).toBe(true);
    expect(isRedactableHeader("authorization")).toBe(true);
    expect(isRedactableHeader("X-Api-Key")).toBe(true);
    expect(isRedactableHeader("Cookie")).toBe(true);
  });

  it("returns false for safe headers", () => {
    expect(isRedactableHeader("Content-Type")).toBe(false);
    expect(isRedactableHeader("User-Agent")).toBe(false);
  });
});

describe("BreadcrumbSchema", () => {
  it("accepts a valid breadcrumb", () => {
    expect(() =>
      BreadcrumbSchema.parse({
        kind: "request_sent",
        occurredAt: "2026-05-15T10:00:00Z",
        message: "GET /v1/tenants",
        attributes: { request_id: "req-1" },
      }),
    ).not.toThrow();
  });

  it("rejects unknown extra keys (strict)", () => {
    expect(() =>
      BreadcrumbSchema.parse({
        kind: "request_sent",
        occurredAt: "2026-05-15T10:00:00Z",
        message: "x",
        attributes: {},
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("ClientRequestRecordSchema", () => {
  const base: ClientRequestRecord = {
    requestId: "req-1",
    operationId: "tenants.list",
    method: "GET",
    pathPattern: "/v1/tenants",
    apiVersion: "v1",
    clientLanguage: "typescript",
    clientVersion: "1.0.0",
    startedAt: "2026-05-15T10:00:00.000Z",
    completedAt: "2026-05-15T10:00:00.200Z",
    latencyMs: 200,
    attemptNumber: 1,
    totalAttempts: 1,
    outcome: "success",
    responseStatus: 200,
    bytesSent: 100,
    bytesReceived: 1000,
    breadcrumbs: [],
    userAgent: "@crossengin/sdk-typescript/1.0.0",
  };

  it("accepts a valid success record", () => {
    expect(() => ClientRequestRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects completedAt before startedAt", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        completedAt: "2026-05-15T09:59:00.000Z",
      }),
    ).toThrow(/cannot be before startedAt/);
  });

  it("rejects latencyMs mismatch", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({ ...base, latencyMs: 999 }),
    ).toThrow(/does not match/);
  });

  it("rejects attemptNumber > totalAttempts", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        attemptNumber: 5,
        totalAttempts: 3,
      }),
    ).toThrow(/cannot exceed totalAttempts/);
  });

  it("rejects success with non-2xx status", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({ ...base, responseStatus: 500 }),
    ).toThrow(/2xx responseStatus/);
  });

  it("rejects client_error with non-4xx status", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        outcome: "client_error",
        responseStatus: 500,
        errorCode: "VALIDATION",
      }),
    ).toThrow(/4xx responseStatus/);
  });

  it("rejects server_error without errorCode", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        outcome: "server_error",
        responseStatus: 500,
      }),
    ).toThrow(/errorCode/);
  });

  it("rejects network_error with non-null responseStatus", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        outcome: "network_error",
        responseStatus: 503,
      }),
    ).toThrow(/responseStatus=null/);
  });

  it("rejects orphan traceId without spanId", () => {
    expect(() =>
      ClientRequestRecordSchema.parse({
        ...base,
        traceId: "0".repeat(32),
      }),
    ).toThrow(/W3C trace context/);
  });
});

describe("aggregateUsage", () => {
  it("returns zeros for empty list", () => {
    expect(aggregateUsage([]).totalRequests).toBe(0);
  });

  it("aggregates success rate and percentiles", () => {
    const make = (latency: number, success: boolean): ClientRequestRecord => ({
      requestId: `r-${latency.toString()}`,
      operationId: "x",
      method: "GET",
      pathPattern: "/v1/x",
      apiVersion: "v1",
      clientLanguage: "python",
      clientVersion: "1.0.0",
      startedAt: "2026-05-15T10:00:00.000Z",
      completedAt: new Date(Date.parse("2026-05-15T10:00:00Z") + latency).toISOString(),
      latencyMs: latency,
      attemptNumber: 1,
      totalAttempts: 1,
      outcome: success ? "success" : "server_error",
      responseStatus: success ? 200 : 500,
      bytesSent: 0,
      bytesReceived: 0,
      breadcrumbs: [],
      userAgent: "x",
      errorCode: success ? undefined : "INTERNAL",
    });
    const records = [
      make(50, true),
      make(100, true),
      make(200, true),
      make(500, false),
    ];
    const agg = aggregateUsage(records);
    expect(agg.totalRequests).toBe(4);
    expect(agg.successfulRequests).toBe(3);
    expect(agg.failedRequests).toBe(1);
    expect(agg.successRate).toBe(0.75);
  });

  it("counts retries via attemptNumber", () => {
    const r: ClientRequestRecord = {
      requestId: "r-1",
      operationId: "x",
      method: "POST",
      pathPattern: "/v1/x",
      apiVersion: "v1",
      clientLanguage: "go",
      clientVersion: "1.0.0",
      startedAt: "2026-05-15T10:00:00.000Z",
      completedAt: "2026-05-15T10:00:00.100Z",
      latencyMs: 100,
      attemptNumber: 3,
      totalAttempts: 3,
      outcome: "success",
      responseStatus: 200,
      bytesSent: 0,
      bytesReceived: 0,
      breadcrumbs: [],
      userAgent: "x",
    };
    expect(aggregateUsage([r]).totalRetries).toBe(2);
  });
});

describe("redactSensitiveAttributes", () => {
  it("redacts sensitive keys", () => {
    const r = redactSensitiveAttributes({
      authorization: "Bearer xyz",
      "Content-Type": "application/json",
      "x-api-key": "secret",
    });
    expect(r.authorization).toBe("[REDACTED]");
    expect(r["x-api-key"]).toBe("[REDACTED]");
    expect(r["Content-Type"]).toBe("application/json");
  });
});
