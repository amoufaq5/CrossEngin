import { z } from "zod";

const Uuid = z.string().min(1);

export const ENTITY_OPERATIONS = ["list", "read", "create", "update", "delete"] as const;
export type EntityOperation = (typeof ENTITY_OPERATIONS)[number];

export const PermissionVerdictSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1).optional(),
  requiresAbac: z.string().min(1).optional(),
});
export type PermissionVerdict = z.infer<typeof PermissionVerdictSchema>;

export const EntityPermissionVerdictSchema = z.object({
  operations: z.record(z.enum(ENTITY_OPERATIONS), PermissionVerdictSchema),
  redactedFields: z.array(z.string().min(1)).default([]),
  writeMaskedFields: z.array(z.string().min(1)).default([]),
  availableTransitions: z.array(z.string().min(1)).default([]),
});
export type EntityPermissionVerdict = z.infer<typeof EntityPermissionVerdictSchema>;

export const PermissionDecisionSetSchema = z.object({
  principalId: Uuid,
  evaluatedAt: z.string().datetime({ offset: true }),
  entities: z.record(z.string().min(1), EntityPermissionVerdictSchema),
  instanceOverrides: z
    .array(
      z.object({
        entityName: z.string().min(1),
        instanceId: Uuid,
        verdict: EntityPermissionVerdictSchema,
      }),
    )
    .default([]),
});
export type PermissionDecisionSet = z.infer<typeof PermissionDecisionSetSchema>;

export function canPerform(
  decisions: PermissionDecisionSet,
  entityName: string,
  operation: EntityOperation,
  instanceId?: string,
): PermissionVerdict {
  if (instanceId !== undefined) {
    const override = decisions.instanceOverrides.find(
      (o) => o.entityName === entityName && o.instanceId === instanceId,
    );
    if (override !== undefined) {
      const verdict = override.verdict.operations[operation];
      if (verdict !== undefined) return verdict;
    }
  }
  const entityVerdict = decisions.entities[entityName];
  if (entityVerdict === undefined) {
    return { allowed: false, reason: `no permission entry for entity '${entityName}'` };
  }
  return (
    entityVerdict.operations[operation] ?? {
      allowed: false,
      reason: `no verdict for operation '${operation}'`,
    }
  );
}

export function isFieldRedacted(
  decisions: PermissionDecisionSet,
  entityName: string,
  fieldPath: string,
  instanceId?: string,
): boolean {
  if (instanceId !== undefined) {
    const override = decisions.instanceOverrides.find(
      (o) => o.entityName === entityName && o.instanceId === instanceId,
    );
    if (override !== undefined && override.verdict.redactedFields.includes(fieldPath)) {
      return true;
    }
  }
  const entityVerdict = decisions.entities[entityName];
  return entityVerdict?.redactedFields.includes(fieldPath) ?? false;
}

export function isFieldWriteMasked(
  decisions: PermissionDecisionSet,
  entityName: string,
  fieldPath: string,
  instanceId?: string,
): boolean {
  if (instanceId !== undefined) {
    const override = decisions.instanceOverrides.find(
      (o) => o.entityName === entityName && o.instanceId === instanceId,
    );
    if (override !== undefined && override.verdict.writeMaskedFields.includes(fieldPath)) {
      return true;
    }
  }
  const entityVerdict = decisions.entities[entityName];
  return entityVerdict?.writeMaskedFields.includes(fieldPath) ?? false;
}

export function availableTransitions(
  decisions: PermissionDecisionSet,
  entityName: string,
  instanceId?: string,
): readonly string[] {
  if (instanceId !== undefined) {
    const override = decisions.instanceOverrides.find(
      (o) => o.entityName === entityName && o.instanceId === instanceId,
    );
    if (override !== undefined) return override.verdict.availableTransitions;
  }
  const entityVerdict = decisions.entities[entityName];
  return entityVerdict?.availableTransitions ?? [];
}
