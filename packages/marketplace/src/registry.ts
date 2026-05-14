import { z } from "zod";
import { compareSemver } from "./packs.js";

const Iso8601 = z.string().datetime({ offset: true });
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const PACK_ID_REGEX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;

export const PACK_VERSION_STATUSES = [
  "draft",
  "in_review",
  "published",
  "deprecated",
  "withdrawn",
] as const;
export type PackVersionStatus = (typeof PACK_VERSION_STATUSES)[number];
export const PackVersionStatusSchema = z.enum(PACK_VERSION_STATUSES);

export const PACK_VERSION_TRANSITIONS: Readonly<
  Record<PackVersionStatus, readonly PackVersionStatus[]>
> = Object.freeze({
  draft: ["in_review", "withdrawn"],
  in_review: ["published", "withdrawn", "draft"],
  published: ["deprecated", "withdrawn"],
  deprecated: ["withdrawn"],
  withdrawn: [],
});

export function canTransitionVersion(
  from: PackVersionStatus,
  to: PackVersionStatus,
): boolean {
  return PACK_VERSION_TRANSITIONS[from].includes(to);
}

export const DISTRIBUTION_CHANNELS = ["stable", "beta", "canary", "internal"] as const;
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number];
export const DistributionChannelSchema = z.enum(DISTRIBUTION_CHANNELS);

export const SECURITY_REVIEW_STATUSES = [
  "pending",
  "in_progress",
  "passed",
  "failed",
  "exempt",
] as const;
export type SecurityReviewStatus = (typeof SECURITY_REVIEW_STATUSES)[number];

export const PackSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    publicKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/, {
      message: "publicKeyFingerprint must be a sha256 hex (64 chars)",
    }),
    signature: z.string().regex(/^[A-Za-z0-9+/]+=*$/, {
      message: "signature must be base64-encoded",
    }),
    signedAt: Iso8601,
  })
  .strict();
export type PackSignature = z.infer<typeof PackSignatureSchema>;

export const PackVersionRecordSchema = z
  .object({
    packId: z.string().regex(PACK_ID_REGEX),
    version: z.string().regex(SEMVER_REGEX),
    status: PackVersionStatusSchema,
    channel: DistributionChannelSchema,
    bundleSha256: z.string().regex(SHA256_REGEX),
    bundleSizeBytes: z.number().int().positive(),
    manifestSha256: z.string().regex(SHA256_REGEX),
    signature: PackSignatureSchema,
    publishedAt: Iso8601.nullable().default(null),
    publishedBy: z.string().min(1).nullable().default(null),
    deprecatedAt: Iso8601.nullable().default(null),
    deprecatedReason: z.string().min(1).optional(),
    withdrawnAt: Iso8601.nullable().default(null),
    withdrawnReason: z.string().min(1).optional(),
    supersededBy: z.string().regex(SEMVER_REGEX).optional(),
    securityReviewStatus: z.enum(SECURITY_REVIEW_STATUSES).default("pending"),
    securityReviewedAt: Iso8601.nullable().default(null),
    securityReviewer: z.string().min(1).nullable().default(null),
    changelog: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.status === "published") {
      if (v.publishedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedAt"],
          message: "published versions must declare publishedAt",
        });
      }
      if (v.publishedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedBy"],
          message: "published versions must declare publishedBy",
        });
      }
      const trustedReview =
        v.securityReviewStatus === "passed" || v.securityReviewStatus === "exempt";
      if (!trustedReview && v.channel === "stable") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["securityReviewStatus"],
          message:
            "published versions on the 'stable' channel require securityReviewStatus='passed' or 'exempt'",
        });
      }
    }
    if (v.status === "deprecated") {
      if (v.deprecatedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedAt"],
          message: "deprecated versions must declare deprecatedAt",
        });
      }
      if (v.deprecatedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deprecatedReason"],
          message: "deprecated versions must declare deprecatedReason",
        });
      }
    }
    if (v.status === "withdrawn") {
      if (v.withdrawnAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["withdrawnAt"],
          message: "withdrawn versions must declare withdrawnAt",
        });
      }
      if (v.withdrawnReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["withdrawnReason"],
          message: "withdrawn versions must declare withdrawnReason",
        });
      }
    }
    if (
      v.securityReviewStatus === "passed" ||
      v.securityReviewStatus === "failed"
    ) {
      if (v.securityReviewedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["securityReviewedAt"],
          message: `securityReviewStatus '${v.securityReviewStatus}' requires securityReviewedAt`,
        });
      }
      if (v.securityReviewer === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["securityReviewer"],
          message: `securityReviewStatus '${v.securityReviewStatus}' requires securityReviewer`,
        });
      }
    }
    if (v.securityReviewStatus === "failed" && v.status === "published") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "versions with failed security review must not be published",
      });
    }
    if (v.supersededBy !== undefined && compareSemver(v.supersededBy, v.version) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededBy"],
        message: "supersededBy must reference a strictly newer version",
      });
    }
  });
export type PackVersionRecord = z.infer<typeof PackVersionRecordSchema>;

export const PackVersionListSchema = z
  .array(PackVersionRecordSchema)
  .superRefine((entries, ctx) => {
    if (entries.length === 0) return;
    const firstId = entries[0]?.packId;
    const seen = new Set<string>();
    entries.forEach((e, i) => {
      if (e.packId !== firstId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "packId"],
          message: `version list must be for a single pack; got mixed ids '${firstId}' and '${e.packId}'`,
        });
      }
      if (seen.has(e.version)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "version"],
          message: `duplicate version '${e.version}'`,
        });
      }
      seen.add(e.version);
    });
  });
export type PackVersionList = z.infer<typeof PackVersionListSchema>;

export function latestPublishedVersion(
  versions: PackVersionList,
  channel?: DistributionChannel,
): PackVersionRecord | null {
  const eligible = versions
    .filter((v) => v.status === "published")
    .filter((v) => channel === undefined || v.channel === channel);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => compareSemver(b.version, a.version))[0] ?? null;
}

export function versionsRequiringResign(
  versions: readonly PackVersionRecord[],
  rotatedFingerprint: string,
): readonly PackVersionRecord[] {
  return versions.filter(
    (v) =>
      v.status === "published" &&
      v.signature.publicKeyFingerprint === rotatedFingerprint,
  );
}
