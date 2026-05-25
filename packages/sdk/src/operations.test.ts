import { describe, expect, it } from "vitest";
import {
  ApiOperationSchema,
  ApiOperationSetSchema,
  HTTP_METHODS,
  OPERATION_CATEGORIES,
  SAFE_METHODS,
  findOperation,
  operationsByCategory,
  operationsRequiringScope,
  type ApiOperation,
} from "./operations.js";

describe("constants", () => {
  it("HTTP_METHODS has 6 entries", () => {
    expect(HTTP_METHODS).toContain("GET");
    expect(HTTP_METHODS).toContain("PATCH");
    expect(HTTP_METHODS).toContain("HEAD");
  });

  it("OPERATION_CATEGORIES covers 9 areas", () => {
    expect(OPERATION_CATEGORIES).toContain("tenants");
    expect(OPERATION_CATEGORIES).toContain("webhooks");
  });

  it("SAFE_METHODS is GET and HEAD", () => {
    expect(SAFE_METHODS.has("GET")).toBe(true);
    expect(SAFE_METHODS.has("HEAD")).toBe(true);
    expect(SAFE_METHODS.has("POST")).toBe(false);
  });
});

describe("ApiOperationSchema", () => {
  const base: ApiOperation = {
    id: "tenants.list",
    category: "tenants",
    method: "GET",
    path: "/v1/tenants",
    versions: ["v1"],
    summary: "List tenants",
    requiredScopes: ["tenants:read"],
    idempotent: true,
    supportsIdempotencyKey: false,
    successStatus: 200,
    requestBodyRequired: false,
    deprecatedAt: null,
    sunsetAt: null,
  };

  it("accepts a valid GET operation", () => {
    expect(() => ApiOperationSchema.parse(base)).not.toThrow();
  });

  it("rejects GET with idempotent=false", () => {
    expect(() => ApiOperationSchema.parse({ ...base, idempotent: false })).toThrow(
      /safe method 'GET' must be idempotent=true/,
    );
  });

  it("rejects GET with requestBodyRequired", () => {
    expect(() => ApiOperationSchema.parse({ ...base, requestBodyRequired: true })).toThrow(
      /must not require a request body/,
    );
  });

  it("rejects PUT with idempotent=false", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        method: "PUT",
        idempotent: false,
        path: "/v1/tenants/:id",
      }),
    ).toThrow(/method 'PUT' must be idempotent/);
  });

  it("rejects DELETE with idempotent=false", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        method: "DELETE",
        idempotent: false,
        path: "/v1/tenants/:id",
      }),
    ).toThrow(/idempotent/);
  });

  it("rejects idempotent POST without supportsIdempotencyKey", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        method: "POST",
        path: "/v1/tenants",
        idempotent: true,
        supportsIdempotencyKey: false,
      }),
    ).toThrow(/supportsIdempotencyKey=true/);
  });

  it("rejects sunsetAt without deprecatedAt", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        sunsetAt: "2027-01-01T00:00:00Z",
      }),
    ).toThrow(/sunsetAt requires deprecatedAt/);
  });

  it("rejects sunset without replacedBy", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        deprecatedAt: "2026-01-01T00:00:00Z",
        sunsetAt: "2027-01-01T00:00:00Z",
      }),
    ).toThrow(/replacedBy/);
  });

  it("rejects duplicate scopes", () => {
    expect(() =>
      ApiOperationSchema.parse({
        ...base,
        requiredScopes: ["tenants:read", "tenants:read"],
      }),
    ).toThrow(/duplicate scope/);
  });

  it("rejects malformed operation id", () => {
    expect(() => ApiOperationSchema.parse({ ...base, id: "TenantsList" })).toThrow();
  });
});

describe("ApiOperationSetSchema", () => {
  const op = (id: string, method: ApiOperation["method"], path: string): ApiOperation => ({
    id,
    category: "tenants",
    method,
    path,
    versions: ["v1"],
    summary: "x",
    requiredScopes: ["tenants:read"],
    idempotent: SAFE_METHODS.has(method) || method === "PUT" || method === "DELETE",
    supportsIdempotencyKey: false,
    successStatus: 200,
    requestBodyRequired: false,
    deprecatedAt: null,
    sunsetAt: null,
  });

  it("accepts distinct operations", () => {
    expect(() =>
      ApiOperationSetSchema.parse([
        op("tenants.list", "GET", "/v1/tenants"),
        op("tenants.get", "GET", "/v1/tenants/:id"),
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      ApiOperationSetSchema.parse([
        op("tenants.list", "GET", "/v1/tenants"),
        op("tenants.list", "GET", "/v1/tenants-alt"),
      ]),
    ).toThrow(/duplicate operation id/);
  });

  it("rejects duplicate (version, method, path)", () => {
    expect(() =>
      ApiOperationSetSchema.parse([
        op("tenants.list", "GET", "/v1/tenants"),
        op("tenants.list-2", "GET", "/v1/tenants"),
      ]),
    ).toThrow(/duplicate \(version, method, path\)/);
  });
});

describe("helpers", () => {
  const set = [
    {
      id: "tenants.list" as const,
      category: "tenants" as const,
      method: "GET" as const,
      path: "/v1/tenants",
      versions: ["v1" as const],
      summary: "x",
      requiredScopes: ["tenants:read"],
      idempotent: true,
      supportsIdempotencyKey: false,
      successStatus: 200,
      requestBodyRequired: false,
      deprecatedAt: null,
      sunsetAt: null,
    },
    {
      id: "manifests.apply" as const,
      category: "manifests" as const,
      method: "POST" as const,
      path: "/v1/manifests/apply",
      versions: ["v1" as const],
      summary: "x",
      requiredScopes: ["manifests:write"],
      idempotent: true,
      supportsIdempotencyKey: true,
      successStatus: 202,
      requestBodyRequired: true,
      deprecatedAt: null,
      sunsetAt: null,
    },
  ];

  it("operationsRequiringScope filters by scope", () => {
    expect(operationsRequiringScope(set, "tenants:read").map((o) => o.id)).toEqual([
      "tenants.list",
    ]);
  });

  it("operationsByCategory filters by category", () => {
    expect(operationsByCategory(set, "manifests").map((o) => o.id)).toEqual(["manifests.apply"]);
  });

  it("findOperation matches (method, path)", () => {
    expect(findOperation(set, "POST", "/v1/manifests/apply")?.id).toBe("manifests.apply");
    expect(findOperation(set, "POST", "/v1/none")).toBeNull();
  });
});
