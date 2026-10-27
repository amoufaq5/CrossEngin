import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CI_JOB_TRIGGERS,
  criticalPathMinutes,
  fitsBudget,
  type CiJobTrigger,
  type CiPipeline,
  type CiStep,
} from "./ci.js";
import { REPO_ROOT } from "./workspace-sql-scan.js";

/**
 * The rule: **`.github/workflows/ci.yml` runs exactly the pipeline `CI_PIPELINE` declares, and
 * nothing else.**
 *
 * The thirteenth workspace rule, and the one whose subject is not a `.ts` file. ADR-0376 built the
 * first fence over `deploy/` on an argument that transfers here word for word: a compose file is not
 * typechecked, not linted and imported by nothing, so a deleted line is invisible to every rule and
 * every test — which is how `docker-compose.ai.yml` came to be ten flags behind the base. **A
 * workflow YAML is in exactly that state, and worse**, because the thing it executes is the fence.
 * A pull request that deletes the `pnpm -r test` step deletes the only check that would have
 * objected, and the pull request it deletes it in reports green.
 *
 * So the pipeline is declared in TypeScript — where `tsc`, the twelve other rules and 20k tests
 * reach it — and this reads the YAML **as text** and compares the two **in both directions**.
 * Both-ways is not thoroughness, it is the lesson ADR-0335 paid for: a one-way comparison was what
 * that increment's original defect was made of, and `pg-record-retention.ts` exists because
 * "declared ⟹ present" passes while an undeclared member sits beside it.
 *
 * **No YAML parser.** No YAML dependency exists anywhere in this workspace, and adding one so a
 * fence can read one file it also wrote is a dependency decision rather than a step — it would put
 * third-party code in the build graph of the package every other member devDepends on. The honest
 * alternative to a parser is not a smaller parser: it is a **refusal**. The reader below enforces
 * one fixed shape (two-space indent, block mappings, single-line scalars) and **throws on any
 * non-blank line it cannot place**. ADR-0330's rule is to ask Postgres rather than imitate its
 * parser; the equivalent here is to ask nothing and refuse, because the file is one this repository
 * writes and can therefore be required to stay simple.
 *
 * The precise claim the both-ways comparison rests on, stated exactly because an approximation of
 * it would be the thing this rule exists to prevent: **every non-blank, non-comment line is either
 * consumed by the shape, or sits inside a block this rule has already reported as undeclared, or is
 * refused by name.** There are two of those reported blocks and both are reachable — an unexpected
 * top-level key (`workflow_key_undeclared`) and an unexpected per-job key
 * (`job_key_undeclared`, where a `services:` or `strategy:` block lands). Their bodies are skipped
 * rather than refused because both realistically *have* bodies, so refusing would name the body's
 * first line instead of the key, and the finding would be reachable only for a childless key —
 * a judgement with no case left (ADR-0375). `CI_JOB_YAML_KEYS` is read by the parse and by the
 * audit, so the set the reader skips and the set the audit reports cannot come to differ.
 *
 * The shipped file therefore has exactly three top-level keys: a `concurrency:` or `permissions:`
 * block would be configuration this fence has no comparison for, and a half-fenced one is worse
 * than a named follow-up (ADR-0382's first open end).
 */

export const CI_WORKFLOW_PATH = join(".github", "workflows", "ci.yml");

/** The only top-level keys the shipped workflow may hold; see the module comment for why three. */
export const CI_WORKFLOW_TOP_LEVEL_KEYS: readonly string[] = Object.freeze(["name", "on", "jobs"]);

/** The only per-job keys. `services:` and `strategy:` are caught by this rather than by name. */
export const CI_JOB_YAML_KEYS: readonly string[] = Object.freeze(["runs-on", "steps"]);

