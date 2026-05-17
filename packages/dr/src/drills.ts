import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";
import { DrTierSchema, type DrTierSpec } from "./tiers.js";

const Iso8601 = z.string().datetime({ offset: true });
const SECONDS_PER_DAY = 86_400;

export const DRILL_KINDS = [
  "tabletop",
  "restore_test",
  "failover_test",
  "full_regional",
  "chaos_injection",
] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];
export const DrillKindSchema = z.enum(DRILL_KINDS);

export const DRILL_OUTCOMES = [
  "passed",
  "passed_with_findings",
  "failed",
  "aborted",
  "not_executed",
] as const;
export type DrillOutcome = (typeof DRILL_OUTCOMES)[number];
export const DrillOutcomeSchema = z.enum(DRILL_OUTCOMES);

export const DRILL_FINDING_SEVERITIES = ["info", "minor", "major", "critical"] as const;
export type DrillFindingSeverity = (typeof DRILL_FINDING_SEVERITIES)[number];

export const DrillFindingSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  severity: z.enum(DRILL_FINDING_SEVERITIES),
  description: z.string().min(1),
  followUpTicketId: z.string().min(1).optional(),
  resolvedAt: Iso8601.nullable().default(null),
});
export type DrillFinding = z.infer<typeof DrillFindingSchema>;

export const DrillRecordSchema = z
  .object({
    id: z.string().min(1),
    kind: DrillKindSchema,
    tier: DrTierSchema,
    scheduledFor: Iso8601,
    executedAt: Iso8601.nullable().default(null),
    executedBy: z.string().min(1).nullable().default(null),
    scopeRegions: z.array(RegionSchema).min(1),
    scopeApps: z.array(z.string().min(1)).min(1),
    outcome: DrillOutcomeSchema,
    measuredRpoSeconds: z.number().int().nonnegative().nullable().default(null),
    measuredRtoSeconds: z.number().int().nonnegative().nullable().default(null),
    findings: z.array(DrillFindingSchema).default([]),
    reportUrl: z.string().url().optional(),
    nextDrillDueAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.outcome !== "not_executed") {
      if (v.executedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executedAt"],
          message: `outcome '${v.outcome}' requires executedAt`,
        });
      }
      if (v.executedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executedBy"],
          message: `outcome '${v.outcome}' requires executedBy`,
        });
      }
    }
    if (
      (v.kind === "failover_test" ||
        v.kind === "full_regional" ||
        v.kind === "restore_test") &&
      (v.outcome === "passed" || v.outcome === "passed_with_findings")
    ) {
      if (v.measuredRpoSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["measuredRpoSeconds"],
          message: `${v.kind} drill must record measuredRpoSeconds when it executes`,
        });
      }
      if (v.measuredRtoSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["measuredRtoSeconds"],
          message: `${v.kind} drill must record measuredRtoSeconds when it executes`,
        });
      }
    }
    if (v.outcome === "passed_with_findings" && v.findings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "outcome 'passed_with_findings' requires at least one finding",
      });
    }
    if (v.outcome === "failed" && v.findings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "failed drill must record at least one finding",
      });
    }
    if (new Date(v.nextDrillDueAt).getTime() <= new Date(v.scheduledFor).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextDrillDueAt"],
        message: "nextDrillDueAt must be after this drill's scheduledFor",
      });
    }
    const ids = new Set<string>();
    v.findings.forEach((f, i) => {
      if (ids.has(f.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", i, "id"],
          message: `duplicate finding id '${f.id}'`,
        });
      }
      ids.add(f.id);
    });
  });
export type DrillRecord = z.infer<typeof DrillRecordSchema>;

export function isDrillPassing(record: DrillRecord): boolean {
  return record.outcome === "passed" || record.outcome === "passed_with_findings";
}

export function isOverdue(
  record: DrillRecord,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= new Date(record.nextDrillDueAt).getTime();
}

export function lastSuccessfulDrill(
  records: readonly DrillRecord[],
  kind: DrillKind,
): DrillRecord | null {
  const filtered = records.filter(
    (r) => r.kind === kind && isDrillPassing(r) && r.executedAt !== null,
  );
  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.executedAt === null ? 0 : new Date(a.executedAt).getTime();
    const bTime = b.executedAt === null ? 0 : new Date(b.executedAt).getTime();
    return bTime - aTime;
  });
  return sorted[0] ?? null;
}

export function overdueDrills(
  records: readonly DrillRecord[],
  now: Date = new Date(),
): readonly DrillRecord[] {
  return records.filter((r) => isOverdue(r, now));
}

export function exceededRpoInDrill(record: DrillRecord, spec: DrTierSpec): boolean {
  return record.measuredRpoSeconds !== null && record.measuredRpoSeconds > spec.maxRpoSeconds;
}

export function exceededRtoInDrill(record: DrillRecord, spec: DrTierSpec): boolean {
  return record.measuredRtoSeconds !== null && record.measuredRtoSeconds > spec.maxRtoSeconds;
}

export function drillCadenceMet(
  record: DrillRecord,
  spec: DrTierSpec,
): boolean {
  if (record.executedAt === null) return false;
  const executedTime = new Date(record.executedAt).getTime();
  const nextDueTime = new Date(record.nextDrillDueAt).getTime();
  const intervalSeconds = (nextDueTime - executedTime) / 1000;
  return intervalSeconds <= spec.requiresDrillCadenceDays * SECONDS_PER_DAY;
}
