import { describe, expect, it } from "vitest";
import {
  FORWARDED_PROTO,
  HTTP_METHODS,
  IDEMPOTENT_HTTP_METHODS,
  IncomingRequestSchema,
  SAFE_HTTP_METHODS,
  TLS_VERSIONS,
  WEAK_TLS_VERSIONS,
  computeOriginIp,
  getHeader,
  hasHeader,
  isIdempotentMethod,
  isSafeMethod,
  isWeakTlsVersion,
  normalizePathSegments,
  type IncomingRequest,
} from "./requests.js";

const baseRequest: IncomingRequest = {
  id: "req_abc12345",
  receivedAt: "2026-05-16T10:00:00.000Z",
  method: "GET",
  path: "/v1/tenants/abc",
  query: { include: "policies" },
  headers: {
    Accept: "application/json",
    "User-Agent": "test/1.0",
  },
  host: "api.crossengin.io",
  scheme: "https",
  bodyBytes: 0,
  bodySha256: null,
  clientIp: "203.0.113.10",
  forwardedFor: [],
  forwardedProto: null,
  forwardedHost: null,
  userAgent: "test/1.0",
  tlsVersion: "tls_1_3",
  tlsCipher: "TLS_AES_256_GCM_SHA384",
  clientCertSha256: null,
  correlationId: null,
  traceparent: null,
  tenantHint: null,
  edgeRegion: "us-east",
};

describe("constants", () => {
  it("has 9 HTTP methods", () => {
    expect(HTTP_METHODS).toHaveLength(9);
  });
  it("SAFE_HTTP_METHODS has 4 entries", () => {
    expect(SAFE_HTTP_METHODS.size).toBe(4);
    expect(SAFE_HTTP_METHODS.has("GET")).toBe(true);
    expect(SAFE_HTTP_METHODS.has("POST")).toBe(false);
  });
  it("IDEMPOTENT_HTTP_METHODS includes PUT + DELETE", () => {
    expect(IDEMPOTENT_HTTP_METHODS.has("PUT")).toBe(true);
    expect(IDEMPOTENT_HTTP_METHODS.has("DELETE")).toBe(true);
    expect(IDEMPOTENT_HTTP_METHODS.has("POST")).toBe(false);
  });
  it("WEAK_TLS_VERSIONS includes tls_1_0 + tls_1_1", () => {
    expect(WEAK_TLS_VERSIONS.size).toBe(2);
    expect(WEAK_TLS_VERSIONS.has("tls_1_0")).toBe(true);
    expect(WEAK_TLS_VERSIONS.has("tls_1_3")).toBe(false);
  });
  it("has 4 TLS versions", () => {
    expect(TLS_VERSIONS).toHaveLength(4);
  });
  it("FORWARDED_PROTO is http or https", () => {
    expect(FORWARDED_PROTO).toEqual(["http", "https"]);
  });
});

describe("IncomingRequestSchema", () => {
  it("accepts a valid HTTPS GET request", () => {
    expect(() => IncomingRequestSchema.parse(baseRequest)).not.toThrow();
  });

  it("rejects external http (no forwardedProto=https)", () => {
    expect(() =>
      IncomingRequestSchema.parse({
        ...baseRequest,
        scheme: "http",
        host: "api.crossengin.io",
      }),
    ).toThrow(/https/);
  });

  it("accepts localhost over http", () => {
    expect(() =>
      IncomingRequestSchema.parse({
        ...baseRequest,
        scheme: "http",
        host: "localhost",
      }),
    ).not.toThrow();
  });

  it("rejects weak TLS versions", () => {
    expect(() =>
      IncomingRequestSchema.parse({ ...baseRequest, tlsVersion: "tls_1_0" }),
    ).toThrow(/weak TLS/);
  });

  it("rejects non-empty body without sha256", () => {
    expect(() =>
      IncomingRequestSchema.parse({
        ...baseRequest,
        method: "POST",
        bodyBytes: 100,
      }),
    ).toThrow(/bodySha256/);
  });

  it("rejects invalid header name", () => {
    expect(() =>
      IncomingRequestSchema.parse({
        ...baseRequest,
        headers: { "Invalid Header!": "x" },
      }),
    ).toThrow(/invalid header name/);
  });

  it("validates traceparent W3C format", () => {
    expect(() =>
      IncomingRequestSchema.parse({
        ...baseRequest,
        traceparent: "00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01",
      }),
    ).not.toThrow();
  });
});

describe("isSafeMethod / isIdempotentMethod", () => {
  it("GET is safe and idempotent", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isIdempotentMethod("GET")).toBe(true);
  });
  it("PUT is idempotent but not safe", () => {
    expect(isSafeMethod("PUT")).toBe(false);
    expect(isIdempotentMethod("PUT")).toBe(true);
  });
  it("POST is neither safe nor idempotent", () => {
    expect(isSafeMethod("POST")).toBe(false);
    expect(isIdempotentMethod("POST")).toBe(false);
  });
});

describe("isWeakTlsVersion", () => {
  it("tls_1_0 is weak", () => {
    expect(isWeakTlsVersion("tls_1_0")).toBe(true);
  });
  it("tls_1_3 is strong", () => {
    expect(isWeakTlsVersion("tls_1_3")).toBe(false);
  });
});

describe("getHeader / hasHeader", () => {
  it("returns header value case-insensitively", () => {
    expect(getHeader(baseRequest, "accept")).toBe("application/json");
    expect(getHeader(baseRequest, "ACCEPT")).toBe("application/json");
  });
  it("returns null for missing header", () => {
    expect(getHeader(baseRequest, "X-Missing")).toBeNull();
  });
  it("hasHeader returns true when present", () => {
    expect(hasHeader(baseRequest, "Accept")).toBe(true);
    expect(hasHeader(baseRequest, "X-Missing")).toBe(false);
  });
});

describe("computeOriginIp", () => {
  it("returns clientIp when no forwardedFor", () => {
    expect(computeOriginIp(baseRequest)).toBe("203.0.113.10");
  });
  it("returns first forwardedFor entry when present", () => {
    expect(
      computeOriginIp({
        ...baseRequest,
        forwardedFor: ["198.51.100.20", "192.0.2.30"],
      }),
    ).toBe("198.51.100.20");
  });
});

describe("normalizePathSegments", () => {
  it("splits and filters", () => {
    expect(normalizePathSegments("/v1/tenants/abc")).toEqual([
      "v1",
      "tenants",
      "abc",
    ]);
  });
  it("returns empty for /", () => {
    expect(normalizePathSegments("/")).toEqual([]);
  });
  it("handles trailing slash", () => {
    expect(normalizePathSegments("/v1/")).toEqual(["v1"]);
  });
});
