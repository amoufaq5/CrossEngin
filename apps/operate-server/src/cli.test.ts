import { describe, expect, it } from "vitest";

import { CliUsageError, parsePruneArgs, parseServeArgs } from "./cli.js";

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

  it("parses --schedule-all-tenants (DB-backed source) with a pg store", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-ms", "60000", "--schedule-all-tenants"]);
    expect(opts.scheduleMs).toBe(60000);
    expect(opts.scheduleAllTenants).toBe(true);
    expect(opts.scheduleTenants).toEqual([]);
  });

  it("defaults the scheduler options to disabled", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.scheduleMs).toBeNull();
    expect(opts.scheduleTenants).toEqual([]);
    expect(opts.scheduleAllTenants).toBe(false);
  });

  it("rejects --schedule-ms with the memory store", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--schedule-ms", "60000", "--schedule-tenant", "t"]),
    ).toThrow(/requires a Postgres store/);
  });

  it("rejects --schedule-ms without a tenant source", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-ms", "60000"])).toThrow(
      /--schedule-tenant or --schedule-all-tenants/,
    );
  });

  it("rejects --schedule-tenant + --schedule-all-tenants together", () => {
    expect(() =>
      parseServeArgs([
        "--pack",
        "erp-core",
        "--store",
        "pg",
        "--schedule-ms",
        "60000",
        "--schedule-tenant",
        "t",
        "--schedule-all-tenants",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects --schedule-all-tenants without --schedule-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-all-tenants"]),
    ).toThrow(/require --schedule-ms/);
  });

  it("rejects --schedule-tenant without --schedule-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-tenant", "t"]),
    ).toThrow(/require --schedule-ms/);
  });

  it("rejects too-small --schedule-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--schedule-ms", "500", "--schedule-tenant", "t"]),
    ).toThrow(/invalid --schedule-ms/);
  });

  it("parses --prune-links-ms with the JSONB pg store", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--prune-links-ms", "60000"]);
    expect(opts.pruneLinksMs).toBe(60000);
  });

  it("defaults --prune-links-ms to null", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).pruneLinksMs).toBeNull();
  });

  it("parses --pack-catalog with a pg store and defaults it to null", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--store", "pg", "--pack-catalog", "./catalog.json"]).packCatalogFile).toBe(
      "./catalog.json",
    );
    expect(parseServeArgs(["--pack", "erp-core"]).packCatalogFile).toBeNull();
  });

  it("rejects --pack-catalog with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--pack-catalog", "./catalog.json"])).toThrow(
      /requires a Postgres store/,
    );
  });

  it("parses --region + --residency-file and defaults them to null", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--region", "eu-central", "--residency-file", "./r.json"]);
    expect(opts.region).toBe("eu-central");
    expect(opts.residencyFile).toBe("./r.json");
    expect(parseServeArgs(["--pack", "erp-core"]).region).toBeNull();
  });

  it("rejects an invalid --region", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--region", "mars-1"])).toThrow(/invalid --region/);
  });

  it("rejects --residency-file without --region", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--residency-file", "./r.json"])).toThrow(
      /--residency-file requires --region/,
    );
  });

  it("parses --residency-store with --region + a pg store", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--region", "eu-central", "--residency-store"]);
    expect(opts.residencyStore).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core"]).residencyStore).toBe(false);
  });

  it("rejects --residency-store without --region, with the memory store, or alongside --residency-file", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--residency-store"])).toThrow(
      /--residency-store requires --region/,
    );
    expect(() => parseServeArgs(["--pack", "erp-core", "--region", "eu-central", "--residency-store"])).toThrow(
      /requires a Postgres store/,
    );
    expect(() =>
      parseServeArgs([
        "--pack",
        "erp-core",
        "--store",
        "pg",
        "--region",
        "eu-central",
        "--residency-store",
        "--residency-file",
        "./r.json",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects --prune-links-ms with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--prune-links-ms", "60000"])).toThrow(
      /requires the JSONB Postgres store/,
    );
  });

  it("rejects --prune-links-ms with the pg-columns store", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg-columns", "--prune-links-ms", "60000"]),
    ).toThrow(/requires the JSONB Postgres store/);
  });

  it("rejects too-small --prune-links-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--prune-links-ms", "500"]),
    ).toThrow(/invalid --prune-links-ms/);
  });

  it("parses --emit-entity-events + --event-prefix with a pg store", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--emit-entity-events",
      "--event-prefix",
      "retail",
    ]);
    expect(opts.emitEntityEvents).toBe(true);
    expect(opts.eventPrefix).toBe("retail");
  });

  it("defaults entity-event emission to off", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.emitEntityEvents).toBe(false);
    expect(opts.eventPrefix).toBeNull();
  });

  it("rejects --emit-entity-events with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--emit-entity-events"])).toThrow(
      /requires a Postgres store/,
    );
  });

  it("rejects --event-prefix without --emit-entity-events", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--event-prefix", "retail"]),
    ).toThrow(/requires --emit-entity-events/);
  });

  it("parses --enable-job-invoke with a pg store, defaults off", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--store", "pg", "--enable-job-invoke"]).enableJobInvoke).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core"]).enableJobInvoke).toBe(false);
  });

  it("rejects --enable-job-invoke with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--enable-job-invoke"])).toThrow(/requires a Postgres store/);
  });

  it("parses repeatable --job-invoke-role with --enable-job-invoke", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--enable-job-invoke",
      "--job-invoke-role",
      "ops_admin",
      "--job-invoke-role",
      "erp_admin",
    ]);
    expect(opts.jobInvokeRoles).toEqual(["ops_admin", "erp_admin"]);
  });

  it("defaults job-invoke roles to empty (open)", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).jobInvokeRoles).toEqual([]);
  });

  it("rejects --job-invoke-role without --enable-job-invoke", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--job-invoke-role", "ops_admin"]),
    ).toThrow(/requires --enable-job-invoke/);
  });

  it("parses repeatable --job-invoke-action-role specs", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--enable-job-invoke",
      "--job-invoke-action-role",
      "reindex-catalog:catalog_admin",
      "--job-invoke-action-role",
      "export-report:analyst",
    ]);
    expect(opts.jobInvokeActionRoles).toEqual(["reindex-catalog:catalog_admin", "export-report:analyst"]);
  });

  it("rejects a malformed --job-invoke-action-role spec", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--enable-job-invoke", "--job-invoke-action-role", "noColon"]),
    ).toThrow(/expected action:role/);
  });

  it("rejects --job-invoke-action-role without --enable-job-invoke", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--job-invoke-action-role", "a:r"]),
    ).toThrow(/requires --enable-job-invoke/);
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

