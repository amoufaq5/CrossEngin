import { ProblemDetailsResponseSchema } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  authenticationRequired,
  forbidden,
  gatewayTimeout,
  idempotencyMismatch,
  internalServerError,
  methodNotAllowed,
  notFound,
  serviceUnavailable,
  sunsetEndpoint,
  tooManyRequests,
  unprocessableEntity,
  unsupportedMediaType,
  weakTlsRejected,
} from "./problems.js";

describe("authenticationRequired", () => {
  it("returns 401 + www-authenticate + schema-valid body", () => {
    const env = authenticationRequired({ reason: "missing bearer token" });
    expect(env.response.status).toBe(401);
    expect(env.response.headers["www-authenticate"]).toMatch(/^Bearer realm=/);
    expect(env.body.extensions["wwwAuthenticate"]).toBeDefined();
    expect(ProblemDetailsResponseSchema.parse(env.body)).toEqual(env.body);
  });

  it("respects a custom challenge", () => {
    const env = authenticationRequired({
      reason: "x",
      wwwAuthenticate: 'Bearer realm="custom", error="expired_token"',
    });
    expect(env.response.headers["www-authenticate"]).toContain("expired_token");
  });
});

describe("forbidden + insufficient_scope", () => {
  it("emits insufficient_scope problem type when requiredScope is supplied", () => {
    const env = forbidden({ reason: "missing scope", requiredScope: "tenants:write" });
    expect(env.body.type).toContain("insufficient-scope");
    expect(env.body.extensions["requiredScope"]).toBe("tenants:write");
    expect(env.response.status).toBe(403);
  });

  it("emits plain forbidden problem type when scope is omitted", () => {
    const env = forbidden({ reason: "blocked" });
    expect(env.body.type).toContain("forbidden");
  });
});

describe("notFound", () => {
  it("returns 404", () => {
    const env = notFound({ reason: "no route for /foo" });
    expect(env.response.status).toBe(404);
    expect(env.body.title).toBe("Not found");
  });
});

describe("methodNotAllowed", () => {
  it("returns 405 + allow header", () => {
    const env = methodNotAllowed({ allowedMethods: ["GET", "HEAD"] });
    expect(env.response.status).toBe(405);
    expect(env.response.headers["allow"]).toBe("GET, HEAD");
  });
});

describe("idempotencyMismatch", () => {
  it("returns 409", () => {
    const env = idempotencyMismatch({ reason: "same key, different body" });
    expect(env.response.status).toBe(409);
    expect(env.body.type).toContain("idempotency-mismatch");
  });
});

describe("unsupportedMediaType", () => {
  it("returns 415", () => {
    const env = unsupportedMediaType({ contentType: "application/xml" });
    expect(env.response.status).toBe(415);
    expect(env.body.detail).toContain("application/xml");
  });
});

describe("unprocessableEntity", () => {
  it("returns 422", () => {
    const env = unprocessableEntity({ reason: "schema validation failed" });
    expect(env.response.status).toBe(422);
  });
});

describe("tooManyRequests", () => {
  it("returns 429 + retry-after header + extension", () => {
    const env = tooManyRequests({ retryAfterSeconds: 60 });
    expect(env.response.status).toBe(429);
    expect(env.response.headers["retry-after"]).toBe("60");
    expect(env.body.extensions["retryAfterSeconds"]).toBe(60);
    expect(env.body.type).toContain("too-many-requests");
  });

  it("emits quota_exceeded type when quotaExceeded=true", () => {
    const env = tooManyRequests({ retryAfterSeconds: 600, quotaExceeded: true });
    expect(env.body.type).toContain("quota-exceeded");
  });

  it("rejects negative retryAfter", () => {
    expect(() => tooManyRequests({ retryAfterSeconds: -1 })).toThrow(/non-negative/);
  });

  it("rejects non-integer retryAfter", () => {
    expect(() => tooManyRequests({ retryAfterSeconds: 1.5 })).toThrow(/non-negative/);
  });
});

describe("serviceUnavailable + gatewayTimeout", () => {
  it("503 + 504 mappings", () => {
    expect(serviceUnavailable({ reason: "x" }).response.status).toBe(503);
    expect(gatewayTimeout({ reason: "x" }).response.status).toBe(504);
  });
});

