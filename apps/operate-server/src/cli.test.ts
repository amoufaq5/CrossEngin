import { generateEd25519Keypair } from "@crossengin/crypto";
import { DEFAULT_DELETION_GRACE_DAYS } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import { COLUMN_KEY_TTL_BOUNDS, DEFAULT_COLUMN_KEY_TTL_MS } from "./data-key-envelope.js";
import {
  COLUMN_KEY_SURVEY_CEILING_BOUNDS,
  COLUMN_KEY_SURVEY_CEILING_FLAG,
  PER_TENANT_SURVEY_CEILING,
} from "./column-key-consistency.js";
import { ALLOW_UNCOVERED_SETTLEMENT_FLAG } from "./settlement-coverage-survey.js";
import {
  CliUsageError,
  helpText,
  parseColumnSchemaArgs,
  parseDocumentIndexesArgs,
  parsePruneArgs,
  parseRekeyArgs,
  parseServeArgs,
  parseSetCredentialArgs,
  parseVerifyChainArgs,
  rekeyHelpText,
  setCredentialCliHelpText,
} from "./cli.js";

const JWKS_PUB = generateEd25519Keypair().publicKeyBase64;

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

  it("--platform-admin defaults its role, accepts overrides, and requires a pg store", () => {
    const dflt = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--platform-admin"]);
    expect(dflt.platformAdmin).toBe(true);
    expect(dflt.platformAdminRoles).toEqual(["platform_admin"]);

    const custom = parseServeArgs([
      "--pack", "erp-core", "--store", "pg-columns", "--platform-admin",
      "--platform-admin-role", "super", "--platform-admin-role", "ops",
    ]);
    expect(custom.platformAdminRoles).toEqual(["super", "ops"]);

    expect(parseServeArgs(["--pack", "erp-core"]).platformAdmin).toBe(false);
    expect(() => parseServeArgs(["--pack", "erp-core", "--platform-admin"])).toThrow(
      /--platform-admin requires a Postgres store/,
    );
  });

  it("--ai-design defaults roles, implies per-tenant manifests, and requires a pg store", () => {
    const dflt = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-design"]);
    expect(dflt.aiDesign).toBe(true);
    expect(dflt.aiDesignRoles).toEqual(["erp_admin", "platform_admin"]);
    expect(dflt.perTenantManifests).toBe(true);
    expect(dflt.aiModel).toBeNull();

    const custom = parseServeArgs([
      "--pack", "erp-core", "--store", "pg-columns", "--ai-design",
      "--ai-design-role", "founder", "--ai-model", "gpt-4o",
    ]);
    expect(custom.aiDesignRoles).toEqual(["founder"]);
    expect(custom.aiModel).toBe("gpt-4o");

    const off = parseServeArgs(["--pack", "erp-core"]);
    expect(off.aiDesign).toBe(false);
    expect(off.perTenantManifests).toBe(false);
    expect(() => parseServeArgs(["--pack", "erp-core", "--ai-design"])).toThrow(
      /--ai-design \/ --per-tenant-manifests require a Postgres store/,
    );
  });

  it("--per-tenant-manifests stands alone without --ai-design", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--per-tenant-manifests"]);
    expect(opts.perTenantManifests).toBe(true);
    expect(opts.aiDesign).toBe(false);
    expect(() => parseServeArgs(["--pack", "erp-core", "--per-tenant-manifests"])).toThrow(
      /require a Postgres store/,
    );
  });

  it("--require-design-review implies --design-review and defaults its role", () => {
    const opts = parseServeArgs([
      "--pack", "erp-core", "--store", "pg", "--ai-design", "--require-design-review",
    ]);
    expect(opts.requireDesignReview).toBe(true);
    // The implication is the whole reason one flag is enough on the shipped compose: passing
    // `--design-review` alone would mount the console over a queue nothing enrols into.
    expect(opts.designReview).toBe(true);
    expect(opts.designReviewRoles).toEqual(["platform_admin"]);

    const bare = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-design", "--design-review"]);
    expect(bare.designReview).toBe(true);
    expect(bare.requireDesignReview).toBe(false);
  });

  it("--allow-design-self-approval is off by default and refused without the review routes", () => {
    const off = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-design", "--require-design-review"]);
    expect(off.allowDesignSelfApproval).toBe(false);
    const on = parseServeArgs([
      "--pack", "erp-core", "--store", "pg", "--ai-design", "--require-design-review",
      "--allow-design-self-approval",
    ]);
    expect(on.allowDesignSelfApproval).toBe(true);
    // Without the review routes nothing enforces four-eyes, so the hatch would read as a decision
    // and change nothing.
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-design", "--allow-design-self-approval"]),
    ).toThrow(/--allow-design-self-approval requires --design-review/);
  });

  it("refuses a review gate that would be silently inert", () => {
    // No Postgres: `reviewStore` is never built, so nothing enrols a proposal and `reviewGate` is
    // never passed — the activation handler skips the check and every proposal activates unreviewed.
    //
    // WITH `--ai-design` the message is the Architect's own store refusal, which fires first and is
    // the right thing to say: the operator needs Postgres for the Architect at all, so naming the
    // review gate would send them to the narrower of two problems. That ordering is asserted rather
    // than worked around, because it is why the review store arm below is only ever reached on a
    // deployment that did not ask for the Architect.
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--ai-design", "--require-design-review"]),
    ).toThrow(/--ai-design \/ --per-tenant-manifests require a Postgres store/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--design-review"])).toThrow(
      /--design-review \/ --require-design-review require a Postgres store/,
    );

    // No producer: `source: "ai"` is the only thing that writes a proposal, so a reviewer without
    // the Architect gets a console over a queue that can never be non-empty.
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--require-design-review"]),
    ).toThrow(/require --ai-design/);
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--design-review"]),
    ).toThrow(/require --ai-design/);

    // Both arms are refusals of a *gate*, not of the Architect: --ai-design alone still parses.
    expect(
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-design"]).designReview,
    ).toBe(false);
  });

  it("requires a value for a value-flag", () => {
    expect(() => parseServeArgs(["--pack"])).toThrow(/requires a value/);
  });

  it("parses JWKS + JWT flags", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-key",
      `key-1:${JWKS_PUB}`,
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience",
      "https://api/",
    ]);
    expect(opts.jwksKeys).toEqual([`key-1:${JWKS_PUB}`]);
    expect(opts.jwtIssuer).toBe("https://idp/");
    expect(opts.jwtAudience).toBe("https://api/");
  });

  it("requires issuer + audience when a JWKS is configured", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--jwks-key", `k:${JWKS_PUB}`])).toThrow(
      /issuer.*audience/,
    );
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

  it("parses --notification-drain-ms with a pg store", () => {
    const opts = parseServeArgs([
      "--pack", "erp-core", "--store", "pg", "--notification-drain-ms", "30000",
    ]);
    expect(opts.notificationDrainMs).toBe(30000);
  });

  it("defaults --notification-drain-ms to null and the admin roles to the built-ins", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.notificationDrainMs).toBeNull();
    expect(opts.notificationAdminRoles).toContain("erp_admin");
  });

  it("rejects --notification-drain-ms with the memory store", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--notification-drain-ms", "30000"]),
    ).toThrow(/requires a Postgres store/);
  });

  it("rejects a sub-second --notification-drain-ms", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--notification-drain-ms", "10"]),
    ).toThrow(/invalid --notification-drain-ms/);
  });

  it("collects repeatable --notification-admin-role", () => {
    const opts = parseServeArgs([
      "--pack", "erp-core", "--store", "pg",
      "--notification-drain-ms", "30000",
      "--notification-admin-role", "ops_lead",
      "--notification-admin-role", "billing_admin",
    ]);
    expect(opts.notificationAdminRoles).toEqual(["ops_lead", "billing_admin"]);
  });

  it("rejects --notification-admin-role without the drain interval", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--notification-admin-role", "ops_lead"]),
    ).toThrow(/requires --notification-drain-ms/);
  });

  it("parses --pack-catalog with a pg store and a registered publisher, and defaults it to null", () => {
    const key = `com.acme:community:${generateEd25519Keypair().publicKeyBase64}`;
    const opts = parseServeArgs([
      "--pack", "erp-core", "--store", "pg", "--pack-catalog", "./catalog.json", "--pack-publisher-key", key,
    ]);
    expect(opts.packCatalogFile).toBe("./catalog.json");
    expect(opts.packPublisherKeys).toEqual([key]);
    expect(opts.packAdminRoles).toEqual(["erp_admin"]);
    expect(opts.marketplacePlatformVersion).toBeNull();
    expect(parseServeArgs(["--pack", "erp-core"]).packCatalogFile).toBeNull();
  });

  it("refuses a marketplace surface with no registered publisher key, naming the flag", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--pack-catalog", "./catalog.json"])).toThrow(
      /--pack-catalog requires at least one --pack-publisher-key/,
    );
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--marketplace-authoring"])).toThrow(
      /--marketplace-authoring requires at least one --pack-publisher-key/,
    );
  });

  it("refuses a malformed publisher key, and two keys whose namespaces overlap", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--marketplace-authoring", "--pack-publisher-key", "com.acme:community"]),
    ).toThrow(/invalid --pack-publisher-key/);
    const a = `com.acme:community:${generateEd25519Keypair().publicKeyBase64}`;
    const b = `com.acme.labs:community:${generateEd25519Keypair().publicKeyBase64}`;
    expect(() =>
      parseServeArgs([
        "--pack", "erp-core", "--store", "pg", "--marketplace-authoring", "--pack-publisher-key", a, "--pack-publisher-key", b,
      ]),
    ).toThrow(/invalid --pack-publisher-key set: .*overlap/);
  });

  it("parses --marketplace-platform-version and --pack-admin-role, refusing a non-semver version", () => {
    const key = `com.acme:community:${generateEd25519Keypair().publicKeyBase64}`;
    const catalog = ["--store", "pg", "--pack-catalog", "./c.json", "--pack-publisher-key", key];
    const opts = parseServeArgs([
      "--pack", "erp-core", ...catalog, "--marketplace-platform-version", "1.4.0", "--pack-admin-role", "pack_admin",
    ]);
    expect(opts.marketplacePlatformVersion).toBe("1.4.0");
    expect(opts.packAdminRoles).toEqual(["pack_admin"]);
    expect(() => parseServeArgs(["--pack", "erp-core", ...catalog, "--marketplace-platform-version", "latest"])).toThrow(
      /invalid --marketplace-platform-version/,
    );
  });

  it("refuses the marketplace's configuration flags when no surface reads them", () => {
    const key = `com.acme:community:${generateEd25519Keypair().publicKeyBase64}`;
    expect(() => parseServeArgs(["--pack", "erp-core", "--pack-admin-role", "pack_admin"])).toThrow(
      /--pack-admin-role configures a marketplace surface and none is mounted/,
    );
    expect(() => parseServeArgs(["--pack", "erp-core", "--marketplace-platform-version", "1.4.0"])).toThrow(
      /none is mounted/,
    );
    expect(() => parseServeArgs(["--pack", "erp-core", "--pack-publisher-key", key])).toThrow(
      /--pack-publisher-key configures .* pass --pack-catalog or --marketplace-authoring/,
    );
    // Authoring reads the keys and nothing else: the platform version and the install role stay inert.
    expect(() =>
      parseServeArgs([
        "--pack", "erp-core", "--store", "pg", "--marketplace-authoring", "--pack-publisher-key", key,
        "--pack-admin-role", "pack_admin",
      ]),
    ).toThrow(/--pack-admin-role configures/);
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

  it("parses --bounce-webhook + --bounce-transient-hours with a pg store", () => {
    // A boolean flag must not advance the index itself: `consumed()` is an *extra* increment on top
    // of the loop's own, so an `i += 1` here swallowed the following flag and left its value bare.
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--bounce-webhook",
      "--bounce-transient-hours",
      "24",
    ]);
    expect(opts.bounceWebhook).toBe(true);
    expect(opts.bounceTransientHours).toBe(24);
  });

  it("defaults the bounce webhook to off", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.bounceWebhook).toBe(false);
    expect(opts.bounceTransientHours).toBeNull();
  });

  it("rejects --bounce-webhook with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--bounce-webhook"])).toThrow(
      /requires a Postgres store/,
    );
  });

  it("rejects --bounce-transient-hours without --bounce-webhook", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--bounce-transient-hours", "24"]),
    ).toThrow(/requires --bounce-webhook/);
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

  it("admits --plan-catalog without --stripe-webhook-secret: the secret may come from STRIPE_WEBHOOK_SECRET, so boot decides", () => {
    // The parser reads no environment, so this check moved to boot over the resolved secrets
    // (stripeRequirementRefusal); refusing here refused every environment-only deployment.
    expect(
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--plan-catalog", "./plans.json"]).planCatalogFile,
    ).toBe("./plans.json");
  });

  it("parses --stripe-webhook-secret with a pg store", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--store", "pg", "--stripe-webhook-secret", "whsec_x"]);
    expect(opts.stripeWebhookSecret).toBe("whsec_x");
  });

  it("rejects --stripe-webhook-secret with the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--stripe-webhook-secret", "whsec_x"])).toThrow(/requires a Postgres store/);
  });

  it("parses --slo-config and defaults it to null", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--integrity-proof-config", "./ip.json"])
        .integrityProofConfig,
    ).toBe("./ip.json");
    expect(
      parseServeArgs(["--pack=erp-core", "--integrity-proof-config=./ip.json"]).integrityProofConfig,
    ).toBe("./ip.json");
    expect(parseServeArgs(["--pack", "erp-core"]).integrityProofConfig).toBeNull();
    expect(parseServeArgs(["--pack", "erp-core", "--slo-config", "./slo.json"]).sloConfig).toBe("./slo.json");
    expect(parseServeArgs(["--pack=erp-core", "--slo-config=./slo.json"]).sloConfig).toBe("./slo.json");
    expect(parseServeArgs(["--pack", "erp-core"]).sloConfig).toBeNull();
  });

  it("parses --slo-defaults and defaults it to false", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--slo-defaults"]).sloDefaults).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core"]).sloDefaults).toBe(false);
  });

  it("rejects --slo-defaults together with --slo-config", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--slo-defaults", "--slo-config", "./slo.json"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("parses --slo-defaults-override only with --slo-defaults", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--slo-defaults", "--slo-defaults-override", "./ov.json"]).sloDefaultsOverride,
    ).toBe("./ov.json");
    expect(parseServeArgs(["--pack", "erp-core"]).sloDefaultsOverride).toBeNull();
  });

  it("rejects --slo-defaults-override without --slo-defaults", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--slo-defaults-override", "./ov.json"])).toThrow(
      /requires --slo-defaults/,
    );
  });

  it("parses --dr-readiness-config and defaults it to null", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--dr-readiness-config", "./dr.json"]).drReadinessConfig).toBe("./dr.json");
    expect(parseServeArgs(["--pack=erp-core", "--dr-readiness-config=./dr.json"]).drReadinessConfig).toBe("./dr.json");
    expect(parseServeArgs(["--pack", "erp-core"]).drReadinessConfig).toBeNull();
  });

  it("parses --access-reviews-live-grants only with --access-reviews-config", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--access-reviews-config", "./ar.json", "--access-reviews-live-grants"])
        .accessReviewsLiveGrants,
    ).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core"]).accessReviewsLiveGrants).toBe(false);
  });

  it("rejects --access-reviews-live-grants without --access-reviews-config", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--access-reviews-live-grants"])).toThrow(
      /requires --access-reviews-config/,
    );
  });

  it("parses --marketplace-authoring (needs pg) and defaults it to false", () => {
    const key = `com.acme:community:${generateEd25519Keypair().publicKeyBase64}`;
    expect(
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--marketplace-authoring", "--pack-publisher-key", key])
        .marketplaceAuthoring,
    ).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core"]).marketplaceAuthoring).toBe(false);
  });

  it("rejects --marketplace-authoring on a memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--marketplace-authoring"])).toThrow(/requires a Postgres store/);
  });

  it("parses --metering-config and defaults it to null", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--metering-config", "./m.json"]).meteringConfig).toBe("./m.json");
    expect(parseServeArgs(["--pack=erp-core", "--metering-config=./m.json"]).meteringConfig).toBe("./m.json");
    expect(parseServeArgs(["--pack", "erp-core"]).meteringConfig).toBeNull();
  });

  it("parses --stripe-usage-sync-config (needs --stripe-api-key + pg)", () => {
    const ok = parseServeArgs([
      "--pack", "erp-core", "--store", "pg", "--stripe-api-key", "sk_test", "--stripe-usage-sync-config", "./s.json",
    ]);
    expect(ok.stripeUsageSyncConfig).toBe("./s.json");
    expect(parseServeArgs(["--pack", "erp-core"]).stripeUsageSyncConfig).toBeNull();
  });

  it("admits --stripe-usage-sync-config without --stripe-api-key: STRIPE_API_KEY may supply it, so boot decides", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--stripe-usage-sync-config", "./s.json"])
        .stripeUsageSyncConfig,
    ).toBe("./s.json");
  });

  it("allows --stripe-api-key with --stripe-usage-sync-config (no billing-portal url needed)", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--stripe-api-key", "sk_test", "--stripe-usage-sync-config", "./s.json"]),
    ).not.toThrow();
  });

  it("parses --access-reviews-config and defaults it to null", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--access-reviews-config", "./ar.json"]).accessReviewsConfig).toBe("./ar.json");
    expect(parseServeArgs(["--pack=erp-core", "--access-reviews-config=./ar.json"]).accessReviewsConfig).toBe("./ar.json");
    expect(parseServeArgs(["--pack", "erp-core"]).accessReviewsConfig).toBeNull();
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

describe("parseVerifyChainArgs", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";

  it("parses a tenant scope with schema + format", () => {
    const opts = parseVerifyChainArgs(["--tenant", TENANT, "--schema", "tenant_app", "--format", "json"]);
    expect(opts.tenantId).toBe(TENANT);
    expect(opts.platform).toBe(false);
    expect(opts.schema).toBe("tenant_app");
    expect(opts.format).toBe("json");
  });

  it("parses the platform scope and defaults format to human", () => {
    const opts = parseVerifyChainArgs(["--platform"]);
    expect(opts.platform).toBe(true);
    expect(opts.tenantId).toBeNull();
    expect(opts.format).toBe("human");
    expect(opts.fromCheckpoint).toBe(false);
  });

  it("parses --from-checkpoint", () => {
    expect(parseVerifyChainArgs(["--platform", "--from-checkpoint"]).fromCheckpoint).toBe(true);
    expect(parseVerifyChainArgs(["--tenant", TENANT]).fromCheckpoint).toBe(false);
  });

  it("requires exactly one of --tenant / --platform", () => {
    expect(() => parseVerifyChainArgs([])).toThrow(/--tenant <uuid> or --platform/);
    expect(() => parseVerifyChainArgs(["--tenant", TENANT, "--platform"])).toThrow(/mutually exclusive/);
  });

  it("rejects a malformed tenant, a bad format, and unknown args", () => {
    expect(() => parseVerifyChainArgs(["--tenant", "nope!"])).toThrow(/invalid --tenant/);
    expect(() => parseVerifyChainArgs(["--platform", "--format", "yaml"])).toThrow(/invalid --format/);
    expect(() => parseVerifyChainArgs(["--platform", "--bogus"])).toThrow(CliUsageError);
  });

  it("--help skips required-flag validation", () => {
    expect(parseVerifyChainArgs(["--help"]).help).toBe(true);
  });
});

