import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CI_JOB_TRIGGERS,
  CI_PIPELINE,
  CiPipelineSchema,
  criticalPathMinutes,
  fitsBudget,
  FAST_CI_BUDGET_MINUTES,
  measuredSuiteSeconds,
} from "./ci.js";
import {
  auditCiWorkflow,
  CI_JOB_YAML_KEYS,
  CI_MAIN_BRANCH,
  CI_TRIGGER_YAML_KEY,
  CI_WORKFLOW_FINDING_KINDS,
  CI_WORKFLOW_FINDING_MEANINGS,
  CI_WORKFLOW_PATH,
  CI_WORKFLOW_TOP_LEVEL_KEYS,
  CiWorkflowUnreadable,
  parseCiWorkflow,
  readCiWorkflow,
  renderDeclaredStep,
  type CiWorkflowFinding,
  type CiWorkflowFindingKind,
} from "./ci-workflow.js";
import { REPO_ROOT } from "./workspace-sql-scan.js";

/** The real artifact, so every mutation below is a mutation of the file that ships. */
const WORKFLOW_TEXT = readFileSync(join(REPO_ROOT, CI_WORKFLOW_PATH), "utf8");

/** Finding kinds, for an assertion that reads at a glance. */
function kinds(
  findings: readonly { readonly kind: CiWorkflowFindingKind }[],
): readonly CiWorkflowFindingKind[] {
  return findings.map((f) => f.kind);
}

/** Every finding the shipped pair produces, which is `[]` while the workflow and the declaration agree. */
const BASELINE = auditCiWorkflow(CI_PIPELINE, parseCiWorkflow(WORKFLOW_TEXT));
const BASELINE_KEYS = new Set(BASELINE.map((f) => `${f.kind}|${f.subject}`));

/**
 * The findings a fixture **adds** to the baseline, by `(kind, subject)` and not by kind alone.
 *
 * Relative rather than absolute, and the reason is a measurement on this file: the fixtures below
 * are mutations of the *real* workflow, which is what stops them going stale against a shape the
 * file no longer has — and it also means that breaking the real file changed the baseline every
 * fixture was compared against, so one edit produced a dozen failures. Measured over ADR-0382's
 * nine disk mutations, counting failing tests apiece: the six that edit the workflow or the
 * declaration went from **12–18** before this helper to **2–9** after, and the three that edit the
 * hook or the `prepare` script were 1–2 either way, because they never pass through the baseline.
 * A fence that reports a dozen failures for one edit is a fence people skim, which is the same
 * argument the audit's `step_order_differs` guard is written for.
 *
 * The 9 is the honest residue and is not a cascade: deleting a step the fixtures below *anchor* on
 * makes `mutate` fail its own presence guard, which is the guard doing its job rather than noise.
 *
 * Subtracting by `(kind, subject)` rather than by kind keeps it honest: a mutation that adds a
 * *second* `action_input_differs` about a different input is still reported.
 */
function addedFindings(text: string): readonly CiWorkflowFinding[] {
  return auditCiWorkflow(CI_PIPELINE, parseCiWorkflow(text)).filter(
    (f) => !BASELINE_KEYS.has(`${f.kind}|${f.subject}`),
  );
}

function addedKinds(text: string): readonly CiWorkflowFindingKind[] {
  return addedFindings(text).map((f) => f.kind);
}

/** A mutation that must land, so a fixture built on a string the file no longer holds fails loudly. */
function mutate(from: string, to: string): string {
  expect(WORKFLOW_TEXT.includes(from), `the workflow no longer contains ${JSON.stringify(from)}`).toBe(
    true,
  );
  return WORKFLOW_TEXT.replace(from, to);
}

