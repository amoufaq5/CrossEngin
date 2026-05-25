import { z } from "zod";
import { DrTierSchema } from "./tiers.js";

const Iso8601 = z.string().datetime({ offset: true });
const SECONDS_PER_DAY = 86_400;

export const RUNBOOK_KINDS = [
  "failover",
  "restore_from_backup",
  "partial_outage",
  "data_loss_event",
  "regional_evacuation",
  "key_rotation_emergency",
] as const;
export type RunbookKind = (typeof RUNBOOK_KINDS)[number];
export const RunbookKindSchema = z.enum(RUNBOOK_KINDS);

export const RUNBOOK_STATUSES = ["draft", "approved", "deprecated", "broken"] as const;
export type RunbookStatus = (typeof RUNBOOK_STATUSES)[number];
export const RunbookStatusSchema = z.enum(RUNBOOK_STATUSES);

const RUNBOOK_ID_REGEX = /^RB-[0-9]{4}$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const RunbookSpecSchema = z
  .object({
    id: z.string().regex(RUNBOOK_ID_REGEX, {
      message: "runbook id must be 'RB-NNNN' (e.g., 'RB-0001')",
    }),
    kind: RunbookKindSchema,
    appliesToTiers: z.array(DrTierSchema).min(1),
    title: z.string().min(1),
    version: z.string().regex(SEMVER_REGEX),
    owner: z.string().min(1),
    storageUri: z.string().url(),
    estimatedExecutionMinutes: z.number().int().positive(),
    requiresIncidentCommander: z.boolean().default(false),
    requiredApprovers: z.array(z.string().min(1)).default([]),
    lastReviewedAt: Iso8601,
    lastTestedAt: Iso8601.nullable().default(null),
    lastTestedBy: z.string().min(1).nullable().default(null),
    status: RunbookStatusSchema,
  })
  .superRefine((v, ctx) => {
    if (v.status === "approved" && v.lastTestedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastTestedAt"],
        message: "approved runbooks must have been tested at least once",
      });
    }
    if (v.status === "approved" && v.lastTestedBy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastTestedBy"],
        message: "approved runbooks must record lastTestedBy",
      });
    }
    if (v.kind === "failover" || v.kind === "regional_evacuation" || v.kind === "data_loss_event") {
      if (!v.requiresIncidentCommander) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiresIncidentCommander"],
          message: `kind '${v.kind}' requires incident commander oversight`,
        });
      }
    }
    if (v.appliesToTiers.includes("tier_0_mission_critical") && v.requiredApprovers.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredApprovers"],
        message:
          "tier-0 mission-critical runbooks need at least two required approvers (four-eyes)",
      });
    }
    const dedup = new Set<string>();
    v.requiredApprovers.forEach((a, i) => {
      if (dedup.has(a)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredApprovers", i],
          message: `duplicate approver '${a}'`,
        });
      }
      dedup.add(a);
    });
  });
export type RunbookSpec = z.infer<typeof RunbookSpecSchema>;

export interface RunbookFreshness {
  readonly daysSinceReview: number;
  readonly daysSinceTest: number | null;
  readonly stale: boolean;
}

export function runbookFreshness(
  runbook: RunbookSpec,
  maxDaysSinceReview: number,
  maxDaysSinceTest: number,
  now: Date = new Date(),
): RunbookFreshness {
  const nowTime = now.getTime();
  const reviewedTime = new Date(runbook.lastReviewedAt).getTime();
  const daysSinceReview = Math.floor((nowTime - reviewedTime) / 1000 / SECONDS_PER_DAY);
  const daysSinceTest =
    runbook.lastTestedAt === null
      ? null
      : Math.floor((nowTime - new Date(runbook.lastTestedAt).getTime()) / 1000 / SECONDS_PER_DAY);
  const stale =
    daysSinceReview > maxDaysSinceReview ||
    (daysSinceTest !== null && daysSinceTest > maxDaysSinceTest) ||
    runbook.lastTestedAt === null;
  return { daysSinceReview, daysSinceTest, stale };
}

export function staleRunbooks(
  runbooks: readonly RunbookSpec[],
  maxDaysSinceReview: number,
  maxDaysSinceTest: number,
  now: Date = new Date(),
): readonly RunbookSpec[] {
  return runbooks.filter(
    (r) => runbookFreshness(r, maxDaysSinceReview, maxDaysSinceTest, now).stale,
  );
}

export function approvedRunbooksFor(
  runbooks: readonly RunbookSpec[],
  kind: RunbookKind,
): readonly RunbookSpec[] {
  return runbooks.filter((r) => r.kind === kind && r.status === "approved");
}
