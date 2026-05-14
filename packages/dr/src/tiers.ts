import { z } from "zod";

export const DR_TIERS = [
  "tier_0_mission_critical",
  "tier_1_business_critical",
  "tier_2_important",
  "tier_3_recoverable",
  "tier_4_best_effort",
] as const;
export type DrTier = (typeof DR_TIERS)[number];
export const DrTierSchema = z.enum(DR_TIERS);

export const REPLICATION_KINDS = ["sync", "async", "snapshot", "none"] as const;
export type ReplicationKind = (typeof REPLICATION_KINDS)[number];
export const ReplicationKindSchema = z.enum(REPLICATION_KINDS);

export const DATA_CLASSES = [
  "public",
  "internal",
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DrTierSpecSchema = z
  .object({
    tier: DrTierSchema,
    label: z.string().min(1),
    maxRpoSeconds: z.number().int().nonnegative(),
    maxRtoSeconds: z.number().int().nonnegative(),
    replicationKind: ReplicationKindSchema,
    backupFrequencySeconds: z.number().int().positive(),
    retentionDays: z.number().int().positive(),
    requiresCrossRegion: z.boolean(),
    requiresDrillCadenceDays: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    if (v.replicationKind === "sync" && v.maxRpoSeconds > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxRpoSeconds"],
        message: "sync replication implies zero RPO; set maxRpoSeconds=0",
      });
    }
    if (v.replicationKind === "none" && v.requiresCrossRegion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresCrossRegion"],
        message: "replicationKind='none' is incompatible with requiresCrossRegion=true",
      });
    }
    if (v.retentionDays * 86_400 < v.maxRpoSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionDays"],
        message: "retentionDays must cover at least one RPO window",
      });
    }
  });
export type DrTierSpec = z.infer<typeof DrTierSpecSchema>;

export const DEFAULT_DR_TIERS: Readonly<Record<DrTier, DrTierSpec>> = Object.freeze({
  tier_0_mission_critical: {
    tier: "tier_0_mission_critical",
    label: "Mission-critical (regulated, financial, life-safety)",
    maxRpoSeconds: 0,
    maxRtoSeconds: 60,
    replicationKind: "sync",
    backupFrequencySeconds: 900,
    retentionDays: 2555,
    requiresCrossRegion: true,
    requiresDrillCadenceDays: 30,
  },
  tier_1_business_critical: {
    tier: "tier_1_business_critical",
    label: "Business-critical (production workloads, PHI/PII)",
    maxRpoSeconds: 60,
    maxRtoSeconds: 900,
    replicationKind: "async",
    backupFrequencySeconds: 3600,
    retentionDays: 365,
    requiresCrossRegion: true,
    requiresDrillCadenceDays: 90,
  },
  tier_2_important: {
    tier: "tier_2_important",
    label: "Important (multi-tenant SaaS, commercial-sensitive)",
    maxRpoSeconds: 900,
    maxRtoSeconds: 3600,
    replicationKind: "async",
    backupFrequencySeconds: 14_400,
    retentionDays: 90,
    requiresCrossRegion: true,
    requiresDrillCadenceDays: 180,
  },
  tier_3_recoverable: {
    tier: "tier_3_recoverable",
    label: "Recoverable (internal tools, low-traffic)",
    maxRpoSeconds: 3600,
    maxRtoSeconds: 14_400,
    replicationKind: "snapshot",
    backupFrequencySeconds: 86_400,
    retentionDays: 30,
    requiresCrossRegion: false,
    requiresDrillCadenceDays: 365,
  },
  tier_4_best_effort: {
    tier: "tier_4_best_effort",
    label: "Best-effort (caches, ephemeral data)",
    maxRpoSeconds: 86_400,
    maxRtoSeconds: 86_400,
    replicationKind: "none",
    backupFrequencySeconds: 86_400,
    retentionDays: 7,
    requiresCrossRegion: false,
    requiresDrillCadenceDays: 365,
  },
});

export const DATA_CLASS_TIER: Readonly<Record<DataClass, DrTier>> = Object.freeze({
  public: "tier_3_recoverable",
  internal: "tier_2_important",
  commercial_sensitive: "tier_1_business_critical",
  pii: "tier_1_business_critical",
  phi: "tier_0_mission_critical",
  regulated: "tier_0_mission_critical",
});

export function tierForDataClass(dataClass: DataClass): DrTierSpec {
  const tier = DATA_CLASS_TIER[dataClass];
  return DEFAULT_DR_TIERS[tier];
}

export function tierMeetsTarget(
  spec: DrTierSpec,
  actualRpoSeconds: number,
  actualRtoSeconds: number,
): boolean {
  return actualRpoSeconds <= spec.maxRpoSeconds && actualRtoSeconds <= spec.maxRtoSeconds;
}
