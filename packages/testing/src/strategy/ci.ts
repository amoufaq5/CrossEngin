import { z } from "zod";
import { TestKindSchema, type TestKind } from "./test-kinds.js";

const JOB_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const CI_JOB_TRIGGERS = ["pull_request", "push_main", "schedule", "manual"] as const;
export type CiJobTrigger = (typeof CI_JOB_TRIGGERS)[number];

export const CiJobSchema = z
  .object({
    id: z.string().regex(JOB_ID_REGEX),
    runs: z.array(TestKindSchema).min(1),
    triggers: z.array(z.enum(CI_JOB_TRIGGERS)).min(1),
    requiresServices: z.array(z.string().min(1)).default([]),
    targetMinutes: z.number().int().positive().max(60),
    dependsOn: z.array(z.string().min(1)).default([]),
    parallelism: z.number().int().min(1).max(16).default(1),
    failOnUnstable: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.dependsOn.includes(v.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependsOn"],
        message: "a job cannot depend on itself",
      });
    }
  });
export type CiJob = z.infer<typeof CiJobSchema>;

export const CI_PIPELINE_BUDGET_MINUTES = 20;
export const FAST_CI_BUDGET_MINUTES = 10;

export const CiPipelineSchema = z
  .object({
    name: z.string().min(1),
    jobs: z.array(CiJobSchema).min(1),
    pullRequestTargetMinutes: z.number().int().positive().default(FAST_CI_BUDGET_MINUTES),
    pushMainTargetMinutes: z.number().int().positive().default(CI_PIPELINE_BUDGET_MINUTES),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    v.jobs.forEach((j, i) => {
      if (ids.has(j.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["jobs", i, "id"],
          message: `duplicate job id '${j.id}'`,
        });
      }
      ids.add(j.id);
    });
    for (const job of v.jobs) {
      for (const dep of job.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["jobs"],
            message: `job '${job.id}' depends on unknown job '${dep}'`,
          });
        }
      }
    }
  });
export type CiPipeline = z.infer<typeof CiPipelineSchema>;

export function topologicalOrder(pipeline: CiPipeline): readonly string[] {
  const byId = new Map(pipeline.jobs.map((j) => [j.id, j]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`cycle detected involving job '${id}'`);
    }
    visiting.add(id);
    const job = byId.get(id);
    if (job !== undefined) {
      for (const dep of job.dependsOn) {
        visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const job of pipeline.jobs) {
    visit(job.id);
  }
  return order;
}

export function criticalPathMinutes(pipeline: CiPipeline): number {
  const byId = new Map(pipeline.jobs.map((j) => [j.id, j]));
  const memo = new Map<string, number>();

  function durationTo(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const job = byId.get(id);
    if (job === undefined) return 0;
    const depMax =
      job.dependsOn.length === 0 ? 0 : Math.max(...job.dependsOn.map((d) => durationTo(d)));
    const total = depMax + job.targetMinutes;
    memo.set(id, total);
    return total;
  }

  return Math.max(...pipeline.jobs.map((j) => durationTo(j.id)));
}

export function fitsBudget(pipeline: CiPipeline, trigger: CiJobTrigger): boolean {
  const budget =
    trigger === "pull_request" ? pipeline.pullRequestTargetMinutes : pipeline.pushMainTargetMinutes;
  return criticalPathMinutes(pipeline) <= budget;
}

export function kindsCovered(pipeline: CiPipeline): ReadonlySet<TestKind> {
  const covered = new Set<TestKind>();
  for (const job of pipeline.jobs) {
    for (const kind of job.runs) {
      covered.add(kind);
    }
  }
  return covered;
}