describe("the vocabulary", () => {
  it("gives every finding kind a meaning", () => {
    // Total map, so a sixteenth kind is a compile error until it says what it claims.
    expect(Object.keys(CI_WORKFLOW_FINDING_MEANINGS).sort()).toEqual([...CI_WORKFLOW_FINDING_KINDS].sort());
  });

  it("gives every finding kind a meaning that is not its own name", () => {
    // ADR-0351's hazard: a map that documents a hazard and asserts nothing. A meaning that restates
    // its key is a key with no explanation, which is what this is for.
    for (const kind of CI_WORKFLOW_FINDING_KINDS) {
      const meaning = CI_WORKFLOW_FINDING_MEANINGS[kind];
      expect(meaning.length).toBeGreaterThan(kind.length);
      expect(meaning).not.toBe(kind.replace(/_/g, " "));
    }
  });

  it("spells every trigger in the contract's vocabulary", () => {
    expect(Object.keys(CI_TRIGGER_YAML_KEY).sort()).toEqual([...CI_JOB_TRIGGERS].sort());
    // Distinct, because two triggers mapping to one `on:` key would make `trigger_absent`
    // unanswerable for one of them.
    const spellings = Object.values(CI_TRIGGER_YAML_KEY);
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  it("names the allow-lists it compares against", () => {
    expect(CI_WORKFLOW_TOP_LEVEL_KEYS).toEqual(["name", "on", "jobs"]);
    expect(CI_JOB_YAML_KEYS).toEqual(["runs-on", "steps"]);
    expect(Object.isFrozen(CI_WORKFLOW_TOP_LEVEL_KEYS)).toBe(true);
    expect(Object.isFrozen(CI_JOB_YAML_KEYS)).toBe(true);
  });
});

describe("the shipped workflow", () => {
  const parsed = readCiWorkflow();

  it("agrees with CI_PIPELINE in both directions", () => {
    expect(auditCiWorkflow(CI_PIPELINE, parsed)).toEqual([]);
  });

  it("was really read, so the assertion above is not vacuous", () => {
    // The floors are the point: a parse that returned an empty workflow would make the agreement
    // above pass over nothing. Round numbers below the real counts, so adding a step is not a test
    // edit — what matters is that the reader found a job, a runner and both step kinds.
    expect(parsed.jobs.length).toBeGreaterThanOrEqual(1);
    const job = parsed.jobs[0];
    expect(job).toBeDefined();
    expect(job?.runsOn).toBe("ubuntu-latest");
    expect((job?.steps ?? []).length).toBeGreaterThanOrEqual(8);
    expect((job?.steps ?? []).filter((s) => s.rendered.startsWith("run ")).length).toBeGreaterThanOrEqual(4);
    expect((job?.steps ?? []).filter((s) => s.rendered.startsWith("uses ")).length).toBeGreaterThanOrEqual(3);
    expect(parsed.triggers).toContain("pull_request");
    expect(parsed.pushBranches).toEqual([CI_MAIN_BRANCH]);
  });

  it("runs the workspace rules before the build, which is the whole step order argument", () => {
    // `@crossengin/testing` imports no workspace package, so its tests need nothing built — which
    // is why this step can come first and why putting it first is worth a test rather than a
    // comment. Reversed, the fail-fast is gone and a drifting pull request pays 430 s before
    // anything objects.
    const steps = (parsed.jobs[0]?.steps ?? []).map((s) => s.rendered);
    const rules = steps.indexOf("run pnpm --filter @crossengin/testing test");
    const build = steps.indexOf("run pnpm -r build");
    const sweep = steps.indexOf("run pnpm -r test");
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(rules);
    expect(sweep).toBeGreaterThan(build);
  });

  it("builds and typechecks operate-web through the sweeps rather than in its own steps", () => {
    // CLAUDE.md instructs verifying `apps/operate-web` separately with `npx next build` and
    // `npx tsc --noEmit`; measured from its own package.json, that is redundant — it has a `build`
    // and a `typecheck` script, so `pnpm -r build` and `pnpm -r typecheck` already cover it. Only
    // the *test* sweep excludes it, because it has no vitest config and no tests.
    const web = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "operate-web", "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(web.scripts?.build).toBe("next build");
    expect(web.scripts?.typecheck).toContain("--noEmit");
    const steps = (parsed.jobs[0]?.steps ?? []).map((s) => s.rendered);
    expect(steps.filter((s) => s.includes("next build"))).toEqual([]);
    expect(steps.filter((s) => s.includes("operate-web"))).toEqual([]);
  });

  it("mounts no lint step, because lint is a hard red and not a vacuous green", () => {
    // Measured: 90 workspace members, exactly one `lint` script (`operate-web -> next lint`), and
    // that app has no eslint config file and no eslint dependency at all — so `next lint` prompts
    // interactively and the non-TTY read cancels it. A lint step would fail every run.
    const steps = (parsed.jobs[0]?.steps ?? []).map((s) => s.rendered);
    expect(steps.filter((s) => s.includes("lint"))).toEqual([]);
    const web = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "operate-web", "package.json"), "utf8"),
    ) as { readonly devDependencies?: Readonly<Record<string, string>> };
    expect(Object.keys(web.devDependencies ?? {}).filter((d) => d.includes("eslint"))).toEqual([]);
  });
});

