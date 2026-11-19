import { PackCompatibilitySchema, checkCompatibility } from "@crossengin/marketplace";
import type { TenantResidencyDirectory } from "@crossengin/residency-runtime";
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_UNSOURCED_FACTS,
  buildMarketplaceTenantContext,
  formatMarketplaceTenantFacts,
} from "./marketplace-tenant-context.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function directory(resolve: TenantResidencyDirectory["resolve"]): TenantResidencyDirectory {
  return { resolve } as TenantResidencyDirectory;
}

describe("buildMarketplaceTenantContext", () => {
  it("supplies the deployment's region and version and nothing it does not know", async () => {
    const ctx = await buildMarketplaceTenantContext({
      platformVersion: "1.4.0",
      deploymentRegion: "us-east",
      residency: () => undefined,
    })(TENANT);
    expect(ctx).toEqual({
      platformVersion: "1.4.0",
      region: "us-east",
      planTier: null,
      compliancePacks: null,
      isDedicatedTenant: null,
    });
  });

  it("prefers the tenant's residency primary region over the deployment's, asking for that tenant", async () => {
    const asked: string[] = [];
    const ctx = await buildMarketplaceTenantContext({
      platformVersion: null,
      deploymentRegion: "us-east",
      residency: () =>
        directory(async (id) => {
          asked.push(id);
          return { primaryRegion: "eu-central" } as Awaited<ReturnType<TenantResidencyDirectory["resolve"]>>;
        }),
    })(TENANT);
    expect(ctx.region).toBe("eu-central");
    expect(asked).toEqual([TENANT]);
  });

  it("falls back to the deployment's region for a tenant with no profile", async () => {
    const ctx = await buildMarketplaceTenantContext({
      platformVersion: null,
      deploymentRegion: "us-east",
      residency: () => directory(async () => null),
    })(TENANT);
    expect(ctx.region).toBe("us-east");
  });

  it("reads a failed residency lookup as unknown, never as the deployment's region", async () => {
    const ctx = await buildMarketplaceTenantContext({
      platformVersion: null,
      deploymentRegion: "us-east",
      residency: () => directory(async () => Promise.reject(new Error("directory down"))),
    })(TENANT);
    expect(ctx.region).toBeNull();
  });

  it("refuses a pack constraining a fact it does not know, and admits one that constrains none", async () => {
    const ctx = await buildMarketplaceTenantContext({
      platformVersion: null,
      deploymentRegion: null,
      residency: () => undefined,
    })(TENANT);
    const plain = checkCompatibility(PackCompatibilitySchema.parse({ minPlatformVersion: "0.0.0" }), ctx);
    expect(plain.compatible).toBe(true);
    const tiered = checkCompatibility(
      PackCompatibilitySchema.parse({ minPlatformVersion: "0.0.0", requiredPlanTier: "enterprise" }),
      ctx,
    );
    expect(tiered.compatible).toBe(false);
    expect(tiered.undetermined).toContain("planTier");
  });
});

describe("formatMarketplaceTenantFacts", () => {
  it("names every unsourced fact with its reason", () => {
    const out = formatMarketplaceTenantFacts(
      { platformVersion: null, deploymentRegion: null, residencyConfigured: false },
      [],
    );
    for (const [fact, why] of Object.entries(MARKETPLACE_UNSOURCED_FACTS)) {
      expect(out).toContain(`${fact}: unknown — ${why}`);
    }
    expect(out).toContain("platform version unknown (no --marketplace-platform-version)");
    expect(out).toContain("region unknown (no --region)");
    expect(out).toContain("manifest declares compliance packs: none");
  });

  it("names declared compliance ids outside the marketplace vocabulary, which is most of them", () => {
    const out = formatMarketplaceTenantFacts(
      { platformVersion: "1.4.0", deploymentRegion: "us-east", residencyConfigured: true },
      ["hipaa", "pci", "uae-moh"],
    );
    expect(out).toContain("region a tenant's residency primary region, else us-east");
    expect(out).toContain("2 outside the marketplace vocabulary: pci, uae-moh");
  });
});
