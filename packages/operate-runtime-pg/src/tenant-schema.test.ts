import { describe, expect, it } from "vitest";

import {
  DEFAULT_TENANT_SCHEMA_PREFIX,
  isTenantSchemaName,
  tenantSchemaName,
} from "./tenant-schema.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

describe("tenantSchemaName", () => {
  it("derives t_<32 hex> from a canonical uuid", () => {
    expect(tenantSchemaName(TENANT)).toBe("t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8");
  });

  it("fits inside Postgres's 63-character identifier limit", () => {
    expect(tenantSchemaName(TENANT).length).toBe(34);
  });

  it("is a valid lowercase identifier", () => {
    expect(tenantSchemaName(TENANT)).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it("lowercases an uppercase uuid, so one tenant has exactly one schema", () => {
    expect(tenantSchemaName(TENANT.toUpperCase())).toBe(tenantSchemaName(TENANT));
  });

  it("is injective: two tenants never collide", () => {
    const other = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f9";
    expect(tenantSchemaName(other)).not.toBe(tenantSchemaName(TENANT));
  });

  it("honours a custom prefix", () => {
    expect(tenantSchemaName(TENANT, "tenant_")).toBe("tenant_3f2a1b4c5d6e4f708192a3b4c5d6e7f8");
  });

  it("defaults the prefix to t_", () => {
    expect(DEFAULT_TENANT_SCHEMA_PREFIX).toBe("t_");
    expect(tenantSchemaName(TENANT, DEFAULT_TENANT_SCHEMA_PREFIX)).toBe(tenantSchemaName(TENANT));
  });

  it("rejects a non-uuid tenant id — the RLS predicate casts to UUID, so it could never match a row", () => {
    expect(() => tenantSchemaName("acme")).toThrow(/canonical UUID/);
    expect(() => tenantSchemaName("3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f")).toThrow(/canonical UUID/);
  });

  it("rejects a prefix that is not a valid identifier start, so it cannot be injected", () => {
    expect(() => tenantSchemaName(TENANT, 'x"; DROP SCHEMA public; --')).toThrow(/invalid tenant schema prefix/);
    expect(() => tenantSchemaName(TENANT, "9t")).toThrow(/invalid tenant schema prefix/);
    expect(() => tenantSchemaName(TENANT, "")).toThrow(/invalid tenant schema prefix/);
  });

  it("refuses rather than truncates an over-long name — truncation would collide two tenants", () => {
    expect(() => tenantSchemaName(TENANT, "a".repeat(40))).toThrow(/exceeds 63 characters/);
  });
});

describe("isTenantSchemaName", () => {
  it("recognises a schema it produced", () => {
    expect(isTenantSchemaName(tenantSchemaName(TENANT))).toBe(true);
    expect(isTenantSchemaName(tenantSchemaName(TENANT, "tenant_"), "tenant_")).toBe(true);
  });

  it("does not mistake the shared boot schema for a tenant's", () => {
    expect(isTenantSchemaName("public")).toBe(false);
    expect(isTenantSchemaName("meta")).toBe(false);
    expect(isTenantSchemaName("tenant_app")).toBe(false);
  });

  it("requires the full 32 hex characters", () => {
    expect(isTenantSchemaName("t_3f2a1b4c")).toBe(false);
    expect(isTenantSchemaName("t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8_old")).toBe(false);
  });

  it("is false for a different prefix", () => {
    expect(isTenantSchemaName(tenantSchemaName(TENANT), "tenant_")).toBe(false);
  });

  it("is false for an invalid prefix rather than throwing", () => {
    expect(isTenantSchemaName("t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8", "9bad")).toBe(false);
  });
});
