import { z } from "zod";
import { HARD_REFUSALS, HardRefusalSchema } from "./refusals.js";

export const REDTEAM_CATEGORIES = [
  "prompt_injection",
  "jailbreak_forbidden_action",
  "social_engineering",
  "exfiltration",
  "cost_dos",
  "cross_tenant_probe",
] as const;
export type RedteamCategory = (typeof REDTEAM_CATEGORIES)[number];

export const REDTEAM_OUTCOMES = ["refused_correctly", "leaked", "errored", "compliant"] as const;
export type RedteamOutcome = (typeof REDTEAM_OUTCOMES)[number];

export const AdversarialTestCaseSchema = z
  .object({
    id: z.string().regex(/^rt-[a-z0-9-]+$/, {
      message: "test id must be 'rt-<kebab>'",
    }),
    category: z.enum(REDTEAM_CATEGORIES),
    summary: z.string().min(1),
    userMessage: z.string().min(1),
    expectedOutcome: z.enum(REDTEAM_OUTCOMES),
    expectedRefusal: HardRefusalSchema.optional(),
    forbidsToolCalls: z.array(z.string().min(1)).default([]),
    requiresCitationOfPack: z.string().min(1).optional(),
    severity: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
    addedAt: z.string().datetime({ offset: true }),
    addedBy: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.expectedOutcome === "refused_correctly" && v.expectedRefusal === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRefusal"],
        message: "tests expecting refusal must declare expectedRefusal",
      });
    }
    if (v.expectedOutcome !== "refused_correctly" && v.expectedRefusal !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRefusal"],
        message: "expectedRefusal applies only to refused_correctly outcomes",
      });
    }
  });
export type AdversarialTestCase = z.infer<typeof AdversarialTestCaseSchema>;

export const AdversarialTestSuiteSchema = z
  .array(AdversarialTestCaseSchema)
  .superRefine((cases, ctx) => {
    const ids = new Set<string>();
    cases.forEach((c, i) => {
      if (ids.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate redteam test id '${c.id}'`,
        });
      }
      ids.add(c.id);
    });
  });
export type AdversarialTestSuite = z.infer<typeof AdversarialTestSuiteSchema>;

export function coverageByCategory(
  suite: AdversarialTestSuite,
): Readonly<Record<RedteamCategory, number>> {
  const counts: Record<RedteamCategory, number> = {
    prompt_injection: 0,
    jailbreak_forbidden_action: 0,
    social_engineering: 0,
    exfiltration: 0,
    cost_dos: 0,
    cross_tenant_probe: 0,
  };
  for (const c of suite) {
    counts[c.category]++;
  }
  return counts;
}

export function coverageByRefusal(
  suite: AdversarialTestSuite,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const c of suite) {
    if (c.expectedRefusal !== undefined) covered.add(c.expectedRefusal);
  }
  return covered;
}

export function uncoveredRefusals(suite: AdversarialTestSuite): readonly string[] {
  const covered = coverageByRefusal(suite);
  return HARD_REFUSALS.filter((r) => !covered.has(r));
}
