import { describe, expect, it } from "vitest";
import {
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_FILTER_OPERATORS,
  SCIM_OPERATIONS,
  SCIM_OUTCOMES,
  SCIM_PATCH_OPS,
  SCIM_RESOURCE_TYPES,
  SCIM_VERSION,
  ScimBulkRequestSchema,
  ScimGroupSchema,
  ScimPatchOperationSchema,
  ScimPatchRequestSchema,
  ScimUserSchema,
  isValidPatchPath,
  normalizeUserName,
  parseScimFilter,
} from "./scim.js";

describe("constants", () => {
  it("SCIM_VERSION is 2.0", () => {
    expect(SCIM_VERSION).toBe("2.0");
  });
  it("has 5 resource types", () => {
    expect(SCIM_RESOURCE_TYPES).toHaveLength(5);
  });
  it("has 7 operations", () => {
    expect(SCIM_OPERATIONS).toHaveLength(7);
  });
  it("has 3 patch ops", () => {
    expect(SCIM_PATCH_OPS).toEqual(["add", "replace", "remove"]);
  });
  it("has 10 filter operators", () => {
    expect(SCIM_FILTER_OPERATORS).toHaveLength(10);
  });
  it("has 10 outcomes including conflict and rate_limited", () => {
    expect(SCIM_OUTCOMES).toContain("conflict");
    expect(SCIM_OUTCOMES).toContain("rate_limited");
  });
  it("bulk operation limit is 1000", () => {
    expect(SCIM_BULK_MAX_OPERATIONS).toBe(1000);
  });
});

describe("ScimUserSchema", () => {
  it("accepts a valid User resource", () => {
    expect(() =>
      ScimUserSchema.parse({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "alice@acme.com",
        name: { givenName: "Alice", familyName: "Liddell" },
        emails: [{ value: "alice@acme.com", type: "work", primary: true }],
        active: true,
      }),
    ).not.toThrow();
  });

  it("rejects missing schemas", () => {
    expect(() =>
      ScimUserSchema.parse({
        schemas: [],
        userName: "alice",
        active: true,
      }),
    ).toThrow();
  });

  it("rejects invalid email format", () => {
    expect(() =>
      ScimUserSchema.parse({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "alice",
        emails: [{ value: "not-email" }],
        active: true,
      }),
    ).toThrow();
  });
});

describe("ScimGroupSchema", () => {
  it("accepts a valid Group", () => {
    expect(() =>
      ScimGroupSchema.parse({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Engineering",
        members: [{ value: "user-1", type: "User" }],
      }),
    ).not.toThrow();
  });

  it("defaults members to []", () => {
    const parsed = ScimGroupSchema.parse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Empty",
    });
    expect(parsed.members).toEqual([]);
  });
});

describe("ScimPatchOperationSchema", () => {
  it("accepts add op without path", () => {
    expect(() =>
      ScimPatchOperationSchema.parse({ op: "add", value: { active: false } }),
    ).not.toThrow();
  });

  it("rejects remove op without path", () => {
    expect(() => ScimPatchOperationSchema.parse({ op: "remove" })).toThrow(
      /remove operations require a path/,
    );
  });
});

describe("ScimPatchRequestSchema", () => {
  it("accepts a single-op patch", () => {
    expect(() =>
      ScimPatchRequestSchema.parse({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    ).not.toThrow();
  });

  it("rejects empty Operations", () => {
    expect(() =>
      ScimPatchRequestSchema.parse({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [],
      }),
    ).toThrow();
  });
});

describe("ScimBulkRequestSchema", () => {
  it("accepts a bulk with unique bulkIds", () => {
    expect(() =>
      ScimBulkRequestSchema.parse({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
        Operations: [
          { method: "POST", bulkId: "id1", path: "/Users", data: {} },
          { method: "POST", bulkId: "id2", path: "/Users", data: {} },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate bulkIds", () => {
    expect(() =>
      ScimBulkRequestSchema.parse({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
        Operations: [
          { method: "POST", bulkId: "id1", path: "/Users", data: {} },
          { method: "POST", bulkId: "id1", path: "/Users", data: {} },
        ],
      }),
    ).toThrow(/duplicate bulkId/);
  });

  it("rejects POST without bulkId", () => {
    expect(() =>
      ScimBulkRequestSchema.parse({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
        Operations: [
          { method: "POST", path: "/Users", data: {} },
        ],
      }),
    ).toThrow(/require bulkId/);
  });
});

describe("parseScimFilter", () => {
  it("parses eq filter", () => {
    expect(parseScimFilter('userName eq "alice"')).toEqual({
      attribute: "userName",
      operator: "eq",
      value: "alice",
    });
  });

  it("parses pr filter without value", () => {
    expect(parseScimFilter("emails pr")).toEqual({
      attribute: "emails",
      operator: "pr",
      value: null,
    });
  });

  it("rejects garbage", () => {
    expect(parseScimFilter("nonsense")).toBeNull();
  });

  it("rejects eq without value", () => {
    expect(parseScimFilter("userName eq")).toBeNull();
  });
});

describe("normalizeUserName", () => {
  it("lowercases and trims", () => {
    expect(normalizeUserName("  Alice@ACME.COM  ")).toBe("alice@acme.com");
  });
});

describe("isValidPatchPath", () => {
  it("accepts a simple attribute path", () => {
    expect(isValidPatchPath("userName")).toBe(true);
  });
  it("rejects empty path", () => {
    expect(isValidPatchPath("")).toBe(false);
  });
  it("rejects path containing slashes (invalid SCIM path syntax)", () => {
    expect(isValidPatchPath("emails/value")).toBe(false);
  });
});
