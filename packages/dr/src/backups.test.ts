import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS } from "./tiers.js";
import {
  BACKUP_KINDS,
  BACKUP_STATUSES,
  BackupPolicySchema,
  BackupRecordSchema,
  backupSatisfiesTier,
  canTransitionBackup,
  expiredBackups,
  isBackupExpired,
  isBackupVerified,
  type BackupPolicy,
  type BackupRecord,
} from "./backups.js";

const SHA256 = "a".repeat(64);

describe("constants", () => {
  it("BACKUP_KINDS has 5 entries", () => {
    expect(BACKUP_KINDS).toHaveLength(5);
    expect(BACKUP_KINDS).toContain("full");
    expect(BACKUP_KINDS).toContain("wal_archive");
  });

  it("BACKUP_STATUSES has 6 entries", () => {
    expect(BACKUP_STATUSES).toHaveLength(6);
    expect(BACKUP_STATUSES).toContain("verified");
    expect(BACKUP_STATUSES).toContain("expired");
  });
});

describe("canTransitionBackup", () => {
  it("scheduled -> running is valid", () => {
    expect(canTransitionBackup("scheduled", "running")).toBe(true);
  });

  it("succeeded -> verified is valid", () => {
    expect(canTransitionBackup("succeeded", "verified")).toBe(true);
  });

  it("verified -> expired is valid", () => {
    expect(canTransitionBackup("verified", "expired")).toBe(true);
  });

  it("failed is terminal", () => {
    expect(canTransitionBackup("failed", "scheduled")).toBe(false);
  });

  it("scheduled -> succeeded skips running", () => {
    expect(canTransitionBackup("scheduled", "succeeded")).toBe(false);
  });
});

describe("BackupPolicySchema", () => {
  const base: BackupPolicy = {
    id: "policy-1",
    kind: "full",
    tier: "tier_1_business_critical",
    cron: "0 2 * * *",
    timezone: "UTC",
    retentionDays: 365,
    encryptionKeyId: "key-1",
    storageRegion: "eu-central",
    crossRegionCopyTo: ["eu-west", "us-east"],
    requiresVerification: true,
  };

  it("accepts a valid policy", () => {
    expect(() => BackupPolicySchema.parse(base)).not.toThrow();
  });

  it("rejects crossRegionCopyTo that includes storageRegion", () => {
    expect(() =>
      BackupPolicySchema.parse({
        ...base,
        crossRegionCopyTo: ["eu-central", "us-east"],
      }),
    ).toThrow(/cannot include storageRegion/);
  });

  it("rejects duplicate cross-region targets", () => {
    expect(() =>
      BackupPolicySchema.parse({
        ...base,
        crossRegionCopyTo: ["eu-west", "eu-west"],
      }),
    ).toThrow(/duplicate region/);
  });

  it("rejects malformed cron", () => {
    expect(() =>
      BackupPolicySchema.parse({ ...base, cron: "0 2" }),
    ).toThrow(/5 whitespace-separated fields/);
  });
});