describe("parseDocumentIndexesArgs", () => {
  it("takes the pack the API serves, inline or separate", () => {
    expect(parseDocumentIndexesArgs(["--pack", "erp-core"])).toEqual({
      pack: "erp-core",
      manifestPath: null,
      schema: null,
      help: false,
    });
    expect(parseDocumentIndexesArgs(["--pack=erp-core", "--schema=tenants"]).schema).toBe("tenants");
  });

  it("takes a manifest file instead", () => {
    expect(parseDocumentIndexesArgs(["--manifest", "m.json"]).manifestPath).toBe("m.json");
  });

  it("requires exactly one manifest source, because the indexes are per manifest", () => {
    expect(() => parseDocumentIndexesArgs([])).toThrow(/one of --pack or --manifest is required/);
    expect(() => parseDocumentIndexesArgs(["--pack", "erp-core", "--manifest", "m.json"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    expect(() => parseDocumentIndexesArgs(["--pack", "erp-core", "--store", "pg"])).toThrow(
      /unknown argument: --store/,
    );
  });

  it("answers --help without a source", () => {
    expect(parseDocumentIndexesArgs(["--help"]).help).toBe(true);
  });
});

describe("parseColumnSchemaArgs", () => {
  it("takes the pack, the schema and every role to grant, de-duplicated", () => {
    expect(
      parseColumnSchemaArgs(["--pack", "erp-core", "--grant-to", "crossengin_app", "--grant-to=crossengin_app"]),
    ).toEqual({ pack: "erp-core", manifestPath: null, schema: null, grantTo: ["crossengin_app"], help: false });
    expect(parseColumnSchemaArgs(["--manifest=m.json", "--schema", "tenant_app"]).schema).toBe("tenant_app");
  });

  it("grants nothing when no role is named", () => {
    expect(parseColumnSchemaArgs(["--pack", "erp-core"]).grantTo).toEqual([]);
  });

  it("refuses a role name that is not one, because it becomes a quoted identifier in a GRANT", () => {
    expect(() => parseColumnSchemaArgs(["--pack", "erp-core", "--grant-to", "app; DROP"])).toThrow(
      /not a role name/,
    );
  });

  it("requires exactly one manifest source, and refuses an unknown argument", () => {
    expect(() => parseColumnSchemaArgs([])).toThrow(/one of --pack or --manifest is required/);
    expect(() => parseColumnSchemaArgs(["--pack", "a", "--manifest", "b"])).toThrow(/mutually exclusive/);
    expect(() => parseColumnSchemaArgs(["--pack", "a", "--store", "pg"])).toThrow(/unknown argument: --store/);
  });

  it("answers --help without a source", () => {
    expect(parseColumnSchemaArgs(["-h"]).help).toBe(true);
  });
});

describe("parseRekeyArgs", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";
  const OTHER = "00000000-0000-4000-8000-000000000002";
  const REQUIRED = ["--tenant", TENANT, "--confirm-tenant", TENANT];

  it("parses --rewrap-kek, off by default", () => {
    expect(parseRekeyArgs(REQUIRED).rewrapKek).toBe(false);
    expect(parseRekeyArgs([...REQUIRED, "--rewrap-kek"]).rewrapKek).toBe(true);
  });

  it("refuses --rewrap-kek with --allow-live-rekey, which has nothing to allow there", () => {
    expect(() => parseRekeyArgs([...REQUIRED, "--rewrap-kek", "--allow-live-rekey"])).toThrow(
      /nothing to allow/,
    );
  });

  it("still requires the confirmation under --rewrap-kek", () => {
    expect(() => parseRekeyArgs(["--tenant", TENANT, "--rewrap-kek"])).toThrow(/--confirm-tenant/);
  });

  it("parses the required pair, the two schemas and the flags", () => {
    const opts = parseRekeyArgs([
      ...REQUIRED,
      "--plan",
      "--schema",
      "custom_meta",
      "--data-schema",
      "t_abc",
      "--allow-live-rekey",
      "--format",
      "json",
    ]);
    expect(opts.tenantId).toBe(TENANT);
    expect(opts.confirmTenantId).toBe(TENANT);
    expect(opts.plan).toBe(true);
    expect(opts.schema).toBe("custom_meta");
    expect(opts.dataSchema).toBe("t_abc");
    expect(opts.allowLiveRekey).toBe(true);
    expect(opts.format).toBe("json");
  });

  it("defaults both schemas to null and every flag to off", () => {
    const opts = parseRekeyArgs(REQUIRED);
    expect(opts.schema).toBeNull();
    expect(opts.dataSchema).toBeNull();
    expect(opts.plan).toBe(false);
    expect(opts.allowLiveRekey).toBe(false);
    expect(opts.format).toBe("human");
    expect(opts.help).toBe(false);
  });

  it("requires the tenant id twice, including under --plan", () => {
    expect(() => parseRekeyArgs([])).toThrow(/rekey requires --tenant/);
    expect(() => parseRekeyArgs(["--tenant", TENANT])).toThrow(/requires --confirm-tenant/);
    // Required under `--plan` too, so the invocation an operator reviews is the one they then
    // re-run without the flag.
    expect(() => parseRekeyArgs(["--tenant", TENANT, "--plan"])).toThrow(
      /requires --confirm-tenant/,
    );
    expect(() => parseRekeyArgs(["--tenant", TENANT, "--confirm-tenant", OTHER])).toThrow(
      /--confirm-tenant must equal --tenant/,
    );
  });

  it("rejects a malformed tenant, a bad format and unknown args", () => {
    expect(() => parseRekeyArgs(["--tenant", "nope!", "--confirm-tenant", "nope!"])).toThrow(
      /invalid --tenant/,
    );
    expect(() => parseRekeyArgs([...REQUIRED, "--format", "yaml"])).toThrow(/invalid --format/);
    expect(() => parseRekeyArgs([...REQUIRED, "--yes"])).toThrow(CliUsageError);
  });

  it("--help skips required-flag validation", () => {
    expect(parseRekeyArgs(["--help"]).help).toBe(true);
    expect(parseRekeyArgs(["-h"]).help).toBe(true);
  });
});

describe("parseRekeyArgs — --column-key-ttl-ms", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";
  const REQUIRED = ["--tenant", TENANT, "--confirm-tenant", TENANT];

  it("parses the fleet's value, in both flag forms", () => {
    // The flag this subcommand did not parse at all, while printing the default beside its name —
    // so the stale-key window read as a measurement and understated the hazard by up to 10x for a
    // fleet on the ceiling, in the direction where an operator resumes writes too early.
    expect(parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms", "60000"]).columnKeyTtlMs).toBe(
      60_000,
    );
    expect(parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms=60000"]).columnKeyTtlMs).toBe(60_000);
  });

  it("is null when omitted, so the report can say the figure is a default and unread", () => {
    // Null and not `DEFAULT_COLUMN_KEY_TTL_MS`: the absence is the fact the stale-key line reports,
    // and defaulting it here would make "stated" unanswerable downstream.
    expect(parseRekeyArgs(REQUIRED).columnKeyTtlMs).toBeNull();
    expect(DEFAULT_COLUMN_KEY_TTL_MS).toBeGreaterThanOrEqual(COLUMN_KEY_TTL_BOUNDS.min);
  });

  it("accepts both bounds and refuses a value outside them, naming them", () => {
    const min = COLUMN_KEY_TTL_BOUNDS.min;
    const max = COLUMN_KEY_TTL_BOUNDS.max;
    expect(
      parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms", String(min)]).columnKeyTtlMs,
    ).toBe(min);
    expect(
      parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms", String(max)]).columnKeyTtlMs,
    ).toBe(max);
    for (const bad of [String(min - 1), String(max + 1), "0", "-1"]) {
      const thrown = (): unknown => parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms", bad]);
      expect(thrown).toThrow(CliUsageError);
      expect(thrown).toThrow(
        new RegExp(`must be an integer between ${String(min)} and ${String(max)} ms`),
      );
    }
  });

  it("refuses a non-integer rather than coercing it", () => {
    for (const bad of ["abc", "1.5", "30s", ""]) {
      expect(() => parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms", bad])).toThrow(
        /must be an integer between/,
      );
    }
  });

  it("requires a value", () => {
    expect(() => parseRekeyArgs([...REQUIRED, "--column-key-ttl-ms"])).toThrow(
      /--column-key-ttl-ms requires a value/,
    );
  });

  it("is documented in the help text, with what it is for", () => {
    // A flag the report points at has to be a flag the help mentions, or an operator reading
    // "pass it here" has nowhere to look.
    expect(rekeyHelpText).toContain("--column-key-ttl-ms");
    expect(rekeyHelpText).toContain("does not run");
    expect(rekeyHelpText).toContain("--confirm-tenant");
    expect(rekeyHelpText).toContain("--data-schema");
  });
});

describe("parseServeArgs — manifest refresh + AI budget flags", () => {
  const BASE = ["--pack", "erp-core"];
  it("defaults both to null", () => {
    const opts = parseServeArgs(BASE);
    expect(opts.manifestRefreshMs).toBeNull();
    expect(opts.aiMaxUsdPerMonth).toBeNull();
  });

  it("parses --manifest-refresh-ms in both forms and rejects sub-second / non-integer", () => {
    expect(parseServeArgs([...BASE, "--manifest-refresh-ms", "5000"]).manifestRefreshMs).toBe(5000);
    expect(parseServeArgs([...BASE, "--manifest-refresh-ms=2500"]).manifestRefreshMs).toBe(2500);
    expect(() => parseServeArgs([...BASE, "--manifest-refresh-ms", "999"])).toThrow();
    expect(() => parseServeArgs([...BASE, "--manifest-refresh-ms", "abc"])).toThrow();
  });

  it("parses --ai-max-usd-per-month and rejects zero / negative / non-numeric", () => {
    expect(parseServeArgs([...BASE, "--ai-max-usd-per-month", "50"]).aiMaxUsdPerMonth).toBe(50);
    expect(parseServeArgs([...BASE, "--ai-max-usd-per-month=12.5"]).aiMaxUsdPerMonth).toBe(12.5);
    expect(() => parseServeArgs([...BASE, "--ai-max-usd-per-month", "0"])).toThrow();
    expect(() => parseServeArgs([...BASE, "--ai-max-usd-per-month", "-3"])).toThrow();
    expect(() => parseServeArgs([...BASE, "--ai-max-usd-per-month", "nope"])).toThrow();
  });
});

describe("parseServeArgs — notification audit roles", () => {
  it("defaults to nobody, so the inbox is per-recipient", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).notificationAuditRoles).toEqual([]);
  });

  it("collects repeatable --notification-audit-role", () => {
    const opts = parseServeArgs([
      "--pack", "erp-core", "--store", "pg",
      "--notification-audit-role", "platform_admin",
      "--notification-audit-role", "compliance_officer",
    ]);
    expect(opts.notificationAuditRoles).toEqual(["platform_admin", "compliance_officer"]);
  });
});

