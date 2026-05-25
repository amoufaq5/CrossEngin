import { describe, expect, it } from "vitest";
import {
  ClientReleaseSchema,
  RELEASE_CHANNELS,
  RELEASE_STATUSES,
  SecurityAdvisorySchema,
  canTransitionRelease,
  hasCriticalAdvisory,
  highestSeverityAdvisory,
  isInstallable,
  type ClientRelease,
} from "./releases.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("RELEASE_CHANNELS has 4 entries", () => {
    expect(RELEASE_CHANNELS).toEqual(["stable", "beta", "rc", "nightly"]);
  });

  it("RELEASE_STATUSES has 5 entries", () => {
    expect(RELEASE_STATUSES).toContain("draft");
    expect(RELEASE_STATUSES).toContain("yanked");
  });
});

describe("canTransitionRelease", () => {
  it("draft -> in_review", () => {
    expect(canTransitionRelease("draft", "in_review")).toBe(true);
  });

  it("published -> deprecated", () => {
    expect(canTransitionRelease("published", "deprecated")).toBe(true);
  });

  it("yanked is terminal", () => {
    expect(canTransitionRelease("yanked", "published")).toBe(false);
  });

  it("draft -> published not allowed (must review)", () => {
    expect(canTransitionRelease("draft", "published")).toBe(false);
  });
});

describe("SecurityAdvisorySchema", () => {
  it("accepts with cveId", () => {
    expect(() =>
      SecurityAdvisorySchema.parse({
        cveId: "CVE-2026-1234",
        severity: "high",
        title: "Token leakage in logging",
        description: "Logs may contain bearer tokens",
        fixedInVersion: "1.2.3",
        affectedVersionsRange: "<1.2.3",
        publishedAt: "2026-05-15T10:00:00Z",
      }),
    ).not.toThrow();
  });

  it("rejects without cveId or ghsaId", () => {
    expect(() =>
      SecurityAdvisorySchema.parse({
        severity: "low",
        title: "x",
        description: "x",
        fixedInVersion: "1.2.3",
        affectedVersionsRange: "<1.2.3",
        publishedAt: "2026-05-15T10:00:00Z",
      }),
    ).toThrow(/cveId or ghsaId/);
  });

  it("rejects malformed CVE id", () => {
    expect(() =>
      SecurityAdvisorySchema.parse({
        cveId: "CVE-bad",
        severity: "low",
        title: "x",
        description: "x",
        fixedInVersion: "1.2.3",
        affectedVersionsRange: "<1.2.3",
        publishedAt: "2026-05-15T10:00:00Z",
      }),
    ).toThrow();
  });
});

describe("ClientReleaseSchema", () => {
  const base: ClientRelease = {
    id: "rel-1",
    language: "typescript",
    version: "1.2.0",
    apiVersion: "v1",
    channel: "stable",
    status: "published",
    artifactSha256: SHA,
    artifactSizeBytes: 500_000,
    registryPackageUri: "https://www.npmjs.com/package/@crossengin/sdk-typescript/v/1.2.0",
    generationRunId: "gen-1",
    publishedAt: "2026-05-15T10:00:00Z",
    publishedBy: "ci-bot",
    deprecatedAt: null,
    yankedAt: null,
    securityAdvisories: [],
    changelogUrl: "https://docs.crossengin.io/sdk/typescript/CHANGELOG.md#1.2.0",
    downloadCount: 0,
    breakingChanges: false,
  };

  it("accepts a valid published release", () => {
    expect(() => ClientReleaseSchema.parse(base)).not.toThrow();
  });

  it("rejects published without publishedBy", () => {
    expect(() => ClientReleaseSchema.parse({ ...base, publishedBy: null })).toThrow(/publishedBy/);
  });

  it("rejects deprecated without reason", () => {
    expect(() =>
      ClientReleaseSchema.parse({
        ...base,
        status: "deprecated",
        deprecatedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/deprecatedReason/);
  });

  it("rejects yanked without reason", () => {
    expect(() =>
      ClientReleaseSchema.parse({
        ...base,
        status: "yanked",
        yankedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/yankedReason/);
  });

  it("rejects stable channel with pre-release version", () => {
    expect(() => ClientReleaseSchema.parse({ ...base, version: "1.2.0-beta.1" })).toThrow(
      /plain semver/,
    );
  });

  it("rejects beta channel without pre-release", () => {
    expect(() => ClientReleaseSchema.parse({ ...base, channel: "beta" })).toThrow(/pre-release/);
  });

  it("rejects critical advisory on non-yanked/deprecated release", () => {
    expect(() =>
      ClientReleaseSchema.parse({
        ...base,
        securityAdvisories: [
          {
            ghsaId: "GHSA-abcd-efgh-ijkl",
            severity: "critical",
            title: "x",
            description: "x",
            fixedInVersion: "1.2.1",
            affectedVersionsRange: "<1.2.1",
            publishedAt: "2026-05-15T10:00:00Z",
          },
        ],
      }),
    ).toThrow(/must be yanked or deprecated/);
  });

  it("rejects breaking changes on stable 0.x", () => {
    expect(() =>
      ClientReleaseSchema.parse({
        ...base,
        version: "0.9.0",
        breakingChanges: true,
      }),
    ).toThrow(/0\.x/);
  });
});

describe("helpers", () => {
  const base: ClientRelease = {
    id: "rel-1",
    language: "python",
    version: "2.0.0",
    apiVersion: "v1",
    channel: "stable",
    status: "published",
    artifactSha256: SHA,
    artifactSizeBytes: 1000,
    registryPackageUri: "https://pypi.org/project/crossengin/2.0.0/",
    generationRunId: "gen-2",
    publishedAt: "2026-05-15T10:00:00Z",
    publishedBy: "ci-bot",
    deprecatedAt: null,
    yankedAt: null,
    securityAdvisories: [
      {
        ghsaId: "GHSA-abcd-efgh-ijkl",
        severity: "moderate",
        title: "x",
        description: "x",
        fixedInVersion: "2.0.1",
        affectedVersionsRange: "<2.0.1",
        publishedAt: "2026-05-15T10:00:00Z",
      },
    ],
    changelogUrl: "https://docs.crossengin.io/sdk/python/CHANGELOG.md",
    downloadCount: 0,
    breakingChanges: false,
  };

  it("hasCriticalAdvisory false for moderate", () => {
    expect(hasCriticalAdvisory(base)).toBe(false);
  });

  it("isInstallable true for published with non-critical advisories", () => {
    expect(isInstallable(base)).toBe(true);
  });

  it("isInstallable false for draft", () => {
    expect(isInstallable({ ...base, status: "draft" })).toBe(false);
  });

  it("isInstallable false for yanked", () => {
    expect(
      isInstallable({
        ...base,
        status: "yanked",
        yankedAt: "2026-06-01T00:00:00Z",
        yankedReason: "broken build",
      }),
    ).toBe(false);
  });

  it("highestSeverityAdvisory returns the maximum severity", () => {
    expect(highestSeverityAdvisory(base)).toBe("moderate");
  });

  it("highestSeverityAdvisory null for no advisories", () => {
    expect(highestSeverityAdvisory({ ...base, securityAdvisories: [] })).toBeNull();
  });
});