describe("BackupRecordSchema", () => {
  const base: BackupRecord = {
    id: "br-1",
    policyId: "policy-1",
    kind: "full",
    startedAt: "2026-05-14T02:00:00Z",
    completedAt: "2026-05-14T02:15:00Z",
    durationSeconds: 900,
    status: "succeeded",
    sizeBytes: 1_000_000_000,
    sha256: SHA256,
    storageRegion: "eu-central",
    copiedToRegions: ["eu-west"],
    verifiedAt: null,
    verifiedBy: null,
    expiresAt: "2027-05-14T02:00:00Z",
  };

  it("accepts a valid succeeded record", () => {
    expect(() => BackupRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects succeeded without sha256", () => {
    expect(() =>
      BackupRecordSchema.parse({ ...base, sha256: null }),
    ).toThrow(/sha256/);
  });

  it("rejects succeeded without sizeBytes", () => {
    expect(() =>
      BackupRecordSchema.parse({ ...base, sizeBytes: null }),
    ).toThrow(/sizeBytes/);
  });

  it("rejects verified without verifiedAt", () => {
    expect(() =>
      BackupRecordSchema.parse({
        ...base,
        status: "verified",
      }),
    ).toThrow(/verifiedAt/);
  });

  it("accepts a verified record with verifiedAt + verifiedBy", () => {
    expect(() =>
      BackupRecordSchema.parse({
        ...base,
        status: "verified",
        verifiedAt: "2026-05-14T03:00:00Z",
        verifiedBy: "ci-bot",
      }),
    ).not.toThrow();
  });

  it("rejects failed without errorMessage", () => {
    expect(() =>
      BackupRecordSchema.parse({ ...base, status: "failed" }),
    ).toThrow(/errorMessage/);
  });

  it("rejects expiresAt <= startedAt", () => {
    expect(() =>
      BackupRecordSchema.parse({
        ...base,
        expiresAt: "2026-05-14T02:00:00Z",
      }),
    ).toThrow(/expiresAt must be after/);
  });
});

describe("helpers", () => {
  const verified: BackupRecord = {
    id: "br-1",
    policyId: "policy-1",
    kind: "full",
    startedAt: "2026-05-14T02:00:00Z",
    completedAt: "2026-05-14T02:15:00Z",
    durationSeconds: 900,
    status: "verified",
    sizeBytes: 1_000_000_000,
    sha256: SHA256,
    storageRegion: "eu-central",
    copiedToRegions: ["eu-west"],
    verifiedAt: "2026-05-14T03:00:00Z",
    verifiedBy: "ci-bot",
    expiresAt: "2027-05-14T02:00:00Z",
  };

  it("isBackupVerified returns true for verified status", () => {
    expect(isBackupVerified(verified)).toBe(true);
  });

  it("isBackupExpired returns false before expiresAt", () => {
    expect(isBackupExpired(verified, new Date("2027-05-13T00:00:00Z"))).toBe(false);
  });

  it("isBackupExpired returns true after expiresAt", () => {
    expect(isBackupExpired(verified, new Date("2027-05-15T00:00:00Z"))).toBe(true);
  });

  it("expiredBackups filters expired records", () => {
    expect(
      expiredBackups([verified], new Date("2027-05-15T00:00:00Z")).map((r) => r.id),
    ).toEqual(["br-1"]);
    expect(
      expiredBackups([verified], new Date("2027-05-13T00:00:00Z")),
    ).toEqual([]);
  });

  it("backupSatisfiesTier returns true when policy meets tier", () => {
    const policy: BackupPolicy = {
      id: "p-1",
      kind: "full",
      tier: "tier_1_business_critical",
      cron: "0 2 * * *",
      timezone: "UTC",
      retentionDays: 365,
      encryptionKeyId: "k-1",
      storageRegion: "eu-central",
      crossRegionCopyTo: ["eu-west"],
      requiresVerification: true,
    };
    expect(backupSatisfiesTier(policy, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(true);
  });

  it("backupSatisfiesTier returns false when retention is shorter than required", () => {
    const policy: BackupPolicy = {
      id: "p-1",
      kind: "full",
      tier: "tier_1_business_critical",
      cron: "0 2 * * *",
      timezone: "UTC",
      retentionDays: 30,
      encryptionKeyId: "k-1",
      storageRegion: "eu-central",
      crossRegionCopyTo: ["eu-west"],
      requiresVerification: true,
    };
    expect(backupSatisfiesTier(policy, DEFAULT_DR_TIERS.tier_1_business_critical)).toBe(false);
  });

  it("backupSatisfiesTier returns false when cross-region missing for tier-0", () => {
    const policy: BackupPolicy = {
      id: "p-0",
      kind: "full",
      tier: "tier_0_mission_critical",
      cron: "*/15 * * * *",
      timezone: "UTC",
      retentionDays: 2555,
      encryptionKeyId: "k-1",
      storageRegion: "eu-central",
      crossRegionCopyTo: [],
      requiresVerification: true,
    };
    expect(backupSatisfiesTier(policy, DEFAULT_DR_TIERS.tier_0_mission_critical)).toBe(false);
  });
});