describe("the declared pipeline", () => {
  it("fits the fast budget on the measured figures", () => {
    // Against the measurement and not against itself: a bare `toBe(9)` here was the declaration
    // compared with the literal it was typed from, since a one-job pipeline's critical path *is*
    // `targetMinutes`. `ci.test.ts` owns the both-ways fence between the measurement and the steps;
    // this asserts the arithmetic that turns it into a budget.
    expect(criticalPathMinutes(CI_PIPELINE)).toBe(Math.ceil(measuredSuiteSeconds() / 60));
    expect(CI_PIPELINE.pullRequestTargetMinutes).toBe(FAST_CI_BUDGET_MINUTES);
    expect(fitsBudget(CI_PIPELINE, "pull_request")).toBe(true);
  });

  it("claims only the one test kind the workspace demonstrably has", () => {
    // 771 `*.test.ts` files; `toMatchSnapshot`/`toMatchInlineSnapshot` in 0, `fast-check` in 0,
    // `playwright`/`puppeteer` in 0, `axe-core`/`jest-axe` in 0 — all five **excluding this file**,
    // which quotes every one of those patterns and is therefore the sole match for each of them if
    // the grep is re-run naively. Widening this list needs a measurement, which is why it is
    // asserted exactly rather than as a superset.
    expect(CI_PIPELINE.jobs.map((j) => j.runs)).toEqual([["unit"]]);
  });

  it("claims no services, which is why the workflow needs no Postgres", () => {
    // Empty is the claim (ADR-0331): measured, `new Pool`/`new Client`/`from "pg"` occurs in 0 of
    // the 771 test files other than this one, so nothing in the sweep needs a database.
    expect(CI_PIPELINE.jobs.map((j) => j.requiresServices)).toEqual([[]]);
    expect(CI_PIPELINE.jobs.map((j) => j.parallelism)).toEqual([1]);
  });

  it("cannot be emptied and stay a pipeline", () => {
    // The strongest form of the non-vacuity floor: `CiPipelineSchema` requires `jobs.min(1)`, so
    // emptying `CI_PIPELINE` is a parse failure at module load rather than a quietly passing audit.
    expect(() => CiPipelineSchema.parse({ ...CI_PIPELINE, jobs: [] })).toThrow();
  });

  it("reports budget_exceeded when the path outgrows the budget", () => {
    const slow = CiPipelineSchema.parse({
      ...CI_PIPELINE,
      jobs: CI_PIPELINE.jobs.map((j) => ({ ...j, targetMinutes: 30 })),
    });
    // Not through `addedKinds`: the pipeline is the mutated side here, not the workflow, so the
    // baseline this fixture is relative to is the declaration itself.
    const findings = auditCiWorkflow(slow, readCiWorkflow());
    expect(kinds(findings)).toContain("budget_exceeded");
    expect(findings.find((f) => f.kind === "budget_exceeded")?.detail).toContain("30 min");
  });
});

