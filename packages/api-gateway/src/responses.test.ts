import { describe, expect, it } from "vitest";
import {
  CORS_MODES,
  CorsPolicySchema,
  DEFAULT_SECURITY_HEADERS,
  PROBLEM_STATUS_CODES,
  PROBLEM_TYPES,
  ProblemDetailsResponseSchema,
  RESIDENCY_REGION_HEADER,
  SECURITY_HEADER_NAMES,
  buildProblemDetails,
  evaluateCors,
  isCacheableStatus,
  type CorsPolicy,
} from "./responses.js";

describe("constants", () => {
  it("PROBLEM_TYPES has 21 entries", () => {
    expect(Object.keys(PROBLEM_TYPES)).toHaveLength(21);
  });
  it("gives the AI provider's residency refusals types of their own (ADR-0462)", () => {
    // A different question from the region gate's, so no AI refusal may share a residency type.
    const ai = [
      PROBLEM_TYPES.ai_provider_residency_forbidden,
      PROBLEM_TYPES.ai_provider_residency_undeclared,
      PROBLEM_TYPES.ai_provider_residency_unresolved,
    ];
    const region = [
      PROBLEM_TYPES.residency_misdirected,
      PROBLEM_TYPES.residency_violation,
      PROBLEM_TYPES.residency_unresolved,
    ];
    for (const t of ai) expect(region).not.toContain(t);
  });
  it("has 16 problem status codes", () => {
    expect(PROBLEM_STATUS_CODES).toHaveLength(16);
  });
  it("puts every problem type under one namespace, residency included", () => {
    // ADR-0457: the residency refusals used to spell crossengin.dev/problems and
    // crossengin.io/problems, two hosts beside the registry's own base.
    for (const value of Object.values(PROBLEM_TYPES)) {
      expect(value.startsWith("https://crossengin.io/errors/")).toBe(true);
    }
    expect((PROBLEM_STATUS_CODES as readonly number[]).includes(421)).toBe(true);
    expect(RESIDENCY_REGION_HEADER).toBe("x-crossengin-region");
  });
  it("carries a type for 500, which was in PROBLEM_STATUS_CODES with nothing to name it", () => {
    expect(PROBLEM_TYPES.internal_server_error).toBe(
      "https://crossengin.io/errors/internal-server-error",
    );
    expect((PROBLEM_STATUS_CODES as readonly number[]).includes(500)).toBe(true);
  });
  it("accepts a 500 problem, which needs no extension", () => {
    // 429/401/410 each carry a required extension; 500 deliberately carries none, because an
    // unclassified fault has nothing to add that does not come from the fault.
    const parsed = ProblemDetailsResponseSchema.parse({
      type: PROBLEM_TYPES.internal_server_error,
      title: "Internal server error",
      status: 500,
      detail: "the request could not be completed",
    });
    expect(parsed.extensions).toEqual({});
  });
  it("every PROBLEM_TYPES value is a distinct https url", () => {
    const values = Object.values(PROBLEM_TYPES);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value.startsWith("https://")).toBe(true);
  });
  it("has 6 security header names", () => {
    expect(SECURITY_HEADER_NAMES).toHaveLength(6);
  });
  it("DEFAULT_SECURITY_HEADERS includes HSTS with 1-year max-age", () => {
    expect(DEFAULT_SECURITY_HEADERS.strict_transport_security).toContain(
      "max-age=31536000",
    );
  });
  it("has 5 CORS modes", () => {
    expect(CORS_MODES).toHaveLength(5);
  });
});

describe("ProblemDetailsResponseSchema", () => {
  it("refuses a 421 that names no home region and accepts one that does", () => {
    const base = {
      type: PROBLEM_TYPES.residency_misdirected,
      title: "Misdirected region",
      status: 421,
      detail: "tenant's home region is eu-central",
    };
    expect(ProblemDetailsResponseSchema.safeParse(base).success).toBe(false);
    expect(
      ProblemDetailsResponseSchema.safeParse({ ...base, extensions: { correctRegion: "eu-central" } })
        .success,
    ).toBe(true);
  });
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
    expect(() =>
      CorsPolicySchema.parse({ ...base, allowedOrigins: [] }),
    ).toThrow(/non-empty allowedOrigins/);
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
