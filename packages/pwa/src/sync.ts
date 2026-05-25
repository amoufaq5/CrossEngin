import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const ENTITY_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;

export const SYNC_TRIGGERS = [
  "foreground",
  "reconnect",
  "push_notification",
  "manual_refresh",
  "background_periodic",
] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const CONFLICT_STRATEGIES = [
  "last_write_wins",
  "manual_merge",
  "server_authoritative",
] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const SyncWatermarkSchema = z.object({
  tenantId: Uuid,
  entity: z.string().regex(ENTITY_NAME_REGEX),
  updatedAtCursor: Iso8601,
  rowIdCursor: Uuid.optional(),
});
export type SyncWatermark = z.infer<typeof SyncWatermarkSchema>;

export const SyncDeltaOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    entity: z.string().regex(ENTITY_NAME_REGEX),
    id: Uuid,
    updatedAt: Iso8601,
    row: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal("delete"),
    entity: z.string().regex(ENTITY_NAME_REGEX),
    id: Uuid,
    deletedAt: Iso8601,
  }),
]);
export type SyncDeltaOperation = z.infer<typeof SyncDeltaOperationSchema>;

export const SyncRequestSchema = z
  .object({
    tenantId: Uuid,
    trigger: z.enum(SYNC_TRIGGERS),
    watermarks: z.array(SyncWatermarkSchema).default([]),
    entities: z.array(z.string().regex(ENTITY_NAME_REGEX)).default([]),
    maxOps: z.number().int().min(1).max(10_000).default(500),
    includeFiles: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.entities.length > 0) {
      const entitySet = new Set(v.entities);
      for (const w of v.watermarks) {
        if (!entitySet.has(w.entity)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["watermarks"],
            message: `watermark for '${w.entity}' is not in the requested entities scope`,
          });
        }
      }
    }
  });
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncResponseSchema = z.object({
  tenantId: Uuid,
  receivedAt: Iso8601,
  operations: z.array(SyncDeltaOperationSchema),
  newWatermarks: z.array(SyncWatermarkSchema),
  hasMore: z.boolean(),
  serverNowMillis: z.number().int().nonnegative(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export const ConflictResolutionRecordSchema = z
  .object({
    entity: z.string().regex(ENTITY_NAME_REGEX),
    entityId: Uuid,
    strategy: z.enum(CONFLICT_STRATEGIES),
    localUpdatedAt: Iso8601,
    serverUpdatedAt: Iso8601,
    resolvedAt: Iso8601,
    resolvedBy: Uuid.optional(),
    winner: z.enum(["local", "server", "merged"]),
    mergedRow: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.strategy === "manual_merge" && v.winner === "merged" && v.mergedRow === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mergedRow"],
        message: "manual_merge with winner='merged' must declare mergedRow",
      });
    }
    if (v.strategy === "manual_merge" && v.resolvedBy === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedBy"],
        message: "manual_merge requires resolvedBy (the user who picked)",
      });
    }
  });
export type ConflictResolutionRecord = z.infer<typeof ConflictResolutionRecordSchema>;

export interface ConflictDetectionInput {
  readonly localUpdatedAt: string;
  readonly serverUpdatedAt: string;
  readonly hasUnsyncedLocalChanges: boolean;
}

export function hasConflict(input: ConflictDetectionInput): boolean {
  if (!input.hasUnsyncedLocalChanges) return false;
  return new Date(input.serverUpdatedAt).getTime() > new Date(input.localUpdatedAt).getTime();
}

export function applyLastWriteWins(input: ConflictDetectionInput): "local" | "server" {
  const localMs = new Date(input.localUpdatedAt).getTime();
  const serverMs = new Date(input.serverUpdatedAt).getTime();
  return localMs >= serverMs ? "local" : "server";
}

export function advanceWatermark(
  current: SyncWatermark | null,
  operations: readonly SyncDeltaOperation[],
): SyncWatermark | null {
  let maxUpdatedAt = current?.updatedAtCursor ?? null;
  const tenantId = current?.tenantId ?? null;
  let entity = current?.entity ?? null;
  for (const op of operations) {
    const ts = op.op === "upsert" ? op.updatedAt : op.deletedAt;
    if (maxUpdatedAt === null || new Date(ts).getTime() > new Date(maxUpdatedAt).getTime()) {
      maxUpdatedAt = ts;
      entity = op.entity;
    }
  }
  if (maxUpdatedAt === null || entity === null || tenantId === null) return current;
  return { tenantId, entity, updatedAtCursor: maxUpdatedAt };
}