describe("the reader refuses rather than guessing", () => {
  it("refuses a tab", () => {
    expect(() => parseCiWorkflow("name: ci\n\tjobs:\n")).toThrow(CiWorkflowUnreadable);
  });

  it("refuses a file with no jobs: block", () => {
    expect(() => parseCiWorkflow("name: ci\non:\n  pull_request:\n")).toThrow(/no jobs: block/);
  });

  it("refuses an empty file", () => {
    // The other half of the non-vacuity pair: emptying the YAML must fail, not pass.
    expect(() => parseCiWorkflow("")).toThrow(/no jobs: block/);
  });

  it("refuses a jobs: block with no job", () => {
    expect(() => parseCiWorkflow("name: ci\njobs:\n")).toThrow(/declares no jobs/);
  });

  it("refuses a job with no steps", () => {
    expect(() => parseCiWorkflow("name: ci\njobs:\n  verify:\n    runs-on: ubuntu-latest\n")).toThrow(
      /has no steps/,
    );
  });

  it("refuses a step with neither uses: nor run:", () => {
    expect(() =>
      parseCiWorkflow("name: ci\njobs:\n  verify:\n    steps:\n      - name: nothing\n"),
    ).toThrow(/neither uses: nor run:/);
  });

  it("refuses a run: block scalar", () => {
    // A multi-line command cannot be compared against a declaration as one string, and comparing
    // its first line would understate — the one direction a fence must never fail in.
    expect(() => parseCiWorkflow(mutate("        run: pnpm -r test\n", "        run: |\n"))).toThrow(
      /block scalar/,
    );
  });

  it("refuses a step carrying both uses: and run:", () => {
    expect(() =>
      parseCiWorkflow(
        mutate("      - name: Install\n        run: pnpm install --frozen-lockfile\n",
          "      - name: Install\n        uses: actions/checkout@v4\n        run: pnpm install --frozen-lockfile\n"),
      ),
    ).toThrow(/both uses: and run:/);
  });

  it("refuses a step key other than name, uses, with or run", () => {
    // `if:`, `env:` and `continue-on-error:` each change whether or how a step runs, so accepting
    // one silently would break the claim that every executing line is declared.
    expect(() =>
      parseCiWorkflow(
        mutate("      - name: Test\n        run: pnpm -r test\n",
          "      - name: Test\n        if: false\n        run: pnpm -r test\n"),
      ),
    ).toThrow(/step key other than/);
  });

  it("refuses a mis-indented line", () => {
    expect(() =>
      parseCiWorkflow(mutate("        run: pnpm -r test\n", "          run: pnpm -r test\n")),
    ).toThrow(/unreadable inside the jobs: block/);
  });

  it("names the line it refused", () => {
    // A refusal that does not say where is a refusal somebody disables.
    expect(() => parseCiWorkflow("name: ci\njobs:\n  verify:\n    steps:\n      - name: x\n")).toThrow(
      /line 5/,
    );
  });

  it("skips the body of an undeclared top-level key rather than refusing it", () => {
    // So `workflow_key_undeclared` is reachable for a key WITH a body as well as a bare one. A
    // refusal there would make the finding a judgement with no case left (ADR-0375).
    const text = mutate("jobs:\n", "permissions:\n  contents: read\njobs:\n");
    const parsed = parseCiWorkflow(text);
    expect(parsed.topLevelKeys).toContain("permissions");
    expect(addedKinds(text)).toEqual(["workflow_key_undeclared"]);
  });

  it("refuses an unreadable line inside the on: block", () => {
    expect(() => parseCiWorkflow("on:\n    stray: 1\njobs:\n")).toThrow(/inside the on: block/);
  });

  it("refuses a schedule: body by name, and not with the generic on:-block message", () => {
    // `CI_TRIGGER_YAML_KEY.schedule` would otherwise be a total-map member whose only reachable
    // case is a *childless* `schedule:` — which GitHub itself rejects, so it is ADR-0375's
    // judgement with no case left. Naming the refusal is what gives the member a real case and
    // points at the missing `CiJob` field rather than at this reader.
    expect(() =>
      parseCiWorkflow("on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n"),
    ).toThrow(/cron has no field on CiJob/);
    // The childless form still parses, so the other arm of that map stays reachable — it is what
    // `reports a trigger no job asked for` below exercises.
    expect(parseCiWorkflow(mutate("  pull_request:\n", "  pull_request:\n  schedule:\n")).triggers).toContain(
      "schedule",
    );
  });

  it("refuses a line inside jobs: that comes before any job id", () => {
    expect(() => parseCiWorkflow("jobs:\n    runs-on: ubuntu-latest\n")).toThrow(
      /before any job id/,
    );
  });

  it("refuses a body under a top-level key that takes a scalar", () => {
    // `name:` has a value, so anything indented beneath it is a shape this reader does not have —
    // and unlike an *undeclared* key, `name` is one the audit compares, so skipping its body would
    // be a line consumed by nothing and reported by nobody.
    expect(() => parseCiWorkflow("name: ci\n  nested: x\njobs:\n  v:\n    steps:\n      - run: x\n")).toThrow(
      /unreadable at the top level \(region name\)/,
    );
  });

  it("reads a quoted scalar as its bare spelling", () => {
    expect(addedKinds(mutate("    runs-on: ubuntu-latest\n", '    runs-on: "ubuntu-latest"\n'))).toEqual([]);
  });
});

