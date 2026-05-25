import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";
import { DrTierSchema, type DrTierSpec } from "./tiers.js";

const Iso8601 = z.string().datetime({ offset: true });

export const FAILOVER_TRIGGERS = [
  "planned_drill",
  "primary_outage",
  "regional_failure",
  "maintenance_window",
  "manual_promotion",
] as const;
export type FailoverTrigger = (typeof FAILOVER_TRIGGERS)[number];
export const FailoverTriggerSchema = z.enum(FAILOVER_TRIGGERS);

export const FAILOVER_STATUSES = [
  "queued",
  "in_progress",
  "succeeded",
  "failed",
  "aborted",
  "reverted",
] as const;
export type FailoverStatus = (typeof FAILOVER_STATUSES)[number];
export const FailoverStatusSchema = z.enum(FAILOVER_STATUSES);

export const FAILOVER_TRANSITIONS: Readonly<Record<FailoverStatus, readonly FailoverStatus[]>> =
  Object.freeze({
    queued: ["in_progress", "aborted"],
    in_progress: ["succeeded", "failed", "aborted"],
    succeeded: ["reverted"],
    failed: [],
    aborted: [],
    reverted: [],
  });

export function canTransitionFailover(from: FailoverStatus, to: FailoverStatus): boolean {
  return FAILOVER_TRANSITIONS[from].includes(to);
}

export const FailoverRecordSchema = z
  .object({
    id: z.string().min(1),
    tier: DrTierSchema,
    trigger: FailoverTriggerSchema,
    triggeredBy: z.string().min(1),
    triggeredAt: Iso8601,
    fromRegion: RegionSchema,
    toRegion: RegionSchema,
    affectedApps: z.array(z.string().min(1)).min(1),
    status: FailoverStatusSchema,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    actualRpoSeconds: z.number().int().nonnegative().nullable().default(null),
    actualRtoSeconds: z.number().int().nonnegative().nullable().default(null),
    revertedAt: Iso8601.nullable().default(null),
    revertedToFailoverId: z.string().min(1).nullable().default(null),
    incidentTicketId: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fromRegion === v.toRegion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toRegion"],
        message: "failover fromRegion and toRegion must differ",
      });
    }
    if (v.status === "succeeded") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "succeeded failover must declare completedAt",
        });
      }
      if (v.actualRpoSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actualRpoSeconds"],
          message: "succeeded failover must record actualRpoSeconds",
        });
      }
      if (v.actualRtoSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actualRtoSeconds"],
          message: "succeeded failover must record actualRtoSeconds",
        });
      }
    }
    if (v.status === "reverted") {
      if (v.revertedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revertedAt"],
          message: "reverted failover must declare revertedAt",
        });
      }
      if (v.revertedToFailoverId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revertedToFailoverId"],
          message: "reverted failover must reference revertedToFailoverId",
        });
      }
    }
    if (
      (v.trigger === "primary_outage" || v.trigger === "regional_failure") &&
      v.incidentTicketId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["incidentTicketId"],
        message: `trigger '${v.trigger}' requires incidentTicketId`,
      });
    }
  });
export type FailoverRecord = z.infer<typeof FailoverRecordSchema>;

export function exceededRpo(record: FailoverRecord, spec: DrTierSpec): boolean {
  return record.actualRpoSeconds !== null && record.actualRpoSeconds > spec.maxRpoSeconds;
}

export function exceededRto(record: FailoverRecord, spec: DrTierSpec): boolean {
  return record.actualRtoSeconds !== null && record.actualRtoSeconds > spec.maxRtoSeconds;
}

export function lastFailover(
  records: readonly FailoverRecord[],
  fromRegion?: Region,
): FailoverRecord | null {
  const filtered =
    fromRegion === undefined ? records : records.filter((r) => r.fromRegion === fromRegion);
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime(),
  );
  return sorted[0] ?? null;
}
