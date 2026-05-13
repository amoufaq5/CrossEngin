import { describe, expect, it } from "vitest";
import {
  BROAD_REGION_OF,
  BROAD_REGIONS,
  broadRegionOf,
  DEFAULT_REGION_CATALOG,
  RegionCatalogSchema,
  REGIONS,
  RegionRecordSchema,
  RegionSchema,
} from "./regions.js";

describe("REGIONS / BROAD_REGIONS", () => {
  it("declares the eight canonical regions", () => {
    expect(REGIONS).toHaveLength(8);
    expect(REGIONS).toContain("eu-central");
    expect(REGIONS).toContain("me-uae");
  });

  it("BROAD_REGIONS covers each top-level continent", () => {
    expect(BROAD_REGIONS).toEqual(["eu", "us", "me", "ap", "sa"]);
  });

  it("broadRegionOf maps every region to a known broad region", () => {
    for (const r of REGIONS) {
      expect(BROAD_REGIONS).toContain(BROAD_REGION_OF[r]);
      expect(broadRegionOf(r)).toBe(BROAD_REGION_OF[r]);
    }
  });

  it("eu regions share the eu broad region", () => {
    expect(broadRegionOf("eu-central")).toBe("eu");
    expect(broadRegionOf("eu-west")).toBe("eu");
  });
});

describe("RegionSchema", () => {
  it("accepts each canonical region", () => {
    for (const r of REGIONS) {
      expect(() => RegionSchema.parse(r)).not.toThrow();
    }
  });

  it("rejects an unknown region", () => {
    expect(() => RegionSchema.parse("antarctica")).toThrow();
  });
});

describe("RegionRecordSchema", () => {
  it("parses a typical record", () => {
    const r = RegionRecordSchema.parse({
      region: "eu-central",
      label: "EU Central (Frankfurt)",
      cloudProvider: "supabase",
      cloudProviderRegion: "supabase-eu-central-1",
      status: "active",
      yearAvailable: 2026,
    });
    expect(r.region).toBe("eu-central");
  });

  it("rejects unknown status", () => {
    expect(() =>
      RegionRecordSchema.parse({
        region: "eu-central",
        label: "x",
        cloudProvider: "supabase",
        cloudProviderRegion: "x",
        status: "imaginary",
        yearAvailable: 2026,
      }),
    ).toThrow();
  });
});

describe("RegionCatalogSchema", () => {
  it("parses DEFAULT_REGION_CATALOG", () => {
    expect(() => RegionCatalogSchema.parse(DEFAULT_REGION_CATALOG)).not.toThrow();
  });

  it("rejects duplicate regions", () => {
    expect(() =>
      RegionCatalogSchema.parse([
        {
          region: "eu-central",
          label: "A",
          cloudProvider: "supabase",
          cloudProviderRegion: "x",
          status: "active",
          yearAvailable: 2026,
        },
        {
          region: "eu-central",
          label: "B",
          cloudProvider: "supabase",
          cloudProviderRegion: "y",
          status: "active",
          yearAvailable: 2026,
        },
      ]),
    ).toThrow(/duplicate region/);
  });

  it("rejects a drReplicaOf referencing an unknown region", () => {
    expect(() =>
      RegionCatalogSchema.parse([
        {
          region: "apac-sg",
          label: "x",
          cloudProvider: "supabase",
          cloudProviderRegion: "x",
          status: "dr_replica",
          yearAvailable: 2027,
          drReplicaOf: "atlantis",
        },
      ]),
    ).toThrow();
  });
});

describe("DEFAULT_REGION_CATALOG content", () => {
  it("marks eu-central as active in 2026", () => {
    const eu = DEFAULT_REGION_CATALOG.find((r) => r.region === "eu-central");
    expect(eu?.status).toBe("active");
    expect(eu?.yearAvailable).toBe(2026);
  });

  it("marks me-uae as planned with self-hosted cloud provider", () => {
    const uae = DEFAULT_REGION_CATALOG.find((r) => r.region === "me-uae");
    expect(uae?.status).toBe("planned");
    expect(uae?.cloudProvider).toBe("self-hosted");
  });

  it("marks apac-sg as a DR replica of eu-central", () => {
    const sg = DEFAULT_REGION_CATALOG.find((r) => r.region === "apac-sg");
    expect(sg?.status).toBe("dr_replica");
    expect(sg?.drReplicaOf).toBe("eu-central");
  });
});
