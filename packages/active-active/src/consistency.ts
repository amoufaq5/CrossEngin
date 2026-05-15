import { z } from "zod";

export const CONSISTENCY_LEVELS = [
  "eventual",
  "monotonic_read",
  "read_your_writes",
  "monotonic_writes",
  "bounded_staleness",
  "linearizable",
  "session",
] as const;
export type ConsistencyLevel = (typeof CONSISTENCY_LEVELS)[number];
export const ConsistencyLevelSchema = z.enum(CONSISTENCY_LEVELS);

export const CONSISTENCY_RANK: Readonly<Record<ConsistencyLevel, number>> = Object.freeze({
  eventual: 0,
  monotonic_read: 1,
  monotonic_writes: 1,
  read_your_writes: 2,
  session: 3,
  bounded_staleness: 4,
  linearizable: 5,
});

export const OPERATION_KINDS = [
  "read",
  "read_index",
  "write_insert",
  "write_update",
  "write_delete",
  "transactional_multi",
  "read_modify_write",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];
export const OperationKindSchema = z.enum(OPERATION_KINDS);

const MIN_BOUNDED_STALENESS_MS = 100;
const MAX_BOUNDED_STALENESS_MS = 60_000;

export const ConsistencyPolicySchema = z
  .object({
    operationKind: OperationKindSchema,
    level: ConsistencyLevelSchema,
    boundedStalenessMs: z.number().int().min(MIN_BOUNDED_STALENESS_MS).max(MAX_BOUNDED_STALENESS_MS).optional(),
    requiresQuorum: z.boolean().default(false),
    quorumSize: z.number().int().min(2).optional(),
    overrideAllowed: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.level === "bounded_staleness" && v.boundedStalenessMs === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundedStalenessMs"],
        message: "level='bounded_staleness' requires boundedStalenessMs",
      });
    }
    if (v.level !== "bounded_staleness" && v.boundedStalenessMs !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundedStalenessMs"],
        message: "boundedStalenessMs only valid for level='bounded_staleness'",
      });
    }
    if (v.requiresQuorum && v.quorumSize === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quorumSize"],
        message: "requiresQuorum=true requires quorumSize",
      });
    }
    if (v.level === "linearizable" && !v.requiresQuorum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresQuorum"],
        message: "linearizable consistency requires quorum",
      });
    }
    const writeOps: ReadonlySet<OperationKind> = new Set([
      "write_insert",
      "write_update",
      "write_delete",
      "transactional_multi",
      "read_modify_write",
    ]);
    if (writeOps.has(v.operationKind) && v.level === "eventual") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: "write operations cannot use level='eventual' (eventual is a read concept; use monotonic_writes or stricter)",
      });
    }
    if (v.operationKind === "read_modify_write" && v.level === "monotonic_read") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: "read_modify_write requires at least read_your_writes (monotonic_read is insufficient)",
      });
    }
  });
export type ConsistencyPolicy = z.infer<typeof ConsistencyPolicySchema>;

export const ConsistencyPolicySetSchema = z
  .array(ConsistencyPolicySchema)
  .superRefine((policies, ctx) => {
    const seen = new Set<OperationKind>();
    policies.forEach((p, i) => {
      if (seen.has(p.operationKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "operationKind"],
          message: `duplicate operationKind '${p.operationKind}'`,
        });
      }
      seen.add(p.operationKind);
    });
  });
export type ConsistencyPolicySet = z.infer<typeof ConsistencyPolicySetSchema>;

export function compareLevel(
  a: ConsistencyLevel,
  b: ConsistencyLevel,
): number {
  return CONSISTENCY_RANK[a] - CONSISTENCY_RANK[b];
}

export function isStrongerOrEqual(
  required: ConsistencyLevel,
  provided: ConsistencyLevel,
): boolean {
  return CONSISTENCY_RANK[provided] >= CONSISTENCY_RANK[required];
}

export function policyFor(
  set: ConsistencyPolicySet,
  operationKind: OperationKind,
): ConsistencyPolicy | null {
  return set.find((p) => p.operationKind === operationKind) ?? null;
}

export function defaultPolicySet(): ConsistencyPolicySet {
  return [
    {
      operationKind: "read",
      level: "eventual",
      requiresQuorum: false,
      overrideAllowed: true,
    },
    {
      operationKind: "read_index",
      level: "eventual",
      requiresQuorum: false,
      overrideAllowed: true,
    },
    {
      operationKind: "write_insert",
      level: "read_your_writes",
      requiresQuorum: false,
      overrideAllowed: false,
    },
    {
      operationKind: "write_update",
      level: "read_your_writes",
      requiresQuorum: false,
      overrideAllowed: false,
    },
    {
      operationKind: "write_delete",
      level: "read_your_writes",
      requiresQuorum: false,
      overrideAllowed: false,
    },
    {
      operationKind: "transactional_multi",
      level: "linearizable",
      requiresQuorum: true,
      quorumSize: 2,
      overrideAllowed: false,
    },
    {
      operationKind: "read_modify_write",
      level: "read_your_writes",
      requiresQuorum: false,
      overrideAllowed: false,
    },
  ];
}
