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
    /**
     * Empty is a claim (ADR-0331): a job that runs no test at all, which is what a static-analysis
     * job is. It was `.min(1)` until a lint job existed, and a lint job forced to name a test kind
     * would claim coverage no file provides.
     */
    runs: z.array(TestKindSchema),
    triggers: z.array(z.enum(CI_JOB_TRIGGERS)).min(1),
    requiresServices: z.array(z.string().min(1)).default([]),
    targetMinutes: z.number().int().positive().max(60),
    dependsOn: z.array(z.string().min(1)).default([]),
    parallelism: z.number().int().min(1).max(16).default(1),
    failOnUnstable: z.boolean().default(true),
    /** The runner image. Declared so a change to it is a change to this file. */
    runsOn: z.string().min(1).default("ubuntu-latest"),
    /**
     * The runner's own `timeout-minutes:`, or `null` for none. A **does-not-hang bound and not the
     * budget**: `targetMinutes` is a measured figure excluding install, and a timeout near it would
     * red the first green run on install latency (the refutation recorded on `CI_PIPELINE`). So the
     * schema refuses one at or below the target, and the value shipped is generous on purpose.
     */
    timeoutMinutes: z.number().int().positive().max(360).nullable().default(null),
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
    if (v.timeoutMinutes !== null && v.timeoutMinutes <= v.targetMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeoutMinutes"],
        message:
          `a ${v.timeoutMinutes.toString()}-minute timeout is at or below the job's measured ` +
          `${v.targetMinutes.toString()}-minute target, which excludes install, so it would fail a ` +
          "healthy run; the timeout bounds a hang, not the budget",
      });
    }
  });
export type CiJob = z.infer<typeof CiJobSchema>;

/** The workflow's `permissions:` values, which are GitHub's three. */
export const CI_PERMISSION_LEVELS = ["read", "write", "none"] as const;

/**
 * The workflow's `concurrency:` block. `group` is compared as the literal the YAML holds, including
 * a `${{ … }}` expression, because the fence compares text and the expression is the meaning.
 */
export const CiConcurrencySchema = z
  .object({ group: z.string().min(1), cancelInProgress: z.boolean() })
  .strict();
export type CiConcurrency = z.infer<typeof CiConcurrencySchema>;

export const CI_PIPELINE_BUDGET_MINUTES = 20;
export const FAST_CI_BUDGET_MINUTES = 10;

export const CiPipelineSchema = z
  .object({
    name: z.string().min(1),
    jobs: z.array(CiJobSchema).min(1),
    pullRequestTargetMinutes: z.number().int().positive().default(FAST_CI_BUDGET_MINUTES),
    pushMainTargetMinutes: z.number().int().positive().default(CI_PIPELINE_BUDGET_MINUTES),
    /**
     * The workflow token's scopes, or `null` for no `permissions:` block (GitHub's default, which is
     * the repository's setting and may be `write-all`). Declared so a widening is a diff here.
     */
    permissions: z.record(z.enum(CI_PERMISSION_LEVELS)).nullable().default(null),
    concurrency: CiConcurrencySchema.nullable().default(null),
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
  // Warm on the same host, after an install: one registry round trip and the report. It runs before
  // anything slow, so a new high advisory fails a pull request in seconds.
  "pnpm audit --audit-level=high --prod": 3.8,
  "pnpm --filter @crossengin/testing test": 46.2,
  "pnpm -r build": 149.3,
  "pnpm -r typecheck": 130.7,
  "pnpm -r test": 200.5,
  // A clean `eslint .` over 1,056 files with the suppressions baseline, after a build: 91.8 s and
  // 96.0 s on two runs; the later one is kept.
  "pnpm lint": 96.0,
  // Cold: 110 s to build the application image with an empty build cache, 8 s for the Postgres
  // image, then 34 s from `up` to every check passing — migrate, app-role, document-indexes, the
  // API's and the web UI's health checks, and the backup service's first dump and restore.
  "bash deploy/ci-smoke.sh": 152,
});

/**
 * One job's measured seconds: the figures of its own command steps, each command counted once per
 * job that runs it. A command shared by two jobs (install, the build) is paid by both, because two
 * runners each pay it, so the figure is per command and the sum is per job.
 */
