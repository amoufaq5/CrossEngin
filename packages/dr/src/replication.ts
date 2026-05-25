import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";
import { DrTierSchema, ReplicationKindSchema, type DrTierSpec } from "./tiers.js";

const Iso8601 = z.string().datetime({ offset: true });

export const REPLICA_ROLES = [
  "primary",
  "standby_sync",
  "standby_async",
  "snapshot_only",
  "cold",
] as const;
export type ReplicaRole = (typeof REPLICA_ROLES)[number];
export const ReplicaRoleSchema = z.enum(REPLICA_ROLES);

export const ReplicationEdgeSchema = z
  .object({
    source: RegionSchema,
    target: RegionSchema,
    kind: ReplicationKindSchema,
    tier: DrTierSchema,
    laggingThresholdSeconds: z.number().int().nonnegative(),
    targetRole: ReplicaRoleSchema,
  })
  .superRefine((v, ctx) => {
    if (v.source === v.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "replication source and target must be different regions",
      });
    }
    if (v.kind === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "replication edge with kind='none' makes no sense; remove the edge",
      });
    }
    if (v.kind === "sync" && v.targetRole !== "standby_sync") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRole"],
        message: "sync replication requires targetRole='standby_sync'",
      });
    }
    if (v.kind === "snapshot" && v.targetRole !== "snapshot_only") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRole"],
        message: "snapshot replication requires targetRole='snapshot_only'",
      });
    }
  });
export type ReplicationEdge = z.infer<typeof ReplicationEdgeSchema>;

export const ReplicationTopologySchema = z
  .array(ReplicationEdgeSchema)
  .superRefine((edges, ctx) => {
    const pairs = new Set<string>();
    edges.forEach((e, i) => {
      const key = `${e.source}->${e.target}`;
      if (pairs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `duplicate replication edge '${key}'`,
        });
      }
      pairs.add(key);
    });
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge === undefined) continue;
      const reverseKey = `${edge.target}->${edge.source}`;
      if (pairs.has(reverseKey)) {
        const reverse = edges.find((e) => e.source === edge.target && e.target === edge.source);
        if (
          reverse !== undefined &&
          reverse.kind === edge.kind &&
          (edge.kind === "sync" || edge.kind === "async")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `bidirectional ${edge.kind} replication between '${edge.source}' and '${edge.target}' creates a write loop`,
          });
        }
      }
    }
  });
export type ReplicationTopology = z.infer<typeof ReplicationTopologySchema>;

export const ReplicationLagRecordSchema = z
  .object({
    source: RegionSchema,
    target: RegionSchema,
    measuredAt: Iso8601,
    lagBytes: z.number().int().nonnegative(),
    lagSeconds: z.number().nonnegative(),
    status: z.enum(["healthy", "lagging", "broken", "paused"]),
    lastErrorMessage: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "broken" && v.lastErrorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastErrorMessage"],
        message: "broken replication must record lastErrorMessage",
      });
    }
  });
export type ReplicationLagRecord = z.infer<typeof ReplicationLagRecordSchema>;

export function isLagAcceptable(record: ReplicationLagRecord, edge: ReplicationEdge): boolean {
  if (record.status === "broken" || record.status === "paused") return false;
  return record.lagSeconds <= edge.laggingThresholdSeconds;
}

export function targetsFor(topology: ReplicationTopology, source: Region): readonly Region[] {
  return topology.filter((e) => e.source === source).map((e) => e.target);
}

export function sourcesFor(topology: ReplicationTopology, target: Region): readonly Region[] {
  return topology.filter((e) => e.target === target).map((e) => e.source);
}

export function violatesTier(record: ReplicationLagRecord, spec: DrTierSpec): boolean {
  return record.lagSeconds > spec.maxRpoSeconds;
}