describe("parseServeArgs — the GDPR deletion handle", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("defaults every grant to nobody", () => {
    const opts = parseServeArgs([...PG, "--deletion-request-routes"]);
    expect(opts.deletionRequestSubmitRoles).toEqual([]);
    expect(opts.deletionRequestVerifyRoles).toEqual([]);
    expect(opts.deletionRequestReadRoles).toEqual([]);
  });

  it("a role implies the routes, like every sibling flag", () => {
    const opts = parseServeArgs([...PG, "--deletion-request-submit-role", "support"]);
    expect(opts.deletionRequestRoutes).toBe(true);
    expect(opts.deletionRequestSubmitRoles).toEqual(["support"]);
  });

  it("caps the deadline at Article 12(3)'s three months", () => {
    expect(parseServeArgs([...PG, "--deletion-request-deadline-days=90"]).deletionRequestDeadlineDays).toBe(90);
    expect(() => parseServeArgs([...PG, "--deletion-request-deadline-days", "91"])).toThrow(/Article 12\(3\)/);
    expect(() => parseServeArgs([...PG, "--deletion-request-deadline-days", "0"])).toThrow();
  });

  it("rejects a sub-second runner interval and a batch size outside 1..100", () => {
    expect(parseServeArgs([...PG, "--deletion-runner-ms=2000"]).deletionRunnerMs).toBe(2000);
    expect(() => parseServeArgs([...PG, "--deletion-runner-ms", "999"])).toThrow();
    expect(() => parseServeArgs([...PG, "--deletion-runner-batch-size", "101"])).toThrow();
  });

  it("refuses the memory store, rather than booting a surface that cannot work", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--deletion-request-routes"])).toThrow(/Postgres/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--deletion-runner-ms", "2000"])).toThrow(/Postgres/);
  });

  it("refuses --deletion-runner-approved-by by name: the approver is the request's verifier (H-05)", () => {
    // It used to be a configured string standing in for an approval nobody gave; every value,
    // including the former default, is refused rather than silently ignored.
    for (const value of ["system:retention-policy", "b", "a"]) {
      expect(() => parseServeArgs([...PG, "--deletion-runner-approved-by", value])).toThrow(
        /principal who verified/,
      );
    }
    expect(
      parseServeArgs([...PG, "--deletion-runner-executed-by", "a"]).deletionRunnerExecutedBy,
    ).toBe("a");
  });

  it("defaults the grace period and accepts 0..90 whole days, refusing the rest", () => {
    expect(parseServeArgs([...PG]).deletionGraceDays).toBe(DEFAULT_DELETION_GRACE_DAYS);
    expect(parseServeArgs([...PG, "--deletion-grace-days", "0"]).deletionGraceDays).toBe(0);
    expect(parseServeArgs([...PG, "--deletion-grace-days=90"]).deletionGraceDays).toBe(90);
    for (const bad of ["-1", "91", "1.5", "x"]) {
      expect(() => parseServeArgs([...PG, "--deletion-grace-days", bad])).toThrow(
        /--deletion-grace-days/,
      );
    }
  });
});

describe("parseServeArgs — reconciling a stranded deletion", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("defaults the reconcile grant to nobody and the window to unset", () => {
    const opts = parseServeArgs([...PG, "--deletion-request-routes"]);
    expect(opts.deletionRequestReconcileRoles).toEqual([]);
    expect(opts.deletionStrandedAfterMs).toBeNull();
  });

  it("a reconcile role implies the routes", () => {
    const opts = parseServeArgs([...PG, "--deletion-request-reconcile-role=platform_admin"]);
    expect(opts.deletionRequestRoutes).toBe(true);
    expect(opts.deletionRequestReconcileRoles).toEqual(["platform_admin"]);
  });

  it("floors the staleness window at a minute", () => {
    expect(parseServeArgs([...PG, "--deletion-stranded-after-ms", "60000"]).deletionStrandedAfterMs).toBe(60_000);
    // The window exists to be far longer than any pipeline run; a shorter one would read "still
    // running" as "never committed".
    expect(() => parseServeArgs([...PG, "--deletion-stranded-after-ms", "5000"])).toThrow(/60000/);
    expect(() => parseServeArgs([...PG, "--deletion-stranded-after-ms", "nope"])).toThrow();
  });

  it("accepts --deletion-subject-scope tenant and defaults it to nothing", () => {
    // No default, because neither value is safe to assume: `tenant` destroys every subject's data
    // when one person asks, and `subject` cannot be performed at all. The runner refuses to mount
    // without it (node.ts), where it used to answer the question by hardcoding the kind.
    expect(parseServeArgs(PG).deletionSubjectScope).toBeNull();
    expect(parseServeArgs([...PG, "--deletion-subject-scope", "tenant"]).deletionSubjectScope).toBe(
      "tenant",
    );
    expect(parseServeArgs([...PG, "--deletion-subject-scope=tenant"]).deletionSubjectScope).toBe(
      "tenant",
    );
  });

  it("refuses --deletion-subject-scope subject by name, and says what is missing", () => {
    // In the vocabulary and refused, rather than left out so the flag has one legal value: an
    // operator who needs it has a declaration to reach for and a refusal naming the real blocker,
    // where a single legal value would read as the platform's position on the question.
    let message = "";
    try {
      parseServeArgs([...PG, "--deletion-subject-scope", "subject"]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("cannot erase one data subject");
    // Names the capability, not a field to supply — the remedy is a subsystem, and telling an
    // operator to pass a subject identifier would have them manufacture a falsely-true proof.
    expect(message).toContain("P1.4");
    expect(message).not.toContain("subjectIdentifier");
    // And an unknown value is an ordinary usage error rather than this one.
    expect(() => parseServeArgs([...PG, "--deletion-subject-scope", "both"])).toThrow(
      /tenant \| subject/,
    );
  });
});

describe("parseServeArgs — deletion-evidence escalation", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is off unless a config is given, and implies the routes", () => {
    expect(parseServeArgs([...PG, "--deletion-request-routes"]).deletionEscalationConfig).toBeNull();
    const opts = parseServeArgs([...PG, "--deletion-escalation-config=/tmp/esc.json"]);
    expect(opts.deletionEscalationConfig).toBe("/tmp/esc.json");
    expect(opts.deletionRequestRoutes).toBe(true);
  });
});

describe("parseServeArgs — the reverse-direction audit cadence", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is off unless asked for", () => {
    expect(parseServeArgs([...PG, "--deletion-runner-ms=3000"]).deletionAuditEveryTicks).toBeNull();
  });

  it("takes a tick multiple and refuses zero or a fraction", () => {
    expect(parseServeArgs([...PG, "--deletion-audit-every-ticks=20"]).deletionAuditEveryTicks).toBe(20);
    // A multiple of the tick, not a duration: 0 would mean "every tick", which is what the flag
    // exists to avoid.
    expect(() => parseServeArgs([...PG, "--deletion-audit-every-ticks", "0"])).toThrow();
    expect(() => parseServeArgs([...PG, "--deletion-audit-every-ticks", "1.5"])).toThrow();
  });

  it("takes an Article 12(3) warning horizon in days and refuses a non-positive integer", () => {
    expect(parseServeArgs([...PG, "--deletion-warning-days=14"]).deletionWarningDays).toBe(14);
    // Null and not a default: the reconciler owns `DEFAULT_DEADLINE_WARNING_DAYS`, so a flag that
    // defaulted here would be a second spelling of one figure (ADR-0387).
    expect(parseServeArgs([...PG]).deletionWarningDays).toBeNull();
    // Days, so 0 would make the horizon the deadline itself — a warning that arrives as the breach.
    expect(() => parseServeArgs([...PG, "--deletion-warning-days", "0"])).toThrow();
    expect(() => parseServeArgs([...PG, "--deletion-warning-days", "7.5"])).toThrow();
  });
});

/**
 * Per-class sensitive grants on the audit trail (ADR-0329).
 *
 * `--audit-read-sensitive-role` is wholesale — pii *and* phi — so a HIPAA deployment wanting
 * support staff to read contact details had to expose patient records or redact everything.
 */
describe("parseServeArgs — --audit-read-sensitive-class", () => {
  const PG = ["--pack", "erp-core", "--store", "pg", "--audit-read-routes"];

  it("is empty unless asked for", () => {
    expect(parseServeArgs([...PG]).auditReadSensitiveClasses).toEqual({});
  });

  it("grants one class to one role", () => {
    const o = parseServeArgs([...PG, "--audit-read-sensitive-class=pii=support"]);
    expect(o.auditReadSensitiveClasses).toEqual({ pii: ["support"] });
  });

  it("accumulates roles for one class and keeps classes apart", () => {
    const o = parseServeArgs([
      ...PG,
      "--audit-read-sensitive-class=pii=support",
      "--audit-read-sensitive-class=pii=billing",
      "--audit-read-sensitive-class",
      "phi=clinician",
    ]);
    expect(o.auditReadSensitiveClasses).toEqual({
      pii: ["support", "billing"],
      phi: ["clinician"],
    });
  });

  it("takes a class with NO role, which is how a class is withheld from everyone", () => {
    // Not an error: naming a class makes it authoritative, so an empty list withholds it even from
    // a wholesale `--audit-read-sensitive-role` grantee. That is the narrowing the flag exists for.
    const o = parseServeArgs([
      ...PG,
      "--audit-read-sensitive-role=auditor",
      "--audit-read-sensitive-class=phi=",
    ]);
    expect(o.auditReadSensitiveRoles).toEqual(["auditor"]);
    expect(o.auditReadSensitiveClasses).toEqual({ phi: [] });
  });

  it("refuses a value with no '=' at all", () => {
    expect(() => parseServeArgs([...PG, "--audit-read-sensitive-class=pii"])).toThrow(
      /<class>=<role>/,
    );
    expect(() => parseServeArgs([...PG, "--audit-read-sensitive-class==support"])).toThrow();
  });

  it("refuses a class that is not a sensitive classification", () => {
    // Checked against `SENSITIVE_DATA_CLASSIFICATIONS`, not a copy: a typo'd class would otherwise
    // be accepted, apply to nothing, and leave the wholesale grant quietly reaching the class the
    // operator meant to withhold — a narrowing that does not narrow.
    expect(() => parseServeArgs([...PG, "--audit-read-sensitive-class=pll=support"])).toThrow(
      /unknown sensitive class/,
    );
    // `public` is a real classification and deliberately not a sensitive one, so granting it is
    // meaningless and is refused rather than silently ignored.
    expect(() => parseServeArgs([...PG, "--audit-read-sensitive-class=public=support"])).toThrow(
      /unknown sensitive class/,
    );
  });

  it("names the accepted classes in the refusal, so the operator can fix it", () => {
    let message = "";
    try {
      parseServeArgs([...PG, "--audit-read-sensitive-class=nope=x"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const cls of ["commercial_sensitive", "phi", "pii", "regulated"]) {
      expect(message).toContain(cls);
    }
  });
});

/** Per-viewer notification read state over HTTP (ADR-0331), closing ADR-0309's never-read tables. */
describe("parseServeArgs — --read-state-routes", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is off and ungranted unless asked for", () => {
    const o = parseServeArgs([...PG]);
    expect(o.readStateRoutes).toBe(false);
    expect(o.readStateRoles).toEqual([]);
    expect(o.readStateBackfillRoles).toEqual([]);
    expect("readStateUnreadScan" in o).toBe(false);
  });

  it("a role turns the routes on, the way every sibling flag does", () => {
    const o = parseServeArgs([...PG, "--read-state-role=cashier", "--read-state-role", "manager"]);
    expect(o.readStateRoutes).toBe(true);
    expect(o.readStateRoles).toEqual(["cashier", "manager"]);
  });

  it("refuses the routes on the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--read-state-routes"])).toThrow(
      /--read-state-routes requires a Postgres store/,
    );
  });

  it("refuses a backfill role that is not also granted the base role", () => {
    // Additive, not a substitute. The base grant is checked first, so a backfill role missing from
    // it is refused there and the backfill grant never comes into play — which reads as the backfill
    // grant not working. Said at boot instead.
    expect(() =>
      parseServeArgs([...PG, "--read-state-role=staff", "--read-state-backfill-role=migrator"]),
    ).toThrow(/additive on top of --read-state-role: migrator/);
  });

  it("accepts a backfill role that holds both grants", () => {
    const o = parseServeArgs([
      ...PG,
      "--read-state-role=migrator",
      "--read-state-role=staff",
      "--read-state-backfill-role=migrator",
    ]);
    expect(o.readStateBackfillRoles).toEqual(["migrator"]);
  });

  it("refuses the removed scan flag by name, at every value it used to accept", () => {
    // ADR-0476: the count is exact and reads no page, so the flag governs nothing. It accepted
    // 1..1000 while the store returned at most 200; accepting it silently now would be that defect
    // a second time. Every former value is refused, including the in-band 200 and 750.
    for (const v of ["1", "200", "750", "1000"]) {
      expect(() => parseServeArgs([...PG, `--read-state-unread-scan=${v}`])).toThrow(
        /--read-state-unread-scan was removed \(ADR-0476\).*limit= \(1-200/,
      );
      expect(() => parseServeArgs([...PG, "--read-state-unread-scan", v])).toThrow(/was removed/);
    }
  });
});