export function measuredJobSeconds(steps: readonly CiStep[]): number {
  return steps.reduce<number>(
    (a, s) => a + (s.kind === "command" ? (CI_MEASURED_STEP_SECONDS[s.run] ?? 0) : 0),
    0,
  );
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

/** The four steps every job that installs the workspace opens with, in the one order that works. */
const SETUP_STEPS: readonly CiStep[] = [
  { kind: "action", uses: "actions/checkout@v4", with: {} },
  // Before `setup-node`, not after: `setup-node`'s `cache: pnpm` resolves the store path by
  // running pnpm, so the reverse order fails at the cache step rather than at install.
  { kind: "action", uses: "pnpm/action-setup@v4", with: { version: "9.12.0" } },
  // Node 22, on two measurements that agree: `package.json`'s `engines.node` is `">=22"`, and
  // `deploy/Dockerfile` pins `node:22.23.5-bookworm-slim`, so 22 is the version the repository
  // promises and the only one anything deploys. It was 20 on the same argument while the image was
  // 20; 20's maintenance ended in April 2026 and `eslint` 10 needs 20.19 or later. Floating within
  // the major here, where the image pins a patch: CI tests the line, the image is the artifact.
  { kind: "action", uses: "actions/setup-node@v4", with: { "node-version": "22", cache: "pnpm" } },
  { kind: "command", run: "pnpm install --frozen-lockfile" },
];

const VERIFY_STEPS: readonly CiStep[] = [
  ...SETUP_STEPS,
  // Directly after install and before anything slow. `--prod` because the question is what a
  // deployment ships; the advisories it still reports are declared in `CI_AUDIT_EXCEPTIONS` with
  // their reasons and listed in `package.json`'s `pnpm.auditConfig.ignoreGhsas`, compared both ways.
  { kind: "command", run: "pnpm audit --audit-level=high --prod" },
  { kind: "command", run: "pnpm --filter @crossengin/testing test" },
  { kind: "command", run: "pnpm -r build" },
  { kind: "command", run: "pnpm -r typecheck" },
  { kind: "command", run: "pnpm -r test" },
];

// Its own job and not a step of `verify`: lint needs the build (type-aware rules resolve every
// workspace import through `dist/*.d.ts`), and appended to `verify` it would make that job
// 530.5 + 96.0 = 626.5 s, ceiling 11 against the 10-minute budget. In parallel it costs a second
// build on a second runner and moves the critical path by nothing.
const LINT_STEPS: readonly CiStep[] = [
  ...SETUP_STEPS,
  { kind: "command", run: "pnpm -r build" },
  { kind: "command", run: "pnpm lint" },
];

// The deployment itself, which no other job touches: the Dockerfile builds, the compose one-shots
// migrate a real Postgres, the API boots as the confined role, the web UI and the backup service
// come up healthy. Docker and Compose ship on the runner, so this needs no `services:` block and no
// setup steps — the script builds everything it runs.
const DEPLOY_SMOKE_STEPS: readonly CiStep[] = [
  { kind: "action", uses: "actions/checkout@v4", with: {} },
  { kind: "command", run: "bash deploy/ci-smoke.sh" },
];

/**
 * The pipeline `.github/workflows/ci.yml` is required to be, and the first reader this module has
 * ever had: every one of its twelve exports was measured at zero external references before
 * ADR-0382, so the budget, the dependency graph and the schemas described a CI that did not exist.
 *
 * **Three jobs, each one runner, and the steps within a job are the faithful encoding of a
 * sequential `runs-on` block.** `verify` is the original one; `lint` and `deploy-smoke` run beside
 * it, so the critical path is the longest of the three rather than their sum. The four sweeps stay
 * *steps* of `verify` and not jobs chained by `dependsOn`: four ceilings (1 + 3 + 3 + 4 = 11) exceed
 * a budget the measured total does not, and crossing a job boundary needs `dist/` carried in a cache
 * whose stale hit is ADR-0307's conditional green. `lint` pays a second build for exactly that
 * reason, and pays it in parallel.
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
 * **`targetMinutes` is derived per job from `CI_MEASURED_STEP_SECONDS`, and excludes install.**
 * `verify` sums to 530.5 s, 8.84 min, ceiling **9**; `lint` to 245.3 s, ceiling 5; `deploy-smoke`
 * to the figure its script was measured at. Each ceiling is computed here rather than typed, which is
 * the whole of what makes the budget check fire from something other than itself.
 *
 * **What the check can see, stated exactly, because the alternative is a falsely-true control.**
 * `fitsBudget` compares two *declared* numbers, and with no `dependsOn` `criticalPathMinutes` **is**
 * the largest job's `targetMinutes`. So it fires on exactly two events, both real and both reachable: a **new command
 * step**, which `measuredStepDisagreements` refuses until it carries a figure; and a
 * **re-measurement** that pushes a job past 600 s, since `ceil(601/60)` is 11 against a budget of
 * 10. `verify`'s slack is therefore 69.5 s.
 *
 * **What it cannot see: an existing step getting slower.** Nothing here times a run, so a `pnpm -r
 * test` that drifts from 200 s to 500 s leaves `fitsBudget` true for ever. The mechanism that would
 * catch it is the runner's, `timeout-minutes:` on the job, and the tight form of it is refused on
 * measurement: the job's wall clock is install + the suite, install is the `null` above, and
 * `timeout-minutes: 10` against an 8.78-minute suite would red the *first green* pull request on
 * install latency alone — ADR-0382's own argument against the lint job, that shipping a CI which
 * fails on arrival teaches people to ignore it. **The generous form landed in ADR-0482**:
 * `CI_JOB_TIMEOUT_MINUTES` on every job, a `CiJob.timeoutMinutes` field the schema refuses at or
 * below `targetMinutes`, and a comparison in the audit. It enforces a different claim — this job
 * does not hang — and still does not see a step getting slower inside the bound.
 *
 * When the check does fire the remedy is one of two, and naming them is the point: split `build`
 * into its own job and fan `typecheck`/`test` out behind it — refused today on the measurement in
 * ADR-0382, because `dist/` is gitignored and crossing a job boundary needs a content-addressed
 * cache whose stale hit is ADR-0307's conditional green — or raise `FAST_CI_BUDGET_MINUTES`, which
 * is a decision about the budget and not about the pipeline.
 */
/**
 * Every job's `timeout-minutes:`. Forty-five against a largest measured target of nine: a run that
 * reaches it has hung, not slowed, and that is the only claim it makes (ADR-0482).
 */
export const CI_JOB_TIMEOUT_MINUTES = 45;

export const CI_PIPELINE: CiPipeline = CiPipelineSchema.parse({
  name: "ci",
  /**
   * The token's scopes, narrowed to what the jobs use: they read the repository and write nothing
   * back to it. Without the block a job's token takes the repository's default, which a fork's
   * pull request does not control and an owner may have set to `write-all`.
   */
  permissions: { contents: "read" },
  /** One run per ref, and a newer push cancels the older one rather than queueing behind it. */
  concurrency: { group: "ci-${{ github.ref }}", cancelInProgress: true },
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
      /** Derived, never supplied — see `CI_MEASURED_STEP_SECONDS`. `ceil(530.5 / 60) = 9`. */
      targetMinutes: Math.ceil(measuredJobSeconds(VERIFY_STEPS) / 60),
      timeoutMinutes: CI_JOB_TIMEOUT_MINUTES,
      steps: VERIFY_STEPS,
    },
    {
      id: "lint",
      /** No test kind: static analysis runs no test, and `[]` says so rather than borrowing one. */
      runs: [],
      triggers: ["pull_request", "push_main"],
      requiresServices: [],
      /** `ceil(245.3 / 60) = 5`. */
      targetMinutes: Math.ceil(measuredJobSeconds(LINT_STEPS) / 60),
      timeoutMinutes: CI_JOB_TIMEOUT_MINUTES,
      steps: LINT_STEPS,
    },
    {
      id: "deploy-smoke",
      /**
       * `integration` and not `e2e`: it drives the real database, the real migrations and the real
       * containers, and no browser. The first job in this pipeline that touches Postgres at all.
       */
      runs: ["integration"],
      triggers: ["pull_request", "push_main"],
      /**
       * Empty although the job runs Postgres: `requiresServices` names the runner's `services:`
       * block, and the database here is one of the stack's own containers, started by the script.
       */
      requiresServices: [],
      targetMinutes: Math.ceil(measuredJobSeconds(DEPLOY_SMOKE_STEPS) / 60),
      timeoutMinutes: CI_JOB_TIMEOUT_MINUTES,
      steps: DEPLOY_SMOKE_STEPS,
    },
  ],
});

