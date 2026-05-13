import { describe, expect, it } from "vitest";
import {
  checkQuota,
  QUOTA_TIER_DEFAULT_BYTES,
  QUOTA_TIERS,
  QuotaSchema,
  TenantStorageUsageSchema,
} from "./quota.js";

describe("QuotaSchema / TenantStorageUsageSchema", () => {
  it("parses a quota", () => {
    const q = QuotaSchema.parse({
      tenantId: "t_1",
      tier: "operate_premium",
      hardLimitBytes: 100 * 1024 * 1024 * 1024,
    });
    expect(q.softWarnPercent).toBe(80);
    expect(q.upgradePrompt).toBe(true);
  });

  it("parses a usage row with phase split", () => {
    const u = TenantStorageUsageSchema.parse({
      tenantId: "t_1",
      measuredAt: "2026-05-13T00:00:00.000Z",
      totalBytes: 1_000_000,
      hotBytes: 800_000,
      archiveBytes: 200_000,
      coldBytes: 0,
      fileCount: 42,
    });
    expect(u.totalBytes).toBe(1_000_000);
  });

  it("rejects negative byte counts", () => {
    expect(() =>
      TenantStorageUsageSchema.parse({
        tenantId: "t",
        measuredAt: "2026-05-13T00:00:00.000Z",
        totalBytes: -1,
        fileCount: 0,
      }),
    ).toThrow();
  });
});

describe("QUOTA_TIER_DEFAULT_BYTES", () => {
  it("covers each tier with ascending limits", () => {
    let prev = 0;
    for (const t of QUOTA_TIERS) {
      const v = QUOTA_TIER_DEFAULT_BYTES[t];
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe("checkQuota", () => {
  const quota = QuotaSchema.parse({
    tenantId: "t_1",
    tier: "operate_base",
    hardLimitBytes: 1000,
  });
  const usage = TenantStorageUsageSchema.parse({
    tenantId: "t_1",
    measuredAt: "2026-05-13T00:00:00.000Z",
    totalBytes: 500,
    fileCount: 5,
  });

  it("ok when well within limits", () => {
    const r = checkQuota(quota, usage, 100);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.remainingBytes).toBe(400);
  });

  it("soft_warn when projected >= softWarnPercent", () => {
    const r = checkQuota(quota, usage, 300);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("soft_warn");
  });

  it("hard_limit when projected exceeds quota", () => {
    const r = checkQuota(quota, usage, 600);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("hard_limit");
    expect(r.remainingBytes).toBe(0);
  });

  it("rejects negative incoming size", () => {
    expect(() => checkQuota(quota, usage, -1)).toThrow();
  });
});