/** The consecutive-fax counter (ADR-0332), closing ADR-0310's named-but-inert `fax` verdict. */
describe("parseServeArgs — --bounce-fax-observations", () => {
  const PG = ["--pack", "erp-core", "--store", "pg", "--bounce-webhook"];

  it("is off, unthresholded and default-windowed unless asked for", () => {
    const o = parseServeArgs([...PG]);
    expect(o.bounceFaxObservations).toBe(false);
    expect(o.bounceFaxSuppressAfter).toBeNull();
    expect(o.bounceFaxWindowHours).toBeNull();
  });

  it("counts without suppressing, which is the designed default and not a degradation", () => {
    // One `AnsweredBy=fax` is a detector's guess from a few hundred ms of audio, so the one
    // suppression derived from an inference is the one a deployment opts into (ADR-0302).
    const o = parseServeArgs([...PG, "--bounce-fax-observations"]);
    expect(o.bounceFaxObservations).toBe(true);
    expect(o.bounceFaxSuppressAfter).toBeNull();
  });

  it("refuses a threshold of 1 by name rather than clamping it", () => {
    // Clamping would impose a policy the operator did not choose, and 1 is exactly the
    // suppress-on-one-sample behaviour the count exists to prevent.
    let message = "";
    try {
      parseServeArgs([...PG, "--bounce-fax-observations", "--bounce-fax-suppress-after=1"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("single detector sample");
    expect(parseServeArgs([...PG, "--bounce-fax-observations", "--bounce-fax-suppress-after=2"])
      .bounceFaxSuppressAfter).toBe(2);
  });

  it("refuses the counter without the webhook, and on the memory store", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "pg", "--bounce-fax-observations"]))
      .toThrow(/requires --bounce-webhook/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--bounce-webhook", "--bounce-fax-observations"]))
      .toThrow(/requires a Postgres store/);
  });

  it("refuses a threshold or a window with no counter to configure", () => {
    // A threshold that silently counts nothing is the shape of misconfiguration this family refuses.
    expect(() => parseServeArgs([...PG, "--bounce-fax-suppress-after=3"]))
      .toThrow(/requires --bounce-fax-observations/);
    expect(() => parseServeArgs([...PG, "--bounce-fax-window-hours=24"]))
      .toThrow(/requires --bounce-fax-observations/);
  });

  it("takes a window in hours", () => {
    const o = parseServeArgs([...PG, "--bounce-fax-observations", "--bounce-fax-window-hours", "24"]);
    expect(o.bounceFaxWindowHours).toBe(24);
    expect(() => parseServeArgs([...PG, "--bounce-fax-observations", "--bounce-fax-window-hours=0"]))
      .toThrow(/>= 1/);
  });
});

describe("parseServeArgs — per-route body limits", () => {
  const PG = ["--pack", "erp-core", "--store", "pg", "--audit-read-routes"];

  it("parses per-route body limits, longest prefix independent of argv order", () => {
    const out = parseServeArgs([
      ...PG,
      "--max-request-body",
      "64kb",
      "--max-request-body-route=/v1/platform/manifests=8mb",
      "--max-request-body-route",
      "/v1/platform=256kb",
    ]);
    // The point of the feature: the default can finally be *small*, with the large routes named.
    expect(out.maxRequestBodyBytes).toBe(64 * 1024);
    expect(out.maxRequestBodyRoutes).toHaveLength(2);
  });

  it("refuses a per-route spec that could never match", () => {
    // A relative prefix matches no request URL, so the operator would believe a limit was in force
    // and none would be.
    expect(() =>
      parseServeArgs([...PG, "--max-request-body-route=v1/platform=2mb"]),
    ).toThrow(CliUsageError);
  });

  it("refuses a duplicated prefix rather than letting one silently win", () => {
    expect(() =>
      parseServeArgs([
        ...PG,
        "--max-request-body-route=/v1/a=2mb",
        "--max-request-body-route=/v1/a=3mb",
      ]),
    ).toThrow(CliUsageError);
  });

  it("names every bad spec in one refusal, so an operator fixes them in one pass", () => {
    let message = "";
    try {
      parseServeArgs([
        ...PG,
        "--max-request-body-route=nope",
        "--max-request-body-route=/v1/b=notasize",
      ]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("nope");
    expect(message).toContain("/v1/b");
  });

  it("defaults to no overrides, which is every deployment today", () => {
    expect(parseServeArgs([...PG]).maxRequestBodyRoutes).toEqual([]);
  });

  it("accepts --workflow-cancel-role now that definitions have a writer", () => {
    // ADR-0330 refused this flag outright and the premise it named was true: no WorkflowEngine was
    // instantiated, because `meta.workflow_definitions` had no writer and so there was no source of
    // definitions. ADR-0331 built the writer, so the refusal's reason has expired.
    expect(parseServeArgs([...PG, "--workflow-cancel-role", "ops"]).workflowCancelRoles).toEqual([
      "ops",
    ]);
  });

  it("still refuses it on the memory store, which has neither table", () => {
    // The refusal narrows rather than disappearing. ADR-0329's rule holds: a cancellation route
    // that can find no instance is worse than an absent one, because its 404 reads as "no such
    // instance" rather than "this server has no engine".
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--workflow-cancel-role=ops"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    // And it names both tables, so the reason is the data and not the flag.
    expect(message).toContain("meta.workflow_definitions");
    expect(message).toContain("meta.workflow_instances");
  });

  it("boots fine without it", () => {
    expect(parseServeArgs([...PG]).workflowCancelRoles).toEqual([]);
  });
});

describe("--workflow-workers", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("mounts the three workers that drive the queues", () => {
    // ADR-0331 made the engine mountable and nothing polled it, so a due timer never fired. The
    // workers and their supervisor already existed, tested, exported, and unreachable from the
    // binary — which is the same silence in a new place.
    const o = parseServeArgs([...PG, "--workflow-workers"]);
    expect(o.workflowWorkers).toBe(true);
    expect(o.workflowDeferActivities).toBe(false);
    expect(o.workflowWorkerConfig).toBeNull();
  });

  it("defaults off, so no existing deployment starts claiming", () => {
    expect(parseServeArgs([...PG]).workflowWorkers).toBe(false);
  });

  it("refuses the memory store, which has none of the three claim tables", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--workflow-workers"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    // Names the tables rather than the flag, so the reason is the data. Three poll loops against
    // tables that do not exist throw on a cadence rather than once, which is why this refuses.
    expect(message).toContain("meta.workflow_timers");
    expect(message).toContain("meta.workflow_activities");
    expect(message).toContain("meta.job_runs");
  });

  it("refuses a config for a fleet that is not mounted", () => {
    // A tuning block read, validated and then ignored is the silence this whole family of flags
    // keeps producing. The operator who passed it believes they changed a lease.
    let message = "";
    try {
      parseServeArgs([...PG, "--workflow-worker-config", "/tmp/nope.json"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("--workflow-worker-config has no effect");
    expect(message).toContain("--workflow-workers");
  });

  it("parses the entity sensitive-field grant with the audit flag's grammar", () => {
    const o = parseServeArgs([
      ...PG,
      "--sensitive-field-role",
      "support",
      "--sensitive-field-class",
      "phi=clinician",
      "--sensitive-field-class",
      "phi=clinical_admin",
    ]);
    expect(o.sensitiveFieldRoles).toEqual(["support"]);
    expect(o.sensitiveFieldClasses).toEqual({ phi: ["clinician", "clinical_admin"] });
  });

  it("reads `<class>=` with no role as a refusal, not an error", () => {
    // ADR-0329's rule, and the whole reason the per-class map exists: a class named here is
    // authoritative for it, so an empty list withholds that class from everyone including a
    // wholesale grantee. Identical to --audit-read-sensitive-class by design.
    const o = parseServeArgs([...PG, "--sensitive-field-role", "support", "--sensitive-field-class", "phi="]);
    expect(o.sensitiveFieldClasses).toEqual({ phi: [] });
    expect(o.sensitiveFieldRoles).toEqual(["support"]);
  });

  it("refuses an unknown sensitive class rather than letting a typo narrow nothing", () => {
    let message = "";
    try {
      parseServeArgs([...PG, "--sensitive-field-class", "phj=clinician"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("unknown sensitive class 'phj'");
  });

  it("does not let the declaration imply the write mask", () => {
    // Where this parser departs from the audit one, which does imply its feature flag. The
    // declaration says who may see a class; the mask says writes are enforced against it. A
    // deployment declaring a grant to make PHI readable must not silently acquire a write refusal.
    const declared = parseServeArgs([...PG, "--sensitive-field-class", "phi=clinician"]);
    expect(declared.classifiedWriteMask).toBe(false);
    expect(parseServeArgs([...PG]).classifiedWriteMask).toBe(false);
    expect(parseServeArgs([...PG, "--classified-write-mask"]).classifiedWriteMask).toBe(true);
  });

  it("documents both halves and why the mask is off by default", () => {
    expect(helpText).toContain("--sensitive-field-role");
    expect(helpText).toContain("--sensitive-field-class");
    expect(helpText).toContain("--classified-write-mask");
    // The figures are the argument for the default; a help entry that said only "off by default"
    // would leave an operator unable to tell whether turning it on is safe.
    expect(helpText).toContain("12 required fields");
    expect(helpText).toContain("writable by nobody");
  });

  it("defaults --allow-plaintext-phi off, so a classified field is refused rather than stored bare", () => {
    expect(parseServeArgs([...PG]).allowPlaintextPhi).toBe(false);
    expect(parseServeArgs([...PG, "--allow-plaintext-phi"]).allowPlaintextPhi).toBe(true);
  });

  it("defaults --allow-cursor-disclosure off, so a filtered list's cursor is sealed or refused", () => {
    expect(parseServeArgs([...PG]).allowCursorDisclosure).toBe(false);
    expect(parseServeArgs([...PG, "--allow-cursor-disclosure"]).allowCursorDisclosure).toBe(true);
  });

  it("defaults --allow-uncovered-settlement off, so an unpaid document cannot be marked paid", () => {
    expect(parseServeArgs([...PG]).allowUncoveredSettlement).toBe(false);
    expect(parseServeArgs([...PG, ALLOW_UNCOVERED_SETTLEMENT_FLAG]).allowUncoveredSettlement).toBe(
      true,
    );
  });

  it("defaults --segregation-of-duties off, because a one-person tenant could approve nothing", () => {
    expect(parseServeArgs([...PG]).segregationOfDuties).toBe(false);
    expect(parseServeArgs([...PG, "--segregation-of-duties"]).segregationOfDuties).toBe(true);
    expect(parseServeArgs(["--pack", "erp-core", "--store", "memory", "--segregation-of-duties"]).segregationOfDuties).toBe(true);
  });

  it("parses --allow-uncovered-settlement on every store, because the question is not about one", () => {
    // Unlike `--allow-plaintext-phi`, which is refused on `pg-columns` because that store cannot
    // produce the outcome the flag accepts. Coverage is read through the `EntityStore` interface,
    // so the divergence this accepts is reachable on all three and no store makes it redundant.
    for (const store of ["memory", "pg", "pg-columns"]) {
      expect(
        parseServeArgs(["--pack", "erp-core", "--store", store, ALLOW_UNCOVERED_SETTLEMENT_FLAG])
          .allowUncoveredSettlement,
        store,
      ).toBe(true);
    }
  });

  it("documents the divergence the settlement flag accepts, not only that it exists", () => {
    // The cursor entry's rule: an operator cannot tell whether accepting this is safe from the
    // words "off by default". Both halves of the divergence have to be named, because the harm is
    // that the two surfaces disagree rather than that either is wrong on its own.
    expect(helpText).toContain(ALLOW_UNCOVERED_SETTLEMENT_FLAG);
    expect(helpText).toContain("aging report");
    expect(helpText).toContain("control account");
    expect(helpText).toContain("recoverable");
  });

  it("does not refuse --allow-cursor-disclosure beside a store, unlike --allow-plaintext-phi", () => {
    // The asymmetry is deliberate and is about *where the question can be answered*. Whether
    // plaintext PHI is even reachable is decidable from argv (`--store pg-columns` cannot produce
    // it), so that flag is refused here. Whether this one is redundant depends on
    // CURSOR_ENCRYPTION_SECRET, which `parseServeArgs` deliberately cannot read — so the
    // set-and-unused case is a warning in `node.ts`, where both halves are in hand, and every
    // store parses the flag without complaint.
    for (const store of ["memory", "pg", "pg-columns"]) {
      expect(
        parseServeArgs(["--pack", "erp-core", "--store", store, "--allow-cursor-disclosure"])
          .allowCursorDisclosure,
      ).toBe(true);
    }
  });

  it("documents the cursor disclosure the flag accepts, not only that it exists", () => {
    // The help entry has to carry the mechanism, for the sensitive-field entry's reason: an
    // operator cannot tell whether accepting a disclosure is safe from the words "off by default".
    expect(helpText).toContain("--allow-cursor-disclosure");
    expect(helpText).toContain("CURSOR_ENCRYPTION_SECRET");
    expect(helpText).toContain("never argv");
  });

  it("refuses --allow-plaintext-phi on pg-columns, where plaintext is not an outcome", () => {
    // Not ignored, on this file's standing rule: a phi column is BYTEA on the typed store, so the
    // write is encrypted or refused for a missing secret — never the plaintext the flag claims to
    // authorise. Accepting it would let an operator believe they had opted into something.
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--store", "pg-columns", "--allow-plaintext-phi"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("--allow-plaintext-phi is not applicable to --store pg-columns");
    expect(message).toContain("BYTEA");
    expect(message).toContain("COLUMN_ENCRYPTION_SECRET");
  });

  it("never reads the column-encryption secret from argv", () => {
    // ADR-0301's rule: argv is readable via `ps`, so a credential may only arrive by environment.
    // The secret feeds HKDF for PHI, which makes it the last thing that should ever be a flag.
    expect(helpText).toContain("COLUMN_ENCRYPTION_SECRET");
    expect(helpText).not.toContain("--column-encryption-secret");
    // And the flag that *is* a flag is documented, since one reachable only by reading cli.ts is
    // the same defect as an undocumented refusal.
    expect(helpText).toContain("--allow-plaintext-phi");
  });

  it("refuses deferral without the workers, which is the load-bearing one", () => {
    // `deferActivities` is a biconditional and its own contract says so. Deferring with no worker
    // claiming leaves every scheduled activity at rest, so the instance stalls at its first
    // activity and nothing anywhere reports it — strictly worse than both alternatives.
    let message = "";
    try {
      parseServeArgs([...PG, "--workflow-defer-activities"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("--workflow-defer-activities requires --workflow-workers");
    expect(message).toContain("stalls");
  });

  it("accepts the pair, which is the only configuration deferral is correct in", () => {
    const o = parseServeArgs([...PG, "--workflow-workers", "--workflow-defer-activities"]);
    expect(o.workflowWorkers).toBe(true);
    expect(o.workflowDeferActivities).toBe(true);
  });

  it("takes a config path in both spellings", () => {
    expect(
      parseServeArgs([...PG, "--workflow-workers", "--workflow-worker-config", "/tmp/w.json"])
        .workflowWorkerConfig,
    ).toBe("/tmp/w.json");
    expect(
      parseServeArgs([...PG, "--workflow-workers", "--workflow-worker-config=/tmp/w.json"])
        .workflowWorkerConfig,
    ).toBe("/tmp/w.json");
  });

  it("documents all four flags in the help text", () => {
    // `--workflow-cancel-role` had shipped with no help entry at all, which this adds alongside —
    // a flag that exists and is undocumented is reachable only by reading cli.ts.
    for (const flag of [
      "--workflow-cancel-role",
      "--workflow-workers",
      "--workflow-worker-config",
      "--workflow-defer-activities",
    ]) {
      expect(helpText).toContain(flag);
    }
    // And the help says what the workers are *for*, since the reason they matter is that nothing
    // polled the queues before — and that each one refuses by name rather than polling uselessly.
    expect(helpText).toContain("a due timer never fires");
    for (const refusal of ["no_definitions", "activities_run_inline", "no_job_handlers"]) {
      expect(helpText).toContain(refusal);
    }
  });
});

describe("--tenant-status-gate", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is on by default on a Postgres store, and says it was a default", () => {
    // It was opt-in until the default moved; this test pinned that and is rewritten rather than
    // deleted, because the opt-in was the defect: a suspended or pending_deletion tenant kept writing
    // on every deployment that did not know to pass the flag.
    for (const store of ["pg", "pg-columns"]) {
      const o = parseServeArgs(["--pack", "erp-core", "--store", store]);
      expect(o.tenantStatusGate).toBe(true);
      expect(o.tenantStatusGateSource).toBe("default");
    }
    expect(parseServeArgs([...PG]).tenantStatusTtlMs).toBeNull();
  });

  it("does not reach the memory store by default, which has no registry to gate on", () => {
    const o = parseServeArgs(["--pack", "erp-core", "--store", "memory"]);
    expect(o.tenantStatusGate).toBe(false);
    expect(o.tenantStatusGateSource).toBe("not_applicable");
  });

  it("mounts the gate when asked explicitly", () => {
    const o = parseServeArgs([...PG, "--tenant-status-gate"]);
    expect(o.tenantStatusGate).toBe(true);
    expect(o.tenantStatusGateSource).toBe("flag");
  });

  it("turns it off with the hatch, and records that it was turned off", () => {
    const o = parseServeArgs([...PG, "--no-tenant-status-gate"]);
    expect(o.tenantStatusGate).toBe(false);
    expect(o.tenantStatusGateSource).toBe("disabled_by_flag");
  });

  it("refuses the two contradicting flags", () => {
    expect(() =>
      parseServeArgs([...PG, "--tenant-status-gate", "--no-tenant-status-gate"]),
    ).toThrow(/contradict/);
  });

  it("takes a TTL in both spellings", () => {
    expect(parseServeArgs([...PG, "--tenant-status-gate", "--tenant-status-ttl-ms", "5000"]).tenantStatusTtlMs).toBe(5000);
    expect(parseServeArgs([...PG, "--tenant-status-gate", "--tenant-status-ttl-ms=60000"]).tenantStatusTtlMs).toBe(60_000);
  });

  it("refuses a TTL outside the floor and the ceiling", () => {
    for (const bad of ["999", "300001", "0", "-1", "1.5", "soon"]) {
      expect(() =>
        parseServeArgs([...PG, "--tenant-status-gate", "--tenant-status-ttl-ms", bad]),
      ).toThrow(/invalid --tenant-status-ttl-ms/);
    }
  });

  it("refuses the memory store, because every request would be a 503", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "memory", "--tenant-status-gate"]),
    ).toThrow(/requires a Postgres store/);
  });

  it("takes a TTL for the default gate, and refuses one with no gate mounted", () => {
    expect(parseServeArgs([...PG, "--tenant-status-ttl-ms", "5000"]).tenantStatusTtlMs).toBe(5000);
    expect(() =>
      parseServeArgs([...PG, "--no-tenant-status-gate", "--tenant-status-ttl-ms", "5000"]),
    ).toThrow(/no effect without --tenant-status-gate/);
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "memory", "--tenant-status-ttl-ms", "5000"]),
    ).toThrow(/no effect without --tenant-status-gate/);
  });

  it("documents the gate and its exemption in the help text", () => {
    expect(helpText).toContain("--tenant-status-gate");
    expect(helpText).toContain("--no-tenant-status-gate");
    expect(helpText).toContain("--tenant-status-ttl-ms");
    expect(helpText).toContain("/v1/platform routes are exempt");
  });
});

