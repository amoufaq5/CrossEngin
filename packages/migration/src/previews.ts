import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SOURCE_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const MAPPING_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const PREVIEW_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];
export const PreviewStatusSchema = z.enum(PREVIEW_STATUSES);

export const PREVIEW_TRANSITIONS: Readonly<Record<PreviewStatus, readonly PreviewStatus[]>> =
  Object.freeze({
    pending: ["running", "cancelled"],
    running: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  });

export function canTransitionPreview(from: PreviewStatus, to: PreviewStatus): boolean {
  return PREVIEW_TRANSITIONS[from].includes(to);
}

export const ROW_VALIDATION_OUTCOMES = [
  "valid",
  "type_mismatch",
  "missing_required",
  "constraint_violation",
  "duplicate_idempotency_key",
  "skipped",
] as const;
export type RowValidationOutcome = (typeof ROW_VALIDATION_OUTCOMES)[number];

export const RowValidationIssueSchema = z.object({
  field: z.string().min(1),
  outcome: z.enum(ROW_VALIDATION_OUTCOMES),
  message: z.string().min(1),
  sourceValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});
export type RowValidationIssue = z.infer<typeof RowValidationIssueSchema>;

export const PreviewRowSchema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    outcome: z.enum(ROW_VALIDATION_OUTCOMES),
    issues: z.array(RowValidationIssueSchema).default([]),
    transformedSample: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "valid" && v.issues.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues"],
        message: "valid rows must not have issues",
      });
    }
    if (v.outcome !== "valid" && v.issues.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues"],
        message: `outcome '${v.outcome}' requires at least one issue`,
      });
    }
  });
export type PreviewRow = z.infer<typeof PreviewRowSchema>;

export const PreviewRunSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    sourceId: z.string().regex(SOURCE_ID_REGEX),
    mappingId: z.string().regex(MAPPING_ID_REGEX),
    status: PreviewStatusSchema,
    requestedAt: Iso8601,
    requestedBy: z.string().min(1),
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    sampleSize: z.number().int().min(1),
    rowsRead: z.number().int().nonnegative(),
    rowsValid: z.number().int().nonnegative(),
    rowsInvalid: z.number().int().nonnegative(),
    rowsSkipped: z.number().int().nonnegative(),
    rows: z.array(PreviewRowSchema).default([]),
    errorMessage: z.string().min(1).optional(),
    estimatedSourceRowCount: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "running" && v.startedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "running status requires startedAt",
      });
    }
    if (v.status === "completed") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed status requires completedAt",
        });
      }
      if (v.startedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startedAt"],
          message: "completed status requires startedAt",
        });
      }
    }
    if (v.status === "failed" && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "failed status requires errorMessage",
      });
    }
    if (v.rowsValid + v.rowsInvalid + v.rowsSkipped > v.rowsRead) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rowsRead"],
        message: "rowsValid + rowsInvalid + rowsSkipped must not exceed rowsRead",
      });
    }
    if (v.rowsRead > v.sampleSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rowsRead"],
        message: "rowsRead must not exceed sampleSize",
      });
    }
    const indexes = new Set<number>();
    v.rows.forEach((r, i) => {
      if (indexes.has(r.rowIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", i, "rowIndex"],
          message: `duplicate rowIndex ${r.rowIndex.toString()}`,
        });
      }
      indexes.add(r.rowIndex);
    });
  });
export type PreviewRun = z.infer<typeof PreviewRunSchema>;

export interface PreviewSummary {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly issueByOutcome: Readonly<Record<RowValidationOutcome, number>>;
  readonly readyToCommit: boolean;
}

export function summarizePreview(
  run: PreviewRun,
  acceptableFailureRate: number = 0.05,
): PreviewSummary {
  const counts: Record<RowValidationOutcome, number> = {
    valid: 0,
    type_mismatch: 0,
    missing_required: 0,
    constraint_violation: 0,
    duplicate_idempotency_key: 0,
    skipped: 0,
  };
  for (const row of run.rows) {
    counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  }
  const failureRate = run.rowsRead === 0 ? 1 : run.rowsInvalid / run.rowsRead;
  return {
    totalRows: run.rowsRead,
    validRows: run.rowsValid,
    invalidRows: run.rowsInvalid,
    issueByOutcome: counts,
    readyToCommit:
      run.status === "completed" && run.rowsRead > 0 && failureRate <= acceptableFailureRate,
  };
}

export function failureRate(run: PreviewRun): number {
  if (run.rowsRead === 0) return 0;
  return run.rowsInvalid / run.rowsRead;
}
