import { describe, expect, it } from "vitest";

import {
  CreateTenantInputSchema,
  TENANT_STATUS_TRANSITIONS,
  TenantRecordSchema,
  canTransitionTenant,
  deriveSchemaName,
} from "./platform-tenants.js";

const VALID_TENANT = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "acme",
  name: "Acme Inc",
  status: "active",
  tier: "small",
  region: "eu",
  schemaName: "t_acme",
  searchLocale: "simple",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("TenantRecordSchema", () => {
  it("accepts a well-formed record", () => {
    expect(TenantRecordSchema.parse(VALID_TENANT).slug).toBe("acme");
  });

  it("rejects an unknown status", () => {
    expect(TenantRecordSchema.safeParse({ ...VALID_TENANT, status: "frozen" }).success).toBe(false);
  });

  it("rejects an unknown tier and an extra key (strict)", () => {
    expect(TenantRecordSchema.safeParse({ ...VALID_TENANT, tier: "mega" }).success).toBe(false);
    expect(TenantRecordSchema.safeParse({ ...VALID_TENANT, extra: 1 }).success).toBe(false);
  });

  it("rejects a non-uuid id and a non-iso timestamp", () => {
    expect(TenantRecordSchema.safeParse({ ...VALID_TENANT, id: "nope" }).success).toBe(false);
    expect(TenantRecordSchema.safeParse({ ...VALID_TENANT, createdAt: "2026-06-01" }).success).toBe(false);
  });
});

describe("CreateTenantInputSchema", () => {
  it("defaults tier/region/searchLocale and leaves schemaName optional", () => {
    const parsed = CreateTenantInputSchema.parse({ slug: "acme", name: "Acme" });
    expect(parsed.tier).toBe("small");
    expect(parsed.region).toBe("eu");
    expect(parsed.searchLocale).toBe("simple");
    expect(parsed.schemaName).toBeUndefined();
  });

  it("accepts explicit tier/region/schemaName", () => {
    const parsed = CreateTenantInputSchema.parse({
      slug: "big-co",
      name: "Big Co",
      tier: "enterprise",
      region: "us",
      searchLocale: "english",
      schemaName: "t_bigco",
    });
    expect(parsed.tier).toBe("enterprise");
    expect(parsed.schemaName).toBe("t_bigco");
  });

  it("rejects an invalid slug (uppercase / leading digit / too short)", () => {
    expect(CreateTenantInputSchema.safeParse({ slug: "Acme", name: "x" }).success).toBe(false);
    expect(CreateTenantInputSchema.safeParse({ slug: "1acme", name: "x" }).success).toBe(false);
    expect(CreateTenantInputSchema.safeParse({ slug: "a", name: "x" }).success).toBe(false);
  });

  it("rejects an empty name and an unknown key (strict)", () => {
    expect(CreateTenantInputSchema.safeParse({ slug: "acme", name: "" }).success).toBe(false);
    expect(CreateTenantInputSchema.safeParse({ slug: "acme", name: "x", nope: 1 }).success).toBe(false);
  });
});

describe("canTransitionTenant", () => {
  it("allows the console transitions", () => {
    expect(canTransitionTenant("active", "suspended")).toBe(true);
    expect(canTransitionTenant("suspended", "active")).toBe(true);
    expect(canTransitionTenant("active", "archived")).toBe(true);
    expect(canTransitionTenant("suspended", "archived")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransitionTenant("active", "active")).toBe(false);
    expect(canTransitionTenant("archived", "active")).toBe(false);
    expect(canTransitionTenant("archived", "suspended")).toBe(false);
  });

  it("never reaches deleted from the console, from any status", () => {
    for (const from of ["active", "suspended", "archived", "deleted"] as const) {
      expect(canTransitionTenant(from, "deleted")).toBe(false);
    }
    expect(TENANT_STATUS_TRANSITIONS.deleted).toHaveLength(0);
  });
});

describe("deriveSchemaName", () => {
  it("prefixes t_ and folds hyphens to underscores", () => {
    expect(deriveSchemaName("acme")).toBe("t_acme");
    expect(deriveSchemaName("big-co")).toBe("t_big_co");
  });

  it("always yields a valid pg identifier", () => {
    for (const slug of ["acme", "big-co", "a1b2-c3", "zzz-zzz-zzz"]) {
      expect(deriveSchemaName(slug)).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});