describe("--rate-limit-policy", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is undeclared by default, which keeps the in-memory 10,000/60s every deployment has had", () => {
    expect(parseServeArgs([...PG]).rateLimitPolicies).toBeNull();
  });

  it("declares one policy and infers the default from it", () => {
    const o = parseServeArgs([...PG, "--rate-limit-policy", "rlp_standard:600:60"]);
    expect(o.rateLimitPolicies?.defaultPolicy).toEqual({
      policyId: "rlp_standard",
      limit: 600,
      windowSeconds: 60,
    });
    expect(Object.keys(o.rateLimitPolicies?.byPolicyId ?? {})).toEqual(["rlp_standard"]);
  });

  it("takes several policies with a named default, in both spellings", () => {
    const o = parseServeArgs([
      ...PG,
      "--rate-limit-policy",
      "rlp_standard:600:60",
      "--rate-limit-policy=rlp_burstlimit:5000:60",
      "--rate-limit-default-policy=rlp_burstlimit",
    ]);
    expect(o.rateLimitPolicies?.defaultPolicy.policyId).toBe("rlp_burstlimit");
    expect(Object.keys(o.rateLimitPolicies?.byPolicyId ?? {}).sort()).toEqual([
      "rlp_burstlimit",
      "rlp_standard",
    ]);
  });

  it("refuses a default with no policy declared", () => {
    // The declaration needs a policy for the routes that name none — which today is every route —
    // so there is nothing for the named default to be.
    expect(() =>
      parseServeArgs([...PG, "--rate-limit-default-policy", "rlp_standard"]),
    ).toThrow(/--rate-limit-default-policy requires at least one/);
  });

  it("refuses an unnamed default once more than one policy is declared", () => {
    expect(() =>
      parseServeArgs([
        ...PG,
        "--rate-limit-policy",
        "rlp_standard:600:60",
        "--rate-limit-policy",
        "rlp_burstlimit:5000:60",
      ]),
    ).toThrow(/--rate-limit-default-policy is required when more than one/);
  });

  it("refuses a default naming a policy nobody declared, and names the ones that were", () => {
    // Falling back would apply terms the operator did not write down and then record the fallback's
    // id in the decision row — the defect this flag family exists to end.
    let message = "";
    try {
      parseServeArgs([
        ...PG,
        "--rate-limit-policy",
        "rlp_standard:600:60",
        "--rate-limit-default-policy",
        "rlp_notdeclared",
      ]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("rlp_notdeclared is not among the declared policies");
    expect(message).toContain("rlp_standard");
  });

  it("refuses the memory store, which has no meta.rate_limit_decisions to name the policy in", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--rate-limit-policy", "rlp_standard:600:60"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    expect(message).toContain("meta.rate_limit_decisions");
  });

  it("refuses a malformed spec by name rather than coercing it", () => {
    // `Number()` accepts "0x10", "1e3" and " 10 ", so a limit silently read as 16 from "0x10" is a
    // ceiling the operator never configured.
    for (const bad of ["rlp_standard:600", "rlp_standard:0x10:60", "rlp_standard:600:0"]) {
      expect(() => parseServeArgs([...PG, "--rate-limit-policy", bad])).toThrow(
        /invalid --rate-limit-policy/,
      );
    }
    expect(() => parseServeArgs([...PG, "--rate-limit-policy", "standard:600:60"])).toThrow(
      /policy_id_malformed/,
    );
  });

  it("refuses two declarations of one policy id", () => {
    expect(() =>
      parseServeArgs([
        ...PG,
        "--rate-limit-policy",
        "rlp_standard:600:60",
        "--rate-limit-policy",
        "rlp_standard:900:60",
        "--rate-limit-default-policy",
        "rlp_standard",
      ]),
    ).toThrow(/invalid rate-limit declaration.*duplicate_policy_id/);
  });

  it("documents both flags in the help text", () => {
    expect(helpText).toContain("--rate-limit-policy");
    expect(helpText).toContain("--rate-limit-default-policy");
    // And offers a starting point, since the whole point is that nothing defaults the ceiling.
    expect(helpText).toContain("rlp_conservativedefault:600:60");
  });
});

describe("--platform-user-routes", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is off and ungranted unless asked for", () => {
    const o = parseServeArgs([...PG]);
    expect(o.platformUserRoutes).toBe(false);
    expect(o.platformUserRoles).toEqual([]);
  });

  it("mounts the registry, fail-closed on the grant", () => {
    const o = parseServeArgs([...PG, "--platform-user-routes"]);
    expect(o.platformUserRoutes).toBe(true);
    expect(o.platformUserRoles).toEqual([]);
  });

  it("collects repeatable roles in both spellings", () => {
    const o = parseServeArgs([
      ...PG,
      "--platform-user-routes",
      "--platform-user-role",
      "platform_admin",
      "--platform-user-role=identity_admin",
    ]);
    expect(o.platformUserRoles).toEqual(["platform_admin", "identity_admin"]);
  });

  it("refuses a grant with no surface, rather than implying the routes", () => {
    // The opposite of `--deletion-request-role` and its siblings, which turn their routes on. A
    // registry grant is a licence to mint principals, so inferring the surface from it would mount
    // the one surface an operator should have to ask for by name.
    expect(() => parseServeArgs([...PG, "--platform-user-role", "ops"])).toThrow(
      /--platform-user-role requires --platform-user-routes/,
    );
  });

  it("refuses the memory store, which has neither registry table", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--platform-user-routes"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    expect(message).toContain("meta.users");
    expect(message).toContain("meta.user_tenant_membership");
  });

  it("documents both flags in the help text", () => {
    expect(helpText).toContain("--platform-user-routes");
    expect(helpText).toContain("--platform-user-role");
    expect(helpText).toContain("/v1/platform/users");
    // And says it is a different grant from the tenant administrator's, which is the mistake an
    // operator reading only the flag names would make.
    expect(helpText).toContain("Separate from --platform-admin-role, which administers tenants");
  });
});

describe("--preference-routes", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("is off and ungranted unless asked for", () => {
    const o = parseServeArgs([...PG]);
    expect(o.preferenceRoutes).toBe(false);
    expect(o.preferenceRoles).toEqual([]);
    expect(o.preferenceAdminRoles).toEqual([]);
  });

  it("mounts the routes with both grants, in both spellings", () => {
    const o = parseServeArgs([
      ...PG,
      "--preference-routes",
      "--preference-role",
      "erp_user",
      "--preference-role=cashier",
      "--preference-admin-role=tenant_admin",
    ]);
    expect(o.preferenceRoutes).toBe(true);
    expect(o.preferenceRoles).toEqual(["erp_user", "cashier"]);
    expect(o.preferenceAdminRoles).toEqual(["tenant_admin"]);
  });

  it("refuses either grant with no surface mounted", () => {
    expect(() => parseServeArgs([...PG, "--preference-role", "erp_user"])).toThrow(
      /--preference-role requires --preference-routes/,
    );
    expect(() => parseServeArgs([...PG, "--preference-admin-role", "tenant_admin"])).toThrow(
      /--preference-admin-role requires --preference-routes/,
    );
  });

  it("takes the admin grant without the base grant, which leaves the own-preference path closed", () => {
    // Unlike `--read-state-backfill-role`, the admin grant is not asserted to be a subset: a
    // deployment may well want a support role that can set somebody else's preferences and has no
    // preferences of its own to read.
    const o = parseServeArgs([...PG, "--preference-routes", "--preference-admin-role", "support"]);
    expect(o.preferenceRoles).toEqual([]);
    expect(o.preferenceAdminRoles).toEqual(["support"]);
  });

  it("refuses the memory store, which has no meta.notification_preferences", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--preference-routes"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    expect(message).toContain("meta.notification_preferences");
  });

  it("documents all three flags in the help text", () => {
    expect(helpText).toContain("--preference-routes");
    expect(helpText).toContain("--preference-role");
    expect(helpText).toContain("--preference-admin-role");
    // The reason the surface matters: without it the defaults are permanent.
    expect(helpText).toContain("built-in defaults for ever");
    expect(helpText).toContain("A body naming another user is refused, not ignored");
  });
});

describe("--idempotency-store", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("defaults to the in-memory guard, which is what every deployment has had", () => {
    expect(parseServeArgs([...PG]).pgIdempotencyStore).toBe(false);
  });

  it("takes pg and memory, in both spellings", () => {
    expect(parseServeArgs([...PG, "--idempotency-store", "pg"]).pgIdempotencyStore).toBe(true);
    expect(parseServeArgs([...PG, "--idempotency-store=pg"]).pgIdempotencyStore).toBe(true);
    expect(parseServeArgs([...PG, "--idempotency-store", "memory"]).pgIdempotencyStore).toBe(false);
  });

  it("refuses an unknown kind by name rather than falling back to memory", () => {
    // Falling back would mount the per-process guard on a deployment that asked for durability and
    // report success, which is the class this flag exists to close.
    expect(() => parseServeArgs([...PG, "--idempotency-store", "postgres"])).toThrow(
      /must be 'memory' or 'pg'/,
    );
  });

  it("refuses the memory store, which has no meta.gateway_idempotency_records", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--idempotency-store", "pg"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    expect(message).toContain("meta.gateway_idempotency_records");
  });

  it("permits memory with the memory store, since that is the existing behaviour spelled out", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--idempotency-store", "memory"]).pgIdempotencyStore,
    ).toBe(false);
  });
});

