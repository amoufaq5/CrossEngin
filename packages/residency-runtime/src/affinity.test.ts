import { buildProfileFromTemplate, type Region, type ResidencyProfile } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { selectServingRegion } from "./affinity.js";

const AT = { establishedAt: "2026-01-01T00:00:00.000Z" };
const euOnly: ResidencyProfile = buildProfileFromTemplate("eu-only", AT);
const meOnly: ResidencyProfile = buildProfileFromTemplate("me-only", AT);
const unrestricted: ResidencyProfile = buildProfileFromTemplate("unrestricted", AT);

describe("selectServingRegion", () => {
  it("prefers the primary region when it is available", () => {
    const avail: Region[] = ["eu-west", "eu-central", "us-east"];
    expect(selectServingRegion(euOnly, avail)).toBe("eu-central");
  });

  it("falls back to an allowed region in the same broad region when the primary is down", () => {
    // eu-central (primary) not available → eu-west (also broad 'eu' + allowed) wins over us regions.
    expect(selectServingRegion(euOnly, ["us-east", "eu-west"])).toBe("eu-west");
  });

  it("picks a same-broad-region allowed fallback for a me-only tenant", () => {
    // me-uae down → gcc-ksa (broad 'me', allowed).
    expect(selectServingRegion(meOnly, ["apac-sg", "gcc-ksa"])).toBe("gcc-ksa");
  });

  it("returns null when no available region is allowed (never leaks to a forbidden region)", () => {
    expect(selectServingRegion(euOnly, ["us-east", "us-west", "apac-sg"])).toBeNull();
  });

  it("returns null when nothing is available", () => {
    expect(selectServingRegion(euOnly, [])).toBeNull();
  });

  it("serves an unrestricted tenant from any available region (first, since no primary present)", () => {
    expect(selectServingRegion(unrestricted, ["ap-south", "us-west"])).toBe("ap-south");
  });
});
