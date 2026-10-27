import { z } from "zod";
import { TestKindSchema, type TestKind } from "./test-kinds.js";

const JOB_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const CI_JOB_TRIGGERS = ["pull_request", "push_main", "schedule", "manual"] as const;
export type CiJobTrigger = (typeof CI_JOB_TRIGGERS)[number];

/**
 * The two things a CI step can be: third-party code, or a command this repository wrote.
 *
 * Deliberately **no `CI_STEP_KINDS` array beside this**. One shipped briefly and was deleted in the
 * same increment's review: it had one reader — a test asserting it equalled its own literal — and
 * `CiStepKind` had none, while the schema below spells its members with `z.literal(...)` and never
 * read the array, so a third member added to one and not the other was not a compile error. A
 * constant nobody can get wrong is the point; a constant that merely exists is the class this
 * repository keeps finding, and here it was a *parallel* spelling of the discriminator rather than a
 * fence over it.
 *
 * The forcing function is where it already was and is checkable: `renderDeclaredStep` reads
 * `step.kind === "action" ? step.uses : step.run`, so a third member carrying neither field is a
 * **type error** there rather than a silent mis-render, and `ci.test.ts` asserts the membership by
 * reading `CiStepSchema.options` — the thing that defines the vocabulary — so a third member is a
 * test failure in the one file that would then have to consider the renderers.
 */
export const CiStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    /** `owner/name@ref`. The ref is part of the identity: a floating action is third-party code. */
    uses: z.string().min(1),
    /**
     * The action's inputs, flat and as **strings**.
     *
     * Strings and not `unknown`, because the two inputs that matter here — a pnpm version and a
     * Node version — are exactly the pins a reader of this declaration wants to check, and YAML
     * renders both as bare scalars that a text reader sees as text either way. A richer type would
     * only move the coercion somewhere a comparison could disagree about it.
     */
    with: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    kind: z.literal("command"),
    /**
     * One shell command, on one line.
     *
     * Single-line is a constraint on the *artifact* and not a limitation of the type: a multi-line
     * `run: |` block cannot be compared against a declaration as one string, and comparing only its
     * first line would understate — which is the direction a fence must never fail in. The reader
     * refuses such a block by name rather than reading part of it.
     */
    run: z.string().min(1),
  }),
]);
export type CiStep = z.infer<typeof CiStepSchema>;

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
    /** The runner image. Declared so a change to it is a change to this file. */
    runsOn: z.string().min(1).default("ubuntu-latest"),
    /**
     * The job's steps in order. Defaulted to `[]` so a pipeline that declares only budgets and a
     * dependency graph — which is every use of this schema before `CI_PIPELINE` existed — still
     * parses; a pipeline a workflow file is compared against declares them.
     */
    steps: z.array(CiStepSchema).default([]),
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
      job.dependsOn.length === 0
        ? 0
        : Math.max(...job.dependsOn.map((d) => durationTo(d)));
    const total = depMax + job.targetMinutes;
    memo.set(id, total);
    return total;
  }

  return Math.max(...pipeline.jobs.map((j) => durationTo(j.id)));
}