describe("--retention-sweep / --retention", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("prunes nothing by default, because the sweep deletes rows a deployment keeps today", () => {
    expect(parseServeArgs([...PG]).retention).toBeNull();
  });

  it("mounts the declared defaults under the sweep flag", () => {
    expect(parseServeArgs([...PG, "--retention-sweep"]).retention).toEqual({
      job_runs: 90,
      gateway_pipeline_executions: 30,
      rate_limit_decisions: 30,
      notification_dispatches: 365,
    });
  });

  it("takes an override in both spellings, and off", () => {
    const retention = parseServeArgs([
      ...PG,
      "--retention-sweep",
      "--retention",
      "job_runs=14",
      "--retention=notification_dispatches=off",
    ]).retention;
    expect(retention?.job_runs).toBe(14);
    expect(retention?.notification_dispatches).toBeNull();
    expect(retention?.gateway_pipeline_executions).toBe(30);
  });

  it("refuses an override with no sweep, which would be a policy nothing reads", () => {
    expect(() => parseServeArgs([...PG, "--retention", "job_runs=14"])).toThrow(
      /--retention requires --retention-sweep/,
    );
  });

  it("refuses the memory store, which has no operational tables", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--retention-sweep"])).toThrow(
      /--retention-sweep requires a Postgres store/,
    );
  });

  it("surfaces the policy's own refusals as usage errors", () => {
    expect(() =>
      parseServeArgs([...PG, "--retention-sweep", "--retention", "audit_log=30"]),
    ).toThrow(/the table must be one of/);
    expect(() =>
      parseServeArgs([
        ...PG,
        "--retention-sweep",
        "--retention",
        "rate_limit_decisions=7",
      ]),
    ).toThrow(/rate_limit_decisions/);
  });
});

describe("--gateway-execution-capture", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("captures nothing by default, as today", () => {
    expect(parseServeArgs([...PG]).gatewayExecutionCapture).toBeNull();
  });

  it("takes a rate in both spellings and carries no default", () => {
    expect(
      parseServeArgs([...PG, "--gateway-execution-capture", "0.01"]).gatewayExecutionCapture,
    ).toEqual({ sampleRate: 0.01 });
    expect(
      parseServeArgs([...PG, "--gateway-execution-capture=1"]).gatewayExecutionCapture?.sampleRate,
    ).toBe(1);
  });

  it("refuses a rate of 0 and names the remedy", () => {
    // 0 is spelled by omitting the flag. A sink that is mounted and writes nothing reads as
    // configured and records nothing, which is the class this increment closes, not a setting.
    let message = "";
    try {
      parseServeArgs([...PG, "--gateway-execution-capture", "0"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("must be in (0, 1]");
    expect(message).toContain("omit the flag");
  });

  it("refuses a rate above 1 and a non-number, rather than coercing", () => {
    // `Number("")` is 0 and `Number("1e3")` is 1000: a rate read as a thousand would be clamped by
    // nothing and a rate read as 0 would mount a sink that writes nothing.
    for (const bad of ["1.5", "2", "abc", ""]) {
      expect(() => parseServeArgs([...PG, "--gateway-execution-capture", bad])).toThrow();
    }
  });

  it("narrows to operations, and refuses a narrowing with no capture mounted", () => {
    const o = parseServeArgs([
      ...PG,
      "--gateway-execution-capture",
      "0.1",
      "--gateway-execution-capture-operation",
      "invoice.create",
      "--gateway-execution-capture-operation=invoice.post",
    ]);
    expect(o.gatewayExecutionCapture?.operations).toEqual(["invoice.create", "invoice.post"]);
    expect(() =>
      parseServeArgs([...PG, "--gateway-execution-capture-operation", "invoice.create"]),
    ).toThrow(/requires --gateway-execution-capture/);
  });

  it("refuses the memory store, which has no meta.gateway_pipeline_executions", () => {
    let message = "";
    try {
      parseServeArgs(["--pack", "erp-core", "--gateway-execution-capture", "0.1"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("requires a Postgres store");
    expect(message).toContain("meta.gateway_pipeline_executions");
  });
});

describe("--credential-login", () => {
  const base = ["--pack", "erp-core", "--store", "pg", "--jwt-issuer", "https://i.test", "--jwt-audience", "a"];

  it("parses with its three companion flags", () => {
    const opts = parseServeArgs([
      ...base,
      "--credential-login",
      "--session-token-ttl",
      "1800",
      "--login-lockout-attempts",
      "5",
      "--login-lockout-seconds",
      "600",
    ]);
    expect(opts.credentialLogin).toBe(true);
    expect(opts.sessionTokenTtl).toBe(1800);
    expect(opts.loginLockoutAttempts).toBe(5);
    expect(opts.loginLockoutSeconds).toBe(600);
  });

  it("defaults to off, with every companion null", () => {
    const opts = parseServeArgs(["--pack", "erp-core"]);
    expect(opts.credentialLogin).toBe(false);
    expect(opts.sessionTokenTtl).toBeNull();
    expect(opts.loginLockoutAttempts).toBeNull();
    expect(opts.loginLockoutSeconds).toBeNull();
  });

  it("requires --jwt-issuer and --jwt-audience, because the token asserts both", () => {
    // The minted token carries `iss` and `aud` and the verifier beside it checks both. Without
    // them the runtime falls back to `https://crossengin.io`, so a minter using any other issuer
    // answers `issuer_mismatch` for a token it had just signed.
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--credential-login"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseServeArgs([
        "--pack",
        "erp-core",
        "--store",
        "pg",
        "--credential-login",
        "--jwt-issuer",
        "https://i.test",
      ]),
    ).toThrow(/requires --jwt-issuer and --jwt-audience/);
  });

  it("requires a Postgres store", () => {
    expect(() =>
      parseServeArgs([
        "--pack",
        "erp-core",
        "--credential-login",
        "--jwt-issuer",
        "https://i.test",
        "--jwt-audience",
        "a",
      ]),
    ).toThrow(/requires a Postgres store/);
  });

  it("is mutually exclusive with --jwks-url", () => {
    // `node.ts` branches on the URL and DISCARDS the static key specs, so the key derived from the
    // signing seed would never be registered and every minted token would come back
    // `invalid_signature` -- at the gateway, not at the mint, so the mint looks fine in testing.
    expect(() =>
      parseServeArgs([...base, "--credential-login", "--jwks-url", "https://idp.test/jwks"]),
    ).toThrow(/mutually exclusive/);
  });

  it("refuses a lockout threshold below the floor rather than raising it", () => {
    // ADR-0332's rule: a threshold of 1 locks a real user out on one typo, and silently clamping
    // would leave the deployment believing it configured something it did not.
    for (const bad of ["0", "1", "2", "-1", "1.5", "x"]) {
      expect(() =>
        parseServeArgs([...base, "--credential-login", "--login-lockout-attempts", bad]),
        bad,
      ).toThrow(/invalid --login-lockout-attempts/);
    }
    expect(() =>
      parseServeArgs([...base, "--credential-login", "--login-lockout-attempts", "3"]),
    ).not.toThrow();
  });

  it("refuses a session ttl outside the bounds", () => {
    for (const bad of ["0", "59", "86401", "1.5", "x"]) {
      expect(() =>
        parseServeArgs([...base, "--credential-login", "--session-token-ttl", bad]),
        bad,
      ).toThrow(/invalid --session-token-ttl/);
    }
  });

  it("refuses each companion flag without --credential-login", () => {
    // A flag that silently does nothing is worse than one that refuses: an operator who set a
    // 5-minute session and got an hour would have no way to tell.
    for (const [flag, value] of [
      ["--session-token-ttl", "600"],
      ["--login-lockout-attempts", "5"],
      ["--login-lockout-seconds", "60"],
    ] as const) {
      expect(() => parseServeArgs([...base, flag, value]), flag).toThrow(
        /requires --credential-login/,
      );
    }
  });
});

describe("--mtls-client and --trusted-edge-client-cert", () => {
  const base = ["--pack", "erp-core"];
  const F1 = "a".repeat(64);
  const P1 = "00000000-0000-4000-8000-000000000001";
  const SPEC = `${F1}:erp_admin:tenant-a:${P1}`;

  it("defaults to off, with no enrolment and no trust", () => {
    const opts = parseServeArgs(base);
    expect(opts.mtlsClients).toEqual([]);
    expect(opts.trustedEdgeClientCert).toBe(false);
  });

  it("parses both, repeatably", () => {
    const opts = parseServeArgs([
      ...base,
      "--trusted-edge-client-cert",
      "--mtls-client",
      SPEC,
      `--mtls-client=${"b".repeat(64)}:hr_manager:tenant-b:${P1}`,
    ]);
    expect(opts.trustedEdgeClientCert).toBe(true);
    expect(opts.mtlsClients).toHaveLength(2);
  });

  it("validates the spec at parse, so a usage error names the flag and exits 2", () => {
    // Validated here as well as at boot, for `--hmac-key`'s stated reason: the parser can answer
    // with the help text where `resolveMtlsClients` can only report an absence. This is also the
    // one of the three credential specs whose first field has a shape, so an unmatchable enrolment
    // is caught here rather than accepted into a registry that can never fire.
    expect(() =>
      parseServeArgs([...base, "--trusted-edge-client-cert", "--mtls-client", "nope:r:t:p"]),
    ).toThrow(/--mtls-client/);
    expect(() =>
      parseServeArgs([...base, "--trusted-edge-client-cert", "--mtls-client", `${F1}:erp_admin:t`]),
    ).toThrow(/principalId is required/);
  });

  /**
   * The refusal that lets `mtlsClientLookupConfigured` be one gate key for a scheme needing two
   * facts: without the declaration `buildIncomingRequest` drops the forwarded fingerprint, so a
   * registry alone would report the scheme served while nothing could authenticate — ADR-0337's
   * falsely-true direction.
   */
  it("refuses --mtls-client without --trusted-edge-client-cert", () => {
    expect(() => parseServeArgs([...base, "--mtls-client", SPEC])).toThrow(
      /requires --trusted-edge-client-cert/,
    );
    expect(() => parseServeArgs([...base, "--mtls-client", SPEC])).toThrow(/unmatchable/);
  });

  /**
   * And the converse is **not** refused, which is the asymmetry worth pinning: the declaration
   * governs every forwarded fact — `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` and
   * the TLS version — so a deployment behind a trusted edge that serves no client certificates
   * still wants its client IPs and its TLS floor believed. A symmetric refusal would make the
   * broader capability unreachable without the narrower one.
   */
  it("accepts --trusted-edge-client-cert alone", () => {
    const opts = parseServeArgs([...base, "--trusted-edge-client-cert"]);
    expect(opts.trustedEdgeClientCert).toBe(true);
    expect(opts.mtlsClients).toEqual([]);
  });

  it("documents both flags in --help", () => {
    // The help text is the only place the *stripping* requirement reaches an operator who has not
    // read the Caddyfile, and it is the half that makes the declaration true rather than merely
    // permissive.
    const help = helpText;
    expect(help).toContain("--mtls-client");
    expect(help).toContain("--trusted-edge-client-cert");
    expect(help).toMatch(/OVERWRITES|overwrites/);
  });

  /**
   * Each flag's continuation lines belong to **that** flag, which three `toContain`s cannot see.
   *
   * This exists because inserting these two entries split `--hmac-key`'s continuation from its own
   * flag, so `--help` told an operator that a boolean taking no value was "repeatable; all four
   * fields required" and needed `REQUEST_SIGNING_SECRET` — ADR-0364's addendum class, documentation
   * that cannot be followed, and invisible to every order-independent assertion above.
   *
   * Read as blocks rather than as one string: a help entry is its `--flag` line plus every
   * following line indented past the description column, which is structural and does not rest on
   * the prose's wording.
   */
  // A flag *definition* sits at exactly two spaces of indent and a continuation at the description
  // column, so the block boundary is `/^ {2}--/` and **not** `/^\s*--/`. That distinction is
  // load-bearing rather than pedantic: `--mtls-client`'s own continuation names
  // `--trusted-edge-client-cert`, so the lax pattern cuts its block two lines early — a defect in
  // the first draft of this helper, which would have reported the fixed text as still broken.
  //
  // Hoisted out of the one `it` that first needed it, because a second insertion wanted the same
  // rule and two copies of a boundary predicate is how the two come to disagree about where a
  // block ends.
  const FLAG_DEF = /^ {2}--/;
  const blockFor = (flag: string): string => {
    const lines = helpText.split("\n");
    const start = lines.findIndex(
      (l) => FLAG_DEF.test(l) && (l.trimStart().startsWith(`${flag} `) || l.trim() === flag),
    );
    expect(start, `${flag} is absent from --help`).toBeGreaterThanOrEqual(0);
    const out = [lines[start] ?? ""];
    for (const line of lines.slice(start + 1)) {
      if (FLAG_DEF.test(line)) break;
      out.push(line);
    }
    return out.join("\n");
  };

  it("keeps each flag's continuation under its own flag", () => {
    const hmac = blockFor("--hmac-key");
    const mtls = blockFor("--mtls-client");
    const trust = blockFor("--trusted-edge-client-cert");

    // The orphaned text, back where it belongs and nowhere else.
    expect(hmac).toContain("REQUEST_SIGNING_SECRET");
    expect(mtls).not.toContain("REQUEST_SIGNING_SECRET");
    expect(trust).not.toContain("REQUEST_SIGNING_SECRET");
    // A flag taking no value is never described as repeatable or as having fields.
    expect(trust).not.toMatch(/repeatable|fields required/);
    // And each block carries the fact only it is about, so none is an empty shell that would
    // satisfy the three negatives above by saying nothing at all.
    expect(mtls).toMatch(/sha256/);
    expect(mtls).toContain("--trusted-edge-client-cert");
    expect(trust).toMatch(/OVERWRITES|overwrites/);
    for (const [name, block] of [
      ["--hmac-key", hmac],
      ["--mtls-client", mtls],
      ["--trusted-edge-client-cert", trust],
    ] as const) {
      expect(block.split("\n").length, `${name}'s help block is a single line`).toBeGreaterThan(2);
    }
  });

  it("keeps --admin-role's own block intact, and its neighbours' too", () => {
    // Inserted between `--platform-admin-role` and `--ai-design`, which is exactly the position
    // ADR-0394's addendum found a defect in: an inserted entry orphaned the *preceding* flag's
    // continuation, so `--help` described a boolean as "repeatable; all four fields required".
    // Measured here for all three, because the hazard is the neighbours and not the new entry.
    const admin = blockFor("--admin-role");
    const platform = blockFor("--platform-admin-role");
    const ai = blockFor("--ai-design");

    // Each block carries the fact only it is about.
    expect(admin).toContain("/v1/admin/settings");
    expect(admin).toContain("erp_admin");
    expect(platform).toContain("/v1/platform");
    expect(ai).toContain("AI Architect");

    // And no block has absorbed a neighbour's subject.
    expect(platform).not.toContain("/v1/admin/settings");
    expect(ai).not.toContain("/v1/admin/settings");
    expect(admin).not.toContain("AI Architect");

    // The help entry has to carry the WARN-not-refuse decision, because that is the one thing an
    // operator cannot infer: `platform_admin` is declared by none of the seven packs and is a
    // correct value here, so an undeclared role is not a typo.
    expect(admin).toMatch(/WARNED|warned/);
    expect(admin).toContain("platform_admin");
    // And the distinction from the flag beside it, which is the mistake the name invites.
    expect(admin).toContain("--platform-admin-role");

    for (const [name, block] of [
      ["--admin-role", admin],
      ["--platform-admin-role", platform],
      ["--ai-design", ai],
    ] as const) {
      expect(block.split("\n").length, `${name}'s help block is a single line`).toBeGreaterThan(1);
    }
  });
});

describe("--job-actor-role", () => {
  it("defaults to erp_admin, which every shipped pack declares and grants the jobs' writes", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).jobActorRoles).toEqual(["erp_admin"]);
  });

  it("is repeatable, primary first, and replaces the default", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--job-actor-role", "controller", "--job-actor-role=erp_admin"]);
    expect(opts.jobActorRoles).toEqual(["controller", "erp_admin"]);
  });

  it("refuses a missing value", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--job-actor-role"])).toThrow(CliUsageError);
  });
});

