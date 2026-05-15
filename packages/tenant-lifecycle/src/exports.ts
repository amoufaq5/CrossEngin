import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const EXPORT_FORMATS = ["json", "ndjson", "csv", "parquet", "sql_dump"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);

export const EXPORT_TRIGGERS = [
  "customer_request",
  "pre_deletion_archive",
  "scheduled_backup_certified",
  "regulatory_subpoena",
  "tenant_migration",
] as const;
export type ExportTrigger = (typeof EXPORT_TRIGGERS)[number];
export const ExportTriggerSchema = z.enum(EXPORT_TRIGGERS);

export const EXPORT_STATUSES = [
  "queued",
  "running",
  "ready_for_download",
  "delivered",
  "failed",
  "expired",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const ExportStatusSchema = z.enum(EXPORT_STATUSES);

export const EXPORT_TRANSITIONS: Readonly<
  Record<ExportStatus, readonly ExportStatus[]>
> = Object.freeze({
  queued: ["running", "failed"],
  running: ["ready_for_download", "failed"],
  ready_for_download: ["delivered", "expired"],
  delivered: ["expired"],
  failed: [],
  expired: [],
});

export function canTransitionExport(from: ExportStatus, to: ExportStatus): boolean {
  return EXPORT_TRANSITIONS[from].includes(to);
}

export const EXPORT_DOWNLOAD_TTL_MIN_HOURS = 24;
export const EXPORT_DOWNLOAD_TTL_MAX_HOURS = 30 * 24;

export const TenantDataExportSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    trigger: ExportTriggerSchema,
    requestedAt: Iso8601,
    requestedBy: z.string().min(1),
    format: ExportFormatSchema,
    includesPiiCategories: z.boolean(),
    includesPhiCategories: z.boolean(),
    encryptionKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    status: ExportStatusSchema,
    startedAt: Iso8601.nullable().default(null),
    readyAt: Iso8601.nullable().default(null),
    deliveredAt: Iso8601.nullable().default(null),
    failedAt: Iso8601.nullable().default(null),
    failureReason: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    rowCount: z.number().int().nonnegative().nullable().default(null),
    sha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    storageUri: z.string().min(1).nullable().default(null),
    downloadUrlExpiresAt: Iso8601.nullable().default(null),
    downloadCount: z.number().int().nonnegative().default(0),
    maxDownloads: z.number().int().min(1).max(10).default(3),
    purgedAt: Iso8601.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.includesPhiCategories && v.trigger === "customer_request") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger"],
        message:
          "PHI exports cannot use trigger='customer_request' alone; require regulatory_subpoena or pre_deletion_archive",
      });
    }
    if (v.status === "running" && v.startedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "running status requires startedAt",
      });
    }
    if (
      v.status === "ready_for_download" ||
      v.status === "delivered" ||
      v.status === "expired"
    ) {
      if (v.readyAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["readyAt"],
          message: `status '${v.status}' requires readyAt`,
        });
      }
      if (v.sizeBytes === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sizeBytes"],
          message: `status '${v.status}' requires sizeBytes`,
        });
      }
      if (v.sha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sha256"],
          message: `status '${v.status}' requires sha256`,
        });
      }
      if (v.storageUri === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["storageUri"],
          message: `status '${v.status}' requires storageUri`,
        });
      }
      if (v.downloadUrlExpiresAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["downloadUrlExpiresAt"],
          message: `status '${v.status}' requires downloadUrlExpiresAt`,
        });
      }
    }
    if (v.status === "delivered" && v.deliveredAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveredAt"],
        message: "delivered status requires deliveredAt",
      });
    }
    if (v.status === "failed") {
      if (v.failedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failedAt"],
          message: "failed status requires failedAt",
        });
      }
      if (v.failureReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failureReason"],
          message: "failed status requires failureReason",
        });
      }
    }
    if (v.downloadUrlExpiresAt !== null && v.readyAt !== null) {
      const readyMs = new Date(v.readyAt).getTime();
      const expireMs = new Date(v.downloadUrlExpiresAt).getTime();
      const hours = (expireMs - readyMs) / 3_600_000;
      if (hours < EXPORT_DOWNLOAD_TTL_MIN_HOURS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["downloadUrlExpiresAt"],
          message: `download window must be >= ${EXPORT_DOWNLOAD_TTL_MIN_HOURS.toString()}h`,
        });
      }
      if (hours > EXPORT_DOWNLOAD_TTL_MAX_HOURS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["downloadUrlExpiresAt"],
          message: `download window must be <= ${EXPORT_DOWNLOAD_TTL_MAX_HOURS.toString()}h`,
        });
      }
    }
    if (v.downloadCount > v.maxDownloads) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["downloadCount"],
        message: "downloadCount must not exceed maxDownloads",
      });
    }
    if (v.status === "expired" && v.purgedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purgedAt"],
        message: "expired status requires purgedAt (artifact purge timestamp)",
      });
    }
  });
export type TenantDataExport = z.infer<typeof TenantDataExportSchema>;

export function isExportDownloadable(exp: TenantDataExport, now: Date = new Date()): boolean {
  if (exp.status !== "ready_for_download" && exp.status !== "delivered") return false;
  if (exp.downloadUrlExpiresAt === null) return false;
  if (now.getTime() >= new Date(exp.downloadUrlExpiresAt).getTime()) return false;
  if (exp.downloadCount >= exp.maxDownloads) return false;
  return true;
}

export function downloadsRemaining(exp: TenantDataExport): number {
  return Math.max(0, exp.maxDownloads - exp.downloadCount);
}

export function shouldPurge(exp: TenantDataExport, now: Date = new Date()): boolean {
  if (exp.purgedAt !== null) return false;
  if (exp.downloadUrlExpiresAt === null) return false;
  return now.getTime() >= new Date(exp.downloadUrlExpiresAt).getTime();
}
