import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";
import { DrTierSchema, type DrTierSpec } from "./tiers.js";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const BACKUP_KINDS = [
  "full",
  "incremental",
  "wal_archive",
  "logical_dump",
  "object_snapshot",
] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export const BackupKindSchema = z.enum(BACKUP_KINDS);

export const BACKUP_STATUSES = [
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "verified",
  "expired",
] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];
export const BackupStatusSchema = z.enum(BACKUP_STATUSES);

export const BACKUP_TRANSITIONS: Readonly<Record<BackupStatus, readonly BackupStatus[]>> =
  Object.freeze({
    scheduled: ["running", "failed"],
    running: ["succeeded", "failed"],
    succeeded: ["verified", "expired", "failed"],
    failed: [],
    verified: ["expired"],
    expired: [],
  });

export function canTransitionBackup(from: BackupStatus, to: BackupStatus): boolean {
  return BACKUP_TRANSITIONS[from].includes(to);
}

export const BackupPolicySchema = z
  .object({
    id: z.string().min(1),
    kind: BackupKindSchema,
    tier: DrTierSchema,
    cron: z.string().regex(/^(\S+\s+){4}\S+$/, {
      message: "cron must have exactly 5 whitespace-separated fields",
    }),
    timezone: z.string().default("UTC"),
    retentionDays: z.number().int().positive(),
    encryptionKeyId: z.string().min(1),
    storageRegion: RegionSchema,
    crossRegionCopyTo: z.array(RegionSchema).default([]),
    requiresVerification: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.crossRegionCopyTo.includes(v.storageRegion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crossRegionCopyTo"],
        message: "crossRegionCopyTo cannot include storageRegion (same region is not cross-region)",
      });
    }
    const seen = new Set<string>();
    v.crossRegionCopyTo.forEach((r, i) => {
      if (seen.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["crossRegionCopyTo", i],
          message: `duplicate region '${r}' in crossRegionCopyTo`,
        });
      }
      seen.add(r);
    });
  });
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;

export const BackupRecordSchema = z
  .object({
    id: z.string().min(1),
    policyId: z.string().min(1),
    kind: BackupKindSchema,
    startedAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    status: BackupStatusSchema,
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    sha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    storageRegion: RegionSchema,
    copiedToRegions: z.array(RegionSchema).default([]),
    verifiedAt: Iso8601.nullable().default(null),
    verifiedBy: z.string().min(1).nullable().default(null),
    expiresAt: Iso8601,
    errorMessage: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "succeeded" || v.status === "verified") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: `${v.status} backups must declare completedAt`,
        });
      }
      if (v.sha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sha256"],
          message: `${v.status} backups must declare sha256`,
        });
      }
      if (v.sizeBytes === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sizeBytes"],
          message: `${v.status} backups must declare sizeBytes`,
        });
      }
    }
    if (v.status === "verified") {
      if (v.verifiedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAt"],
          message: "verified backups must declare verifiedAt",
        });
      }
      if (v.verifiedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedBy"],
          message: "verified backups must declare verifiedBy",
        });
      }
    }
    if (v.status === "failed" && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "failed backups must declare errorMessage",
      });
    }
    if (new Date(v.expiresAt).getTime() <= new Date(v.startedAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after startedAt",
      });
    }
  });
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export function isBackupExpired(record: BackupRecord, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(record.expiresAt).getTime();
}

export function isBackupVerified(record: BackupRecord): boolean {
  return record.status === "verified" && record.verifiedAt !== null;
}

export function expiredBackups(
  records: readonly BackupRecord[],
  now: Date = new Date(),
): readonly BackupRecord[] {
  return records.filter((r) => isBackupExpired(r, now));
}

export function backupSatisfiesTier(policy: BackupPolicy, spec: DrTierSpec): boolean {
  if (policy.tier !== spec.tier) return false;
  if (policy.retentionDays < spec.retentionDays) return false;
  if (spec.requiresCrossRegion && policy.crossRegionCopyTo.length === 0) return false;
  return true;
}