describe("--admin-role", () => {
  it("defaults to erp_admin, so declaring nothing changes nothing", () => {
    // `compileOperateServer`'s own `?? DEFAULT_ADMIN_ROLES` has always been `["erp_admin"]`, and
    // every one of the seven packs declares that role — so the default is what every deployment
    // already had. Widening it to the three-member exported `DEFAULT_ADMIN_ROLES` would silently
    // hand `platform_admin` a tenant's settings everywhere, which is a privilege decision.
    expect(parseServeArgs(["--pack", "erp-core"]).adminRoles).toEqual(["erp_admin"]);
  });

  it("is repeatable and replaces the default rather than adding to it", () => {
    const opts = parseServeArgs([
      "--pack", "erp-core",
      "--admin-role", "erp_admin",
      "--admin-role", "platform_admin",
    ]);
    expect(opts.adminRoles).toEqual(["erp_admin", "platform_admin"]);
  });

  it("accepts the --flag=value form", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--admin-role=ops"]).adminRoles).toEqual(["ops"]);
  });

  it("refuses a missing value", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--admin-role"])).toThrow(CliUsageError);
  });

  it("needs no companion flag, because the routes it grants are always mounted", () => {
    // Deliberately unlike `--credential-admin-role`, which is refused without `--credential-login`
    // because its routes would not be mounted. `/v1/admin/settings` is registered whenever a
    // settings store exists, and `ResolvedStores.settingsStore` is non-optional — so this grant is
    // never inert and has nothing to be refused against.
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--admin-role", "whoever"]),
    ).not.toThrow();
  });
});

describe("parseSetCredentialArgs", () => {
  const USER = "22222222-2222-4222-8222-222222222222";

  it("parses a matching pair", () => {
    const opts = parseSetCredentialArgs(["--user", USER, "--confirm-user", USER]);
    expect(opts).toEqual({
      userId: USER,
      confirmUserId: USER,
      schema: null,
      format: "human",
      help: false,
    });
  });

  it("requires --confirm-user and refuses a mismatch", () => {
    // `rekey`'s `--confirm-tenant` rule: this overwrites a credential, so naming the wrong user
    // both locks that person out and hands their account to whoever typed the password.
    expect(() => parseSetCredentialArgs(["--user", USER])).toThrow(/requires --confirm-user/);
    expect(() =>
      parseSetCredentialArgs(["--user", USER, "--confirm-user", "22222222-2222-4222-8222-222222222223"]),
    ).toThrow(/differ/);
  });

  it("requires --user", () => {
    expect(() => parseSetCredentialArgs(["--confirm-user", USER])).toThrow(/requires --user/);
  });

  it("refuses --password by name, and says where the password goes instead", () => {
    // Named explicitly rather than falling through to "unknown option", so an operator is told why
    // rather than left thinking they mistyped it.
    expect(() =>
      parseSetCredentialArgs(["--user", USER, "--confirm-user", USER, "--password", "hunter2"]),
    ).toThrow(/readable by anyone who can run 'ps'/);
    expect(() =>
      parseSetCredentialArgs(["--user", USER, "--confirm-user", USER, "--password=hunter2"]),
    ).toThrow(/OPERATE_NEW_PASSWORD/);
  });

  it("has no --yes", () => {
    expect(() =>
      parseSetCredentialArgs(["--user", USER, "--confirm-user", USER, "--yes"]),
    ).toThrow(/unknown option/);
  });

  it("answers --help without requiring the ids", () => {
    expect(parseSetCredentialArgs(["--help"]).help).toBe(true);
  });

  it("is named in the subcommand list and documents both variables", () => {
    expect(helpText).toContain("set-credential");
    expect(setCredentialCliHelpText).toContain("OPERATE_NEW_PASSWORD");
    expect(setCredentialCliHelpText).toContain("CREDENTIAL_PEPPER");
    expect(setCredentialCliHelpText).toContain("never from argv");
  });
});

describe("--min-password-length", () => {
  const login = [
    "--pack", "erp-core", "--store", "pg", "--jwt-issuer", "https://i.test", "--jwt-audience", "a",
    "--credential-login",
  ];

  it("defaults to null (the route applies 12) and parses a declared floor at both bounds", () => {
    expect(parseServeArgs(login).minPasswordLength).toBeNull();
    expect(parseServeArgs([...login, "--min-password-length", "8"]).minPasswordLength).toBe(8);
    expect(parseServeArgs([...login, "--min-password-length=1024"]).minPasswordLength).toBe(1024);
  });

  it("refuses a floor below 8, above the maximum length, or not an integer", () => {
    for (const bad of ["7", "1025", "12.5", "twelve", "0"]) {
      expect(() => parseServeArgs([...login, "--min-password-length", bad])).toThrow(
        /invalid --min-password-length/,
      );
    }
  });

  it("is refused without --credential-login, where nothing sets a password", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--min-password-length", "16"]),
    ).toThrow(/--min-password-length requires --credential-login/);
  });

  it("reaches set-credential too, and is absent from its result when not passed", () => {
    const USER = "22222222-2222-4222-8222-222222222222";
    expect(
      parseSetCredentialArgs(["--user", USER, "--confirm-user", USER, "--min-password-length", "20"])
        .minPasswordLength,
    ).toBe(20);
    expect("minPasswordLength" in parseSetCredentialArgs(["--user", USER, "--confirm-user", USER])).toBe(
      false,
    );
  });
});

describe("--allow-weak-api-keys and --idp-platform-roles", () => {
  const base = ["--pack", "erp-core", "--store", "pg"];

  it("default off, so a weak key and a foreign platform role are refused unless asked", () => {
    const opts = parseServeArgs(base);
    expect(opts.allowWeakApiKeys).toBe(false);
    expect(opts.idpPlatformRoles).toBe(false);
  });

  it("are booleans that take no value", () => {
    const jwks = ["--jwks-key", `k:${JWKS_PUB}`, "--jwt-issuer", "https://idp.test", "--jwt-audience", "api"];
    const opts = parseServeArgs([...base, ...jwks, "--allow-weak-api-keys", "--idp-platform-roles"]);
    expect(opts.allowWeakApiKeys).toBe(true);
    expect(opts.idpPlatformRoles).toBe(true);
  });

  it("refuses --idp-platform-roles with no JWKS, naming the three flags that would give it one (ADR-0479)", () => {
    expect(() => parseServeArgs([...base, "--idp-platform-roles"])).toThrow(
      "--idp-platform-roles requires a JWKS (--jwks-key, --jwks-file or --jwks-url): with none, no" +
        " foreign token is verified, so there is no IdP scope for it to let through",
    );
  });

  it("are documented in --help", () => {
    expect(helpText).toContain("--allow-weak-api-keys");
    expect(helpText).toContain("--idp-platform-roles");
    expect(helpText).toContain("--min-password-length");
  });
});

describe("--jwks-key validation", () => {
  it("refuses a value that is not a 32-byte Ed25519 public key, as a USAGE error", () => {
    // Exit 2 with the help text, rather than a boot stack trace. Until this increment nothing
    // validated the value at all: `isEd25519PublicKeyBase64` existed with zero callers while
    // `parseJwksKeySpec` checked only for a colon, so a typo'd key booted cleanly and turned every
    // Bearer request into an `invalid_signature` 401 whose body names nothing an operator can act
    // on. Both ends are closed now -- here for argv, and in `resolveJwtConfig` for a programmatic
    // `ServeOptions` that bypassed this parser.
    for (const bad of ["key-1:AAAbase64", "key-1:AAAxyz==", "key-1:not!base64!"]) {
      expect(
        () =>
          parseServeArgs([
            "--pack",
            "erp-core",
            "--jwks-key",
            bad,
            "--jwt-issuer",
            "https://i.test",
            "--jwt-audience",
            "a",
          ]),
        bad,
      ).toThrow(CliUsageError);
    }
  });

  it("accepts a real key", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-key",
      `k:${JWKS_PUB}`,
      "--jwt-issuer",
      "https://i.test",
      "--jwt-audience",
      "a",
    ]);
    expect(opts.jwksKeys).toEqual([`k:${JWKS_PUB}`]);
  });
});

describe("--deletion-capability (the inline route for an Article 17 proof's reach)", () => {
  const HONEST: readonly [string, string][] = [
    ["tenant_schema", "erases"],
    ["shared_tables", "erases"],
    ["object_storage", "absent"],
    ["backups", "present_not_erased"],
    ["search_indexes", "absent"],
    ["caches", "absent"],
  ];
  const argv = (pairs: readonly (readonly [string, string])[]): string[] => [
    "--pack=erp-core",
    ...pairs.flatMap(([k, v]) => ["--deletion-capability", `${k}=${v}`]),
  ];

  it("accumulates a complete set, and is null when the flag is absent", () => {
    expect(parseServeArgs(["--pack=erp-core"]).deletionCapabilityDeclarations).toBeNull();
    expect(parseServeArgs(argv(HONEST)).deletionCapabilityDeclarations).toEqual(
      Object.fromEntries(HONEST),
    );
  });

  it("is equivalent to the file route over the same six values", () => {
    // The two routes must produce the same declaration, which is why `node.ts` parses both through
    // one `DeletionCapabilitiesSchema` rather than assembling the inline one.
    const inline = parseServeArgs(argv(HONEST)).deletionCapabilityDeclarations;
    expect(inline).toEqual(JSON.parse(JSON.stringify(Object.fromEntries(HONEST))));
  });

  it("refuses an incomplete set, naming every missing subsystem", () => {
    // The decision ADR-0328 turns on: silence may not answer the reach of a proof, so a partial
    // set is refused here — where the operator can read which subsystems are unanswered — rather
    // than one layer in by six `invalid_type` issues naming neither the flag nor the remedy.
    try {
      parseServeArgs(argv(HONEST.slice(0, 4)));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(CliUsageError);
      const msg = (err as Error).message;
      expect(msg).toContain("2 of 6 subsystems undeclared");
      expect(msg).toContain("caches");
      expect(msg).toContain("search_indexes");
      expect(msg).toContain("ADR-0328");
    }
  });

  it("refuses an unknown subsystem and an unknown disposition, each against the real vocabulary", () => {
    expect(() => parseServeArgs(argv([["backup", "absent"]]))).toThrow(/unknown subsystem 'backup'/);
    expect(() => parseServeArgs(argv([["backups", "presnt_not_erased"]]))).toThrow(
      /unknown disposition 'presnt_not_erased' for backups/,
    );
    // And the refusal lists what IS admissible, so an operator can act on it without the docs.
    expect(() => parseServeArgs(argv([["backup", "absent"]]))).toThrow(/tenant_schema/);
    expect(() => parseServeArgs(argv([["backups", "x"]]))).toThrow(/present_not_erased/);
  });

  it("refuses a repeated subsystem rather than taking the last one", () => {
    // Every other repeatable flag here accumulates, because a role list is a set. A disposition is
    // one decision, so last-wins would let argv order decide what a signed proof claims.
    try {
      parseServeArgs(argv([...HONEST, ["backups", "absent"]]));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(CliUsageError);
      expect((err as Error).message).toMatch(
        /backups declared twice \('present_not_erased' then 'absent'\)/,
      );
    }
  });

  it("refuses the grammar it shares with --audit-read-sensitive-class, naming the form", () => {
    expect(() => parseServeArgs(["--pack=erp-core", "--deletion-capability", "backups"])).toThrow(
      /expected <subsystem>=<disposition>/,
    );
    expect(() => parseServeArgs(["--pack=erp-core", "--deletion-capability", "=absent"])).toThrow(
      /expected <subsystem>=<disposition>/,
    );
  });

  it("is mutually exclusive with the file, because two declarations of one reach is precedence", () => {
    expect(() =>
      parseServeArgs([...argv(HONEST), "--deletion-capabilities", "/tmp/caps.json"]),
    ).toThrow(/mutually exclusive/);
  });

  it("accepts the `=` form as well as the two-token form", () => {
    const opts = parseServeArgs([
      "--pack=erp-core",
      ...HONEST.map(([k, v]) => `--deletion-capability=${k}=${v}`),
    ]);
    expect(opts.deletionCapabilityDeclarations).toEqual(Object.fromEntries(HONEST));
  });

  it("--help names the flag, its totality rule and why the file route was not enough", () => {
    const help = helpText;
    expect(help).toContain("--deletion-capability <subsystem>=<disposition>");
    expect(help).toContain("All six or none");
    expect(help).toContain("volumes:");
  });
});

