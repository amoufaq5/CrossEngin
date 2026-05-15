import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

const Iso8601 = z.string().datetime({ offset: true });
const SB_ID_REGEX = /^SB-\d{4}-\d{4,8}$/;

export const SPLIT_BRAIN_KINDS = [
  "network_partition",
  "asymmetric_partition",
  "membership_disagreement",
  "clock_skew",
  "replication_lag_critical",
] as const;
export type SplitBrainKind = (typeof SPLIT_BRAIN_KINDS)[number];
export const SplitBrainKindSchema = z.enum(SPLIT_BRAIN_KINDS);

export const SPLIT_BRAIN_STATUSES = [
  "detected",
  "isolating",
  "healing",
  "healed",
  "permanent_partition",
] as const;
export type SplitBrainStatus = (typeof SPLIT_BRAIN_STATUSES)[number];
export const SplitBrainStatusSchema = z.enum(SPLIT_BRAIN_STATUSES);

export const SPLIT_BRAIN_TRANSITIONS: Readonly<
  Record<SplitBrainStatus, readonly SplitBrainStatus[]>
> = Object.freeze({
  detected: ["isolating", "healing"],
  isolating: ["healing", "permanent_partition"],
  healing: ["healed", "permanent_partition"],
  healed: [],
  permanent_partition: ["healing"],
});

export function canTransitionSplitBrain(
  from: SplitBrainStatus,
  to: SplitBrainStatus,
): boolean {
  return SPLIT_BRAIN_TRANSITIONS[from].includes(to);
}

export const HEALING_STRATEGIES = [
  "auto_merge_concurrent",
  "manual_evidence_review",
  "rollback_minority",
  "freeze_and_audit",
  "prefer_quorum_side",
] as const;
export type HealingStrategy = (typeof HEALING_STRATEGIES)[number];

export const PartitionGroupSchema = z
  .object({
    groupId: z.string().min(1),
    regions: z.array(RegionSchema).min(1),
    hadQuorum: z.boolean(),
    acceptedWritesDuringPartition: z.boolean(),
    writeCountDuringPartition: z.number().int().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<Region>();
    v.regions.forEach((r, i) => {
      if (seen.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["regions", i],
          message: `duplicate region '${r}'`,
        });
      }
      seen.add(r);
    });
    if (!v.acceptedWritesDuringPartition && v.writeCountDuringPartition > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writeCountDuringPartition"],
        message: "acceptedWritesDuringPartition=false requires writeCountDuringPartition=0",
      });
    }
  });
export type PartitionGroup = z.infer<typeof PartitionGroupSchema>;

export const SplitBrainEventSchema = z
  .object({
    id: z.string().regex(SB_ID_REGEX, {
      message: "split-brain event id must match 'SB-YYYY-NNNN'",
    }),
    kind: SplitBrainKindSchema,
    status: SplitBrainStatusSchema,
    detectedAt: Iso8601,
    detectedBy: z.string().min(1),
    detectorEvidence: z.string().min(1),
    partitionGroups: z.array(PartitionGroupSchema).min(2),
    isolatedAt: Iso8601.nullable().default(null),
    healingStartedAt: Iso8601.nullable().default(null),
    healedAt: Iso8601.nullable().default(null),
    healingStrategy: z.enum(HEALING_STRATEGIES).nullable().default(null),
    conflictRecordIds: z.array(z.string().min(1)).default([]),
    permanentPartitionAt: Iso8601.nullable().default(null),
    permanentPartitionReason: z.string().min(1).optional(),
    requiresIncidentResponse: z.boolean().default(true),
    incidentRecordId: z.string().min(1).optional(),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const groupIds = new Set<string>();
    const allRegions = new Set<Region>();
    let quorumGroups = 0;
    v.partitionGroups.forEach((g, i) => {
      if (groupIds.has(g.groupId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["partitionGroups", i, "groupId"],
          message: `duplicate group id '${g.groupId}'`,
        });
      }
      groupIds.add(g.groupId);
      for (const r of g.regions) {
        if (allRegions.has(r)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["partitionGroups", i, "regions"],
            message: `region '${r}' appears in multiple partition groups`,
          });
        }
        allRegions.add(r);
      }
      if (g.hadQuorum) quorumGroups++;
    });
    if (quorumGroups > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["partitionGroups"],
        message: "at most one partition group can claim quorum (otherwise true split brain — both sides shouldn't have proceeded)",
      });
    }
    if (v.status === "isolating" && v.isolatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isolatedAt"],
        message: "isolating status requires isolatedAt",
      });
    }
    if (v.status === "healing" || v.status === "healed") {
      if (v.healingStartedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["healingStartedAt"],
          message: `status '${v.status}' requires healingStartedAt`,
        });
      }
      if (v.healingStrategy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["healingStrategy"],
          message: `status '${v.status}' requires healingStrategy`,
        });
      }
    }
    if (v.status === "healed") {
      if (v.healedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["healedAt"],
          message: "healed status requires healedAt",
        });
      }
      if (v.durationSeconds === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["durationSeconds"],
          message: "healed status requires durationSeconds",
        });
      }
    }
    if (v.status === "permanent_partition") {
      if (v.permanentPartitionAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["permanentPartitionAt"],
          message: "permanent_partition status requires permanentPartitionAt",
        });
      }
      if (v.permanentPartitionReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["permanentPartitionReason"],
          message: "permanent_partition status requires permanentPartitionReason",
        });
      }
    }
    if (v.requiresIncidentResponse && v.incidentRecordId === undefined) {
      const isActive =
        v.status !== "healed" && v.status !== "permanent_partition";
      if (isActive) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["incidentRecordId"],
          message: "active split-brain events with requiresIncidentResponse=true must reference incidentRecordId",
        });
      }
    }
    const writingMinorities = v.partitionGroups.filter(
      (g) => !g.hadQuorum && g.acceptedWritesDuringPartition,
    );
    if (writingMinorities.length > 0 && v.kind === "network_partition") {
      const conflicts = v.conflictRecordIds.length;
      const totalMinorityWrites = writingMinorities.reduce(
        (acc, g) => acc + g.writeCountDuringPartition,
        0,
      );
      if (totalMinorityWrites > 0 && conflicts === 0 && v.status === "healed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conflictRecordIds"],
          message: "minority partitions that accepted writes must produce conflict records during healing",
        });
      }
    }
  });
export type SplitBrainEvent = z.infer<typeof SplitBrainEventSchema>;

export function affectedRegions(event: SplitBrainEvent): readonly Region[] {
  const out = new Set<Region>();
  for (const g of event.partitionGroups) {
    for (const r of g.regions) out.add(r);
  }
  return [...out];
}

export function quorumGroup(event: SplitBrainEvent): PartitionGroup | null {
  return event.partitionGroups.find((g) => g.hadQuorum) ?? null;
}

export function minorityGroups(event: SplitBrainEvent): readonly PartitionGroup[] {
  return event.partitionGroups.filter((g) => !g.hadQuorum);
}

export function isActive(event: SplitBrainEvent): boolean {
  return event.status !== "healed" && event.status !== "permanent_partition";
}

export function meanTimeToHealSeconds(
  events: readonly SplitBrainEvent[],
): number | null {
  const healed = events.filter(
    (e) => e.status === "healed" && e.durationSeconds !== null,
  );
  if (healed.length === 0) return null;
  const total = healed.reduce((acc, e) => acc + (e.durationSeconds ?? 0), 0);
  return Math.round(total / healed.length);
}
