import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const QUOTA_TIERS = ["free", "operate_base", "operate_premium", "regulated", "enterprise"] as const;
export type QuotaTier = (typeof QUOTA_TIERS)[number];

export const QUOTA_TIER_DEFAULT_BYTES: Readonly<Record<QuotaTier, number>> = Object.freeze({
  free: 1 * 1024 * 1024 * 1024,
  operate_base: 10 * 1024 * 1024 * 1024,
  operate_premium: 100 * 1024 * 1024 * 1024,
  regulated: 500 * 1024 * 1024 * 1024,
  enterprise: 5 * 1024 * 1024 * 1024 * 1024,
});

export const QuotaSchema = z.object({
  tenantId: z.string().min(1),
  tier: z.enum(QUOTA_TIERS),
  hardLimitBytes: z.number().int().nonnegative(),
  softWarnPercent: z.number().min(0).max(100).default(80),
  upgradePrompt: z.boolean().default(true),
});
export type Quota = z.infer<typeof QuotaSchema>;

export const TenantStorageUsageSchema = z.object({
  tenantId: z.string().min(1),
  measuredAt: Iso8601,
  totalBytes: z.number().int().nonnegative(),
  hotBytes: z.number().int().nonnegative().default(0),
  archiveBytes: z.number().int().nonnegative().default(0),
  coldBytes: z.number().int().nonnegative().default(0),
  fileCount: z.number().int().nonnegative(),
});
export type TenantStorageUsage = z.infer<typeof TenantStorageUsageSchema>;

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly reason: "ok" | "soft_warn" | "hard_limit";
  readonly usedBytes: number;
  readonly remainingBytes: number;
  readonly percentUsed: number;
}

export function checkQuota(
  quota: Quota,
  usage: TenantStorageUsage,
  incomingSize: number,
): QuotaCheckResult {
  if (incomingSize < 0) {
    throw new Error("incomingSize must be non-negative");
  }
  const projected = usage.totalBytes + incomingSize;
  const percentUsed = quota.hardLimitBytes === 0 ? 100 : (projected / quota.hardLimitBytes) * 100;
  const remainingBytes = Math.max(0, quota.hardLimitBytes - projected);
  if (projected > quota.hardLimitBytes) {
    return { allowed: false, reason: "hard_limit", usedBytes: projected, remainingBytes, percentUsed };
  }
  if (percentUsed >= quota.softWarnPercent) {
    return { allowed: true, reason: "soft_warn", usedBytes: projected, remainingBytes, percentUsed };
  }
  return { allowed: true, reason: "ok", usedBytes: projected, remainingBytes, percentUsed };
}
