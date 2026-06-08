import { describe, expect, it } from "vitest";

import { ApiKeyRegistry, parseApiKeySpec } from "./principals.js";

describe("parseApiKeySpec", () => {
  it("parses key:role:tenant", () => {
    expect(parseApiKeySpec("k1:store_manager:t1")).toEqual({
      key: "k1",
      role: "store_manager",
      tenantId: "t1",
    });
  });

  it("rejects a wrong arity", () => {
    expect(() => parseApiKeySpec("k1:role")).toThrow();
    expect(() => parseApiKeySpec("k1:role:t:extra")).toThrow();
  });

  it("rejects an empty field", () => {
    expect(() => parseApiKeySpec("k1::t1")).toThrow();
  });
});

describe("ApiKeyRegistry", () => {
  const reg = new ApiKeyRegistry([
    { key: "mgr", role: "store_manager", tenantId: "t1" },
    { key: "csh", role: "cashier", tenantId: "t1" },
  ]);

  it("resolves a known x-api-key", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { "x-api-key": "mgr" } })).toEqual({
      roles: ["store_manager"],
      tenantId: "t1",
    });
  });

  it("resolves a Bearer token", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { authorization: "Bearer csh" } })).toEqual({
      roles: ["cashier"],
      tenantId: "t1",
    });
  });

  it("fails closed on an unknown / missing token", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { "x-api-key": "nope" } })).toBeNull();
    expect(reg.resolve({ method: "GET", url: "/", headers: {} })).toBeNull();
  });
});
