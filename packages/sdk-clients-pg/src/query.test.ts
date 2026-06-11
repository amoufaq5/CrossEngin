import type { ClientRelease, CompatibilityEntry } from "@crossengin/sdk-clients";
import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  parseSdkReleasesArgs,
  runSdkReleases,
  verifySdkLedger,
  type SdkLedgerSource,
} from "./query.js";

function release(over: Partial<ClientRelease> = {}): ClientRelease {
  return {
    id: "rel-typescript-1.0.0",
    language: "typescript",
    version: "1.0.0",
    apiVersion: "v1",
    channel: "stable",
    status: "published",
    artifactSha256: "a".repeat(64),
    artifactSizeBytes: 4096,
    registryPackageUri: "https://registry.npmjs.org/@acme/c",
    generationRunId: "gen-typescript-abc",
    publishedAt: "2026-06-11T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000000",
    deprecatedAt: null,
    yankedAt: null,
    securityAdvisories: [],
    changelogUrl: "https://docs.acme.dev/cl",
    downloadCount: 0,
    breakingChanges: false,
    ...over,
  } as unknown as ClientRelease;
}

function compat(over: Partial<CompatibilityEntry> = {}): CompatibilityEntry {
  return {
    language: "typescript",
    clientVersion: "1.0.0",
    apiVersion: "v1",
    level: "fully_compatible",
    warningCount: 0,
    determinedAt: "2026-06-11T00:00:00.000Z",
    ...over,
  } as unknown as CompatibilityEntry;
}

function source(releases: readonly ClientRelease[], entries: readonly CompatibilityEntry[]): SdkLedgerSource {
  return {
    listReleases: async () => releases,
    listCompatibility: async () => entries,
  };
}

describe("verifySdkLedger", () => {
  it("is clean when every published release has a matching fully-compatible entry", () => {
    expect(verifySdkLedger([release()], [compat()])).toEqual([]);
  });

  it("flags a published release with no compatibility entry", () => {
    const issues = verifySdkLedger([release()], []);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("release_without_compatibility");
  });

  it("flags a compatibility entry with no matching release", () => {
    const issues = verifySdkLedger([], [compat()]);
    expect(issues.map((i) => i.kind)).toContain("compatibility_without_release");
  });

  it("flags a published release marked unsupported/blocked", () => {
    const issues = verifySdkLedger([release()], [compat({ level: "blocked", notes: "gone" } as Partial<CompatibilityEntry>)]);
    expect(issues.map((i) => i.kind)).toContain("published_release_incompatible");
  });

  it("ignores drafts (no compatibility required)", () => {
    expect(verifySdkLedger([release({ status: "draft", publishedAt: null, publishedBy: null } as Partial<ClientRelease>)], [])).toEqual([]);
  });
});

describe("parseSdkReleasesArgs", () => {
  it("parses list with filters", () => {
    const o = parseSdkReleasesArgs(["list", "--language", "go", "--status", "published", "--limit", "10", "--format", "json"]);
    expect(o).toMatchObject({ command: "list", language: "go", status: "published", limit: 10, format: "json", help: false });
  });

  it("parses compat + verify", () => {
    expect(parseSdkReleasesArgs(["compat", "--api-version", "v2"]).apiVersion).toBe("v2");
    expect(parseSdkReleasesArgs(["verify"]).command).toBe("verify");
  });

  it("rejects an unknown command + invalid enums + bad limit", () => {
    expect(() => parseSdkReleasesArgs(["nope"])).toThrow(CliUsageError);
    expect(() => parseSdkReleasesArgs(["list", "--language", "cobol"])).toThrow(CliUsageError);
    expect(() => parseSdkReleasesArgs(["list", "--limit", "0"])).toThrow(CliUsageError);
  });

  it("treats --help / no args as help", () => {
    expect(parseSdkReleasesArgs([]).help).toBe(true);
    expect(parseSdkReleasesArgs(["--help"]).help).toBe(true);
    expect(parseSdkReleasesArgs(["verify", "--help"]).help).toBe(true);
  });
});

describe("runSdkReleases", () => {
  it("list returns exit 0 + formatted output", async () => {
    const lines: string[] = [];
    const res = await runSdkReleases(
      { command: "list", language: null, channel: null, status: null, apiVersion: null, limit: null, format: "human", help: false },
      source([release()], []),
      (l) => lines.push(l),
    );
    expect(res.exitCode).toBe(0);
    expect(lines[0]).toContain("typescript 1.0.0 [stable/published]");
  });

  it("verify exits 1 on drift, 0 when clean", async () => {
    const opts = { command: "verify" as const, language: null, channel: null, status: null, apiVersion: null, limit: null, format: "human" as const, help: false };
    expect((await runSdkReleases(opts, source([release()], []), () => {})).exitCode).toBe(1);
    expect((await runSdkReleases(opts, source([release()], [compat()]), () => {})).exitCode).toBe(0);
  });
});
