import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS,
  ArtifactMetadataSchema,
  BuildArtifactSchema,
  artifactDigest,
  isReleasable,
  type BuildArtifact,
} from "./artifacts.js";

const SHA256 = "a".repeat(64);
const SHA = "b".repeat(40);

describe("ARTIFACT_KINDS", () => {
  it("has 7 entries", () => {
    expect(ARTIFACT_KINDS).toHaveLength(7);
    expect(ARTIFACT_KINDS).toContain("vercel_build");
    expect(ARTIFACT_KINDS).toContain("docker_image");
    expect(ARTIFACT_KINDS).toContain("ios_ipa");
  });
});

describe("BuildArtifactSchema — vercel_build", () => {
  it("accepts a minimal vercel deployment", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "vercel_build",
        deploymentId: "dpl_abc123XYZ",
      }),
    ).not.toThrow();
  });

  it("rejects a deployment id without the dpl_ prefix", () => {
    expect(() =>
      BuildArtifactSchema.parse({ kind: "vercel_build", deploymentId: "abc123" }),
    ).toThrow();
  });

  it("rejects buildCacheHitRate above 1", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "vercel_build",
        deploymentId: "dpl_a",
        buildCacheHitRate: 1.5,
      }),
    ).toThrow();
  });
});

describe("BuildArtifactSchema — docker_image", () => {
  it("accepts a valid GHCR image", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "docker_image",
        registry: "ghcr.io/crossengin/cdc-shipper",
        tag: "1.0.0",
        digest: `sha256:${SHA256}`,
        platforms: ["linux/amd64"],
      }),
    ).not.toThrow();
  });

  it("rejects the 'latest' tag", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "docker_image",
        registry: "ghcr.io/crossengin/cdc-shipper",
        tag: "latest",
        digest: `sha256:${SHA256}`,
        platforms: ["linux/amd64"],
      }),
    ).toThrow(/latest.*forbidden/);
  });

  it("rejects empty platforms array", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "docker_image",
        registry: "ghcr.io/crossengin/cdc-shipper",
        tag: "1.0.0",
        digest: `sha256:${SHA256}`,
        platforms: [],
      }),
    ).toThrow();
  });
});

describe("BuildArtifactSchema — helm_chart", () => {
  it("accepts a valid helm chart", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "helm_chart",
        chartName: "crossengin",
        chartVersion: "1.0.0",
        appVersion: "1.0.0",
        registry: "oci://ghcr.io/crossengin/charts",
        digest: `sha256:${SHA256}`,
      }),
    ).not.toThrow();
  });

  it("rejects a non-OCI registry", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "helm_chart",
        chartName: "crossengin",
        chartVersion: "1.0.0",
        appVersion: "1.0.0",
        registry: "https://example.com/charts",
        digest: `sha256:${SHA256}`,
      }),
    ).toThrow();
  });
});

describe("BuildArtifactSchema — ios_ipa", () => {
  it("accepts a valid iOS IPA", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "ios_ipa",
        bundleId: "com.crossengin.mobile",
        buildNumber: 42,
        version: "1.0.0",
        ipaSha256: SHA256,
        signedWith: "Apple Distribution: CrossEngin",
      }),
    ).not.toThrow();
  });

  it("rejects a bundleId with only two segments", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "ios_ipa",
        bundleId: "com.crossengin",
        buildNumber: 42,
        version: "1.0.0",
        ipaSha256: SHA256,
        signedWith: "x",
      }),
    ).toThrow(/three reverse-DNS segments/);
  });
});

describe("BuildArtifactSchema — android_aab", () => {
  it("accepts a valid AAB", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "android_aab",
        applicationId: "com.crossengin.mobile",
        versionCode: 100,
        versionName: "1.0.0",
        aabSha256: SHA256,
        signedWith: "upload-keystore",
      }),
    ).not.toThrow();
  });
});

describe("BuildArtifactSchema — source_map_bundle / documentation_site", () => {
  it("accepts source_map_bundle", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "source_map_bundle",
        appName: "web",
        uploadedToSentry: true,
        releaseId: "release-1",
        bundleSha256: SHA256,
      }),
    ).not.toThrow();
  });

  it("accepts documentation_site", () => {
    expect(() =>
      BuildArtifactSchema.parse({
        kind: "documentation_site",
        buildUrl: "https://docs.crossengin.io/v1",
        manifestSha256: SHA256,
      }),
    ).not.toThrow();
  });
});

describe("ArtifactMetadataSchema", () => {
  it("accepts a valid metadata record", () => {
    expect(() =>
      ArtifactMetadataSchema.parse({
        id: "build-1",
        artifact: {
          kind: "vercel_build",
          deploymentId: "dpl_abc",
        },
        builtAt: "2026-05-14T10:00:00Z",
        builtBy: "ci-bot",
        commitSha: SHA,
        branch: "main",
      }),
    ).not.toThrow();
  });
});

describe("artifactDigest", () => {
  it("returns the digest for docker_image", () => {
    const a: BuildArtifact = {
      kind: "docker_image",
      registry: "ghcr.io/x/y",
      tag: "1.0.0",
      digest: `sha256:${SHA256}`,
      platforms: ["linux/amd64"],
    };
    expect(artifactDigest(a)).toBe(`sha256:${SHA256}`);
  });

  it("returns the ipaSha256 for ios_ipa", () => {
    const a: BuildArtifact = {
      kind: "ios_ipa",
      bundleId: "com.x.y",
      buildNumber: 1,
      version: "1.0.0",
      ipaSha256: SHA256,
      signedWith: "x",
    };
    expect(artifactDigest(a)).toBe(SHA256);
  });

  it("returns null for vercel_build", () => {
    const a: BuildArtifact = { kind: "vercel_build", deploymentId: "dpl_x" };
    expect(artifactDigest(a)).toBeNull();
  });
});

describe("isReleasable", () => {
  it("returns true for non-docker artifacts", () => {
    expect(isReleasable({ kind: "vercel_build", deploymentId: "dpl_x" })).toBe(true);
  });

  it("returns true for docker_image with a non-latest tag", () => {
    expect(
      isReleasable({
        kind: "docker_image",
        registry: "ghcr.io/x/y",
        tag: "1.0.0",
        digest: `sha256:${SHA256}`,
        platforms: ["linux/amd64"],
      }),
    ).toBe(true);
  });
});
