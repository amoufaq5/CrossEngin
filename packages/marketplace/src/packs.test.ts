import { describe, expect, it } from "vitest";
import {
  PACK_AUTHOR_KINDS,
  PACK_KINDS,
  PACK_LICENSES,
  PackAuthorSchema,
  PackDependencySchema,
  PackManifestSchema,
  compareSemver,
  packAuthorTrusted,
  requiresElevatedReview,
  type PackAuthor,
  type PackManifest,
} from "./packs.js";

describe("constants", () => {
  it("PACK_KINDS has 8 entries", () => {
    expect(PACK_KINDS).toHaveLength(8);
    expect(PACK_KINDS).toContain("vertical_template");
    expect(PACK_KINDS).toContain("ai_tool");
    expect(PACK_KINDS).toContain("data_connector");
  });

  it("PACK_AUTHOR_KINDS has 4 entries", () => {
    expect(PACK_AUTHOR_KINDS).toEqual([
      "crossengin_official",
      "certified_partner",
      "community",
      "private_tenant",
    ]);
  });

  it("PACK_LICENSES covers OSS + commercial", () => {
    expect(PACK_LICENSES).toContain("MIT");
    expect(PACK_LICENSES).toContain("Apache-2.0");
    expect(PACK_LICENSES).toContain("proprietary");
  });
});

describe("PackAuthorSchema", () => {
  const community: PackAuthor = {
    kind: "community",
    name: "Jane Dev",
    verifiedAt: null,
  };

  it("accepts a community author without verifiedAt", () => {
    expect(() => PackAuthorSchema.parse(community)).not.toThrow();
  });

  it("rejects certified_partner without verifiedAt", () => {
    expect(() =>
      PackAuthorSchema.parse({
        ...community,
        kind: "certified_partner",
        verifiedAt: null,
      }),
    ).toThrow(/verifiedAt/);
  });

  it("rejects crossengin_official without verifiedAt", () => {
    expect(() =>
      PackAuthorSchema.parse({
        ...community,
        kind: "crossengin_official",
        verifiedAt: null,
      }),
    ).toThrow(/verifiedAt/);
  });
});

describe("PackDependencySchema", () => {
  it("accepts exact and ranged versions", () => {
    expect(() =>
      PackDependencySchema.parse({
        packId: "com.crossengin.dep",
        versionRange: "1.2.3",
      }),
    ).not.toThrow();
    expect(() =>
      PackDependencySchema.parse({
        packId: "com.crossengin.dep",
        versionRange: "^1.2.0",
      }),
    ).not.toThrow();
    expect(() =>
      PackDependencySchema.parse({
        packId: "com.crossengin.dep",
        versionRange: "~1.2.0",
      }),
    ).not.toThrow();
  });

  it("rejects malformed versionRange", () => {
    expect(() =>
      PackDependencySchema.parse({
        packId: "com.crossengin.dep",
        versionRange: ">=1.0.0",
      }),
    ).toThrow();
  });
});

