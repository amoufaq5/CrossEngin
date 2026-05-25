import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
  DEPLOYMENT_TRIGGERS,
  DeploymentRecordSchema,
  RELEASE_CHANNELS,
  ReleaseSchema,
  canTransitionDeployment,
  latestRelease,
  rollbackTarget,
  semverComparator,
  type DeploymentRecord,
  type Release,
} from "./releases.js";

const SHA = "a".repeat(40);

describe("constants", () => {
  it("DEPLOYMENT_STATUSES has 6 entries", () => {
    expect(DEPLOYMENT_STATUSES).toHaveLength(6);
    expect(DEPLOYMENT_STATUSES).toContain("succeeded");
    expect(DEPLOYMENT_STATUSES).toContain("rolled_back");
  });

  it("DEPLOYMENT_TRIGGERS has 5 entries", () => {
    expect(DEPLOYMENT_TRIGGERS).toContain("merge_to_main");
    expect(DEPLOYMENT_TRIGGERS).toContain("rollback");
  });

  it("RELEASE_CHANNELS has 4 entries", () => {
    expect(RELEASE_CHANNELS).toEqual(["alpha", "beta", "stable", "lts"]);
  });
});

describe("DeploymentRecordSchema", () => {
  const base: DeploymentRecord = {
    id: "d1",
    appKind: "web",
    appId: "crossengin-web",
    environment: "production",
    region: "eu-central",
    target: "vercel",
    strategy: "atomic",
    version: "1.2.3",
    commitSha: SHA,
    artifactRef: "dpl_abc123",
    trigger: "merge_to_main",
    triggeredBy: "ci-bot",
    queuedAt: "2026-05-14T10:00:00Z",
    startedAt: "2026-05-14T10:00:10Z",
    completedAt: "2026-05-14T10:05:00Z",
    durationSeconds: 290,
    status: "succeeded",
    previousVersion: null,
    rolledBackToDeploymentId: null,
    healthCheckPassed: true,
    sentryReleaseId: null,
  };

  it("accepts a valid succeeded deployment", () => {
    expect(() => DeploymentRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects succeeded without completedAt", () => {
    expect(() => DeploymentRecordSchema.parse({ ...base, completedAt: null })).toThrow(
      /completedAt/,
    );
  });

  it("rejects rolled_back without rolledBackToDeploymentId", () => {
    expect(() =>
      DeploymentRecordSchema.parse({
        ...base,
        status: "rolled_back",
        rolledBackToDeploymentId: null,
      }),
    ).toThrow(/rolledBackToDeploymentId/);
  });

  it("rejects rollback trigger without previousVersion", () => {
    expect(() =>
      DeploymentRecordSchema.parse({
        ...base,
        trigger: "rollback",
        previousVersion: null,
      }),
    ).toThrow(/previousVersion/);
  });

  it("rejects an invalid commitSha", () => {
    expect(() => DeploymentRecordSchema.parse({ ...base, commitSha: "abc" })).toThrow();
  });

  it("rejects an invalid version", () => {
    expect(() => DeploymentRecordSchema.parse({ ...base, version: "v1" })).toThrow();
  });
});

describe("DEPLOYMENT_TRANSITIONS / canTransitionDeployment", () => {
  it("queued -> in_progress is valid", () => {
    expect(canTransitionDeployment("queued", "in_progress")).toBe(true);
  });

  it("in_progress -> succeeded is valid", () => {
    expect(canTransitionDeployment("in_progress", "succeeded")).toBe(true);
  });

  it("succeeded -> rolled_back is valid", () => {
    expect(canTransitionDeployment("succeeded", "rolled_back")).toBe(true);
  });

  it("rolled_back is terminal", () => {
    expect(DEPLOYMENT_TRANSITIONS.rolled_back).toEqual([]);
  });

  it("cancelled is terminal", () => {
    expect(DEPLOYMENT_TRANSITIONS.cancelled).toEqual([]);
  });

  it("queued -> succeeded is NOT allowed", () => {
    expect(canTransitionDeployment("queued", "succeeded")).toBe(false);
  });
});

describe("ReleaseSchema", () => {
  const base: Release = {
    version: "1.0.0",
    channel: "stable",
    publishedAt: "2026-01-01T00:00:00Z",
    commitSha: SHA,
    changelog: "Initial release",
    breakingChanges: false,
    apps: ["web"],
    deprecatesVersions: [],
    securityAdvisoriesFixed: [],
  };

  it("accepts a valid stable release", () => {
    expect(() => ReleaseSchema.parse(base)).not.toThrow();
  });

  it("rejects breakingChanges on 0.x stable", () => {
    expect(() => ReleaseSchema.parse({ ...base, version: "0.9.0", breakingChanges: true })).toThrow(
      /0\.x/,
    );
  });

  it("accepts breakingChanges on 1.x stable", () => {
    expect(() =>
      ReleaseSchema.parse({ ...base, version: "2.0.0", breakingChanges: true }),
    ).not.toThrow();
  });

  it("rejects an invalid GHSA identifier", () => {
    expect(() =>
      ReleaseSchema.parse({ ...base, securityAdvisoriesFixed: ["CVE-2024-1234"] }),
    ).toThrow();
  });

  it("accepts a valid GHSA identifier", () => {
    expect(() =>
      ReleaseSchema.parse({
        ...base,
        securityAdvisoriesFixed: ["GHSA-abcd-efgh-ijkl"],
      }),
    ).not.toThrow();
  });
});

describe("semverComparator", () => {
  it("returns negative when a < b", () => {
    expect(semverComparator("1.0.0", "1.1.0")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(semverComparator("2.0.0", "1.99.0")).toBeGreaterThan(0);
  });

  it("returns 0 when equal", () => {
    expect(semverComparator("1.2.3", "1.2.3")).toBe(0);
  });

  it("strips v prefix", () => {
    expect(semverComparator("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("latestRelease", () => {
  it("returns null for empty array", () => {
    expect(latestRelease([])).toBeNull();
  });

  it("returns the highest version", () => {
    const releases: Release[] = [
      {
        version: "1.0.0",
        channel: "stable",
        publishedAt: "2026-01-01T00:00:00Z",
        commitSha: SHA,
        changelog: "x",
        breakingChanges: false,
        apps: ["web"],
        deprecatesVersions: [],
        securityAdvisoriesFixed: [],
      },
      {
        version: "1.2.0",
        channel: "stable",
        publishedAt: "2026-02-01T00:00:00Z",
        commitSha: SHA,
        changelog: "x",
        breakingChanges: false,
        apps: ["web"],
        deprecatesVersions: [],
        securityAdvisoriesFixed: [],
      },
    ];
    expect(latestRelease(releases)?.version).toBe("1.2.0");
  });
});

describe("rollbackTarget", () => {
  const dep = (
    id: string,
    completedAt: string | null,
    status: DeploymentRecord["status"] = "succeeded",
  ): DeploymentRecord => ({
    id,
    appKind: "web",
    appId: "x",
    environment: "production",
    region: "eu-central",
    target: "vercel",
    strategy: "atomic",
    version: "1.0.0",
    commitSha: SHA,
    artifactRef: "dpl_x",
    trigger: "merge_to_main",
    triggeredBy: "u",
    queuedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt,
    durationSeconds: null,
    status,
    previousVersion: null,
    rolledBackToDeploymentId: null,
    healthCheckPassed: null,
    sentryReleaseId: null,
  });

  it("returns the previous successful deployment", () => {
    const history = [
      dep("a", "2026-01-01T00:00:00Z"),
      dep("b", "2026-02-01T00:00:00Z"),
      dep("c", "2026-03-01T00:00:00Z"),
    ];
    expect(rollbackTarget(history, "production", "web")?.id).toBe("b");
  });

  it("returns null when there's only one successful deployment", () => {
    const history = [dep("a", "2026-01-01T00:00:00Z")];
    expect(rollbackTarget(history, "production", "web")).toBeNull();
  });

  it("ignores deployments from other environments / app kinds", () => {
    const history = [
      dep("a", "2026-01-01T00:00:00Z"),
      { ...dep("b", "2026-02-01T00:00:00Z"), environment: "staging" as const },
    ];
    expect(rollbackTarget(history, "production", "web")).toBeNull();
  });
});