describe("the audit compares in both directions", () => {
  it("reports a step the workflow runs and the declaration does not", () => {
    const added = addedKinds(
      mutate("      - name: Test\n", "      - name: Sneak\n        run: curl evil.example\n      - name: Test\n"),
    );
    expect(added).toEqual(["step_undeclared"]);
  });

  it("reports a step the declaration has and the workflow drops", () => {
    // The direction a pull request deleting the sweep takes, and the reason this rule exists.
    const added = addedKinds(mutate("      - name: Test\n        run: pnpm -r test\n", ""));
    expect(added).toEqual(["step_absent"]);
  });

  it("reports a reordering as exactly one finding", () => {
    const added = addedKinds(
      mutate(
        "      - name: Workspace rules\n        run: pnpm --filter @crossengin/testing test\n      - name: Build\n        run: pnpm -r build\n",
        "      - name: Build\n        run: pnpm -r build\n      - name: Workspace rules\n        run: pnpm --filter @crossengin/testing test\n",
      ),
    );
    // One, not three: the membership checks pass because the sets agree, so only the order is
    // reported. Three findings for one edit is how a fence trains people to skim it.
    expect(added).toEqual(["step_order_differs"]);
  });

  it("reports a changed action input, naming the input and both values", () => {
    const added = addedFindings(mutate("          node-version: 20\n", "          node-version: 18\n"));
    expect(added.map((f) => f.kind)).toEqual(["action_input_differs"]);
    // The subject and the detail are what make the finding actionable rather than merely true: a
    // reader has to be told which input of which action, and what each side holds.
    expect(added[0]?.subject).toContain("actions/setup-node@v4 with.node-version");
    expect(added[0]?.detail).toContain('declared "20"');
    expect(added[0]?.detail).toContain('workflow has "18"');
  });

  it("reports a dropped action input", () => {
    const added = addedKinds(mutate("          cache: pnpm\n", ""));
    expect(added).toEqual(["action_input_differs"]);
  });

  it("reports a services: block through the job-key allow-list", () => {
    // Not by name: `requiresServices: []` is the claim and any unlisted job key breaks it, so a
    // `strategy:` matrix lands here too without a second finding kind.
    const added = addedKinds(
      mutate("    steps:\n", "    services:\n      pg:\n    steps:\n"),
    );
    expect(added).toContain("job_key_undeclared");
  });

  it("reports a renamed job in both directions at once", () => {
    const added = addedKinds(mutate("  verify:\n", "  check:\n"));
    expect([...added].sort()).toEqual(["job_absent", "job_undeclared"]);
  });

  it("reports a changed runner", () => {
    const added = addedKinds(mutate("    runs-on: ubuntu-latest\n", "    runs-on: macos-14\n"));
    expect(added).toEqual(["runner_differs"]);
  });

  it("reports a push trigger that names another branch", () => {
    const added = addedKinds(mutate("      - main\n", "      - develop\n"));
    expect(added).toEqual(["push_branches_differ"]);
  });

  it("reports a declared trigger the workflow does not fire on", () => {
    const added = addedKinds(mutate("  pull_request:\n", ""));
    expect(added).toEqual(["trigger_absent"]);
  });

  it("reports a trigger no job asked for", () => {
    const added = addedKinds(mutate("  pull_request:\n", "  pull_request:\n  schedule:\n"));
    expect(added).toEqual(["trigger_undeclared"]);
  });

  it("reports a missing top-level key", () => {
    const added = addedKinds(mutate("name: ci\n", ""));
    expect(added).toEqual(["workflow_key_absent"]);
  });

  it("renders a declared step the same way the parse renders the workflow's", () => {
    // The two renderings are what the comparison rests on; written as one function for that reason,
    // and asserted here so a change to one shape cannot silently stop matching the other.
    expect(renderDeclaredStep({ kind: "command", run: "pnpm -r test" })).toBe("run pnpm -r test");
    expect(renderDeclaredStep({ kind: "action", uses: "actions/checkout@v4", with: {} })).toBe(
      "uses actions/checkout@v4",
    );
  });
});

