import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";
import { compareSemver, type PackManifest } from "./packs.js";

const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const PLAN_TIERS = [
  "trial",
  "base",
  "professional",
  "enterprise",
  "non_profit",
] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];
export const PlanTierSchema = z.enum(PLAN_TIERS);

export const COMPLIANCE_PACKS = [
  "hipaa",
  "gdpr",
  "uae_moh",
  "soc2",
  "iso_27001",
] as const;
export type CompliancePackId = (typeof COMPLIANCE_PACKS)[number];

export const PackCompatibilitySchema = z
  .object({
    minPlatformVersion: z.string().regex(SEMVER_REGEX),
    maxPlatformVersion: z.string().regex(SEMVER_REGEX).optional(),
    allowedRegions: z.array(RegionSchema).default([]),
    blockedRegions: z.array(RegionSchema).default([]),
    requiredPlanTier: PlanTierSchema.optional(),
    requiredCompliancePacks: z.array(z.enum(COMPLIANCE_PACKS)).default([]),
    requiresDedicatedTenant: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (
      v.maxPlatformVersion !== undefined &&
      compareSemver(v.maxPlatformVersion, v.minPlatformVersion) <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxPlatformVersion"],
        message: "maxPlatformVersion must be strictly greater than minPlatformVersion",
      });
    }
    const allowed = new Set(v.allowedRegions);
    for (const r of v.blockedRegions) {
      if (allowed.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blockedRegions"],
          message: `region '${r}' cannot appear in both allowedRegions and blockedRegions`,
        });
      }
    }
    const allowedDup = new Set<Region>();
    v.allowedRegions.forEach((r, i) => {
      if (allowedDup.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedRegions", i],
          message: `duplicate region '${r}'`,
        });
      }
      allowedDup.add(r);
    });
    const blockedDup = new Set<Region>();
    v.blockedRegions.forEach((r, i) => {
      if (blockedDup.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blockedRegions", i],
          message: `duplicate region '${r}'`,
        });
      }
      blockedDup.add(r);
    });
    const compDup = new Set<CompliancePackId>();
    v.requiredCompliancePacks.forEach((c, i) => {
      if (compDup.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredCompliancePacks", i],
          message: `duplicate compliance pack '${c}'`,
        });
      }
      compDup.add(c);
    });
  });
export type PackCompatibility = z.infer<typeof PackCompatibilitySchema>;

export interface TenantContext {
  readonly platformVersion: string;
  readonly region: Region;
  readonly planTier: PlanTier;
  readonly compliancePacks: readonly CompliancePackId[];
  readonly isDedicatedTenant: boolean;
}

export const PLAN_TIER_RANK: Readonly<Record<PlanTier, number>> = Object.freeze({
  trial: 0,
  non_profit: 1,
  base: 2,
  professional: 3,
  enterprise: 4,
});

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

export function checkCompatibility(
  compat: PackCompatibility,
  context: TenantContext,
): CompatibilityResult {
  const reasons: string[] = [];
  if (compareSemver(context.platformVersion, compat.minPlatformVersion) < 0) {
    reasons.push(
      `platform version ${context.platformVersion} is below minPlatformVersion ${compat.minPlatformVersion}`,
    );
  }
  if (
    compat.maxPlatformVersion !== undefined &&
    compareSemver(context.platformVersion, compat.maxPlatformVersion) > 0
  ) {
    reasons.push(
      `platform version ${context.platformVersion} exceeds maxPlatformVersion ${compat.maxPlatformVersion}`,
    );
  }
  if (compat.blockedRegions.includes(context.region)) {
    reasons.push(`region '${context.region}' is blocked`);
  }
  if (compat.allowedRegions.length > 0 && !compat.allowedRegions.includes(context.region)) {
    reasons.push(`region '${context.region}' is not in allowedRegions`);
  }
  if (compat.requiredPlanTier !== undefined) {
    const required = PLAN_TIER_RANK[compat.requiredPlanTier];
    const have = PLAN_TIER_RANK[context.planTier];
    if (have < required) {
      reasons.push(
        `plan tier '${context.planTier}' is below required '${compat.requiredPlanTier}'`,
      );
    }
  }
  const installedCompliance = new Set(context.compliancePacks);
  for (const c of compat.requiredCompliancePacks) {
    if (!installedCompliance.has(c)) {
      reasons.push(`compliance pack '${c}' is required but not installed`);
    }
  }
  if (compat.requiresDedicatedTenant && !context.isDedicatedTenant) {
    reasons.push("pack requires a dedicated tenant (single-tenant deployment)");
  }
  return {
    compatible: reasons.length === 0,
    reasons,
  };
}

export function packMatchesPlatform(
  manifest: PackManifest,
  platformVersion: string,
): boolean {
  if (compareSemver(platformVersion, manifest.minPlatformVersion) < 0) return false;
  if (
    manifest.maxPlatformVersion !== undefined &&
    compareSemver(platformVersion, manifest.maxPlatformVersion) > 0
  ) {
    return false;
  }
  return true;
}
