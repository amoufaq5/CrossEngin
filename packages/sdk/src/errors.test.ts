import { describe, expect, it } from "vitest";
import {
  ERROR_CATEGORIES,
  HTTP_STATUS_FOR_CATEGORY,
  ProblemDetailsSchema,
  httpStatusForCategory,
  isRetryable,
  problemFor,
  type ProblemDetails,
} from "./errors.js";

describe("ERROR_CATEGORIES", () => {
  it("has 9 categories", () => {
    expect(ERROR_CATEGORIES).toHaveLength(9);
    expect(ERROR_CATEGORIES).toContain("validation");
    expect(ERROR_CATEGORIES).toContain("rate_limited");
  });

  it("HTTP_STATUS_FOR_CATEGORY maps every category", () => {
    for (const cat of ERROR_CATEGORIES) {
      expect(HTTP_STATUS_FOR_CATEGORY[cat]).toBeGreaterThanOrEqual(400);
      expect(HTTP_STATUS_FOR_CATEGORY[cat]).toBeLessThanOrEqual(599);
    }
  });

  it("validation -> 422, rate_limited -> 429, internal -> 500", () => {
    expect(HTTP_STATUS_FOR_CATEGORY.validation).toBe(422);
    expect(HTTP_STATUS_FOR_CATEGORY.rate_limited).toBe(429);
    expect(HTTP_STATUS_FOR_CATEGORY.internal).toBe(500);
  });
});

describe("ProblemDetailsSchema", () => {
  const base: ProblemDetails = {
    type: "https://docs.crossengin.io/errors/not-found",
    title: "not found",
    status: 404,
    detail: "tenant 't-123' does not exist",
    instance: "/v1/tenants/t-123",
    code: "TENANT_NOT_FOUND",
    category: "not_found",
    errors: [],
    retryable: false,
  };

  it("accepts a valid not_found problem", () => {
    expect(() => ProblemDetailsSchema.parse(base)).not.toThrow();
  });

  it("rejects status that doesn't match category", () => {
    expect(() =>
      ProblemDetailsSchema.parse({ ...base, status: 500 }),
    ).toThrow(/expects HTTP status 404/);
  });

  it("rejects validation without errors[]", () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        ...base,
        category: "validation",
        status: 422,
        code: "INVALID_REQUEST",
      }),
    ).toThrow(/at least one FieldError/);
  });

  it("rejects rate_limited without retryAfterSeconds", () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        ...base,
        category: "rate_limited",
        status: 429,
        code: "RATE_LIMITED",
      }),
    ).toThrow(/retryAfterSeconds/);
  });

  it("rejects 5xx with retryable=false", () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        ...base,
        category: "internal",
        status: 500,
        code: "INTERNAL_ERROR",
        retryable: false,
      }),
    ).toThrow(/5xx errors must be retryable/);
  });

  it("rejects validation with retryable=true", () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        ...base,
        category: "validation",
        status: 422,
        code: "INVALID_REQUEST",
        retryable: true,
        errors: [{ field: "name", code: "TOO_SHORT", message: "x" }],
      }),
    ).toThrow(/validation errors must not be retryable/);
  });

  it("rejects malformed code", () => {
    expect(() =>
      ProblemDetailsSchema.parse({ ...base, code: "not_found" }),
    ).toThrow();
  });

  it("rejects malformed type URI", () => {
    expect(() =>
      ProblemDetailsSchema.parse({ ...base, type: "not-a-url" }),
    ).toThrow();
  });

  it("rejects duplicate field errors with same field+code", () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        ...base,
        category: "validation",
        status: 422,
        code: "INVALID_REQUEST",
        errors: [
          { field: "name", code: "TOO_SHORT", message: "x" },
          { field: "name", code: "TOO_SHORT", message: "y" },
        ],
      }),
    ).toThrow(/duplicate FieldError/);
  });
});

describe("problemFor factory", () => {
  it("builds a not_found problem", () => {
    const p = problemFor({
      category: "not_found",
      code: "TENANT_NOT_FOUND",
      detail: "tenant 't-1' does not exist",
    });
    expect(p.status).toBe(404);
    expect(p.code).toBe("TENANT_NOT_FOUND");
    expect(p.retryable).toBe(false);
  });

  it("builds a rate_limited problem with retryAfterSeconds", () => {
    const p = problemFor({
      category: "rate_limited",
      code: "RATE_LIMITED",
      detail: "too many requests",
      retryAfterSeconds: 30,
    });
    expect(p.status).toBe(429);
    expect(p.retryable).toBe(true);
    expect(p.retryAfterSeconds).toBe(30);
  });

  it("builds an internal problem with retryable=true", () => {
    const p = problemFor({
      category: "internal",
      code: "INTERNAL_ERROR",
      detail: "boom",
    });
    expect(p.status).toBe(500);
    expect(p.retryable).toBe(true);
  });

  it("encodes the type URI slug", () => {
    const p = problemFor({
      category: "not_found",
      code: "TENANT_NOT_FOUND",
      detail: "x",
    });
    expect(p.type).toBe("https://docs.crossengin.io/errors/tenant-not-found");
  });
});

describe("helpers", () => {
  it("httpStatusForCategory returns the expected status", () => {
    expect(httpStatusForCategory("rate_limited")).toBe(429);
    expect(httpStatusForCategory("conflict")).toBe(409);
  });

  it("isRetryable mirrors the retryable field", () => {
    const p = problemFor({
      category: "internal",
      code: "INTERNAL_ERROR",
      detail: "x",
    });
    expect(isRetryable(p)).toBe(true);
  });
});
