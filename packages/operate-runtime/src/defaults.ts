import type { Entity } from "@crossengin/types/meta-schema";

/** A field whose manifest `default.kind === "literal"` value is applied on create. */
export interface LiteralDefaultPlan {
  readonly field: string;
  readonly value: unknown;
}

/** Extracts the literal-default field plans for an entity (lifecycle state, enums, flags). */
export function literalDefaultPlans(entity: Entity): readonly LiteralDefaultPlan[] {
  const plans: LiteralDefaultPlan[] = [];
  for (const f of entity.fields) {
    if (f.default?.kind === "literal") {
      plans.push({ field: f.name, value: f.default.value });
    }
  }
  return plans;
}

/**
 * Fills in literal defaults for any field the caller omitted, so a created record
 * carries its declared baseline (notably the lifecycle `state`, which the entity
 * stores and the gateway transitions read). Caller-supplied values always win;
 * an explicit `null` is treated as provided and left untouched.
 */
export function applyLiteralDefaults(
  record: Record<string, unknown>,
  plans: readonly LiteralDefaultPlan[],
): Record<string, unknown> {
  if (plans.length === 0) return record;
  const out = { ...record };
  for (const plan of plans) {
    if (!(plan.field in out)) out[plan.field] = plan.value;
  }
  return out;
}