/* ------------------------------------------------------------ the dependency audit's exceptions */

/**
 * Why an advisory `pnpm audit --audit-level=high --prod` reports is not failing CI. Three reasons and
 * no fourth, because each costs something checkable:
 *
 * - `no_patched_version` — the advisory names no fixed release (its patched range is `<0.0.0`), so
 *   there is nothing to upgrade to; the entry goes the day one ships.
 * - `dev_tooling_not_shipped` — the package is reached only through a workspace member that no
 *   shipped app depends on at run time. `--prod` still reports it because `@crossengin/testing`
 *   declares vitest, and `@crossengin/config` the eslint toolchain, as their own `dependencies`; the
 *   premise is asserted, not trusted (`auditExceptionDisagreements`): neither member may appear in
 *   any other member's `dependencies`, and `deploy/Dockerfile`'s `--filter-prod` install keeps both
 *   out of the image.
 * - `fix_is_a_major_migration` — a patched release exists and is a major version this repository
 *   has not migrated to. This is a debt with a name, not an exemption: the advisory reaches running
 *   code.
 */
export const AUDIT_EXCEPTION_REASONS = [
  "no_patched_version",
  "dev_tooling_not_shipped",
  "fix_is_a_major_migration",
] as const;
export type AuditExceptionReason = (typeof AUDIT_EXCEPTION_REASONS)[number];

