import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const REPORT_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "throttled",
  "cancelled",
] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

export const REPORT_RUN_TRIGGERS = [
  "user_invoked",
  "scheduled",
  "dashboard_refresh",
  "ai_architect",
  "api",
] as const;
export type ReportRunTrigger = (typeof REPORT_RUN_TRIGGERS)[number];

export const ReportRunRecordSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  reportId: z.string().min(1),
  runId: Uuid,
  startedAt: Iso8601,
  completedAt: Iso8601.nullable().default(null),
  durationMillis: z.number().int().nonnegative().nullable().default(null),
  status: z.enum(REPORT_RUN_STATUSES),
  trigger: z.enum(REPORT_RUN_TRIGGERS),
  invokedBy: Uuid.nullable().default(null),
  engine: z.enum(["postgres", "clickhouse"]),
  parametersRedacted: z.record(z.string(), z.unknown()).default({}),
  rowCount: z.number().int().nonnegative().nullable().default(null),
  cacheHit: z.boolean().default(false),
  error: z
    .object({
      kind: z.enum(["timeout", "permission_denied", "query_error", "unknown"]),
      message: z.string().min(1),
    })
    .nullable()
    .default(null),
});
export type ReportRunRecord = z.infer<typeof ReportRunRecordSchema>;

export const SCHEDULED_EXPORT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped_empty",
] as const;
export type ScheduledExportStatus = (typeof SCHEDULED_EXPORT_STATUSES)[number];

export const ScheduledExportSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  reportId: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  enabled: z.boolean(),
  lastRunAt: Iso8601.nullable().default(null),
  nextRunAt: Iso8601,
  lastStatus: z.enum(SCHEDULED_EXPORT_STATUSES).nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  lastDeliveryAt: Iso8601.nullable().default(null),
});
export type ScheduledExport = z.infer<typeof ScheduledExportSchema>;