/**
 * How a trigger in `ci.ts`'s provider-neutral vocabulary is spelled in a GitHub `on:` block.
 *
 * It lives here and not beside `CI_JOB_TRIGGERS` because `ci.ts` is deliberately provider-neutral —
 * it says `push_main`, not `on: push` with a branch filter — so the spelling belongs with the module
 * that reads the provider's file. A total map rather than a `switch`, so a fifth trigger is a
 * compile error until it says how it is written down.
 *
 * **`schedule` is declared and its body is refused by name**, which is the honest form of a member
 * the reader cannot serve. A real GitHub `schedule:` trigger always carries a `- cron:` list, and
 * `CiJob` has no field a cron could be compared against — so reading one would produce a value
 * nothing in the declaration can contradict, which is the half-fenced shape ADR-0382 refuses a
 * `permissions:` block for. Keeping the member total and refusing the body is
 * `contract_cannot_carry_the_surface` rather than `prerequisite_of_unbuilt_surface`
 * (ADR-0336's distinction): a cron needs a declaration field before it needs a parser.
 *
 * Without that refusal this member would have been the ADR-0375 shape — a judgement with one
 * reachable case, a **childless** `schedule:`, which GitHub itself rejects. That case still parses
 * and still reports `trigger_undeclared`, so both arms are reachable and both are tested.
 */
export const CI_TRIGGER_YAML_KEY: Readonly<Record<CiJobTrigger, string>> = Object.freeze({
  pull_request: "pull_request",
  push_main: "push",
  schedule: "schedule",
  manual: "workflow_dispatch",
});

/** The branch `push_main` means. Written down because that is the whole content of the name. */
export const CI_MAIN_BRANCH = "main";

export const CI_WORKFLOW_FINDING_KINDS = [
  "workflow_key_undeclared",
  "workflow_key_absent",
  "trigger_undeclared",
  "trigger_absent",
  "push_branches_differ",
  "job_undeclared",
  "job_absent",
  "job_key_undeclared",
  "job_key_absent",
  "runner_differs",
  "step_undeclared",
  "step_absent",
  "step_order_differs",
  "action_input_differs",
  "budget_exceeded",
] as const;
export type CiWorkflowFindingKind = (typeof CI_WORKFLOW_FINDING_KINDS)[number];

/**
 * What each finding claims, read by the shape test and by nothing else — deliberately.
 *
 * Its job is the `Record` being total: a sixteenth finding kind is a compile error here until it
 * says what it means, which the `push` calls below would not make it. Same argument
 * `DOMAIN_LINK_MEANINGS` is kept for.
 */
export const CI_WORKFLOW_FINDING_MEANINGS: Readonly<Record<CiWorkflowFindingKind, string>> =
  Object.freeze({
    workflow_key_undeclared: "a top-level key the fence has no declaration surface for",
    workflow_key_absent: "a required top-level key the workflow does not hold",
    trigger_undeclared: "the workflow fires on an event no declared job asked for",
    trigger_absent: "a declared trigger the workflow does not fire on",
    push_branches_differ: "push_main is declared and the push trigger names other branches",
    job_undeclared: "a job in the workflow that CI_PIPELINE does not declare",
    job_absent: "a declared job the workflow does not define",
    job_key_undeclared: "a per-job key the fence has no declaration surface for",
    job_key_absent: "a required per-job key the job does not hold",
    runner_differs: "the job runs on an image other than the one declared",
    step_undeclared: "a step the workflow runs that the job does not declare",
    step_absent: "a declared step the workflow does not run",
    step_order_differs: "the declared steps, in an order the declaration does not have",
    action_input_differs: "an action input whose value is not the declared one",
    budget_exceeded: "the declared critical path is longer than the trigger's budget",
  });

export interface CiWorkflowFinding {
  readonly kind: CiWorkflowFindingKind;
  readonly subject: string;
  readonly detail: string;
}

export interface ParsedCiStep {
  /** `uses: <ref>` or `run: <command>`, rendered for comparison. One of the two, never both. */
  readonly rendered: string;
  /** An action's inputs. Empty for a command step. */
  readonly inputs: ReadonlyMap<string, string>;
  readonly line: number;
}

