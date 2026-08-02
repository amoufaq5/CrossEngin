import { z } from "zod";

/**
 * The entitlement limits a plan grants. Structurally the value a `PlanLimitsLookup`
 * returns, so a `PlanCatalog` can feed the Stripe webhook connector directly.
 */
export interface PlanLimits {
  readonly maxRecordsPerEntity?: number;
  readonly features?: readonly string[];
}

/** Resolves a plan (or Stripe price) id to its entitlement limits, or `undefined` if unknown. */
export type PlanLimitsLookup = (planId: string) => PlanLimits | undefined;

export const PlanDefinitionSchema = z.object({
  /** Stable plan id (e.g. `free`, `pro`, `enterprise`). */
  id: z.string().min(1),
  /** Human-facing plan name for the console. */
  name: z.string().min(1),
  /** Per-entity record cap; omit for unlimited. */
  maxRecordsPerEntity: z.number().int().nonnegative().optional(),
  /** Feature flags the plan grants. */
  features: z.array(z.string().min(1)).default([]),
  /** Stripe price ids that map to this plan (so a subscription event resolves by price). */
  stripePriceIds: z.array(z.string().min(1)).default([]),
});
export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>;

export const PlanCatalogDocumentSchema = z.object({
  plans: z.array(PlanDefinitionSchema).min(1),
});
export type PlanCatalogDocument = z.infer<typeof PlanCatalogDocumentSchema>;

/**
 * A declarative plan catalog: the single source of truth mapping a plan id — or a Stripe
 * price id — to its entitlement limits (record cap + features). Both the offline license
 * minter and the cloud Stripe webhook draw limits from the same catalog, and the console
 * reads it to render a plan's caps.
 */
export class PlanCatalog {
  private readonly byId: Map<string, PlanDefinition>;
  private readonly byPriceId: Map<string, PlanDefinition>;

  constructor(plans: readonly PlanDefinition[]) {
    this.byId = new Map();
    this.byPriceId = new Map();
    for (const plan of plans) {
      this.byId.set(plan.id, plan);
      for (const priceId of plan.stripePriceIds) this.byPriceId.set(priceId, plan);
    }
  }

  get plans(): readonly PlanDefinition[] {
    return [...this.byId.values()];
  }

  /** Resolve a plan by its id, falling back to a Stripe price id it maps to. */
  resolve(planId: string): PlanDefinition | undefined {
    return this.byId.get(planId) ?? this.byPriceId.get(planId);
  }

  limitsFor(planId: string): PlanLimits | undefined {
    const plan = this.resolve(planId);
    if (plan === undefined) return undefined;
    const limits: { maxRecordsPerEntity?: number; features?: readonly string[] } = {};
    if (plan.maxRecordsPerEntity !== undefined) limits.maxRecordsPerEntity = plan.maxRecordsPerEntity;
    if (plan.features.length > 0) limits.features = plan.features;
    return limits;
  }

  /** A `PlanLimitsLookup` usable directly as the Stripe webhook's `planLimits`. */
  toLookup(): PlanLimitsLookup {
    return (planId) => this.limitsFor(planId);
  }
}

/** Parses + validates a `{plans:[...]}` document into a `PlanCatalog`. */
export function buildPlanCatalog(doc: unknown): PlanCatalog {
  return new PlanCatalog(PlanCatalogDocumentSchema.parse(doc).plans);
}

/**
 * The built-in default catalog — a sensible free / pro / enterprise ladder. A deployment
 * overrides it with its own document (its Stripe price ids, its caps) via `buildPlanCatalog`.
 */
export const DEFAULT_PLAN_CATALOG = new PlanCatalog([
  { id: "free", name: "Free", maxRecordsPerEntity: 1000, features: ["core"], stripePriceIds: [] },
  {
    id: "pro",
    name: "Pro",
    maxRecordsPerEntity: 100000,
    features: ["core", "advanced_reporting", "api_access"],
    stripePriceIds: [],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    features: ["core", "advanced_reporting", "api_access", "sso", "audit_export"],
    stripePriceIds: [],
  },
]);
