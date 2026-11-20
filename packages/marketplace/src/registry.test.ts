import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_CHANNELS,
  PACK_RELEASE_FORM,
  PACK_VERSION_STATUSES,
  PackVersionListSchema,
  PackVersionRecordSchema,
  canTransitionVersion,
  latestPublishedVersion,
  versionsRequiringResign,
  type PackVersionRecord,
} from "./registry.js";

const SHA = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

describe("constants", () => {
  it("PACK_VERSION_STATUSES has 5 entries", () => {
    expect(PACK_VERSION_STATUSES).toEqual([
      "draft",
      "in_review",
      "published",
      "deprecated",
      "withdrawn",
    ]);
  });

  it("DISTRIBUTION_CHANNELS has 4 entries", () => {
    expect(DISTRIBUTION_CHANNELS).toEqual(["stable", "beta", "canary", "internal"]);
  });
});

describe("canTransitionVersion", () => {
  it("draft -> in_review", () => {
    expect(canTransitionVersion("draft", "in_review")).toBe(true);
  });

  it("in_review -> published", () => {
    expect(canTransitionVersion("in_review", "published")).toBe(true);
  });

  it("published -> deprecated", () => {
    expect(canTransitionVersion("published", "deprecated")).toBe(true);
  });

  it("withdrawn is terminal", () => {
    expect(canTransitionVersion("withdrawn", "draft")).toBe(false);
  });

  it("draft -> published is not allowed (must review first)", () => {
    expect(canTransitionVersion("draft", "published")).toBe(false);
  });
});

describe("PackVersionRecordSchema", () => {
  const base: PackVersionRecord = {
    packId: "com.crossengin.x",
    version: "1.0.0",
    status: "published",
    channel: "stable",
    bundleSha256: SHA,
    bundleSizeBytes: 1_000_000,
    manifestSha256: SHA,
    signature: {
      algorithm: "ed25519",
      publicKeyFingerprint: FINGERPRINT,
      signature: "QUJDREVGRw==",
      signedAt: "2026-05-14T10:00:00Z",
    },
    publishedAt: "2026-05-14T10:30:00Z",
    publishedBy: "publisher-1",
    deprecatedAt: null,
    withdrawnAt: null,
    securityReviewStatus: "passed",
    securityReviewedAt: "2026-05-14T09:00:00Z",
    securityReviewer: "reviewer-1",
    changelog: "Initial release",
  };

  it("accepts a valid published version", () => {
    expect(() => PackVersionRecordSchema.parse(base)).not.toThrow();
  });

  describe("against the release its signature names", () => {
    const release = {
      form: PACK_RELEASE_FORM,
      packId: base.packId,
      version: base.version,
      manifestSha256: base.manifestSha256,
      bundleSha256: base.bundleSha256,
    };
    const withRelease = { ...base, signature: { ...base.signature, release } };

    it("accepts a row that agrees with its signed release", () => {
      expect(() => PackVersionRecordSchema.parse(withRelease)).not.toThrow();
    });

    it.each([
      ["packId", { packId: "com.crossengin.y" }],
      ["version", { version: "9.9.9" }],
      ["manifestSha256", { manifestSha256: "c".repeat(64) }],
      ["bundleSha256", { bundleSha256: "d".repeat(64) }],
    ] as const)("refuses a row whose %s was edited after signing", (field, patch) => {
      const result = PackVersionRecordSchema.safeParse({ ...withRelease, ...patch });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0])).toContain(field);
    });

    it("refuses a release in a form this build does not know", () => {
      const result = PackVersionRecordSchema.safeParse({
        ...withRelease,
        signature: { ...withRelease.signature, release: { ...release, form: "crossengin.pack.release.v2" } },
      });
      expect(result.success).toBe(false);
    });
  });

  it("rejects published without publishedAt", () => {
    expect(() =>
      PackVersionRecordSchema.parse({ ...base, publishedAt: null }),
    ).toThrow(/publishedAt/);
  });

  it("rejects published on stable channel without passed/exempt review", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        securityReviewStatus: "pending",
        securityReviewedAt: null,
        securityReviewer: null,
      }),
    ).toThrow(/securityReviewStatus='passed' or 'exempt'/);
  });

  it("accepts beta channel without passing review", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        channel: "beta",
        securityReviewStatus: "pending",
        securityReviewedAt: null,
        securityReviewer: null,
      }),
    ).not.toThrow();
  });

  it("rejects deprecated without deprecatedAt + reason", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        status: "deprecated",
      }),
    ).toThrow(/deprecatedAt/);
  });

  it("rejects withdrawn without withdrawnAt + reason", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        status: "withdrawn",
      }),
    ).toThrow(/withdrawnAt/);
  });

  it("rejects security review 'passed' without reviewedAt + reviewer", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        securityReviewStatus: "passed",
        securityReviewedAt: null,
        securityReviewer: null,
      }),
    ).toThrow(/securityReviewedAt/);
  });

  it("rejects published with failed security review", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        securityReviewStatus: "failed",
      }),
    ).toThrow(/failed security review/);
  });

  it("rejects supersededBy pointing to an older version", () => {
    expect(() =>
      PackVersionRecordSchema.parse({
        ...base,
        version: "2.0.0",
        supersededBy: "1.0.0",
      }),
    ).toThrow(/strictly newer version/);
  });
});

