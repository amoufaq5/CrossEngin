import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";
import { VectorClockSchema, compareVectorClocks } from "./vectors.js";

const Iso8601 = z.string().datetime({ offset: true });
const CONFLICT_ID_REGEX = /^CFL-\d{4}-\d{4,8}$/;

export const CONFLICT_KINDS = [
  "concurrent_write",
  "delete_update_race",
  "constraint_violation_after_merge",
  "ordering_ambiguity",
  "schema_drift",
  "tenant_residency_violation",
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];
export const ConflictKindSchema = z.enum(CONFLICT_KINDS);

export const RESOLUTION_STRATEGIES = [
  "last_writer_wins",
  "first_writer_wins",
  "vector_clock_merge",
  "crdt_merge",
  "application_merge",
  "manual_review",
  "rollback",
] as const;
export type ResolutionStrategy = (typeof RESOLUTION_STRATEGIES)[number];
export const ResolutionStrategySchema = z.enum(RESOLUTION_STRATEGIES);

export const CONFLICT_STATUSES = [
  "detected",
  "auto_resolving",
  "awaiting_review",
  "resolved",
  "escalated",
] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);

export const CONFLICT_TRANSITIONS: Readonly<
  Record<ConflictStatus, readonly ConflictStatus[]>
> = Object.freeze({
  detected: ["auto_resolving", "awaiting_review", "escalated"],
  auto_resolving: ["resolved", "awaiting_review", "escalated"],
  awaiting_review: ["resolved", "escalated"],
  resolved: [],
  escalated: ["awaiting_review", "resolved"],
});

export function canTransitionConflict(
  from: ConflictStatus,
  to: ConflictStatus,
): boolean {
  return CONFLICT_TRANSITIONS[from].includes(to);
}

export const ConflictingWriteSchema = z.object({
  region: RegionSchema,
  vectorClock: VectorClockSchema,
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  occurredAt: Iso8601,
  actorReference: z.string().min(1),
});
export type ConflictingWrite = z.infer<typeof ConflictingWriteSchema>;

export const ConflictRecordSchema = z
  .object({
    id: z.string().regex(CONFLICT_ID_REGEX, {
      message: "conflict id must match 'CFL-YYYY-NNNN'",
    }),
    tenantId: z.string().min(1),
    entityClass: z.string().min(1),
    entityId: z.string().min(1),
    kind: ConflictKindSchema,
    status: ConflictStatusSchema,
    detectedAt: Iso8601,
    conflictingWrites: z.array(ConflictingWriteSchema).min(2),
    chosenStrategy: ResolutionStrategySchema.nullable().default(null),
    chosenStrategyAt: Iso8601.nullable().default(null),
    chosenStrategyBy: z.string().min(1).nullable().default(null),
    resolvedAt: Iso8601.nullable().default(null),
    resolvedBy: z.string().min(1).nullable().default(null),
    resolutionPayloadSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    resolutionNotes: z.string().min(1).optional(),
    requiresAudit: z.boolean().default(false),
    auditRecordedAt: Iso8601.nullable().default(null),
    escalatedTo: z.string().min(1).optional(),
    escalationReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const writers = new Set<string>();
    v.conflictingWrites.forEach((w, i) => {
      if (writers.has(w.region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conflictingWrites", i, "region"],
          message: `duplicate conflicting write from region '${w.region}'`,
        });
      }
      writers.add(w.region);
    });
    if (v.kind === "concurrent_write") {
      for (let i = 0; i < v.conflictingWrites.length - 1; i++) {
        for (let j = i + 1; j < v.conflictingWrites.length; j++) {
          const a = v.conflictingWrites[i];
          const b = v.conflictingWrites[j];
          if (a === undefined || b === undefined) continue;
          const rel = compareVectorClocks(a.vectorClock, b.vectorClock);
          if (rel !== "concurrent") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["conflictingWrites"],
              message: `concurrent_write kind requires causally concurrent vector clocks; '${a.region}' is '${rel}' '${b.region}'`,
            });
          }
        }
      }
    }
    if (v.status === "resolved") {
      if (v.resolvedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolvedAt"],
          message: "resolved status requires resolvedAt",
        });
      }
      if (v.resolvedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolvedBy"],
          message: "resolved status requires resolvedBy",
        });
      }
      if (v.chosenStrategy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chosenStrategy"],
          message: "resolved status requires chosenStrategy",
        });
      }
      if (v.resolutionPayloadSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolutionPayloadSha256"],
          message: "resolved status requires resolutionPayloadSha256 (cryptographic anchor)",
        });
      }
    }
    if (v.status === "escalated") {
      if (v.escalatedTo === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["escalatedTo"],
          message: "escalated status requires escalatedTo",
        });
      }
      if (v.escalationReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["escalationReason"],
          message: "escalated status requires escalationReason",
        });
      }
    }
    if (v.chosenStrategy === "manual_review" && v.status === "resolved" && v.resolutionNotes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolutionNotes"],
        message: "manual_review resolutions must record resolutionNotes",
      });
    }
    if (v.kind === "tenant_residency_violation") {
      if (!v.requiresAudit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiresAudit"],
          message: "tenant_residency_violation kind must requiresAudit=true",
        });
      }
      if (v.status === "auto_resolving") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: "tenant_residency_violation cannot be auto_resolving; requires manual review",
        });
      }
    }
    if (v.requiresAudit && v.status === "resolved" && v.auditRecordedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auditRecordedAt"],
        message: "requiresAudit=true + resolved status requires auditRecordedAt",
      });
    }
  });
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

export function detectConflictKind(
  writes: readonly ConflictingWrite[],
): ConflictKind | null {
  if (writes.length < 2) return null;
  for (let i = 0; i < writes.length - 1; i++) {
    for (let j = i + 1; j < writes.length; j++) {
      const a = writes[i];
      const b = writes[j];
      if (a === undefined || b === undefined) continue;
      const rel = compareVectorClocks(a.vectorClock, b.vectorClock);
      if (rel === "concurrent") return "concurrent_write";
    }
  }
  return null;
}

export function preferredStrategyFor(kind: ConflictKind): ResolutionStrategy {
  switch (kind) {
    case "concurrent_write":
      return "vector_clock_merge";
    case "delete_update_race":
      return "application_merge";
    case "constraint_violation_after_merge":
      return "manual_review";
    case "ordering_ambiguity":
      return "last_writer_wins";
    case "schema_drift":
      return "manual_review";
    case "tenant_residency_violation":
      return "manual_review";
  }
}

export function isAutoResolvable(strategy: ResolutionStrategy): boolean {
  return (
    strategy === "last_writer_wins" ||
    strategy === "first_writer_wins" ||
    strategy === "vector_clock_merge" ||
    strategy === "crdt_merge"
  );
}
