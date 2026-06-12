import { RoutingTableSchema, type RoutingTable } from "@crossengin/edge";
import { buildProfileFromTemplate, type ResidencyProfile } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { RegionRouter } from "./router.js";

const TABLE: RoutingTable = RoutingTableSchema.parse([
  { id: "de", strategy: "region_pinned", priority: 0, sourceCountries: ["DE"], primaryRegions: ["eu-west"] },
  { id: "default", strategy: "region_pinned", priority: 10, sourceCountries: [], primaryRegions: ["us-east"] },
]);

// eu-only: primaryRegion eu-central, allowedRegions [eu-central, eu-west].
const EU_ONLY: ResidencyProfile = buildProfileFromTemplate("eu-only", {});

function router(table: RoutingTable = TABLE): RegionRouter {
  return new RegionRouter({ table });
}

describe("RegionRouter", () => {
  it("routes by the geo table when there's no residency profile", () => {
    expect(router().resolve({ country: "DE" })).toMatchObject({ region: "eu-west", reason: "routing_table", residencyEnforced: false });
    expect(router().resolve({ country: "US" })).toMatchObject({ region: "us-east", reason: "routing_table" });
  });

  it("overrides an out-of-residency geo pick to the profile's primary region", () => {
    // US caller would route to us-east, but the eu-only tenant may not be served there.
    const r = router().resolve({ country: "US", profile: EU_ONLY });
    expect(r).toMatchObject({ region: "eu-central", reason: "residency_override", residencyEnforced: true, decision: "redirect" });
  });

  it("keeps an in-residency geo pick", () => {
    const r = router().resolve({ country: "DE", profile: EU_ONLY });
    expect(r).toMatchObject({ region: "eu-west", reason: "routing_table", residencyEnforced: true });
  });

  it("honors a residency-allowed sticky affinity over the geo table", () => {
    const r = router().resolve({ country: "US", profile: EU_ONLY, affinityRegion: "eu-west" });
    expect(r).toMatchObject({ region: "eu-west", reason: "affinity", residencyEnforced: true });
  });

  it("ignores a sticky affinity that residency forbids (falls through to the override)", () => {
    const r = router().resolve({ country: "US", profile: EU_ONLY, affinityRegion: "us-east" });
    expect(r).toMatchObject({ region: "eu-central", reason: "residency_override" });
  });

  it("serves the residency primary when no routing rule matches", () => {
    const onlyDe: RoutingTable = RoutingTableSchema.parse([
      { id: "de", strategy: "region_pinned", priority: 0, sourceCountries: ["DE"], primaryRegions: ["eu-west"] },
    ]);
    expect(router(onlyDe).resolve({ country: "JP", profile: EU_ONLY })).toMatchObject({ region: "eu-central", reason: "residency_primary" });
    // no profile + no rule → dropped
    expect(router(onlyDe).resolve({ country: "JP" })).toMatchObject({ region: null, reason: "no_rule" });
  });

  it("drops a request a blackhole rule matches", () => {
    const bh: RoutingTable = RoutingTableSchema.parse([
      { id: "bh", strategy: "region_pinned", priority: 0, sourceCountries: ["KP"], primaryRegions: ["us-east"], decision: "blackhole" },
    ]);
    expect(router(bh).resolve({ country: "KP" })).toMatchObject({ region: null, reason: "blackhole" });
  });
});