describe("PackVersionListSchema", () => {
  const v = (version: string): PackVersionRecord => ({
    packId: "com.crossengin.x",
    version,
    status: "published",
    channel: "stable",
    bundleSha256: SHA,
    bundleSizeBytes: 1_000,
    manifestSha256: SHA,
    signature: {
      algorithm: "ed25519",
      publicKeyFingerprint: FINGERPRINT,
      signature: "QQ==",
      signedAt: "2026-05-14T10:00:00Z",
    },
    publishedAt: "2026-05-14T10:30:00Z",
    publishedBy: "p",
    deprecatedAt: null,
    withdrawnAt: null,
    securityReviewStatus: "passed",
    securityReviewedAt: "2026-05-14T09:00:00Z",
    securityReviewer: "r",
    changelog: "x",
  });

  it("accepts distinct versions for one pack", () => {
    expect(() =>
      PackVersionListSchema.parse([v("1.0.0"), v("1.1.0")]),
    ).not.toThrow();
  });

  it("rejects duplicate versions", () => {
    expect(() =>
      PackVersionListSchema.parse([v("1.0.0"), v("1.0.0")]),
    ).toThrow(/duplicate version/);
  });

  it("rejects mixed pack ids", () => {
    expect(() =>
      PackVersionListSchema.parse([
        v("1.0.0"),
        { ...v("1.1.0"), packId: "com.crossengin.y" },
      ]),
    ).toThrow(/mixed ids/);
  });
});

describe("latestPublishedVersion", () => {
  const v = (version: string, channel: "stable" | "beta" = "stable"): PackVersionRecord => ({
    packId: "com.crossengin.x",
    version,
    status: "published",
    channel,
    bundleSha256: SHA,
    bundleSizeBytes: 1_000,
    manifestSha256: SHA,
    signature: {
      algorithm: "ed25519",
      publicKeyFingerprint: FINGERPRINT,
      signature: "QQ==",
      signedAt: "2026-05-14T10:00:00Z",
    },
    publishedAt: "2026-05-14T10:30:00Z",
    publishedBy: "p",
    deprecatedAt: null,
    withdrawnAt: null,
    securityReviewStatus: "passed",
    securityReviewedAt: "2026-05-14T09:00:00Z",
    securityReviewer: "r",
    changelog: "x",
  });

  it("returns the highest semver", () => {
    expect(
      latestPublishedVersion([v("1.0.0"), v("2.0.0"), v("1.5.0")])?.version,
    ).toBe("2.0.0");
  });

  it("filters by channel", () => {
    expect(
      latestPublishedVersion([v("1.0.0", "stable"), v("2.0.0-rc.1", "beta")], "stable")?.version,
    ).toBe("1.0.0");
  });

  it("returns null when nothing is published", () => {
    expect(latestPublishedVersion([])).toBeNull();
  });
});

describe("versionsRequiringResign", () => {
  it("identifies versions signed with the rotated key", () => {
    const records: PackVersionRecord[] = [
      {
        packId: "com.crossengin.x",
        version: "1.0.0",
        status: "published",
        channel: "stable",
        bundleSha256: SHA,
        bundleSizeBytes: 100,
        manifestSha256: SHA,
        signature: {
          algorithm: "ed25519",
          publicKeyFingerprint: FINGERPRINT,
          signature: "QQ==",
          signedAt: "2026-05-14T10:00:00Z",
        },
        publishedAt: "2026-05-14T10:30:00Z",
        publishedBy: "p",
        deprecatedAt: null,
        withdrawnAt: null,
        securityReviewStatus: "passed",
        securityReviewedAt: "2026-05-14T09:00:00Z",
        securityReviewer: "r",
        changelog: "x",
      },
    ];
    expect(versionsRequiringResign(records, FINGERPRINT)).toHaveLength(1);
    expect(versionsRequiringResign(records, "c".repeat(64))).toHaveLength(0);
  });
});
