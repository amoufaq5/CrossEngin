import { describe, expect, it } from "vitest";

import { CliUsageError, parseServeArgs } from "./cli.js";

describe("parseServeArgs", () => {
  it("parses a pack + port + repeated api-keys", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-retail",
      "--port",
      "9000",
      "--api-key",
      "k1:cashier:t1",
      "--api-key",
      "k2:store_manager:t1",
    ]);
    expect(opts.pack).toBe("erp-retail");
    expect(opts.port).toBe(9000);
    expect(opts.apiKeys).toEqual(["k1:cashier:t1", "k2:store_manager:t1"]);
    expect(opts.store).toBe("memory");
  });

  it("supports --flag=value form", () => {
    const opts = parseServeArgs(["--pack=erp-core", "--port=8080", "--store=pg", "--schema=tenant_app"]);
    expect(opts.pack).toBe("erp-core");
    expect(opts.port).toBe(8080);
    expect(opts.store).toBe("pg");
    expect(opts.schema).toBe("tenant_app");
  });

  it("accepts the pg-columns store kind", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--store", "pg-columns"]).store).toBe("pg-columns");
  });

  it("parses --manifest as the source", () => {
    const opts = parseServeArgs(["--manifest", "./m.json"]);
    expect(opts.manifestPath).toBe("./m.json");
    expect(opts.pack).toBeNull();
  });

  it("flags --help and --version without requiring a source", () => {
    expect(parseServeArgs(["--help"]).help).toBe(true);
    expect(parseServeArgs(["-v"]).version).toBe(true);
  });

  it("requires exactly one manifest source", () => {
    expect(() => parseServeArgs([])).toThrow(CliUsageError);
    expect(() => parseServeArgs(["--pack", "erp-core", "--manifest", "m.json"])).toThrow(/mutually exclusive/);
  });

  it("rejects invalid values", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--port", "70000"])).toThrow(/invalid --port/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "sqlite"])).toThrow(/invalid --store/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--scheme", "ftp"])).toThrow(/invalid --scheme/);
    expect(() => parseServeArgs(["--bogus"])).toThrow(/unknown argument/);
  });

  it("requires a value for a value-flag", () => {
    expect(() => parseServeArgs(["--pack"])).toThrow(/requires a value/);
  });

  it("parses JWKS + JWT flags", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-key",
      "key-1:AAAbase64",
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience",
      "https://api/",
    ]);
    expect(opts.jwksKeys).toEqual(["key-1:AAAbase64"]);
    expect(opts.jwtIssuer).toBe("https://idp/");
    expect(opts.jwtAudience).toBe("https://api/");
  });

  it("requires issuer + audience when a JWKS is configured", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--jwks-key", "k:v"])).toThrow(/issuer.*audience/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--jwks-url", "https://idp/jwks"])).toThrow(/issuer.*audience/);
  });

  it("parses --license + --license-key for offline entitlement", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--license", "./tenant.lic", "--license-key", "PUBb64"]);
    expect(opts.licenseFile).toBe("./tenant.lic");
    expect(opts.licenseKey).toBe("PUBb64");
  });

  it("requires --license-key with --license", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--license", "./tenant.lic"])).toThrow(/--license requires --license-key/);
  });

  it("defaults license options to null", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.licenseFile).toBeNull();
    expect(opts.licenseKey).toBeNull();
    expect(opts.stripeWebhookSecret).toBeNull();
    expect(opts.planCatalogFile).toBeNull();
    expect(opts.stripeApiKey).toBeNull();
    expect(opts.billingPortalReturnUrl).toBeNull();
  });

  it("parses --stripe-api-key + --billing-portal-return-url with a pg store", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--stripe-api-key",
      "sk_test_x",
      "--billing-portal-return-url",
      "https://app/admin/billing",
    ]);
    expect(opts.stripeApiKey).toBe("sk_test_x");
    expect(opts.billingPortalReturnUrl).toBe("https://app/admin/billing");
  });

  it("parses --schedule-ms + repeatable --schedule-tenant with a pg store", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--schedule-ms",
      "60000",
      "--schedule-tenant",
      "00000000-0000-4000-8000-000000000001",
      "--schedule-tenant",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(opts.scheduleMs).toBe(60000);
    expect(opts.scheduleTenants).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("defaults the scheduler options to disabled", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.scheduleMs).toBeNull();
    expect(opts.scheduleTenants).toEqual([]);
  });

  it("rejects --schedule-ms with the memory store", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--schedule-ms", "60000", "--schedule-tenant", "t"]),
    ).toThrow(/requires a Postgres store/);
  });

  it("rejects --schedule-ms without a tenant", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-ms", "60000"])).toThrow(
      /requires at least one --schedule-tenant/,
    );
  });

  it("rejects --schedule-tenant without --schedule-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-tenant", "t"]),
    ).toThrow(/requires --schedule-ms/);
  });

  it("rejects too-small --schedule-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-ms", "500", "--schedule-tenant", "t"]),
    ).toThrow(/invalid --schedule-ms/);
  });

  it("rejects --stripe-api-key without a return url", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--stripe-api-key", "sk_x"]),
    ).toThrow(/requires --billing-portal-return-url/);
  });

  it("rejects --stripe-api-key with the memory store", () => {
    expect(() =>
      parseServeArgs([
        "--pack",
        "erp-core",
        "--stripe-api-key",
        "sk_x",
        "--billing-portal-return-url",
        "https://app/",
      ]),
    ).toThrow(/requires a Postgres store/);
  });

  it("parses --plan-catalog with a webhook secret + pg store", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--stripe-webhook-secret",
      "whsec_x",
      "--plan-catalog",
      "./plans.json",
    ]);
    expect(opts.planCatalogFile).toBe("./plans.json");
  });

  it("rejects --plan-catalog without --stripe-webhook-secret", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--plan-catalog", "./plans.json"]),
    ).toThrow(/--plan-catalog requires --stripe-webhook-secret/);
  });

  it("parses --stripe-webhook-secret with a pg store", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--stripe-webhook-secret", "whsec_x"]);
    expect(opts.stripeWebhookSecret).toBe("whsec_x");
  });

  it("rejects --stripe-webhook-secret with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--stripe-webhook-secret", "whsec_x"])).toThrow(/requires a Postgres store/);
  });

  it("parses a remote --jwks-url", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-url",
      "https://idp/.well-known/jwks.json",
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience",
      "https://api/",
    ]);
    expect(opts.jwksUrl).toBe("https://idp/.well-known/jwks.json");
  });
});
