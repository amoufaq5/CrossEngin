import { z } from "zod";

export const TEST_KINDS = [
  "unit",
  "property",
  "snapshot",
  "integration",
  "e2e",
  "eval",
  "accessibility",
  "performance",
  "security",
  "visual_regression",
] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const TestKindSchema = z.enum(TEST_KINDS);

export const TEST_LEVEL_ORDER: Readonly<Record<TestKind, number>> = Object.freeze({
  unit: 0,
  property: 1,
  snapshot: 2,
  eval: 3,
  integration: 4,
  accessibility: 5,
  performance: 6,
  visual_regression: 7,
  e2e: 8,
  security: 9,
});

export const TEST_SEVERITIES = ["smoke", "critical", "regression", "exploratory"] as const;
export type TestSeverity = (typeof TEST_SEVERITIES)[number];

export const TestSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: "test id must be lowercase kebab-case",
    }),
    kind: TestKindSchema,
    severity: z.enum(TEST_SEVERITIES).default("regression"),
    description: z.string().min(1),
    package: z.string().regex(/^@crossengin\/[a-z][a-z0-9-]*$/),
    filePath: z.string().min(1),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    requiresService: z.array(z.string().min(1)).default([]),
    estimatedRuntimeMs: z.number().int().nonnegative(),
    quarantined: z.boolean().default(false),
    quarantineReason: z.string().min(1).optional(),
    flakeRate: z.number().min(0).max(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.quarantined && v.quarantineReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quarantineReason"],
        message: "quarantined tests must declare quarantineReason",
      });
    }
    if (!v.quarantined && v.quarantineReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quarantineReason"],
        message: "quarantineReason set on an active test (set quarantined=true or remove)",
      });
    }
  });
export type TestSpec = z.infer<typeof TestSpecSchema>;

export const TestSuiteSchema = z.array(TestSpecSchema).superRefine((specs, ctx) => {
  const ids = new Set<string>();
  specs.forEach((s, i) => {
    if (ids.has(s.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "id"],
        message: `duplicate test id '${s.id}'`,
      });
    }
    ids.add(s.id);
  });
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

export const PYRAMID_TARGET: Readonly<Record<TestKind, number>> = Object.freeze({
  unit: 10_000,
  property: 1_000,
  snapshot: 500,
  eval: 200,
  integration: 100,
  accessibility: 50,
  performance: 50,
  visual_regression: 200,
  e2e: 30,
  security: 20,
});

export interface PyramidShape {
  readonly kind: TestKind;
  readonly count: number;
  readonly target: number;
  readonly status: "under" | "ok" | "over";
}

export function evaluatePyramid(suite: TestSuite): readonly PyramidShape[] {
  const counts = new Map<TestKind, number>();
  for (const spec of suite) {
    if (spec.quarantined) continue;
    counts.set(spec.kind, (counts.get(spec.kind) ?? 0) + 1);
  }
  return TEST_KINDS.map((kind) => {
    const count = counts.get(kind) ?? 0;
    const target = PYRAMID_TARGET[kind];
    let status: "under" | "ok" | "over" = "ok";
    if (count < target * 0.1) status = "under";
    else if (count > target * 10) status = "over";
    return { kind, count, target, status };
  });
}

export function activeSuite(suite: TestSuite): readonly TestSpec[] {
  return suite.filter((s) => !s.quarantined);
}

export function quarantinedSuite(suite: TestSuite): readonly TestSpec[] {
  return suite.filter((s) => s.quarantined);
}
