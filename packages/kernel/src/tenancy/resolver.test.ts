import { beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "@crossengin/types";
import { createTenantResolver } from "./resolver.js";
import type { TenantDirectory, TenantResolver } from "./types.js";
import { ConflictingTenantSourcesError, TenantNotResolvedError } from "./types.js";

const TENANT_A = "tenant_a" as TenantId;
const TENANT_B = "tenant_b" as TenantId;

function makeDirectory(map: Record<string, TenantId>): TenantDirectory {
  return {
    async getBySlug(slug: string) {
      return map[slug] ?? null;
    },
  };
}

describe("createTenantResolver — resolution priority", () => {
  let resolver: TenantResolver;

  beforeEach(() => {
    resolver = createTenantResolver({
      directory: makeDirectory({ "acme-pharma": TENANT_A }),
      baseDomain: "crossengin.io",
      pathPrefix: "/t",
    });
  });

  it("resolves from subdomain when present", async () => {
    const result = await resolver.resolve({
      url: new URL("https://acme-pharma.crossengin.io/dashboard"),
    });
    expect(result).toEqual({ tenantId: TENANT_A, source: "subdomain" });
  });

  it("resolves from path prefix when subdomain is absent", async () => {
    const result = await resolver.resolve({
      url: new URL("https://crossengin.io/t/acme-pharma/dashboard"),
    });
    expect(result).toEqual({ tenantId: TENANT_A, source: "path_prefix" });
  });

  it("resolves from session when URL has no tenant", async () => {
    const result = await resolver.resolve({
      url: new URL("https://crossengin.io/account"),
      sessionTenantId: TENANT_A,
    });
    expect(result).toEqual({ tenantId: TENANT_A, source: "session" });
  });

  it("subdomain wins when session agrees", async () => {
    const result = await resolver.resolve({
      url: new URL("https://acme-pharma.crossengin.io/x"),
      sessionTenantId: TENANT_A,
    });
    expect(result).toEqual({ tenantId: TENANT_A, source: "subdomain" });
  });

  it("path prefix wins when session agrees", async () => {
    const result = await resolver.resolve({
      url: new URL("https://crossengin.io/t/acme-pharma/x"),
      sessionTenantId: TENANT_A,
    });
    expect(result).toEqual({ tenantId: TENANT_A, source: "path_prefix" });
  });
});

describe("createTenantResolver — conflict detection", () => {
  const resolver = createTenantResolver({
    directory: makeDirectory({ "acme-pharma": TENANT_A }),
    baseDomain: "crossengin.io",
    pathPrefix: "/t",
  });

  it("throws when subdomain and session disagree", async () => {
    await expect(
      resolver.resolve({
        url: new URL("https://acme-pharma.crossengin.io/"),
        sessionTenantId: TENANT_B,
      }),
    ).rejects.toBeInstanceOf(ConflictingTenantSourcesError);
  });

  it("throws when path prefix and session disagree", async () => {
    await expect(
      resolver.resolve({
        url: new URL("https://crossengin.io/t/acme-pharma/x"),
        sessionTenantId: TENANT_B,
      }),
    ).rejects.toBeInstanceOf(ConflictingTenantSourcesError);
  });

  it("conflict error exposes both tenant IDs", async () => {
    try {
      await resolver.resolve({
        url: new URL("https://acme-pharma.crossengin.io/"),
        sessionTenantId: TENANT_B,
      });
      expect.fail("expected ConflictingTenantSourcesError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictingTenantSourcesError);
      const conflict = err as ConflictingTenantSourcesError;
      expect(conflict.urlTenantId).toBe(TENANT_A);
      expect(conflict.sessionTenantId).toBe(TENANT_B);
    }
  });
});

describe("createTenantResolver — nothing-to-resolve", () => {
  const resolver = createTenantResolver({
    directory: makeDirectory({ "acme-pharma": TENANT_A }),
    baseDomain: "crossengin.io",
    pathPrefix: "/t",
  });

  it("throws when no source yields a tenant", async () => {
    await expect(
      resolver.resolve({ url: new URL("https://crossengin.io/marketing") }),
    ).rejects.toBeInstanceOf(TenantNotResolvedError);
  });

  it("treats unknown subdomain as not-resolved (no info leak)", async () => {
    await expect(
      resolver.resolve({ url: new URL("https://unknown.crossengin.io/") }),
    ).rejects.toBeInstanceOf(TenantNotResolvedError);
  });

  it("treats reserved subdomain (www) as not-resolved", async () => {
    await expect(
      resolver.resolve({ url: new URL("https://www.crossengin.io/") }),
    ).rejects.toBeInstanceOf(TenantNotResolvedError);
  });

  it("treats unknown path-prefix slug as not-resolved", async () => {
    await expect(
      resolver.resolve({ url: new URL("https://crossengin.io/t/unknown/x") }),
    ).rejects.toBeInstanceOf(TenantNotResolvedError);
  });
});

describe("createTenantResolver — configuration", () => {
  it("works without baseDomain (path prefix only)", async () => {
    const resolver = createTenantResolver({
      directory: makeDirectory({ acme: TENANT_A }),
      pathPrefix: "/t",
    });
    const result = await resolver.resolve({
      url: new URL("https://app.example.com/t/acme"),
    });
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.source).toBe("path_prefix");
  });

  it("works without pathPrefix (subdomain only)", async () => {
    const resolver = createTenantResolver({
      directory: makeDirectory({ acme: TENANT_A }),
      baseDomain: "crossengin.io",
    });
    const result = await resolver.resolve({
      url: new URL("https://acme.crossengin.io/"),
    });
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.source).toBe("subdomain");
  });

  it("works with directory alone (session-only mode)", async () => {
    const resolver = createTenantResolver({ directory: makeDirectory({}) });
    const result = await resolver.resolve({
      url: new URL("https://example.com/"),
      sessionTenantId: TENANT_A,
    });
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.source).toBe("session");
  });

  it("falls back to session when subdomain is configured but URL has none", async () => {
    const resolver = createTenantResolver({
      directory: makeDirectory({ acme: TENANT_A }),
      baseDomain: "crossengin.io",
    });
    const result = await resolver.resolve({
      url: new URL("https://crossengin.io/"),
      sessionTenantId: TENANT_A,
    });
    expect(result.source).toBe("session");
  });
});
