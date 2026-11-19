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

/**
 * What a deployment knows about the installing tenant. Every fact is nullable and `null` means *this
 * deployment does not know*, which is a different statement from any value: a fabricated default is
 * the defect this shape exists to make unrepresentable, because a guessed `region` or `planTier`
 * admits an install the real value would refuse.
 */
export interface TenantContext {
  readonly platformVersion: string | null;
  readonly region: Region | null;
  readonly planTier: PlanTier | null;
  readonly compliancePacks: readonly CompliancePackId[] | null;
  readonly isDedicatedTenant: boolean | null;
}

export const TENANT_FACTS = [
  "platformVersion",
  "region",
  "planTier",
  "compliancePacks",
  "isDedicatedTenant",
] as const;
export type TenantFact = (typeof TENANT_FACTS)[number];

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
  /** Facts the pack constrains and the deployment could not supply; each is also a reason. */
  readonly undetermined: readonly TenantFact[];
}

/**
 * Whether a pack's envelope constrains each fact at all. An unknown fact refuses only where it is
 * constrained, so a pack that names no region installs on a deployment with no region, and one that
 * blocks a region does not install on a deployment that cannot say which region it is.
 */
function constrainedFacts(compat: PackCompatibility): ReadonlySet<TenantFact> {
  const out = new Set<TenantFact>();
  if (compareSemver(compat.minPlatformVersion, "0.0.0") > 0 || compat.maxPlatformVersion !== undefined) {
    out.add("platformVersion");
  }
  if (compat.allowedRegions.length > 0 || compat.blockedRegions.length > 0) out.add("region");
  if (compat.requiredPlanTier !== undefined && PLAN_TIER_RANK[compat.requiredPlanTier] > 0) out.add("planTier");
  if (compat.requiredCompliancePacks.length > 0) out.add("compliancePacks");
  if (compat.requiresDedicatedTenant) out.add("isDedicatedTenant");
  return out;
}

export function checkCompatibility(
  compat: PackCompatibility,
  context: TenantContext,
): CompatibilityResult {
  const reasons: string[] = [];
  const undetermined: TenantFact[] = [];
  const constrained = constrainedFacts(compat);
  for (const fact of TENANT_FACTS) {
    if (context[fact] === null && constrained.has(fact)) {
      undetermined.push(fact);
      reasons.push(`the pack constrains ${fact}, which this deployment does not know for the tenant`);
    }
  }
  const { platformVersion, region, planTier, compliancePacks, isDedicatedTenant } = context;
  if (platformVersion !== null) {
    if (compareSemver(platformVersion, compat.minPlatformVersion) < 0) {
      reasons.push(
        `platform version ${platformVersion} is below minPlatformVersion ${compat.minPlatformVersion}`,
      );
    }
    if (
      compat.maxPlatformVersion !== undefined &&
      compareSemver(platformVersion, compat.maxPlatformVersion) > 0
    ) {
      reasons.push(
        `platform version ${platformVersion} exceeds maxPlatformVersion ${compat.maxPlatformVersion}`,
      );
    }
  }
  if (region !== null) {
    if (compat.blockedRegions.includes(region)) {
      reasons.push(`region '${region}' is blocked`);
    }
    if (compat.allowedRegions.length > 0 && !compat.allowedRegions.includes(region)) {
      reasons.push(`region '${region}' is not in allowedRegions`);
    }
  }
  if (compat.requiredPlanTier !== undefined && planTier !== null) {
    const required = PLAN_TIER_RANK[compat.requiredPlanTier];
    const have = PLAN_TIER_RANK[planTier];
    if (have < required) {
      reasons.push(`plan tier '${planTier}' is below required '${compat.requiredPlanTier}'`);
    }
  }
  if (compliancePacks !== null) {
    const installedCompliance = new Set(compliancePacks);
    for (const c of compat.requiredCompliancePacks) {
      if (!installedCompliance.has(c)) {
        reasons.push(`compliance pack '${c}' is required but not installed`);
      }
    }
  }
  if (compat.requiresDedicatedTenant && isDedicatedTenant === false) {
    reasons.push("pack requires a dedicated tenant (single-tenant deployment)");
  }
  return {
    compatible: reasons.length === 0,
    reasons,
    undetermined,
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
