import { z } from "zod";

export const LIKELIHOODS = ["very_low", "low", "medium", "high", "very_high"] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export const IMPACTS = [
  "negligible",
  "minor",
  "moderate",
  "severe",
  "catastrophic",
] as const;
export type Impact = (typeof IMPACTS)[number];

export const LIKELIHOOD_ORDER: Readonly<Record<Likelihood, number>> = Object.freeze({
  very_low: 0,
  low: 1,
  medium: 2,
  high: 3,
  very_high: 4,
});

export const IMPACT_ORDER: Readonly<Record<Impact, number>> = Object.freeze({
  negligible: 0,
  minor: 1,
  moderate: 2,
  severe: 3,
  catastrophic: 4,
});

export const ThreatEntrySchema = z.object({
  id: z.string().min(1),
  threat: z.string().min(1),
  likelihood: z.enum(LIKELIHOODS),
  impact: z.enum(IMPACTS),
  primaryMitigation: z.string().min(1),
  secondaryMitigations: z.array(z.string().min(1)).default([]),
  references: z.array(z.string().min(1)).default([]),
  residualRisk: z.enum(LIKELIHOODS).optional(),
});
export type ThreatEntry = z.infer<typeof ThreatEntrySchema>;

export const ThreatModelSchema = z
  .array(ThreatEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((e, i) => {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate threat id '${e.id}'`,
        });
      }
      seen.add(e.id);
    });
  });
export type ThreatModel = z.infer<typeof ThreatModelSchema>;

export function riskScore(entry: ThreatEntry): number {
  return LIKELIHOOD_ORDER[entry.likelihood] * IMPACT_ORDER[entry.impact];
}

export function sortByRisk(model: ThreatModel): readonly ThreatEntry[] {
  return [...model].sort((a, b) => riskScore(b) - riskScore(a));
}