describe("--audit-chain-config's help names the environment route", () => {
  it("names the variable, that the public half is derived, and the same-key rule", () => {
    // The flag was the only route to the seed and `--help` was where an operator looked. A route
    // nothing documents is a route nobody takes.
    const help = helpText;
    expect(help).toContain("AUDIT_CHAIN_SIGNING_KEY");
    expect(help).toContain("public half is derived");
    expect(help).toMatch(/state the SAME one/);
  });
});

describe("--pg-* pool flags", () => {
  const PG = ["--pack", "erp-core", "--store", "pg"];

  it("overrides nothing by default, so the serving defaults apply", () => {
    expect(parseServeArgs([...PG]).pgPool).toEqual({});
  });

  it("takes all six in both spellings, keyed by setting", () => {
    const o = parseServeArgs([
      ...PG,
      "--pg-pool-max",
      "25",
      "--pg-connect-timeout-ms=5000",
      "--pg-idle-timeout-ms",
      "0",
      "--pg-statement-timeout-ms=0",
      "--pg-lock-timeout-ms",
      "2000",
      "--pg-idle-in-transaction-timeout-ms=120000",
    ]);
    expect(o.pgPool).toEqual({
      maxConnections: 25,
      connectTimeoutMs: 5000,
      idleTimeoutMs: 0,
      statementTimeoutMs: 0,
      lockTimeoutMs: 2000,
      idleInTransactionTimeoutMs: 120_000,
    });
  });

  it("refuses an out-of-bounds or malformed value, naming the flag", () => {
    for (const [flag, bad] of [
      ["--pg-pool-max", "0"],
      ["--pg-pool-max", "ten"],
      ["--pg-statement-timeout-ms", "50"],
      ["--pg-lock-timeout-ms", "-1"],
      ["--pg-connect-timeout-ms", "1.5"],
    ] as const) {
      expect(() => parseServeArgs([...PG, flag, bad])).toThrow(`invalid ${flag}`);
    }
  });

  it("refuses a flag given twice rather than letting argv order decide", () => {
    expect(() =>
      parseServeArgs([...PG, "--pg-lock-timeout-ms", "1000", "--pg-lock-timeout-ms=2000"]),
    ).toThrow("--pg-lock-timeout-ms given more than once");
  });

  it("refuses the memory store, which opens no connection to bound", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "memory", "--pg-pool-max", "5"]),
    ).toThrow(/need a Postgres store/);
  });

  it("documents every flag and the subcommands' exemption", () => {
    for (const flag of [
      "--pg-pool-max",
      "--pg-connect-timeout-ms",
      "--pg-idle-timeout-ms",
      "--pg-statement-timeout-ms",
      "--pg-lock-timeout-ms",
      "--pg-idle-in-transaction-timeout-ms",
    ]) {
      expect(helpText).toContain(flag);
    }
    expect(helpText).toContain("migrate and the operator subcommands");
  });
});

describe("parseServeArgs --allow-dangling-references", () => {
  it("is off by default, so the document store enforces references", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--store", "pg"]).allowDanglingReferences).toBe(false);
  });

  it("turns the document store's reference check off when asked", () => {
    expect(
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--allow-dangling-references"]).allowDanglingReferences,
    ).toBe(true);
  });

  it("is refused by name on a store it would do nothing on", () => {
    // `pg-columns` enforces references with foreign keys and `memory` checks nothing, so on either
    // the flag would be accepted and inert, which reads as a choice the deployment made.
    for (const store of ["pg-columns", "memory"]) {
      expect(() =>
        parseServeArgs(["--pack", "erp-core", "--store", store, "--allow-dangling-references"]),
      ).toThrow(/--allow-dangling-references applies to --store pg only/);
    }
  });
});

describe("--integrity-proof-full-every (H-18)", () => {
  const base = ["--pack", "erp-core", "--store", "pg"];

  it("is null unless given, so the config's default decides", () => {
    expect(parseServeArgs([...base, "--integrity-proof"]).integrityProofFullEvery).toBeNull();
  });

  it("takes a non-negative integer, 0 meaning never", () => {
    expect(
      parseServeArgs([...base, "--integrity-proof", "--integrity-proof-full-every", "6"]).integrityProofFullEvery,
    ).toBe(6);
    expect(
      parseServeArgs([...base, "--integrity-proof", "--integrity-proof-full-every=0"]).integrityProofFullEvery,
    ).toBe(0);
    for (const bad of ["-1", "1.5", "x"]) {
      expect(() =>
        parseServeArgs([...base, "--integrity-proof", "--integrity-proof-full-every", bad]),
      ).toThrow(/invalid --integrity-proof-full-every/);
    }
  });

  it("refuses to be inert: it needs --integrity-proof, and the file route states it in the file", () => {
    expect(() => parseServeArgs([...base, "--integrity-proof-full-every", "6"])).toThrow(
      /needs --integrity-proof/,
    );
    expect(() =>
      parseServeArgs([...base, "--integrity-proof-config", "p.json", "--integrity-proof-full-every", "6"]),
    ).toThrow(/set fullFoldEveryPasses in the file/);
  });
});

describe("parseServeArgs — AI provider timeout, price and residency (M-16, M-17)", () => {
  const base = ["--pack", "erp-core", "--store", "pg", "--ai-design"];

  it("defaults to the provider timeout, no declared price, no hatch and no provider ref", () => {
    const o = parseServeArgs(base);
    expect(o.aiProviderTimeoutMs).toBeNull();
    expect(o.aiModelPrice).toBeNull();
    expect(o.allowUnpricedModel).toBe(false);
    expect(o.aiProviderRef).toBeNull();
  });

  it("reads all four", () => {
    const o = parseServeArgs([
      ...base,
      "--ai-provider-timeout-ms",
      "30000",
      "--ai-model-price=2:8:0.5",
      "--ai-allow-unpriced-model",
      "--ai-provider-ref",
      "anthropic:us",
    ]);
    expect(o.aiProviderTimeoutMs).toBe(30_000);
    expect(o.aiModelPrice).toEqual({ inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.5 });
    expect(o.allowUnpricedModel).toBe(true);
    expect(o.aiProviderRef).toBe("anthropic:us");
  });

  it("reads --ai-max-output-tokens and refuses one outside 1024..32768", () => {
    expect(parseServeArgs(base).aiMaxOutputTokens).toBeNull();
    expect(parseServeArgs([...base, "--ai-max-output-tokens", "4096"]).aiMaxOutputTokens).toBe(4096);
    expect(parseServeArgs([...base, "--ai-max-output-tokens=2048"]).aiMaxOutputTokens).toBe(2048);
    expect(() => parseServeArgs([...base, "--ai-max-output-tokens", "512"])).toThrow(CliUsageError);
    expect(() => parseServeArgs([...base, "--ai-max-output-tokens", "40000"])).toThrow(/--ai-max-output-tokens/);
  });

  it("refuses a malformed value of each", () => {
    expect(() => parseServeArgs([...base, "--ai-provider-timeout-ms", "10"])).toThrow(CliUsageError);
    expect(() => parseServeArgs([...base, "--ai-provider-timeout-ms", "1.5e9"])).toThrow(CliUsageError);
    expect(() => parseServeArgs([...base, "--ai-model-price", "3"])).toThrow(/--ai-model-price/);
    expect(() => parseServeArgs([...base, "--ai-model-price", "-1:2"])).toThrow(CliUsageError);
    expect(() => parseServeArgs([...base, "--ai-provider-ref", "anthropic"])).toThrow(/--ai-provider-ref/);
  });

  it("documents each flag in --help", () => {
    const help = helpText;
    for (const flag of ["--ai-provider-timeout-ms", "--ai-model-price", "--ai-allow-unpriced-model", "--ai-provider-ref"]) {
      expect(help).toContain(flag);
    }
  });
});

describe("parseServeArgs — --column-key-survey-ceiling (ADR-0460)", () => {
  const BASE = ["--pack", "erp-core", "--store", "pg-columns"];
  const { min, max } = COLUMN_KEY_SURVEY_CEILING_BOUNDS;

  it("defaults to today's constant, so an unchanged deployment boots exactly as before", () => {
    expect(parseServeArgs(BASE).columnKeySurveyCeiling).toBe(PER_TENANT_SURVEY_CEILING);
  });

  it("parses both flag forms and accepts both bounds", () => {
    expect(parseServeArgs([...BASE, COLUMN_KEY_SURVEY_CEILING_FLAG, "50000"]).columnKeySurveyCeiling).toBe(50_000);
    expect(parseServeArgs([...BASE, `${COLUMN_KEY_SURVEY_CEILING_FLAG}=2500`]).columnKeySurveyCeiling).toBe(2_500);
    expect(parseServeArgs([...BASE, COLUMN_KEY_SURVEY_CEILING_FLAG, String(min)]).columnKeySurveyCeiling).toBe(min);
    expect(parseServeArgs([...BASE, COLUMN_KEY_SURVEY_CEILING_FLAG, String(max)]).columnKeySurveyCeiling).toBe(max);
  });

  it("refuses a value outside the bounds rather than clamping it, naming them", () => {
    for (const bad of [String(min - 1), String(max + 1), "0"]) {
      const thrown = (): unknown => parseServeArgs([...BASE, COLUMN_KEY_SURVEY_CEILING_FLAG, bad]);
      expect(thrown).toThrow(CliUsageError);
      expect(thrown).toThrow(new RegExp(`must be an integer between ${String(min)} and ${String(max)} tenants`));
    }
  });

  it("refuses a spelling that merely parses as a number", () => {
    // `Number()` would read every one of these as an in-range integer (or 0), so digits are required.
    for (const bad of ["1e4", "10000.0", "0x2710", " 5000", "5000 ", "+5000", "abc", ""]) {
      expect(() => parseServeArgs([...BASE, `${COLUMN_KEY_SURVEY_CEILING_FLAG}=${bad}`])).toThrow(
        /must be an integer between/,
      );
    }
  });

  it("is in --help with its bounds and default", () => {
    expect(helpText).toContain(COLUMN_KEY_SURVEY_CEILING_FLAG);
    expect(helpText).toContain(`${String(min)}..${String(max)}, default ${String(PER_TENANT_SURVEY_CEILING)}`);
  });
});

describe("rekeyHelpText — the column-key pre-flight (ADR-0460)", () => {
  it("says the boot's check runs first, on --plan and --rewrap-kek too, and its exit code", () => {
    expect(rekeyHelpText).toContain("the boot's column-key check runs for this");
    expect(rekeyHelpText).toContain("on --plan and --rewrap-kek too");
    expect(rekeyHelpText).toContain("1 when the column-key check or the survey refuses");
  });
});

describe("--access-request-routes", () => {
  const full = [
    "--pack",
    "erp-core",
    "--store",
    "pg",
    "--jwt-issuer",
    "https://i.test",
    "--jwt-audience",
    "a",
    "--credential-login",
    "--platform-admin",
    "--platform-user-routes",
    "--platform-user-role",
    "platform_admin",
    "--credential-admin-role",
    "platform_admin",
  ];
  const without = (flag: string, takesValue = false): string[] => {
    const i = full.indexOf(flag);
    return [...full.slice(0, i), ...full.slice(i + (takesValue ? 2 : 1))];
  };

  it("parses with every grant an approval needs, and defaults the bounds", () => {
    const opts = parseServeArgs([...full, "--access-request-routes"]);
    expect(opts.accessRequestRoutes).toBe(true);
    expect(opts.accessRequestMaxPending).toBe(200);
    expect(opts.accessRequestTtlHours).toBe(72);
    expect(opts.accessRequestRetentionDays).toBe(30);
    expect(opts.accessRequestRole).toBe("erp_admin");
  });

  it("parses the bounds and the role", () => {
    const opts = parseServeArgs([
      ...full,
      "--access-request-routes",
      "--access-request-max-pending",
      "10",
      "--access-request-ttl-hours=24",
      "--access-request-retention-days",
      "7",
      "--access-request-role",
      "erp_viewer",
    ]);
    expect([opts.accessRequestMaxPending, opts.accessRequestTtlHours, opts.accessRequestRetentionDays]).toEqual([
      10, 24, 7,
    ]);
    expect(opts.accessRequestRole).toBe("erp_viewer");
  });

  it.each([
    ["--credential-login", false, /--credential-login/],
    ["--platform-admin", false, /--platform-admin/],
    ["--platform-user-routes", false, /--platform-user-routes/],
  ])("refuses without %s, naming it", (flag, takesValue, message) => {
    const argv = [...without(flag, takesValue), "--access-request-routes"];
    // Removing the routes flag orphans its role flag; drop that too so the refusal is the one asked.
    const cleaned =
      flag === "--platform-user-routes"
        ? argv.filter((a, i) => a !== "--platform-user-role" && argv[i - 1] !== "--platform-user-role")
        : flag === "--credential-login"
          ? argv.filter((a, i) => a !== "--credential-admin-role" && argv[i - 1] !== "--credential-admin-role")
          : argv;
    expect(() => parseServeArgs(cleaned)).toThrow(message);
  });

  it("refuses without --credential-admin-role", () => {
    expect(() => parseServeArgs([...without("--credential-admin-role", true), "--access-request-routes"])).toThrow(
      /--access-request-routes requires --credential-admin-role/,
    );
  });

  it("refuses the memory store", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "memory", "--access-request-routes"]),
    ).toThrow(/--access-request-routes requires a Postgres store/);
  });

  it("refuses out-of-range bounds rather than clamping, and orphaned tuning flags", () => {
    expect(() => parseServeArgs([...full, "--access-request-routes", "--access-request-max-pending", "0"])).toThrow(
      /invalid --access-request-max-pending/,
    );
    expect(() => parseServeArgs([...full, "--access-request-routes", "--access-request-ttl-hours", "721"])).toThrow(
      /invalid --access-request-ttl-hours/,
    );
    expect(() => parseServeArgs([...full, "--access-request-retention-days", "5"])).toThrow(
      /--access-request-retention-days requires --access-request-routes/,
    );
  });

  it("documents every flag in the help", () => {
    for (const flag of [
      "--access-request-routes",
      "--access-request-max-pending",
      "--access-request-ttl-hours",
      "--access-request-retention-days",
      "--access-request-role",
    ]) {
      expect(helpText).toMatch(new RegExp(`^ {2}${flag} `, "m"));
    }
  });
});