describe("internalServerError", () => {
  it("returns 500 with the internal-server-error problem type", () => {
    const env = internalServerError({ reason: "the request could not be completed" });
    expect(env.response.status).toBe(500);
    expect(env.body.status).toBe(500);
    expect(env.body.type).toContain("internal-server-error");
    expect(env.body.title).toBe("Internal server error");
  });

  it("is a distinct type and status from gatewayTimeout, which it replaced on the throw path", () => {
    const five = internalServerError({ reason: "x" });
    const timeout = gatewayTimeout({ reason: "x" });
    expect(five.body.type).not.toBe(timeout.body.type);
    expect(five.response.status).not.toBe(timeout.response.status);
  });

  it("threads the correlationId, which is the caller's only handle on this path", () => {
    const env = internalServerError({ reason: "x", correlationId: "corr-abc" });
    expect(env.body.correlationId).toBe("corr-abc");
  });

  it("omits correlationId entirely when none was supplied", () => {
    // Not the empty string: `x-correlation-id` is client-supplied, so absent must stay absent
    // rather than becoming a field whose value says nothing.
    expect(internalServerError({ reason: "x" }).body.correlationId).toBeUndefined();
  });

  it("serves application/problem+json like every other helper", () => {
    const env = internalServerError({ reason: "x" });
    expect(env.response.headers["content-type"]).toBe("application/problem+json");
  });

  it("produces a schema-valid body with no extensions", () => {
    const env = internalServerError({ reason: "x" });
    expect(env.body.extensions).toEqual({});
    expect(ProblemDetailsResponseSchema.parse(env.body)).toEqual(env.body);
  });
});

describe("sunsetEndpoint", () => {
  it("returns 410 + sunset header + sunsetAt extension", () => {
    const env = sunsetEndpoint({
      sunsetAt: "2027-01-01T00:00:00.000Z",
      successorOperationId: "tenants.create.v2",
    });
    expect(env.response.status).toBe(410);
    expect(env.response.headers["sunset"]).toBe("2027-01-01T00:00:00.000Z");
    expect(env.body.extensions["sunsetAt"]).toBe("2027-01-01T00:00:00.000Z");
    expect(env.body.extensions["successorOperationId"]).toBe("tenants.create.v2");
  });
});

describe("weakTlsRejected", () => {
  it("returns 400 mentioning the offending TLS version", () => {
    const env = weakTlsRejected({ tlsVersion: "tls_1_0" });
    expect(env.response.status).toBe(400);
    expect(env.body.detail).toContain("tls_1_0");
  });
});

describe("correlationId threading", () => {
  it("appears in the body when supplied", () => {
    const env = authenticationRequired({
      reason: "x",
      correlationId: "corr-1234567890",
    });
    expect(env.body.correlationId).toBe("corr-1234567890");
  });
});

describe("schema validation", () => {
  it("every helper produces a body that passes ProblemDetailsResponseSchema", () => {
    const envelopes = [
      authenticationRequired({ reason: "x" }),
      forbidden({ reason: "x" }),
      forbidden({ reason: "x", requiredScope: "y" }),
      notFound({ reason: "x" }),
      methodNotAllowed({ allowedMethods: ["GET"] }),
      idempotencyMismatch({ reason: "x" }),
      unsupportedMediaType({ contentType: "x" }),
      unprocessableEntity({ reason: "x" }),
      tooManyRequests({ retryAfterSeconds: 30 }),
      tooManyRequests({ retryAfterSeconds: 60, quotaExceeded: true }),
      internalServerError({ reason: "x" }),
      serviceUnavailable({ reason: "x" }),
      gatewayTimeout({ reason: "x" }),
      sunsetEndpoint({ sunsetAt: "2027-01-01T00:00:00.000Z" }),
      weakTlsRejected({ tlsVersion: "tls_1_0" }),
    ];
    for (const env of envelopes) {
      expect(() => ProblemDetailsResponseSchema.parse(env.body)).not.toThrow();
    }
  });
});