export function fitsBudget(pipeline: CiPipeline, trigger: CiJobTrigger): boolean {
  const budget =
    trigger === "pull_request"
      ? pipeline.pullRequestTargetMinutes
      : pipeline.pushMainTargetMinutes;
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

/* ------------------------------------------------------------ this repo's own pipeline */

/**
 * The measured seconds of each command step `CI_PIPELINE` declares, keyed by the command itself.
 *
 * It exists so `targetMinutes` is **derived from a measurement rather than hand-typed**, which is
 * what makes the budget check fire from something other than itself. Before it, `targetMinutes: 9`
 * was a literal and `criticalPathMinutes(CI_PIPELINE)` — one job, so the critical path *is* that
 * literal — was compared against it by a test: the declaration against itself, which is ADR-0361's
 * check-that-cannot-fire inside the increment citing it.
 *
 * `null` is the **claim** and not an omission (ADR-0331): `pnpm install --frozen-lockfile` is
 * deliberately unmeasured, because it could not be timed on the host these figures were taken on
 * without rewriting a `node_modules` three other agents were reading, and a minute count nobody
 * derived inside a budget check is the defect this repository has found most often. So the sum
 * bounds **the suite** and makes no claim about a pull request's wall clock.
 *
 * Timed **cold** on a 4-vCPU/15 GiB host at `01fda10`, which is the figure a CI runner pays; the
 * warm figure for the first of them lives in `.githooks/pre-commit`, the one place it decides
 * anything. `measuredStepDisagreements` compares these keys against the declared command steps **in
 * both directions**, so a fifth sweep added to the pipeline is a test failure until somebody
 * measures it, and a figure for a command no job runs is a failure too.
 */
export const CI_MEASURED_STEP_SECONDS: Readonly<Record<string, number | null>> = Object.freeze({
  "pnpm install --frozen-lockfile": null,
  "pnpm --filter @crossengin/testing test": 46.2,
  "pnpm -r build": 149.3,
  "pnpm -r typecheck": 130.7,
  "pnpm -r test": 200.5,
});

/** The measured sum, excluding every step whose figure is the `null` claim above. */
export function measuredSuiteSeconds(): number {
  return Object.values(CI_MEASURED_STEP_SECONDS).reduce<number>((a, s) => a + (s ?? 0), 0);
}

/**
 * Both directions of the link between the measurement and the pipeline.
 *
 * An empty array is the only passing result. A command step with no figure is the half that matters
 * — without it the budget silently keeps describing a shorter suite than the one that runs — and the
 * other half is kept because a one-way comparison is what ADR-0335's original defect was made of.
 */
export function measuredStepDisagreements(pipeline: CiPipeline): readonly string[] {
  const declared = new Set(
    pipeline.jobs
      .flatMap((j) => j.steps)
      .flatMap((s) => (s.kind === "command" ? [s.run] : [])),
  );
  const measured = new Set(Object.keys(CI_MEASURED_STEP_SECONDS));
  const out: string[] = [];
  for (const run of declared) {
    if (!measured.has(run)) {
      out.push(`no figure in CI_MEASURED_STEP_SECONDS for declared command step '${run}'`);
    }
  }
  for (const run of measured) {
    if (!declared.has(run)) {
      out.push(`CI_MEASURED_STEP_SECONDS has a figure for '${run}', which no job declares`);
    }
  }
  return out.sort();
}

/**
 * The pipeline `.github/workflows/ci.yml` is required to be, and the first reader this module has
 * ever had: every one of its twelve exports was measured at zero external references before
 * ADR-0382, so the budget, the dependency graph and the schemas described a CI that did not exist.
 *
 * **One job and not four, because that is what the workflow is.** The four sweeps are *steps* in one
 * sequential `runs-on` block, so one `CiJob` with four `command` steps is the faithful encoding, and
 * four jobs chained by `dependsOn` would be a declaration that does not describe the artifact —
 * which is this increment's own defect class. It also keeps `targetMinutes` to a single rounding:
 * `CiJob.targetMinutes` is `z.number().int()`, so four jobs would need four ceilings and their sum
 * (1 + 3 + 3 + 4 = 11) exceeds a budget the measured total does not.
 *
 * **The step order is the design.** `pnpm --filter @crossengin/testing test` runs *before* the
 * build, and it can, because `@crossengin/testing` needs nothing built. Three measurements, and the
 * first is the decisive one: its `package.json` lists exactly **one** workspace dependency,
 * `@crossengin/config`, as a **devDependency** — and that package has no `src/` and **no `scripts`
 * at all**, so `pnpm -r build` produces nothing for it and the `extends` in `tsconfig.json`
 * resolves a committed JSON file. Second, there are **zero** real `import … from "@crossengin/…"`
 * statements anywhere under `packages/testing/src`: 23 textual occurrences of `from "@crossengin/`,
 * of which 20 are string literals inside `*.test.ts` fixtures (8 distinct specifiers) and **3 are
 * doc comments** — `pg-value-set-domains.ts`, `pg-column-bindings.ts`, and this sentence, which is
 * therefore its own counterexample. An earlier version of this paragraph said all of them were test
 * fixtures; the conclusion held and the stated measurement did not, which is why the breakdown is
 * written out rather than summarised. Third, its own `vitest.config.ts:1` reads
 * `./src/vitest-preset.js` rather than the `dist` export the other 87 of the 88 members holding
 * such a config resolve through. So the rules read the workspace as text and need nothing built.
 * They are **redundant for coverage** — `pnpm -r test` includes them — and are bought purely for
 * fail-fast, with the arithmetic shown so it is checkable: a drifting pull request surfaces the
 * failure at 46 s rather than after build + typecheck + test have all run
 * (149.3 + 130.7 + 200.5 = 480.5 s), so **+46 s on a green pull request against −434 s on a
 * drifting one**.
 *
 * **`targetMinutes` is derived from `CI_MEASURED_STEP_SECONDS`, and excludes install.** The four
 * sweeps sum to 526.7 s, 8.78 min, ceiling **9** — and the ceiling is computed here rather than
 * typed, which is the whole of what makes the budget check fire from something other than itself.
 *
 * **What the check can see, stated exactly, because the alternative is a falsely-true control.**
 * `fitsBudget` compares two *declared* numbers, and with one job `criticalPathMinutes` **is**
 * `targetMinutes`. So it fires on exactly two events, both real and both reachable: a **new command
 * step**, which `measuredStepDisagreements` refuses until it carries a figure; and a
 * **re-measurement** that pushes the sum past 600 s, since `ceil(601/60)` is 11 against a budget of
 * 10. The slack is therefore 73.3 s — the 1.22 minutes this comment used to call "real growth",
 * which was the right arithmetic under a word that claimed more than the mechanism does.
 *
 * **What it cannot see: an existing step getting slower.** Nothing here times a run, so a `pnpm -r
 * test` that drifts from 200 s to 500 s leaves `fitsBudget` true for ever. The mechanism that would
 * catch it is the runner's, `timeout-minutes:` on the job, and it is a **named follow-up with its
 * refutation** rather than an omission: the job's wall clock is install + the suite, install is the
 * `null` above, and `timeout-minutes: 10` against an 8.78-minute suite would red the *first green*
 * pull request on install latency alone — ADR-0382's own argument against the lint job, that
 * shipping a CI which fails on arrival teaches people to ignore it. A *generous* ceiling is honest
 * and enforceable and enforces a different claim (this job does not hang), and landing it needs a
 * `CiJob` field, a fifth member of `CI_JOB_YAML_KEYS` and a sixteenth finding kind — today the fence
 * **reports** such a key as `job_key_undeclared` rather than forbidding it, which is the demand for
 * a declaration surface working as designed.
 *
 * When the check does fire the remedy is one of two, and naming them is the point: split `build`
 * into its own job and fan `typecheck`/`test` out behind it — refused today on the measurement in
 * ADR-0382, because `dist/` is gitignored and crossing a job boundary needs a content-addressed
 * cache whose stale hit is ADR-0307's conditional green — or raise `FAST_CI_BUDGET_MINUTES`, which
 * is a decision about the budget and not about the pipeline.
 */
export const CI_PIPELINE: CiPipeline = CiPipelineSchema.parse({
  name: "ci",
  jobs: [
    {
      id: "verify",
      /**
       * One of the ten `TEST_KINDS`, measured rather than aspirational: over the 771 `*.test.ts`
       * files in `packages/` and `apps/` on 2026-10-26, `toMatchSnapshot`/`toMatchInlineSnapshot`
       * occurs in 0, `fast-check` in 0, `playwright`/`puppeteer` in 0, `axe-core`/`jest-axe` in 0
       * and `new Pool`/`new Client`/`from "pg"` in 0. So the sweep is unit tests, and declaring any
       * other kind here would claim coverage no file provides.
       *
       * **Excluding `ci-workflow.test.ts`, which is the file that records the measurement.** Re-run
       * naively, every one of those five patterns now returns exactly 1 — that file, matching each
       * of them in the comment explaining this figure. This repository's most-found class, landing
       * on its own census, so the exclusion is part of the measurement rather than a footnote to it.
       */
      runs: ["unit"],
      triggers: ["pull_request", "push_main"],
      /**
       * Empty is the **claim** and not an omission (ADR-0331's distinction): the 0 pg-client hits
       * above — under the same exclusion — are why no `services:` block is needed, and the audit
       * reports a workflow that grows one without this list growing with it.
       */
      requiresServices: [],
      /**
       * Derived, never supplied — see `CI_MEASURED_STEP_SECONDS`. `ceil(526.7 / 60) = 9`.
       *
       * A literal here was what made the budget check compare the declaration against itself, and
       * the derivation is what gives it a triggering event: a re-measurement past 600 s makes this
       * 11 and `budget_exceeded` fires.
       */
      targetMinutes: Math.ceil(measuredSuiteSeconds() / 60),
      steps: [
        { kind: "action", uses: "actions/checkout@v4" },
        // Before `setup-node`, not after: `setup-node`'s `cache: pnpm` resolves the store path by
        // running pnpm, so the reverse order fails at the cache step rather than at install.
        { kind: "action", uses: "pnpm/action-setup@v4", with: { version: "9.12.0" } },
        // Node 20 and not the 22.22.2 this machine runs, on two measurements that agree:
        // `package.json`'s `engines.node` is `">=20"`, so 20 is the floor the repository promises,
        // and `deploy/Dockerfile:6` is `FROM node:20-bookworm-slim`, so 20 is the only version
        // anything deploys. Testing the floor tests the promise; pinning 22 would test a version no
        // image runs. Floating within the major for the same reason the image does — a patch pin
        // goes stale on every Node security release and says nothing extra.
        { kind: "action", uses: "actions/setup-node@v4", with: { "node-version": "20", cache: "pnpm" } },
        { kind: "command", run: "pnpm install --frozen-lockfile" },
        { kind: "command", run: "pnpm --filter @crossengin/testing test" },
        { kind: "command", run: "pnpm -r build" },
        { kind: "command", run: "pnpm -r typecheck" },
        { kind: "command", run: "pnpm -r test" },
      ],
    },
  ],
});