export interface ParsedCiJob {
  readonly id: string;
  readonly keys: readonly string[];
  readonly runsOn: string | null;
  readonly steps: readonly ParsedCiStep[];
}

export interface ParsedCiWorkflow {
  readonly topLevelKeys: readonly string[];
  readonly triggers: readonly string[];
  /** The branches the `push` trigger names, or `null` when it names none. */
  readonly pushBranches: readonly string[] | null;
  readonly jobs: readonly ParsedCiJob[];
}

/**
 * The reader refused the file.
 *
 * Thrown rather than returned, following `readProtectedTables`: a fence whose parse failure reads as
 * "found nothing" passes vacuously, and that is the worst shape a rule like this can take. Every
 * refusal below names the line.
 */
export class CiWorkflowUnreadable extends Error {
  public constructor(message: string) {
    super(`${CI_WORKFLOW_PATH}: ${message}`);
    this.name = "CiWorkflowUnreadable";
  }
}

/** A quoted scalar compares equal to its bare spelling; both are legal YAML for one value. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

interface MutableStep {
  rendered: string | null;
  readonly inputs: Map<string, string>;
  readonly line: number;
}

interface MutableJob {
  readonly id: string;
  readonly keys: string[];
  runsOn: string | null;
  readonly steps: MutableStep[];
}

/**
 * The one shape this fence reads.
 *
 * Column-exact on purpose: two spaces per level, `on:`/`jobs:` at 0, a job id at 2, a job key at 4,
 * a step's `- ` at 6, a step key at 8, a `with:` entry at 10. A line at any other indentation is
 * refused rather than skipped (see `CiWorkflowUnreadable`), and the test asserts that for each of
 * the shapes a hand-edit is likely to introduce.
 */
