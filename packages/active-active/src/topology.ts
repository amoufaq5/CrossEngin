import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

export const TOPOLOGY_KINDS = [
  "single_primary",
  "active_passive",
  "active_active",
  "multi_master_partitioned",
] as const;
export type TopologyKind = (typeof TOPOLOGY_KINDS)[number];
export const TopologyKindSchema = z.enum(TOPOLOGY_KINDS);

export const REGION_ROLES = [
  "writer_primary",
  "writer_secondary",
  "reader_only",
  "snapshot_only",
  "isolated",
] as const;
export type RegionRole = (typeof REGION_ROLES)[number];
export const RegionRoleSchema = z.enum(REGION_ROLES);

export const PARTITION_STRATEGIES = [
  "tenant_hash",
  "tenant_residency",
  "entity_class",
  "row_hash",
  "geographic",
] as const;
export type PartitionStrategy = (typeof PARTITION_STRATEGIES)[number];

const ENTITY_CLASS_REGEX = /^[a-z][a-z0-9_]*$/;

export const RegionParticipationSchema = z
  .object({
    region: RegionSchema,
    role: RegionRoleSchema,
    acceptedEntityClasses: z.array(z.string().regex(ENTITY_CLASS_REGEX)).default([]),
    acceptsWritesFor: z.array(z.string().regex(ENTITY_CLASS_REGEX)).default([]),
    weight: z.number().int().min(0).max(100).default(50),
    healthCheckSeconds: z.number().int().min(1).max(300).default(15),
  })
  .superRefine((v, ctx) => {
    const writeRoles: ReadonlySet<RegionRole> = new Set(["writer_primary", "writer_secondary"]);
    if (writeRoles.has(v.role) && v.acceptsWritesFor.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptsWritesFor"],
        message: `role '${v.role}' must declare at least one acceptsWritesFor entity class`,
      });
    }
    if (!writeRoles.has(v.role) && v.acceptsWritesFor.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptsWritesFor"],
        message: `role '${v.role}' cannot declare acceptsWritesFor`,
      });
    }
    if (v.role === "isolated" && v.acceptedEntityClasses.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedEntityClasses"],
        message: "isolated regions cannot accept entity classes",
      });
    }
    const seen = new Set<string>();
    for (const ec of v.acceptsWritesFor) {
      if (!v.acceptedEntityClasses.includes(ec)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptsWritesFor"],
          message: `acceptsWritesFor entity class '${ec}' must also be in acceptedEntityClasses`,
        });
      }
      if (seen.has(ec)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptsWritesFor"],
          message: `duplicate entity class '${ec}'`,
        });
      }
      seen.add(ec);
    }
  });
export type RegionParticipation = z.infer<typeof RegionParticipationSchema>;

export const ActiveActiveTopologySchema = z
  .object({
    id: z.string().min(1),
    kind: TopologyKindSchema,
    partitionStrategy: z.enum(PARTITION_STRATEGIES),
    participations: z.array(RegionParticipationSchema).min(2),
    description: z.string().min(1),
    activatedAt: z.string().datetime({ offset: true }),
    activatedBy: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    const regions = new Set<Region>();
    v.participations.forEach((p, i) => {
      if (regions.has(p.region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations", i, "region"],
          message: `duplicate region '${p.region}'`,
        });
      }
      regions.add(p.region);
    });
    const primaries = v.participations.filter((p) => p.role === "writer_primary");
    const secondaries = v.participations.filter((p) => p.role === "writer_secondary");

    if (v.kind === "single_primary") {
      if (primaries.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message: "single_primary kind requires exactly one writer_primary",
        });
      }
      if (secondaries.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message: "single_primary kind cannot have writer_secondary regions",
        });
      }
    }
    if (v.kind === "active_passive") {
      if (primaries.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message: "active_passive kind requires exactly one writer_primary",
        });
      }
      if (secondaries.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message: "active_passive kind requires at least one writer_secondary as standby",
        });
      }
    }
    if (v.kind === "active_active") {
      const writers = primaries.length + secondaries.length;
      if (writers < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message: "active_active kind requires at least 2 writer regions",
        });
      }
      if (primaries.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message:
            "active_active kind cannot have more than one writer_primary (use writer_secondary for additional writers)",
        });
      }
    }
    if (v.kind === "multi_master_partitioned") {
      if (primaries.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participations"],
          message:
            "multi_master_partitioned kind requires >=2 writer_primary regions (one per partition)",
        });
      }
      const writeMap = new Map<string, Region>();
      for (const p of v.participations) {
        if (p.role === "writer_primary") {
          for (const ec of p.acceptsWritesFor) {
            const existing = writeMap.get(ec);
            if (existing !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["participations"],
                message: `multi_master_partitioned: entity class '${ec}' has multiple writer_primary regions (${existing} and ${p.region}); each partition needs exactly one`,
              });
            }
            writeMap.set(ec, p.region);
          }
        }
      }
    }
  });
export type ActiveActiveTopology = z.infer<typeof ActiveActiveTopologySchema>;

export function writerRegionsFor(
  topology: ActiveActiveTopology,
  entityClass: string,
): readonly Region[] {
  return topology.participations
    .filter((p) => p.acceptsWritesFor.includes(entityClass))
    .map((p) => p.region);
}

export function readerRegionsFor(
  topology: ActiveActiveTopology,
  entityClass: string,
): readonly Region[] {
  return topology.participations
    .filter((p) => p.acceptedEntityClasses.includes(entityClass))
    .map((p) => p.region);
}

export function isMultiWriter(topology: ActiveActiveTopology): boolean {
  const writers = topology.participations.filter(
    (p) => p.role === "writer_primary" || p.role === "writer_secondary",
  );
  return writers.length >= 2;
}
