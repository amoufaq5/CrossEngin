import { describe, expect, it } from "vitest";
import {
  ROOT_SCOPE,
  ScopeCatalogSchema,
  ScopeKeySchema,
  ScopeSpecSchema,
  expandScopes,
  hasScope,
  normalizeScopes,
  type ScopeCatalog,
} from "./scopes.js";

describe("ScopeKeySchema", () => {
  it("accepts resource:action", () => {
    expect(() => ScopeKeySchema.parse("tenants:read")).not.toThrow();
    expect(() => ScopeKeySchema.parse("manifests:write")).not.toThrow();
    expect(() => ScopeKeySchema.parse("*:read")).not.toThrow();
    expect(() => ScopeKeySchema.parse("*:*")).not.toThrow();
  });

  it("rejects malformed scopes", () => {
    expect(() => ScopeKeySchema.parse("Tenants:read")).toThrow();
    expect(() => ScopeKeySchema.parse("tenants")).toThrow();
    expect(() => ScopeKeySchema.parse("tenants:execute")).toThrow();
  });

  it("ROOT_SCOPE is *:*", () => {
    expect(ROOT_SCOPE).toBe("*:*");
  });
});

describe("ScopeSpecSchema", () => {
  it("accepts a valid spec", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        key: "tenants:write",
        description: "Modify tenant configuration",
        implies: ["tenants:read"],
      }),
    ).not.toThrow();
  });

  it("rejects self-imply", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        key: "tenants:read",
        description: "x",
        implies: ["tenants:read"],
      }),
    ).toThrow(/cannot imply itself/);
  });

  it("rejects duplicate implies", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        key: "tenants:admin",
        description: "x",
        implies: ["tenants:read", "tenants:read"],
      }),
    ).toThrow(/duplicate implied scope/);
  });
});

describe("ScopeCatalogSchema", () => {
  const catalog: ScopeCatalog = [
    { key: "tenants:read", description: "x", implies: [], publicGrantable: true },
    {
      key: "tenants:write",
      description: "x",
      implies: ["tenants:read"],
      publicGrantable: true,
    },
    {
      key: "tenants:admin",
      description: "x",
      implies: ["tenants:write"],
      publicGrantable: false,
    },
  ];

  it("accepts a valid hierarchy", () => {
    expect(() => ScopeCatalogSchema.parse(catalog)).not.toThrow();
  });

  it("rejects duplicate keys", () => {
    const dup = [...catalog, catalog[0]!];
    expect(() => ScopeCatalogSchema.parse(dup)).toThrow(/duplicate scope key/);
  });

  it("rejects implies pointing to undeclared scope", () => {
    expect(() =>
      ScopeCatalogSchema.parse([
        {
          key: "tenants:read",
          description: "x",
          implies: ["foo:bar"],
          publicGrantable: true,
        },
      ]),
    ).toThrow(/not declared in the catalog/);
  });

  it("rejects cycles in implies", () => {
    expect(() =>
      ScopeCatalogSchema.parse([
        { key: "a:read", description: "x", implies: ["a:write"], publicGrantable: true },
        { key: "a:write", description: "x", implies: ["a:read"], publicGrantable: true },
      ]),
    ).toThrow(/cycle in scope/);
  });

  it("allows *:* and *:action in implies without explicit declaration", () => {
    expect(() =>
      ScopeCatalogSchema.parse([
        { key: "tenants:write", description: "x", implies: ["*:read"], publicGrantable: true },
      ]),
    ).not.toThrow();
  });
});

describe("expandScopes", () => {
  const catalog: ScopeCatalog = [
    { key: "tenants:read", description: "x", implies: [], publicGrantable: true },
    {
      key: "tenants:write",
      description: "x",
      implies: ["tenants:read"],
      publicGrantable: true,
    },
    {
      key: "tenants:admin",
      description: "x",
      implies: ["tenants:write"],
      publicGrantable: false,
    },
  ];

  it("expands transitively", () => {
    expect(expandScopes(catalog, ["tenants:admin"])).toEqual([
      "tenants:admin",
      "tenants:read",
      "tenants:write",
    ]);
  });

  it("returns the single scope when no implies", () => {
    expect(expandScopes(catalog, ["tenants:read"])).toEqual(["tenants:read"]);
  });

  it("dedupes overlapping grants", () => {
    expect(expandScopes(catalog, ["tenants:write", "tenants:read"])).toEqual([
      "tenants:read",
      "tenants:write",
    ]);
  });
});

describe("hasScope", () => {
  const catalog: ScopeCatalog = [
    { key: "tenants:read", description: "x", implies: [], publicGrantable: true },
    {
      key: "tenants:write",
      description: "x",
      implies: ["tenants:read"],
      publicGrantable: true,
    },
  ];

  it("returns true for direct match", () => {
    expect(hasScope("tenants:read", ["tenants:read"])).toBe(true);
  });

  it("returns true for *:*", () => {
    expect(hasScope("tenants:write", ["*:*"])).toBe(true);
  });

  it("returns true for resource:*", () => {
    expect(hasScope("tenants:read", ["tenants:*"])).toBe(true);
  });

  it("returns true for *:action", () => {
    expect(hasScope("tenants:read", ["*:read"])).toBe(true);
  });

  it("returns true via catalog implies", () => {
    expect(hasScope("tenants:read", ["tenants:write"], catalog)).toBe(true);
  });

  it("returns false when not granted (without catalog)", () => {
    expect(hasScope("tenants:read", ["tenants:write"])).toBe(false);
  });
});

describe("normalizeScopes", () => {
  it("dedupes and sorts", () => {
    expect(normalizeScopes(["tenants:write", "tenants:read", "tenants:write"])).toEqual([
      "tenants:read",
      "tenants:write",
    ]);
  });
});
