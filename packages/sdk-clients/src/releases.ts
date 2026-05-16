import { z } from "zod";
import { TargetLanguageSchema } from "./languages.js";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const RELEASE_CHANNELS = ["stable", "beta", "rc", "nightly"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export const ReleaseChannelSchema = z.enum(RELEASE_CHANNELS);

export const RELEASE_STATUSES = [
  "draft",
  "in_review",
  "published",
  "deprecated",
  "yanked",
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const ReleaseStatusSchema = z.enum(RELEASE_STATUSES);

export const RELEASE_TRANSITIONS: Readonly<
  Record<ReleaseStatus, readonly ReleaseStatus[]>
> = Object.freeze({
  draft: ["in_review", "yanked"],
  in_review: ["published", "draft", "yanked"],
  published: ["deprecated", "yanked"],
  deprecated: ["yanked"],
  yanked: [],
});

export function canTransitionRelease(
  from: ReleaseStatus,
  to: ReleaseStatus,
): boolean {
  return RELEASE_TRANSITIONS[from].includes(to);
}

export const SECURITY_ADVISORY_SEVERITIES = [
  "low",
  "moderate",
  "high",
  "critical",
] as const;
export type SecurityAdvisorySeverity = (typeof SECURITY_ADVISORY_SEVERITIES)[number];

export const SecurityAdvisorySchema = z
  .object({
    cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/).optional(),
    ghsaId: z.string().regex(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/).optional(),
    severity: z.enum(SECURITY_ADVISORY_SEVERITIES),
    title: z.string().min(1),
    description: z.string().min(1),
    fixedInVersion: z.string().regex(SEMVER_REGEX),
    affectedVersionsRange: z.string().min(1),
    publishedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.cveId === undefined && v.ghsaId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cveId"],
        message: "security advisory requires either cveId or ghsaId",
      });
    }
  });
export type SecurityAdvisory = z.infer<typeof SecurityAdvisorySchema>;

export const ClientReleaseSchema = z
  .object({
    id: z.string().min(1),
    language: TargetLanguageSchema,
    version: z.string().regex(SEMVER_REGEX),
    apiVersion: z.string().min(1),
    channel: ReleaseChannelSchema,
    status: ReleaseStatusSchema,
    artifactSha256: z.string().regex(SHA256_REGEX),
    artifactSizeBytes: z.number().int().positive(),
    registryPackageUri: z.string().url(),
    generationRunId: z.string().min(1),
    publishedAt: Iso8601.nullable().default(null),
    publishedBy: z.string().min(1).nullable().default(null),
    deprecatedAt: Iso8601.nullable().default(null),
    deprecatedReason: z.string().min(1).optional(),
    deprecatedReplacedBy: z.string().regex(SEMVER_REGEX).optional(),
    yankedAt: Iso8601.nullable().default(null),
    yankedReason: z.string().min(1).optional(),
    securityAdvisories: z.array(SecurityAdvisorySchema).default([]),
    changelogUrl: z.string().url(),
    downloadCount: z.number().int().nonnegative().default(0),
    breakingChanges: z.boolean().default(false),
    minLanguageRuntimeVersion: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "published" || v.status === "deprecated" || v.status === "yanked") {
      if (v.publishedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedAt"],
          message: `status '${v.status}' requires publishedAt`,
        });
      }
      if (v.publishedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedBy"],
          message: `status '${v.status}' requires publishedBy`,
        });
      }
    }
    if (v.status === "deprecated") {
      if (v.deprecatedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedAt"],
          message: "deprecated status requires deprecatedAt",
        });
      }
      if (v.deprecatedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedReason"],
          message: "deprecated status requires deprecatedReason",
        });
      }
    }
    if (v.status === "yanked") {
      if (v.yankedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["yankedAt"],
          message: "yanked status requires yankedAt",
        });
      }
      if (v.yankedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["yankedReason"],
          message: "yanked status requires yankedReason",
        });
      }
    }
    const stable = v.channel === "stable";
    if (stable && (v.version.includes("-") || v.version.includes("+"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "stable channel requires plain semver (no pre-release or build metadata)",
      });
    }
    const prerelease = v.version.includes("-");
    if (v.channel === "beta" && !prerelease) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "beta channel requires pre-release version (e.g. '1.0.0-beta.1')",
      });
    }
    const critical = v.securityAdvisories.find((a) => a.severity === "critical");
    if (critical !== undefined && v.status !== "yanked" && v.status !== "deprecated") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "release with critical security advisory must be yanked or deprecated",
      });
    }
    if (v.breakingChanges && v.channel === "stable") {
      const major = Number.parseInt(v.version.replace(/^v/, "").split(".")[0] ?? "0", 10);
      if (major === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["channel"],
          message: "breaking changes on 0.x cannot ship on stable channel",
        });
      }
    }
  });
export type ClientRelease = z.infer<typeof ClientReleaseSchema>;

export function hasCriticalAdvisory(release: ClientRelease): boolean {
  return release.securityAdvisories.some((a) => a.severity === "critical");
}

export function isInstallable(release: ClientRelease): boolean {
  if (release.status === "yanked") return false;
  if (release.status === "draft") return false;
  if (release.status === "in_review") return false;
  if (hasCriticalAdvisory(release) && release.status !== "deprecated") return false;
  return true;
}

export function highestSeverityAdvisory(
  release: ClientRelease,
): SecurityAdvisorySeverity | null {
  const ranking: Readonly<Record<SecurityAdvisorySeverity, number>> = {
    low: 0,
    moderate: 1,
    high: 2,
    critical: 3,
  };
  let best: SecurityAdvisorySeverity | null = null;
  let bestRank = -1;
  for (const a of release.securityAdvisories) {
    const rank = ranking[a.severity];
    if (rank > bestRank) {
      bestRank = rank;
      best = a.severity;
    }
  }
  return best;
}