describe("PackManifestSchema", () => {
  const base: PackManifest = {
    id: "com.crossengin.pharmacy",
    name: "Pharmacy Vertical",
    description: "Pharmacy starter pack",
    kind: "vertical_template",
    author: {
      kind: "crossengin_official",
      name: "CrossEngin",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    license: "crossengin-commercial",
    keywords: ["pharmacy", "healthcare"],
    requiredScopes: ["manifests:read"],
    optionalScopes: [],
    dependencies: [],
    minPlatformVersion: "1.0.0",
    requiresNetworkAccess: false,
    requiresPhiAccess: false,
    handlesUserData: true,
  };

  it("accepts a valid manifest", () => {
    expect(() => PackManifestSchema.parse(base)).not.toThrow();
  });

  it("rejects malformed pack id", () => {
    expect(() =>
      PackManifestSchema.parse({ ...base, id: "Pharmacy" }),
    ).toThrow();
  });

  it("rejects duplicate scopes within required", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        requiredScopes: ["manifests:read", "manifests:read"],
      }),
    ).toThrow(/duplicates/);
  });

  it("rejects scope that's both required and optional", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        optionalScopes: ["manifests:read"],
      }),
    ).toThrow(/cannot appear in both/);
  });

  it("rejects self-dependency", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        dependencies: [
          { packId: base.id, versionRange: "1.0.0", optional: false },
        ],
      }),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects duplicate dependencies", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        dependencies: [
          { packId: "com.crossengin.dep", versionRange: "1.0.0", optional: false },
          { packId: "com.crossengin.dep", versionRange: "2.0.0", optional: false },
        ],
      }),
    ).toThrow(/duplicate dependency/);
  });

  it("rejects duplicate keywords", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        keywords: ["pharmacy", "pharmacy"],
      }),
    ).toThrow(/duplicate keyword/);
  });

  it("rejects requiresPhiAccess without handlesUserData", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        requiresPhiAccess: true,
        handlesUserData: false,
      }),
    ).toThrow(/handlesUserData=true/);
  });

  it("rejects community author requesting PHI access", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        author: { kind: "community", name: "x", verifiedAt: null },
        requiresPhiAccess: true,
        handlesUserData: true,
      }),
    ).toThrow(/community-authored packs cannot request PHI/);
  });

  it("rejects maxPlatformVersion <= minPlatformVersion", () => {
    expect(() =>
      PackManifestSchema.parse({
        ...base,
        minPlatformVersion: "2.0.0",
        maxPlatformVersion: "1.0.0",
      }),
    ).toThrow(/must be greater than minPlatformVersion/);
  });
});

describe("compareSemver", () => {
  it("compares major versions", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  it("compares minor versions when major equal", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
  });

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("strips v prefix", () => {
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("helpers", () => {
  it("packAuthorTrusted returns true for official + certified", () => {
    expect(
      packAuthorTrusted({
        kind: "crossengin_official",
        name: "x",
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      packAuthorTrusted({
        kind: "certified_partner",
        name: "x",
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(true);
    expect(packAuthorTrusted({ kind: "community", name: "x", verifiedAt: null })).toBe(false);
  });

  it("requiresElevatedReview flags PHI access", () => {
    const manifest: PackManifest = {
      id: "com.crossengin.x",
      name: "x",
      description: "x",
      kind: "data_connector",
      author: {
        kind: "crossengin_official",
        name: "x",
        verifiedAt: "2026-01-01T00:00:00Z",
      },
      license: "crossengin-commercial",
      keywords: [],
      requiredScopes: ["files:read"],
      optionalScopes: [],
      dependencies: [],
      minPlatformVersion: "1.0.0",
      requiresNetworkAccess: false,
      requiresPhiAccess: true,
      handlesUserData: true,
    };
    expect(requiresElevatedReview(manifest)).toBe(true);
  });

  it("requiresElevatedReview flags admin scopes", () => {
    const manifest: PackManifest = {
      id: "com.crossengin.x",
      name: "x",
      description: "x",
      kind: "ai_tool",
      author: {
        kind: "crossengin_official",
        name: "x",
        verifiedAt: "2026-01-01T00:00:00Z",
      },
      license: "MIT",
      keywords: [],
      requiredScopes: ["tenants:admin"],
      optionalScopes: [],
      dependencies: [],
      minPlatformVersion: "1.0.0",
      requiresNetworkAccess: false,
      requiresPhiAccess: false,
      handlesUserData: false,
    };
    expect(requiresElevatedReview(manifest)).toBe(true);
  });

  it("requiresElevatedReview flags untrusted authors", () => {
    const manifest: PackManifest = {
      id: "com.crossengin.x",
      name: "x",
      description: "x",
      kind: "theme",
      author: { kind: "community", name: "x", verifiedAt: null },
      license: "MIT",
      keywords: [],
      requiredScopes: ["files:read"],
      optionalScopes: [],
      dependencies: [],
      minPlatformVersion: "1.0.0",
      requiresNetworkAccess: false,
      requiresPhiAccess: false,
      handlesUserData: false,
    };
    expect(requiresElevatedReview(manifest)).toBe(true);
  });
});
