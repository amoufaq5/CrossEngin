import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DrillRecordSchema,
  FailoverRecordSchema,
  type DrillRecord,
  type FailoverRecord,
} from "@crossengin/dr";
import {
  DrReadinessReportSchema,
  type DrReadinessReport,
} from "@crossengin/dr-runtime";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32Lower(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 0x1f];
    }
  }
  while (out.length < length) {
    out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

export function generateReadinessSnapshotId(): string {
  return `drr_${encodeBase32Lower(new Uint8Array(randomBytes(20)), 24)}`;
}

const Iso8601 = z.string().datetime({ offset: true });

export const DrFailoverExecutionRecordSchema = z
  .object({
    executionId: z.string().regex(/^fov_[a-z0-9]{4,40}$/),
    tenantId: z.string().uuid().nullable(),
    tier: z.string().min(1),
    trigger: z.string().min(1),
    status: z.string().min(1),
    fromRegion: z.string().min(1),
    toRegion: z.string().min(1),
    triggeredAt: Iso8601,
    completedAt: Iso8601.nullable(),
    actualRpoSeconds: z.number().int().nonnegative().nullable(),
    actualRtoSeconds: z.number().int().nonnegative().nullable(),
    rpoBreached: z.boolean().nullable(),
    rtoBreached: z.boolean().nullable(),
    incidentTicketId: z.string().min(1).nullable(),
    record: FailoverRecordSchema,
    recordedAt: Iso8601,
  })
  .strict();
export type DrFailoverExecutionRecord = z.infer<
  typeof DrFailoverExecutionRecordSchema
>;

export const DrDrillExecutionRecordSchema = z
  .object({
    executionId: z.string().regex(/^drl_[a-z0-9]{4,40}$/),
    tenantId: z.string().uuid().nullable(),
    kind: z.string().min(1),
    tier: z.string().min(1),
    outcome: z.string().min(1).nullable(),
    passing: z.boolean().nullable(),
    rpoBreached: z.boolean().nullable(),
    rtoBreached: z.boolean().nullable(),
    scheduledFor: Iso8601,
    executedAt: Iso8601.nullable(),
    record: DrillRecordSchema,
    recordedAt: Iso8601,
  })
  .strict();
export type DrDrillExecutionRecord = z.infer<
  typeof DrDrillExecutionRecordSchema
>;

export const DrReadinessSnapshotRecordSchema = z
  .object({
    snapshotId: z.string().regex(/^drr_[a-z0-9]{4,40}$/),
    tenantId: z.string().uuid().nullable(),
    ready: z.boolean(),
    totalIssues: z.number().int().nonnegative(),
    overdueDrills: z.number().int().nonnegative(),
    staleRunbooks: z.number().int().nonnegative(),
    expiredBackups: z.number().int().nonnegative(),
    unverifiedBackups: z.number().int().nonnegative(),
    replicationViolations: z.number().int().nonnegative(),
    failoverBreaches: z.number().int().nonnegative(),
    drillBreaches: z.number().int().nonnegative(),
    report: DrReadinessReportSchema,
    generatedAt: Iso8601,
  })
  .strict();
export type DrReadinessSnapshotRecord = z.infer<
  typeof DrReadinessSnapshotRecordSchema
>;

export interface FailoverExecutionRecordInput {
  readonly tenantId: string | null;
  readonly recordedAt: string;
  readonly verdict?: { readonly rpoBreached: boolean; readonly rtoBreached: boolean };
}

export function failoverExecutionRecordFrom(
  record: FailoverRecord,
  opts: FailoverExecutionRecordInput,
): DrFailoverExecutionRecord {
  return DrFailoverExecutionRecordSchema.parse({
    executionId: record.id,
    tenantId: opts.tenantId,
    tier: record.tier,
    trigger: record.trigger,
    status: record.status,
    fromRegion: record.fromRegion,
    toRegion: record.toRegion,
    triggeredAt: record.triggeredAt,
    completedAt: record.completedAt,
    actualRpoSeconds: record.actualRpoSeconds,
    actualRtoSeconds: record.actualRtoSeconds,
    rpoBreached: opts.verdict?.rpoBreached ?? null,
    rtoBreached: opts.verdict?.rtoBreached ?? null,
    incidentTicketId: record.incidentTicketId ?? null,
    record,
    recordedAt: opts.recordedAt,
  });
}

export interface DrillExecutionRecordInput {
  readonly tenantId: string | null;
  readonly recordedAt: string;
  readonly verdict?: {
    readonly rpoBreached: boolean;
    readonly rtoBreached: boolean;
    readonly passing: boolean;
  };
}

export function drillExecutionRecordFrom(
  record: DrillRecord,
  opts: DrillExecutionRecordInput,
): DrDrillExecutionRecord {
  return DrDrillExecutionRecordSchema.parse({
    executionId: record.id,
    tenantId: opts.tenantId,
    kind: record.kind,
    tier: record.tier,
    outcome: record.outcome,
    passing: opts.verdict?.passing ?? null,
    rpoBreached: opts.verdict?.rpoBreached ?? null,
    rtoBreached: opts.verdict?.rtoBreached ?? null,
    scheduledFor: record.scheduledFor,
    executedAt: record.executedAt,
    record,
    recordedAt: opts.recordedAt,
  });
}

export interface ReadinessSnapshotRecordInput {
  readonly tenantId: string | null;
  readonly generatedAt: string;
  readonly snapshotId?: string;
}

export function readinessSnapshotRecordFrom(
  report: DrReadinessReport,
  opts: ReadinessSnapshotRecordInput,
): DrReadinessSnapshotRecord {
  return DrReadinessSnapshotRecordSchema.parse({
    snapshotId: opts.snapshotId ?? generateReadinessSnapshotId(),
    tenantId: opts.tenantId,
    ready: report.ready,
    totalIssues: report.counts.totalIssues,
    overdueDrills: report.counts.overdueDrills,
    staleRunbooks: report.counts.staleRunbooks,
    expiredBackups: report.counts.expiredBackups,
    unverifiedBackups: report.counts.unverifiedBackups,
    replicationViolations: report.counts.replicationViolations,
    failoverBreaches: report.counts.failoverBreaches,
    drillBreaches: report.counts.drillBreaches,
    report,
    generatedAt: opts.generatedAt,
  });
}