describe("parsePruneArgs", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";

  it("parses a pack + tenant + schema", () => {
    const opts = parsePruneArgs(["--pack", "erp-retail", "--tenant", TENANT, "--schema", "tenant_app"]);
    expect(opts).toEqual({
      pack: "erp-retail",
      manifestPath: null,
      schema: "tenant_app",
      tenantId: TENANT,
      allTenants: false,
      dryRun: false,
      help: false,
    });
  });

  it("parses --all-tenants + --dry-run", () => {
    const opts = parsePruneArgs(["--pack", "erp-retail", "--all-tenants", "--dry-run"]);
    expect(opts.allTenants).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(opts.tenantId).toBeNull();
  });

  it("requires --tenant or --all-tenants", () => {
    expect(() => parsePruneArgs(["--pack", "erp-retail"])).toThrow(/--tenant <uuid> or --all-tenants/);
  });

  it("rejects --tenant + --all-tenants together", () => {
    expect(() => parsePruneArgs(["--pack", "x", "--tenant", TENANT, "--all-tenants"])).toThrow(/mutually exclusive/);
  });

  it("parses inline --flag=value form and a manifest source", () => {
    const opts = parsePruneArgs([`--manifest=./m.json`, `--tenant=${TENANT}`]);
    expect(opts.manifestPath).toBe("./m.json");
    expect(opts.tenantId).toBe(TENANT);
    expect(opts.pack).toBeNull();
  });

  it("requires a tenant", () => {
    expect(() => parsePruneArgs(["--pack", "erp-retail"])).toThrow(/requires --tenant/);
  });

  it("requires exactly one manifest source", () => {
    expect(() => parsePruneArgs(["--tenant", TENANT])).toThrow(/--pack or --manifest is required/);
    expect(() => parsePruneArgs(["--pack", "x", "--manifest", "m.json", "--tenant", TENANT])).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects a malformed tenant id", () => {
    expect(() => parsePruneArgs(["--pack", "erp-retail", "--tenant", "not a uuid!"])).toThrow(/invalid --tenant/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parsePruneArgs(["--pack", "x", "--tenant", TENANT, "--bogus"])).toThrow(CliUsageError);
  });

  it("--help skips required-flag validation", () => {
    expect(parsePruneArgs(["--help"]).help).toBe(true);
  });
});
