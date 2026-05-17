import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

const COUNTRY_REGEX = /^[A-Z]{2}$/;
const ROUTING_RULE_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const ROUTING_STRATEGIES = [
  "geo_dns",
  "anycast",
  "latency_based",
  "region_pinned",
  "weighted",
] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];
export const RoutingStrategySchema = z.enum(ROUTING_STRATEGIES);

export const ROUTING_DECISIONS = [
  "primary",
  "failover",
  "blackhole",
  "redirect",
] as const;
export type RoutingDecision = (typeof ROUTING_DECISIONS)[number];

export const RegionWeightSchema = z.object({
  region: RegionSchema,
  weight: z.number().int().min(0).max(100),
});
export type RegionWeight = z.infer<typeof RegionWeightSchema>;

export const RoutingRuleSchema = z
  .object({
    id: z.string().regex(ROUTING_RULE_ID_REGEX),
    strategy: RoutingStrategySchema,
    priority: z.number().int().min(0),
    sourceCountries: z.array(z.string().regex(COUNTRY_REGEX)).default([]),
    sourceCidrs: z.array(z.string().min(1)).default([]),
    primaryRegions: z.array(RegionSchema).min(1),
    failoverRegions: z.array(RegionSchema).default([]),
    weights: z.array(RegionWeightSchema).default([]),
    decision: z.enum(ROUTING_DECISIONS).default("primary"),
    description: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const seenPrimary = new Set<Region>();
    v.primaryRegions.forEach((r, i) => {
      if (seenPrimary.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primaryRegions", i],
          message: `duplicate primary region '${r}'`,
        });
      }
      seenPrimary.add(r);
    });
    for (const r of v.failoverRegions) {
      if (seenPrimary.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failoverRegions"],
          message: `region '${r}' appears in both primaryRegions and failoverRegions`,
        });
      }
    }
    if (v.strategy === "weighted") {
      if (v.weights.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["weights"],
          message: "weighted strategy requires at least one weight",
        });
      }
      const totalWeight = v.weights.reduce((sum, w) => sum + w.weight, 0);
      if (totalWeight !== 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["weights"],
          message: `weighted strategy requires weights summing to 100, got ${totalWeight}`,
        });
      }
      const seen = new Set<Region>();
      v.weights.forEach((w, i) => {
        if (seen.has(w.region)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["weights", i, "region"],
            message: `duplicate region '${w.region}' in weights`,
          });
        }
        seen.add(w.region);
      });
    }
    if (v.strategy === "region_pinned" && v.primaryRegions.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryRegions"],
        message: "region_pinned strategy requires exactly one primary region",
      });
    }
    if (v.strategy === "geo_dns" && v.sourceCountries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceCountries"],
        message: "geo_dns strategy requires at least one source country",
      });
    }
    if (v.decision === "blackhole" && v.failoverRegions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failoverRegions"],
        message: "blackhole decision must not declare failover regions",
      });
    }
  });
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

export const RoutingTableSchema = z
  .array(RoutingRuleSchema)
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    rules.forEach((r, i) => {
      if (ids.has(r.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate routing rule id '${r.id}'`,
        });
      }
      ids.add(r.id);
    });
    const priorityToCountries = new Map<number, Set<string>>();
    rules.forEach((r, i) => {
      const bucket = priorityToCountries.get(r.priority) ?? new Set<string>();
      for (const country of r.sourceCountries) {
        if (bucket.has(country)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "sourceCountries"],
            message: `country '${country}' is matched by another rule at the same priority ${r.priority}`,
          });
        }
        bucket.add(country);
      }
      priorityToCountries.set(r.priority, bucket);
    });
  });
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

export function rulesForCountry(
  table: RoutingTable,
  country: string,
): readonly RoutingRule[] {
  return [...table]
    .filter(
      (r) =>
        r.sourceCountries.length === 0 || r.sourceCountries.includes(country),
    )
    .sort((a, b) => a.priority - b.priority);
}

export function pickRegion(
  rule: RoutingRule,
  random: number = Math.random(),
): Region | null {
  if (rule.decision === "blackhole") return null;
  if (rule.strategy === "weighted") {
    let cumulative = 0;
    const point = Math.floor(random * 100);
    for (const w of rule.weights) {
      cumulative += w.weight;
      if (point < cumulative) return w.region;
    }
    return rule.weights[rule.weights.length - 1]?.region ?? null;
  }
  return rule.primaryRegions[0] ?? null;
}