describe("the pins agree with the repository", () => {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    readonly packageManager?: string;
    readonly engines?: Readonly<Record<string, string>>;
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const inputs = (uses: string): ReadonlyMap<string, string> => {
    const job = readCiWorkflow().jobs[0];
    return job?.steps.find((s) => s.rendered === `uses ${uses}`)?.inputs ?? new Map();
  };

  it("pins the pnpm the workspace declares", () => {
    expect(root.packageManager).toBe("pnpm@9.12.0");
    expect(inputs("pnpm/action-setup@v4").get("version")).toBe("9.12.0");
  });

  it("pins the Node major the engines floor and the deployment image agree on", () => {
    // 20 and not the 22 a developer may be running: `engines.node` is the version the repository
    // promises, and `deploy/Dockerfile` is `FROM node:20-bookworm-slim`, so 20 is the only major
    // anything deploys. Testing the floor tests the promise.
    expect(root.engines?.node).toBe(">=20");
    const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM node:20-");
    expect(inputs("actions/setup-node@v4").get("node-version")).toBe("20");
  });
});

describe("the hook is in the same state as the workflow, and fenced the same way", () => {
  const hook = readFileSync(join(REPO_ROOT, ".githooks", "pre-commit"), "utf8");
  /**
   * The hook with its comment lines removed.
   *
   * Both assertions below read this and not `hook`, and the positive one needs it at least as
   * much as the negative one does — found by mutation, after writing the comment below about
   * exactly this hazard and then committing it one assertion up. The hook's doc comment *quotes*
   * the command it runs, so `expect(hook).toContain(command)` passed with the body replaced by
   * `exec true`: ADR-0376's finding, reproduced inside the increment that cites it. A text fence
   * that reads its own commentary as code either fires on correct code or, worse, is satisfied by
   * the prose explaining the code that is no longer there.
   */
  const hookCode = hook
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("runs the command the pipeline's fail-fast step runs", () => {
    // `.githooks/pre-commit` is a file nothing imports, nothing typechecks and no other rule reads
    // — the condition this increment exists to close for the workflow. So it is fenced here, and
    // against the declaration rather than against a second copy of the string.
    const rulesStep = CI_PIPELINE.jobs
      .flatMap((j) => j.steps)
      .find((s) => s.kind === "command" && s.run.includes("@crossengin/testing"));
    expect(rulesStep).toBeDefined();
    const command = rulesStep !== undefined && rulesStep.kind === "command" ? rulesStep.run : "";
    expect(command).not.toBe("");
    expect(hookCode).toContain(command);
  });

  it("was really stripped, so the assertion above is not reading prose", () => {
    // The vacuity guard for `hookCode`: a strip that removed everything would make the positive
    // assertion fail loudly, but one that removed nothing would make it pass against the comment
    // again. So assert both that the body survived and that the commentary did not.
    expect(hookCode).toContain("exec pnpm");
    expect(hook).toContain("# ADR-0382");
    expect(hookCode).not.toContain("ADR-0382");
  });

  it("runs none of the three sweeps, which are meaningless before a fresh build", () => {
    for (const sweep of ["pnpm -r build", "pnpm -r typecheck", "pnpm -r test"]) {
      expect(hookCode).not.toContain(sweep);
    }
  });

  it("recommends no --no-verify, which CLAUDE.md forbids by name", () => {
    // The strip matters here as much as it does above, and in the other direction: the hook's
    // comment *explains* why it does not recommend `--no-verify`, so a fence over the raw file
    // would fire on correct code. An earlier version of the message did recommend it — a hook
    // telling a developer to break the project's own rule — so this reads the body and the
    // vacuity guard is that the reasoning is still on file in the commentary.
    expect(hookCode).not.toContain("--no-verify");
    expect(hook).toContain("--no-verify");
    // What it names instead has to be an escape that actually works; see the installer test below.
    expect(hookCode).toContain("crossengin.hooks off");
    expect(hookCode).toContain("--unset core.hooksPath");
  });

  it("is installed by a prepare script that delegates to the installer in .githooks", () => {
    const prepare = root().scripts?.prepare ?? "";
    expect(prepare).toContain(".githooks/install-hooks.sh");
    // The guard is the whole decision: `.dockerignore` excludes `.git`, so inside
    // `deploy/Dockerfile`'s `pnpm install --frozen-lockfile` there is no repository and the
    // unguarded form exits 128 — measured — which would stop the deployment image building.
    expect(prepare).toContain("git rev-parse --git-dir");
    expect(prepare.trimEnd().endsWith("|| true")).toBe(true);
    const dockerignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    expect(dockerignore).toMatch(/^\.git$/m);
    // And `.githooks` is deliberately NOT excluded, which is why the installer's own
    // `git rev-parse` guard is a duplicate rather than dead: `COPY . .` lands the script in an
    // image with no repository.
    expect(dockerignore).not.toMatch(/^\.githooks$/m);
  });

  it("installs without clobbering, and names an escape that survives the next install", () => {
    // Both halves measured in a throwaway repository, because both were wrong before this review:
    // the inline `prepare` overwrote a `core.hooksPath` of `/my/own/hooks` with no warning, and it
    // re-set the path after `git config --unset core.hooksPath` — so ADR-0382's claim that the
    // unset "undoes its effect per clone" was false. A remedy that cannot work is worse than none
    // (ADR-0334), which that same ADR cites three times.
    const installer = readFileSync(join(REPO_ROOT, ".githooks", "install-hooks.sh"), "utf8");
    const code = installer
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    // The vacuity guard, same shape as `hookCode`'s: the body survived and the commentary did not.
    expect(code).toContain("git config core.hooksPath .githooks");
    expect(installer).toContain("# ADR-0382");
    expect(code).not.toContain("ADR-0382");
    // The opt-out is read BEFORE anything is written, which is what makes `--unset` stick.
    expect(code).toContain("crossengin.hooks");
    expect(code.indexOf("crossengin.hooks")).toBeLessThan(
      code.indexOf("git config core.hooksPath .githooks"),
    );
    // And a foreign path is compared rather than overwritten.
    expect(code).toContain("core.hooksPath");
    expect(code).toMatch(/!=\s*"\.githooks"/);
  });

  function root(): {
    readonly scripts?: Readonly<Record<string, string>>;
  } {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
  }
});
