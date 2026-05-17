import { z } from "zod";
import { SEARCH_ENGINES, type SearchEngine } from "./query.js";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const REINDEX_SCOPES = ["tenant", "entity", "file", "manifest_section"] as const;
export type ReindexScope = (typeof REINDEX_SCOPES)[number];

export const REINDEX_REASONS = [
  "manifest_indexed_fields_changed",
  "embedding_model_upgraded",
  "drift_detected",
  "admin_force_reindex",
  "compliance_pack_changed",
] as const;
export type ReindexReason = (typeof REINDEX_REASONS)[number];

export const REINDEX_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ReindexStatus = (typeof REINDEX_STATUSES)[number];

export const ReindexRequestSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    engine: z.enum(SEARCH_ENGINES),
    scope: z.enum(REINDEX_SCOPES),
    scopeTarget: z.string().min(1).optional(),
    reason: z.enum(REINDEX_REASONS),
    requestedBy: Uuid,
    requestedAt: Iso8601,
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  })
  .superRefine((v, ctx) => {
    if (v.scope !== "tenant" && v.scopeTarget === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeTarget"],
        message: `scope '${v.scope}' requires scopeTarget`,
      });
    }
    if (v.scope === "tenant" && v.scopeTarget !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeTarget"],
        message: "scope 'tenant' must not declare a scopeTarget",
      });
    }
  });
export type ReindexRequest = z.infer<typeof ReindexRequestSchema>;

export const ReindexProgressSchema = z.object({
  requestId: Uuid,
  status: z.enum(REINDEX_STATUSES),
  itemsTotal: z.number().int().nonnegative(),
  itemsProcessed: z.number().int().nonnegative(),
  startedAt: Iso8601.nullable().default(null),
  completedAt: Iso8601.nullable().default(null),
  errorMessage: z.string().min(1).nullable().default(null),
});
export type ReindexProgress = z.infer<typeof ReindexProgressSchema>;

export function isReindexComplete(progress: ReindexProgress): boolean {
  return (
    progress.status === "completed" ||
    progress.status === "failed" ||
    progress.status === "cancelled"
  );
}

export function reindexPercentComplete(progress: ReindexProgress): number {
  if (progress.itemsTotal === 0) return progress.status === "completed" ? 100 : 0;
  return Math.min(100, Math.round((progress.itemsProcessed / progress.itemsTotal) * 100));
}

export function nextEngineToReindex(
  engines: readonly SearchEngine[],
  completed: readonly SearchEngine[],
): SearchEngine | null {
  for (const engine of engines) {
    if (!completed.includes(engine)) return engine;
  }
  return null;
}
