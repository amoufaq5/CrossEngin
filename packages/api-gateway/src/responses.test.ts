import { describe, expect, it } from "vitest";
import {
  CORS_MODES,
  CorsPolicySchema,
  DEFAULT_SECURITY_HEADERS,
  PROBLEM_STATUS_CODES,
  PROBLEM_TYPES,
  ProblemDetailsResponseSchema,
  SECURITY_HEADER_NAMES,
  buildProblemDetails,
  evaluateCors,
  isCacheableStatus,
  type CorsPolicy,
} from "./responses.js";

describe("constants", () => {
  it("PROBLEM_TYPES has 14 entries", () => {
    expect(Object.keys(PROBLEM_TYPES)).toHaveLength(14);
  });
  it("has 15 problem status codes", () => {
    expect(PROBLEM_STATUS_CODES).toHaveLength(15);
  });
  it("has 6 security header names", () => {
    expect(SECURITY_HEADER_NAMES).toHaveLength(6);
  });
  it("DEFAULT_SECURITY_HEADERS includes HSTS with 1-year max-age", () => {
    expect(DEFAULT_SECURITY_HEADERS.strict_transport_security).toContain("max-age=31536000");
  });
  it("has 5 CORS modes", () => {
    expect(CORS_MODES).toHaveLength(5);
  });
});

describe("ProblemDetailsResponseSchema", () => {
  it("accepts a basic 404 problem", () => {
    expect(() =>
      ProblemDetailsResponseSchema.parse({
        type: PROBLEM_TYPES.not_found,
        title: "Not Found",
        status: 404,
        detail: "Resource not found",
      }),
    ).not.toThrow();
  });

  it("warns on 429 without retryAfterSeconds extension", () => {
    expect(() =>
      ProblemDetailsResponseSchema.parse({
        type: PROBLEM_TYPES.too_many_requests,
        title: "Too Many Requests",
        status: 429,
        detail: "Rate limit",
      }),
    ).toThrow(/retryAfterSeconds/);
  });

  it("requires wwwAuthenticate on 401", () => {
    expect(() =>
      ProblemDetailsResponseSchema.parse({
        type: PROBLEM_TYPES.authentication_required,
        title: "Unauthorized",
        status: 401,
        detail: "Authentication required",
      }),
    ).toThrow(/wwwAuthenticate/);
  });

  it("requires sunsetAt on 410", () => {
    expect(() =>
      ProblemDetailsResponseSchema.parse({
        type: PROBLEM_TYPES.sunset_endpoint,
        title: "Gone",
        status: 410,
        detail: "Endpoint removed",
      }),
    ).toThrow(/sunsetAt/);
  });
});

describe("buildProblemDetails", () => {
  it("constructs a problem with extensions", () => {
    const p = buildProblemDetails({
      type: PROBLEM_TYPES.too_many_requests,
      title: "Too Many Requests",
      status: 429,
      detail: "Rate limit exceeded",
      extensions: { retryAfterSeconds: 30 },
    });
    expect(p.status).toBe(429);
    expect(p.extensions.retryAfterSeconds).toBe(30);
  });
});

describe("CorsPolicySchema", () => {
  const base: CorsPolicy = {
    mode: "allowlist",
    allowedOrigins: ["https://app.crossengin.io"],
    allowedMethods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: [],
    maxAgeSeconds: 600,
    allowCredentials: false,
  };

  it("accepts a basic allowlist policy", () => {
    expect(() => CorsPolicySchema.parse(base)).not.toThrow();
  });

  it("rejects allowlist with empty origins", () => {
    expect(() => CorsPolicySchema.parse({ ...base, allowedOrigins: [] })).toThrow(
      /non-empty allowedOrigins/,
    );
  });

  it("rejects wildcard_credentialed without allowCredentials", () => {
    expect(() =>
      CorsPolicySchema.parse({
        ...base,
        mode: "wildcard_credentialed",
        allowedOrigins: ["*"],
      }),
    ).toThrow(/allowCredentials=true/);
  });

  it("rejects wildcard_anonymous with allowCredentials=true (browser blocks)", () => {
    expect(() =>
      CorsPolicySchema.parse({
        ...base,
        mode: "wildcard_anonymous",
        allowedOrigins: ["*"],
        allowCredentials: true,
      }),
    ).toThrow(/incompatible/);
  });

  it("rejects non-https origin in allowlist", () => {
    expect(() =>
      CorsPolicySchema.parse({
        ...base,
        allowedOrigins: ["http://insecure.com"],
      }),
    ).toThrow(/must use https/);
  });

  it("allows localhost over http", () => {
    expect(() =>
      CorsPolicySchema.parse({
        ...base,
        allowedOrigins: ["http://localhost:3000", "https://app.crossengin.io"],
      }),
    ).not.toThrow();
  });
});

describe("evaluateCors", () => {
  const policy: CorsPolicy = {
    mode: "allowlist",
    allowedOrigins: ["https://app.crossengin.io"],
    allowedMethods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    exposedHeaders: ["X-Request-Id"],
    maxAgeSeconds: 600,
    allowCredentials: true,
  };

  it("disabled mode denies", () => {
    const r = evaluateCors({
      policy: { ...policy, mode: "disabled" },
      origin: "https://app.crossengin.io",
      requestMethod: "GET",
      requestHeaders: [],
    });
    expect(r.allowed).toBe(false);
  });

  it("allows same-origin (no Origin header)", () => {
    const r = evaluateCors({
      policy,
      origin: null,
      requestMethod: "GET",
      requestHeaders: [],
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("same_origin");
  });

  it("allows allowlisted origin and emits credentials header", () => {
    const r = evaluateCors({
      policy,
      origin: "https://app.crossengin.io",
      requestMethod: "GET",
      requestHeaders: [],
    });
    expect(r.allowed).toBe(true);
    expect(r.responseHeaders["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("emits preflight headers on OPTIONS", () => {
    const r = evaluateCors({
      policy,
      origin: "https://app.crossengin.io",
      requestMethod: "OPTIONS",
      requestHeaders: ["Content-Type"],
    });
    expect(r.responseHeaders["Access-Control-Allow-Methods"]).toContain("GET");
    expect(r.responseHeaders["Access-Control-Max-Age"]).toBe("600");
  });

  it("denies non-allowlisted origin", () => {
    const r = evaluateCors({
      policy,
      origin: "https://other.com",
      requestMethod: "GET",
      requestHeaders: [],
    });
    expect(r.allowed).toBe(false);
  });

  it("wildcard_anonymous emits * (no credentials)", () => {
    const r = evaluateCors({
      policy: { ...policy, mode: "wildcard_anonymous", allowCredentials: false },
      origin: "https://random.com",
      requestMethod: "GET",
      requestHeaders: [],
    });
    expect(r.responseHeaders["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("isCacheableStatus", () => {
  it("200 is cacheable", () => {
    expect(isCacheableStatus(200)).toBe(true);
  });
  it("500 is not cacheable", () => {
    expect(isCacheableStatus(500)).toBe(false);
  });
});
