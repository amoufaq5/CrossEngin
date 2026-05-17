import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const SOURCE_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const MAPPING_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const BACKFILL_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;
export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];
export const BackfillStatusSchema = z.enum(BACKFILL_STATUSES);

export const BACKFILL_TRANSITIONS: Readonly<
  Record<BackfillStatus, readonly BackfillStatus[]>
> = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["paused", "completed", "completed_with_errors", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completed: [],
  completed_with_errors: [],
  failed: ["running"],
  cancelled: [],
});

export function canTransitionBackfill(
  from: BackfillStatus,
  to: BackfillStatus,
): boolean {
  return BACKFILL_TRANSITIONS[from].includes(to);
}

export const CONFLICT_RESOLUTIONS = [
  "skip_duplicate",
  "overwrite_existing",
  "fail_on_conflict",
  "merge_fields",
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];
export const ConflictResolutionSchema = z.enum(CONFLICT_RESOLUTIONS);

export const BackfillJobSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    sourceId: z.string().regex(SOURCE_ID_REGEX),
    mappingId: z.string().regex(MAPPING_ID_REGEX),
    previewRunId: z.string().min(1).optional(),
    status: BackfillStatusSchema,
    conflictResolution: ConflictResolutionSchema.default("skip_duplicate"),
    batchSize: z.number().int().min(1).max(10_000).default(500),
    parallelism: z.number().int().min(1).max(64).default(4),
    rateLimitRowsPerSecond: z.number().int().min(1).optional(),
    queuedAt: Iso8601,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    totalRowsEstimate: z.number().int().nonnegative().optional(),
    rowsProcessed: z.number().int().nonnegative().default(0),
    rowsInserted: z.number().int().nonnegative().default(0),
    rowsUpdated: z.number().int().nonnegative().default(0),
    rowsSkipped: z.number().int().nonnegative().default(0),
    rowsFailed: z.number().int().nonnegative().default(0),
    lastError: z.string().min(1).optional(),
    requestedBy: z.string().min(1),
    cancelledBy: z.string().min(1).nullable().default(null),
    cancelledReason: z.string().min(1).optional(),
    checkpointToken: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "running" || v.status === "paused" || v.status === "completed" || v.status === "completed_with_errors" || v.status === "failed") {
      if (v.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: `status '${v.status}' requires startedAt`,
        });
      }
    }
    if (
      v.status === "completed" ||
      v.status === "completed_with_errors" ||
      v.status === "failed" ||
      v.status === "cancelled"
    ) {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: `terminal status '${v.status}' requires completedAt`,
        });
      }
    }
    if (v.status === "completed" && v.rowsFailed > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rowsFailed"],
        message:
          "status='completed' must have rowsFailed=0; use 'completed_with_errors' instead",
      });
    }
    if (v.status === "completed_with_errors" && v.rowsFailed === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rowsFailed"],
        message:
          "status='completed_with_errors' requires rowsFailed > 0",
      });
    }
    if (v.status === "failed" && v.lastError === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastError"],
        message: "failed status requires lastError",
      });
    }
    if (v.status === "cancelled") {
      if (v.cancelledBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledBy"],
          message: "cancelled status requires cancelledBy",
        });
      }
      if (v.cancelledReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledReason"],
          message: "cancelled status requires cancelledReason",
        });
      }
    }
    if (v.rowsInserted + v.rowsUpdated + v.rowsSkipped + v.rowsFailed > v.rowsProcessed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rowsProcessed"],
        message: "rowsInserted + rowsUpdated + rowsSkipped + rowsFailed must not exceed rowsProcessed",
      });
    }
  });
export type BackfillJob = z.infer<typeof BackfillJobSchema>;

export const LEDGER_OUTCOMES = [
  "inserted",
  "updated",
  "skipped",
  "failed",
  "merged",
] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];
export const LedgerOutcomeSchema = z.enum(LEDGER_OUTCOMES);

export const BackfillLedgerEntrySchema = z
  .object({
    backfillJobId: z.string().min(1),
    sourceRowIndex: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
    sourceRowSha256: z.string().regex(SHA256_REGEX),
    targetEntity: z.string().min(1),
    targetRowId: z.string().min(1).nullable(),
    outcome: LedgerOutcomeSchema,
    outcomeAt: Iso8601,
    errorMessage: z.string().min(1).optional(),
    retryCount: z.number().int().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "failed" && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "failed outcome requires errorMessage",
      });
    }
    if (
      (v.outcome === "inserted" ||
        v.outcome === "updated" ||
        v.outcome === "merged") &&
      v.targetRowId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRowId"],
        message: `outcome '${v.outcome}' requires targetRowId`,
      });
    }
    if (v.outcome === "skipped" && v.targetRowId === null && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "skipped outcome without targetRowId requires errorMessage explaining the skip",
      });
    }
  });
export type BackfillLedgerEntry = z.infer<typeof BackfillLedgerEntrySchema>;

export function backfillProgressPercent(job: BackfillJob): number | null {
  if (job.totalRowsEstimate === undefined || job.totalRowsEstimate === 0) {
    return null;
  }
  return Math.min(100, Math.round((job.rowsProcessed / job.totalRowsEstimate) * 100));
}

export function isTerminal(status: BackfillStatus): boolean {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function ledgerOutcomeRate(
  entries: readonly BackfillLedgerEntry[],
  outcome: LedgerOutcome,
): number {
  if (entries.length === 0) return 0;
  const matching = entries.filter((e) => e.outcome === outcome).length;
  return Math.round((matching / entries.length) * 100) / 100;
}