export function parseCiWorkflow(text: string): ParsedCiWorkflow {
  if (text.includes("\t")) {
    throw new CiWorkflowUnreadable("contains a tab; YAML indentation here is two spaces per level");
  }
  const lines = text.split("\n");

  const topLevelKeys: string[] = [];
  const triggers: string[] = [];
  let pushBranches: string[] | null = null;
  const jobs: MutableJob[] = [];

  let region: "none" | "name" | "on" | "jobs" = "none";
  /** Inside `on:`, which trigger's sub-block we are in — only `push` has one. */
  let onTrigger: string | null = null;
  let inPushBranches = false;
  let job: MutableJob | null = null;
  let inSteps = false;
  let step: MutableStep | null = null;
  let inWith = false;
  /**
   * Whether the current job key is one this fence has no comparison for, so its body is skipped.
   *
   * The same treatment an undeclared *top-level* key gets, and for the same reason: a `services:`
   * block has a body, so refusing it would name the body's first line rather than the key, and
   * `job_key_undeclared` — whose detail names the `requiresServices` claim it contradicts — would
   * be reachable only for a childless key, which is a judgement with no case left.
   */
  let skippingJobKey = false;

  const refuse = (i: number, why: string): never => {
    throw new CiWorkflowUnreadable(`line ${i + 1}: ${why}: ${JSON.stringify(lines[i] ?? "")}`);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    // A line that is *only* a comment. Trailing comments are deliberately not stripped: a `run:`
    // command may legitimately contain `#`, and a stripper would truncate it — understating the
    // command, which is the direction this fence must never fail in. Measured: no command in the
    // shipped file contains `#`, so the conservative rule costs nothing and cannot misread one.
    if (/^\s*#/.test(line)) continue;

    const top = /^([a-z_][a-z0-9_-]*):(.*)$/.exec(line);
    if (top !== null) {
      const key = top[1] ?? "";
      topLevelKeys.push(key);
      onTrigger = null;
      inPushBranches = false;
      job = null;
      inSteps = false;
      step = null;
      inWith = false;
      skippingJobKey = false;
      region = key === "on" ? "on" : key === "jobs" ? "jobs" : key === "name" ? "name" : "none";
      continue;
    }

    // An unexpected top-level key is a *finding* and not a refusal — `workflow_key_undeclared`,
    // whose remedy is to declare it or delete it — where refusing would make the whole file
    // unreadable and take every other finding with it. Its body is then skipped. This and the
    // `skippingJobKey` branch below are the **only two** places a line is not consumed by the
    // shape, and both are blocks the audit has already reported; see the module comment for the
    // claim that rests on there being exactly two. Without them each finding would be reachable
    // only for a childless key, which is a judgement with no case left (ADR-0375).
    if (region === "none") continue;

    if (region === "on") {
      const trigger = /^ {2}([a-z_][a-z0-9_-]*):(.*)$/.exec(line);
      if (trigger !== null) {
        onTrigger = trigger[1] ?? "";
        triggers.push(onTrigger);
        inPushBranches = false;
        continue;
      }
      if (onTrigger === "push") {
        if (/^ {4}branches:\s*$/.test(line)) {
          pushBranches = [];
          inPushBranches = true;
          continue;
        }
        const branch = /^ {6}- (.+)$/.exec(line);
        if (branch !== null && inPushBranches && pushBranches !== null) {
          pushBranches.push(scalar(branch[1] ?? ""));
          continue;
        }
      }
      // Named before the generic refusal, because the generic one says only "unreadable" about the
      // one `on:` sub-block whose spelling `CI_TRIGGER_YAML_KEY` declares and this reader cannot
      // serve — and a refusal that does not name the missing surface sends the next person to widen
      // the parser rather than to add the field. See that map's comment.
      if (onTrigger === "schedule") return refuse(i, SCHEDULE_BODY_REFUSAL);
      return refuse(i, "unreadable inside the on: block");
    }

    if (region === "jobs") {
      const jobId = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
      if (jobId !== null) {
        job = { id: jobId[1] ?? "", keys: [], runsOn: null, steps: [] };
        jobs.push(job);
        inSteps = false;
        step = null;
        inWith = false;
        skippingJobKey = false;
        continue;
      }
      if (job === null) return refuse(i, "a line inside jobs: before any job id");

      const jobKey = /^ {4}([a-z][a-z0-9-]*):(.*)$/.exec(line);
      if (jobKey !== null) {
        const key = jobKey[1] ?? "";
        job.keys.push(key);
        inSteps = key === "steps";
        step = null;
        inWith = false;
        skippingJobKey = !CI_JOB_YAML_KEYS.includes(key);
        if (key === "runs-on") job.runsOn = scalar(jobKey[2] ?? "");
        continue;
      }

      if (skippingJobKey && /^ {6,}\S/.test(line)) continue;

      if (inSteps) {
        const item = /^ {6}- ([a-z][a-z0-9-]*):(.*)$/.exec(line);
        if (item !== null) {
          step = { rendered: null, inputs: new Map(), line: i + 1 };
          job.steps.push(step);
          inWith = false;
          const applied = applyStepKey(step, item[1] ?? "", item[2] ?? "");
          if (applied === "block_scalar") return refuse(i, BLOCK_SCALAR_REFUSAL);
          if (applied === "unknown") return refuse(i, UNKNOWN_STEP_KEY_REFUSAL);
          if (applied === "two_bodies") return refuse(i, TWO_BODIES_REFUSAL);
          inWith = applied === "with";
          continue;
        }
        if (step !== null) {
          const stepKey = /^ {8}([a-z][a-z0-9-]*):(.*)$/.exec(line);
          if (stepKey !== null) {
            const applied = applyStepKey(step, stepKey[1] ?? "", stepKey[2] ?? "");
            if (applied === "block_scalar") return refuse(i, BLOCK_SCALAR_REFUSAL);
            if (applied === "unknown") return refuse(i, UNKNOWN_STEP_KEY_REFUSAL);
            if (applied === "two_bodies") return refuse(i, TWO_BODIES_REFUSAL);
            inWith = applied === "with";
            continue;
          }
          const withEntry = /^ {10}([a-z][a-z0-9_-]*):(.*)$/.exec(line);
          if (withEntry !== null && inWith) {
            step.inputs.set(withEntry[1] ?? "", scalar(withEntry[2] ?? ""));
            continue;
          }
        }
      }
      return refuse(i, "unreadable inside the jobs: block");
    }

    return refuse(i, `unreadable at the top level (region ${region})`);
  }

  if (!topLevelKeys.includes("jobs")) {
    throw new CiWorkflowUnreadable("has no jobs: block");
  }
  if (jobs.length === 0) {
    throw new CiWorkflowUnreadable("declares no jobs");
  }
  for (const j of jobs) {
    if (j.steps.length === 0) {
      throw new CiWorkflowUnreadable(`job '${j.id}' has no steps`);
    }
    for (const s of j.steps) {
      if (s.rendered === null) {
        throw new CiWorkflowUnreadable(
          `job '${j.id}' has a step at line ${s.line} with neither uses: nor run:`,
        );
      }
    }
  }

  return {
    topLevelKeys,
    triggers,
    pushBranches,
    jobs: jobs.map((j) => ({
      id: j.id,
      keys: j.keys,
      runsOn: j.runsOn,
      steps: j.steps.map((s) => ({
        // Narrowed by the loop above rather than asserted: `rendered === null` is refused there, so
        // the `?? ""` is unreachable and exists only because the mutable shape cannot say so.
        rendered: s.rendered ?? "",
        inputs: s.inputs,
        line: s.line,
      })),
    })),
  };
}

const SCHEDULE_BODY_REFUSAL =
  "a schedule: trigger's body — its cron has no field on CiJob to be compared against, so declare " +
  "one before adding a scheduled trigger rather than widening this reader";
const BLOCK_SCALAR_REFUSAL = "a block scalar, which cannot be compared against a declaration as one string";
const UNKNOWN_STEP_KEY_REFUSAL = "a step key other than name:, uses:, with: or run:";
const TWO_BODIES_REFUSAL = "a step carrying both uses: and run:";

/**
 * The four step keys this fence reads.
 *
 * `name:` is a label rather than a behaviour, so it is accepted and dropped; anything else — an
 * `if:`, an `env:`, a `continue-on-error:` — changes what the step does or whether it runs, so it is
 * refused by name rather than accepted silently. That is the whole difference between this and a
 * reader that skips what it does not recognise.
 */
function applyStepKey(
  step: MutableStep,
  key: string,
  rest: string,
): "ok" | "with" | "block_scalar" | "unknown" | "two_bodies" {
  if (key === "with") return "with";
  if (key === "name") return "ok";
  if (key === "uses" || key === "run") {
    const value = scalar(rest);
    // `|`, `>`, `|-`, `>+` and the empty string all open a multi-line scalar.
    if (value === "" || value.startsWith("|") || value.startsWith(">")) return "block_scalar";
    // GitHub refuses a step carrying both, and so does this — otherwise the second would overwrite
    // the first and the fence would compare one of the two bodies while the other ran unexamined.
    if (step.rendered !== null) return "two_bodies";
    step.rendered = `${key} ${value}`;
    return "ok";
  }
  return "unknown";
}

/** The declared steps, rendered the same way the parse renders the workflow's. */
export function renderDeclaredStep(step: CiStep): string {
  return step.kind === "action" ? `uses ${step.uses}` : `run ${step.run}`;
}

/** Both directions of the rule. An empty array is the only passing result. */
export function auditCiWorkflow(
  pipeline: CiPipeline,
  parsed: ParsedCiWorkflow,
): readonly CiWorkflowFinding[] {
  const findings: CiWorkflowFinding[] = [];

  const allowedTop = new Set(CI_WORKFLOW_TOP_LEVEL_KEYS);
  for (const key of parsed.topLevelKeys) {
    if (!allowedTop.has(key)) {
      findings.push({
        kind: "workflow_key_undeclared",
        subject: key,
        detail:
          `'${key}:' is a top-level key this fence has no declaration for, so a change to it ` +
          `would be invisible; declare it in CI_WORKFLOW_TOP_LEVEL_KEYS and give it a comparison, ` +
          `or remove it`,
      });
    }
  }
  for (const key of CI_WORKFLOW_TOP_LEVEL_KEYS) {
    if (!parsed.topLevelKeys.includes(key)) {
      findings.push({
        kind: "workflow_key_absent",
        subject: key,
        detail: `the workflow has no '${key}:' key`,
      });
    }
  }

  const declaredTriggers = new Set<CiJobTrigger>();
  for (const job of pipeline.jobs) {
    for (const trigger of job.triggers) declaredTriggers.add(trigger);
  }
  const declaredYamlKeys = new Set([...declaredTriggers].map((t) => CI_TRIGGER_YAML_KEY[t]));
  for (const key of parsed.triggers) {
    if (!declaredYamlKeys.has(key)) {
      findings.push({
        kind: "trigger_undeclared",
        subject: key,
        detail: `the workflow fires on '${key}', which no job's triggers ask for`,
      });
    }
  }
  for (const trigger of CI_JOB_TRIGGERS) {
    if (!declaredTriggers.has(trigger)) continue;
    const key = CI_TRIGGER_YAML_KEY[trigger];
    if (!parsed.triggers.includes(key)) {
      findings.push({
        kind: "trigger_absent",
        subject: key,
        detail: `a job declares trigger '${trigger}' and the on: block has no '${key}'`,
      });
    }
  }
  if (declaredTriggers.has("push_main")) {
    const branches = parsed.pushBranches;
    if (branches === null || branches.length !== 1 || branches[0] !== CI_MAIN_BRANCH) {
      findings.push({
        kind: "push_branches_differ",
        subject: "on.push.branches",
        detail:
          `push_main means exactly [${CI_MAIN_BRANCH}]; the workflow's push trigger names ` +
          `${branches === null ? "no branches" : JSON.stringify(branches)}`,
      });
    }
  }

  const declaredJobs = new Map(pipeline.jobs.map((j) => [j.id, j]));
  const parsedJobs = new Map(parsed.jobs.map((j) => [j.id, j]));
  for (const id of parsedJobs.keys()) {
    if (!declaredJobs.has(id)) {
      findings.push({
        kind: "job_undeclared",
        subject: id,
        detail: `the workflow defines job '${id}', which CI_PIPELINE does not declare`,
      });
    }
  }
  for (const id of declaredJobs.keys()) {
    if (!parsedJobs.has(id)) {
      findings.push({
        kind: "job_absent",
        subject: id,
        detail: `CI_PIPELINE declares job '${id}', which the workflow does not define`,
      });
    }
  }

  for (const [id, declared] of declaredJobs) {
    const actual = parsedJobs.get(id);
    if (actual === undefined) continue;

    const allowedJobKeys = new Set(CI_JOB_YAML_KEYS);
    for (const key of actual.keys) {
      if (!allowedJobKeys.has(key)) {
        findings.push({
          kind: "job_key_undeclared",
          subject: `${id}.${key}`,
          detail:
            `'${key}:' on job '${id}' is a key this fence has no comparison for — a 'services:' ` +
            `or 'strategy:' block lands here, and job '${id}' declares requiresServices=` +
            `${JSON.stringify(declared.requiresServices)} and parallelism=${declared.parallelism}`,
        });
      }
    }
    for (const key of CI_JOB_YAML_KEYS) {
      if (!actual.keys.includes(key)) {
        findings.push({
          kind: "job_key_absent",
          subject: `${id}.${key}`,
          detail: `job '${id}' has no '${key}:' key`,
        });
      }
    }

    if (actual.runsOn !== null && actual.runsOn !== declared.runsOn) {
      findings.push({
        kind: "runner_differs",
        subject: id,
        detail: `job '${id}' runs on '${actual.runsOn}'; CI_PIPELINE declares '${declared.runsOn}'`,
      });
    }

    const declaredSteps = declared.steps.map(renderDeclaredStep);
    const actualSteps = actual.steps.map((s) => s.rendered);
    const declaredSet = new Set(declaredSteps);
    const actualSet = new Set(actualSteps);
    for (const s of actualSteps) {
      if (!declaredSet.has(s)) {
        findings.push({
          kind: "step_undeclared",
          subject: `${id}: ${s}`,
          detail: `job '${id}' runs '${s}', which CI_PIPELINE does not declare`,
        });
      }
    }
    for (const s of declaredSteps) {
      if (!actualSet.has(s)) {
        findings.push({
          kind: "step_absent",
          subject: `${id}: ${s}`,
          detail: `CI_PIPELINE declares '${s}' for job '${id}'; the workflow does not run it`,
        });
      }
    }
    // Only when the *sets* agree, so one reordered step is one finding rather than two bogus
    // membership findings plus this one. The order is reported because it is the design: the rules
    // step runs before the build on purpose, and a reordering that still runs everything would
    // otherwise be silent.
    if (
      declaredSteps.length === actualSteps.length &&
      declaredSteps.every((s) => actualSet.has(s)) &&
      actualSteps.every((s) => declaredSet.has(s)) &&
      declaredSteps.some((s, i) => actualSteps[i] !== s)
    ) {
      findings.push({
        kind: "step_order_differs",
        subject: id,
        detail:
          `job '${id}' runs the declared steps in a different order: declared ` +
          `${JSON.stringify(declaredSteps)}, workflow ${JSON.stringify(actualSteps)}`,
      });
    }

    for (const declaredStep of declared.steps) {
      if (declaredStep.kind !== "action") continue;
      const rendered = renderDeclaredStep(declaredStep);
      const match = actual.steps.find((s) => s.rendered === rendered);
      if (match === undefined) continue;
      const names = new Set([...Object.keys(declaredStep.with), ...match.inputs.keys()]);
      for (const name of [...names].sort()) {
        const want = declaredStep.with[name];
        const got = match.inputs.get(name);
        if (want === got) continue;
        findings.push({
          kind: "action_input_differs",
          subject: `${id}: ${declaredStep.uses} with.${name}`,
          detail:
            `declared ${want === undefined ? "nothing" : JSON.stringify(want)}, workflow has ` +
            `${got === undefined ? "nothing" : JSON.stringify(got)}`,
        });
      }
    }
  }

  for (const trigger of CI_JOB_TRIGGERS) {
    if (!declaredTriggers.has(trigger)) continue;
    if (fitsBudget(pipeline, trigger)) continue;
    findings.push({
      kind: "budget_exceeded",
      subject: trigger,
      detail:
        `the declared critical path is ${criticalPathMinutes(pipeline)} min against a ` +
        `${trigger === "pull_request" ? pipeline.pullRequestTargetMinutes : pipeline.pushMainTargetMinutes}` +
        ` min budget for '${trigger}'; split the build into its own job or raise the budget`,
    });
  }

  return findings;
}

/**
 * The workflow as the repository holds it.
 *
 * Read from **disk** rather than imported, for the reason every rule in this directory is:
 * `packages/kernel` devDepends on `packages/testing`, so nothing here may import a workspace
 * package, and reading a built artifact would make the rule green only after `pnpm -r build`. Here
 * the subject is not even TypeScript, so disk is the only option there was.
 */
export function readCiWorkflow(root: string = REPO_ROOT): ParsedCiWorkflow {
  return parseCiWorkflow(readFileSync(join(root, CI_WORKFLOW_PATH), "utf8"));
}
