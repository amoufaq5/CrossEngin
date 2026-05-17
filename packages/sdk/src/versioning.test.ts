import { describe, expect, it } from "vitest";
import {
  API_VERSIONS,
  API_VERSION_STATUSES,
  ApiVersionCatalogSchema,
  ApiVersionSpecSchema,
  DEPRECATION_HEADER_NAME,
  SUNSET_HEADER_NAME,
  VERSION_HEADER_NAME,
  currentStableVersion,
  daysUntilSunset,
  isSunset,
  versionForRequest,
  type ApiVersionSpec,
} from "./versioning.js";

describe("constants", () => {
  it("API_VERSIONS has 2 entries", () => {
    expect(API_VERSIONS).toEqual(["v1", "v2"]);
  });

  it("API_VERSION_STATUSES has 4 entries", () => {
    expect(API_VERSION_STATUSES).toEqual([
      "preview",
      "stable",
      "deprecated",
      "sunset",
    ]);
  });

  it("declares header name constants", () => {
    expect(VERSION_HEADER_NAME).toBe("X-CrossEngin-Api-Version");
    expect(SUNSET_HEADER_NAME).toBe("Sunset");
    expect(DEPRECATION_HEADER_NAME).toBe("Deprecation");
  });
});

describe("ApiVersionSpecSchema", () => {
  const base: ApiVersionSpec = {
    version: "v1",
    status: "stable",
    releasedAt: "2026-01-01T00:00:00Z",
    deprecatedAt: null,
    sunsetAt: null,
    breakingChangeCount: 0,
  };

  it("accepts a valid stable spec", () => {
    expect(() => ApiVersionSpecSchema.parse(base)).not.toThrow();
  });

  it("rejects deprecated without deprecatedAt", () => {
    expect(() =>
      ApiVersionSpecSchema.parse({
        ...base,
        status: "deprecated",
        migrationGuideUrl: "https://docs.x.io/v2",
      }),
    ).toThrow(/deprecatedAt/);
  });

  it("rejects sunset without sunsetAt", () => {
    expect(() =>
      ApiVersionSpecSchema.parse({
        ...base,
        status: "sunset",
        deprecatedAt: "2026-01-01T00:00:00Z",
        migrationGuideUrl: "https://docs.x.io/v2",
      }),
    ).toThrow(/sunsetAt/);
  });

  it("rejects sunsetAt <= deprecatedAt", () => {
    expect(() =>
      ApiVersionSpecSchema.parse({
        ...base,
        status: "sunset",
        deprecatedAt: "2027-01-01T00:00:00Z",
        sunsetAt: "2026-01-01T00:00:00Z",
        migrationGuideUrl: "https://docs.x.io/v2",
      }),
    ).toThrow(/sunsetAt must be after deprecatedAt/);
  });

  it("rejects deprecated without migrationGuideUrl", () => {
    expect(() =>
      ApiVersionSpecSchema.parse({
        ...base,
        status: "deprecated",
        deprecatedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/migrationGuideUrl/);
  });
});

describe("ApiVersionCatalogSchema", () => {
  const spec = (
    version: "v1" | "v2",
    status: ApiVersionSpec["status"],
  ): ApiVersionSpec => ({
    version,
    status,
    releasedAt: "2026-01-01T00:00:00Z",
    deprecatedAt: status === "deprecated" || status === "sunset" ? "2026-06-01T00:00:00Z" : null,
    sunsetAt: status === "sunset" ? "2027-01-01T00:00:00Z" : null,
    migrationGuideUrl:
      status === "deprecated" || status === "sunset"
        ? "https://docs.x.io/v2"
        : undefined,
    breakingChangeCount: 0,
  });

  it("accepts one stable + one preview", () => {
    expect(() =>
      ApiVersionCatalogSchema.parse([spec("v1", "stable"), spec("v2", "preview")]),
    ).not.toThrow();
  });

  it("rejects duplicate versions", () => {
    expect(() =>
      ApiVersionCatalogSchema.parse([spec("v1", "stable"), spec("v1", "preview")]),
    ).toThrow(/duplicate version/);
  });

  it("rejects two stable versions", () => {
    expect(() =>
      ApiVersionCatalogSchema.parse([spec("v1", "stable"), spec("v2", "stable")]),
    ).toThrow(/at most one version/);
  });
});

describe("helpers", () => {
  const catalog = [
    {
      version: "v1" as const,
      status: "deprecated" as const,
      releasedAt: "2025-01-01T00:00:00Z",
      deprecatedAt: "2026-01-01T00:00:00Z",
      sunsetAt: "2027-01-01T00:00:00Z",
      migrationGuideUrl: "https://docs.x.io/v2",
      breakingChangeCount: 3,
    },
    {
      version: "v2" as const,
      status: "stable" as const,
      releasedAt: "2026-01-01T00:00:00Z",
      deprecatedAt: null,
      sunsetAt: null,
      breakingChangeCount: 0,
    },
  ];

  it("currentStableVersion returns the v2 stable", () => {
    expect(currentStableVersion(catalog)?.version).toBe("v2");
  });

  it("daysUntilSunset returns days remaining", () => {
    const days = daysUntilSunset(catalog[0]!, new Date("2026-12-22T00:00:00Z"));
    expect(days).toBe(10);
  });

  it("daysUntilSunset returns null for non-sunsetting spec", () => {
    expect(daysUntilSunset(catalog[1]!)).toBeNull();
  });

  it("isSunset returns true after sunsetAt", () => {
    expect(isSunset(catalog[0]!, new Date("2027-06-01T00:00:00Z"))).toBe(true);
  });

  it("isSunset returns false before sunsetAt", () => {
    expect(isSunset(catalog[0]!, new Date("2026-12-22T00:00:00Z"))).toBe(false);
  });

  it("versionForRequest returns stable when header is undefined", () => {
    expect(versionForRequest(catalog, undefined)?.version).toBe("v2");
  });

  it("versionForRequest returns the requested version", () => {
    expect(versionForRequest(catalog, "v1")?.version).toBe("v1");
  });

  it("versionForRequest returns null for unknown version", () => {
    expect(versionForRequest(catalog, "v99")).toBeNull();
  });
});
