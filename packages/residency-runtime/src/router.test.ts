import { buildProfileFromTemplate, type ResidencyProfile } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { decideRegionRouting } from "./router.js";

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