export interface AuditException {
  readonly advisory: string;
  readonly package: string;
  readonly severity: "high" | "critical";
  readonly reason: AuditExceptionReason;
  /** The workspace member the advisory is reached through, for `dev_tooling_not_shipped`. */
  readonly via: string | null;
  readonly note: string;
}

/**
 * Every advisory the CI audit step ignores, with its reason. Compared in both directions against
 * `package.json`'s `pnpm.auditConfig.ignoreGhsas`, which is what `pnpm audit` actually reads: an
 * ignore with no entry here is an exception nobody justified, and an entry here with no ignore is a
 * justification for nothing.
 *
 * Measured on 2026-11-17 after the Next 15 upgrade and the four `pnpm.overrides`: 1 low, 10 moderate,
 * 3 high and 3 critical remain, and these six advisories are all of the high and critical ones. (The
 * summary line `pnpm audit` prints still counts ignored advisories; its exit status does not.)
 */
export const CI_AUDIT_EXCEPTIONS: readonly AuditException[] = Object.freeze([
  {
    advisory: "GHSA-5xrq-8626-4rwp",
    package: "vitest",
    severity: "critical",
    reason: "dev_tooling_not_shipped",
    via: "@crossengin/testing",
    note:
      "Reachable only while the Vitest UI server listens, which no script here starts. Fixed in " +
      "vitest 3.2.6; moving 88 package configs off 2.1.9 is its own increment.",
  },
  {
    advisory: "GHSA-5gmw-xhrv-c9v3",
    package: "tinypool",
    severity: "critical",
    reason: "dev_tooling_not_shipped",
    via: "@crossengin/testing",
    note: "vitest 2.1.9's worker pool. vitest 3.2.6 still pins tinypool ^1.1.1; vitest 4 drops it.",
  },
  {
    advisory: "GHSA-85c8-ppgw-ccpr",
    package: "tinypool",
    severity: "critical",
    reason: "dev_tooling_not_shipped",
    via: "@crossengin/testing",
    note: "As GHSA-5gmw-xhrv-c9v3: the same pool, the same upgrade.",
  },
  {
    advisory: "GHSA-587h-7wmj-h5pm",
    package: "vite",
    severity: "high",
    reason: "dev_tooling_not_shipped",
    via: "@crossengin/testing",
    note: "vite 5.4.21 under vitest 2.1.9; a Windows-only editor-launch bypass in a dev server.",
  },
  {
    advisory: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    severity: "high",
    reason: "no_patched_version",
    via: null,
    note:
      "Patched range is `<0.0.0`. Reached through typescript-eslint's file globbing and vite, " +
      "both dev tooling, so it is not shipped either way.",
  },
  {
    advisory: "GHSA-mrhx-c7xc-m3w5",
    package: "zod",
    severity: "high",
    reason: "fix_is_a_major_migration",
    via: null,
    note:
      "Every package parses with zod 3.25.76; the fix is zod 4.6.6. Memory exhaustion validating an " +
      "oversized constrained collection, which the request-body cap bounds but does not remove.",
  },
]);
