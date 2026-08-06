import { buildProfileFromTemplate, type ResidencyProfile } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { InMemoryTenantResidencyDirectory } from "./directory.js";
import { RegionRouter, decideRegionRouting } from "./router.js";

const AT = { establishedAt: "2026-01-01T00:00:00.000Z" };
const euOnly: ResidencyProfile = buildProfileFromTemplate("eu-only", AT);
const usOnly: ResidencyProfile = buildProfileFromTemplate("us-only", AT);

describe("decideRegionRouting", () => {
  it("serves when the region is the primary", () => {
    expect(decideRegionRouting(euOnly, "eu-central")).toEqual({ action: "serve", region: "eu-central" });
  });

  it("serves when the region is a non-primary allowed region", () => {
    expect(decideRegionRouting(euOnly, "eu-west")).toEqual({ action: "serve", region: "eu-west" });
  });

  it("redirects to the primary when the serving region is forbidden", () => {
    const decision = decideRegionRouting(euOnly, "us-east");
    expect(decision.action).toBe("redirect");
    if (decision.action !== "redirect") return;
    expect(decision.region).toBe("eu-central");
    expect(decision.reason).toMatch(/forbidden/);
  });

  it("redirects a us-only tenant hitting eu back to us-east", () => {
    const decision = decideRegionRouting(usOnly, "eu-central");
    expect(decision).toMatchObject({ action: "redirect", region: "us-east" });
  });
});

describe("RegionRouter", () => {
  const TENANT = "00000000-0000-4000-8000-000000000001";

  it("serves a known tenant in an allowed region", async () => {
    const dir = new InMemoryTenantResidencyDirectory([[TENANT, euOnly]]);
    const router = new RegionRouter(dir);
    expect(await router.route({ tenantId: TENANT, servingRegion: "eu-central" })).toEqual({
      action: "serve",
      region: "eu-central",
    });
  });

  it("redirects a known tenant served in a forbidden region", async () => {
    const dir = new InMemoryTenantResidencyDirectory().set(TENANT, euOnly);
    const router = new RegionRouter(dir);
    const decision = await router.route({ tenantId: TENANT, servingRegion: "apac-sg" });
    expect(decision).toMatchObject({ action: "redirect", region: "eu-central" });
  });

  it("denies an unknown tenant (fail-closed — never served without a profile)", async () => {
    const router = new RegionRouter(new InMemoryTenantResidencyDirectory());
    const decision = await router.route({ tenantId: "unknown", servingRegion: "eu-central" });
    expect(decision.action).toBe("deny");
    if (decision.action !== "deny") return;
    expect(decision.reason).toMatch(/no residency profile/);
  });

  it("awaits an async directory", async () => {
    const router = new RegionRouter({
      resolve: async (t) => (t === TENANT ? euOnly : null),
    });
    expect((await router.route({ tenantId: TENANT, servingRegion: "eu-west" })).action).toBe("serve");
    expect((await router.route({ tenantId: "x", servingRegion: "eu-west" })).action).toBe("deny");
  });
});
