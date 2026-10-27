# ADR-0382: A rule nothing runs

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-26 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0376 (the first fence over `deploy/`, and the argument this one copies), ADR-0335 (why a comparison is both-ways), ADR-0307 (the conditional green a stale `dist` produces), ADR-0330 (ask rather than imitate a parser), ADR-0331 (a claim is not an absence of one), ADR-0334 (a remedy that cannot work is worse than none), ADR-0336 (blocked by shape against blocked by ordering), ADR-0337 (a callerless symbol is a question, not a verdict), ADR-0351 (a test that documented a hazard and asserted nothing), ADR-0356 (the zero-collision premise a `pg_catalog` alias broke), ADR-0361 (the check that cannot fire), ADR-0375 (a judgement with no case left), ADR-0384 (the `AUTH_OUTCOMES` widening that made the suite red) |

## Context

Register item P1.3: **no CI, no git hook, no smoke, e2e, load or migration test.** Re-derived
against the committed tree at `01fda10` rather than taken on trust, and all four halves hold:

- `.github` has **never existed on any branch** — `git log --all -- .github` is empty — and
  `.dockerignore` has excluded it since Phase 1 anyway, so somebody once anticipated the directory
  and nobody created it.
- `.git/hooks` holds **0** non-`.sample` files and `core.hooksPath` is unset. No husky, lefthook,
  simple-git-hooks or lint-staged appears in any of the 90 members' `package.json`.
- So the twelve workspace rules and the 20,185 tests run **only when a human types
  `pnpm -r test`**, and CLAUDE.md's instruction never to use `--no-verify` describes a guardrail
  that does not exist to be bypassed.
- `packages/testing/src/strategy/ci.ts` — 134 lines of `CiJobSchema`, `CiPipelineSchema`,
  `CI_PIPELINE_BUDGET_MINUTES = 20`, `FAST_CI_BUDGET_MINUTES = 10`, `topologicalOrder`,
  `criticalPathMinutes`, `fitsBudget`, `kindsCovered` — was measured at **zero external references
  for all twelve exports**. It is a contract, not an executor and not a generator: no YAML emitter
  exists anywhere in `packages/testing/src`. Nine passing tests, no consumer. The class is **six
  files** (`budgets`, `ci`, `coverage`, `fixtures`, `flake`, `test-kinds`, all dated 26 Sep), and
  `test-kinds.ts` is imported by `ci.ts` alone, so it is transitively dead.

So the repository had a modelled CI with a budget and a dependency graph, and no CI. And it had the
inverse of the register's heading: not merely *nothing runs the rules*, but **a declaration of what
should run them that nothing read.**

Two measured facts changed the shape of the work, and both contradict CLAUDE.md:

**`pnpm lint` fails, and it is not the vacuous green that file records.** `next lint` with no
config **prompts interactively** (`? How would you like to configure ESLint?`) and the non-TTY read
cancels it, so turbo reports `Failed: @crossengin/operate-web#lint`. And the v9 flat config *does
exist*, at `packages/config/eslint/base.mjs` — a real `tseslint.config(...)` exported as
`"./eslint/base"` with `eslint ^9` in peer deps — referenced by **zero** files. Measured: **90**
members, exactly **1** `lint` script (`operate-web -> next lint`), and that app has **no eslint
config file and no eslint dependency at all**. So lint is a hard red, not a falsely-true control,
and a lint job would fail every run from the first.

**`pnpm -r <script>` is not turbo and bypasses `dependsOn`.** `turbo.json` declares
`test`/`typecheck`/`lint` as `dependsOn: ["^build"]` and the *root* scripts are turbo — but
`pnpm -r typecheck`'s log holds 0 `build$` lines, 0 cache hits, and the string `turbo` appears in
neither log. The three sweep figures are therefore independent and additive, and CLAUDE.md's
documented ordering is enforced only by the `&&` between them. That matters because the build is a
**hard prerequisite nothing enforces**: `dist/` is gitignored, **372 of 771** test files name an
`@crossengin/*` package on a `from "…"` line (a lower bound — a single-quoted or multi-line import
is not matched), and **87** of the **88** members holding a `vitest.config.ts` import
`@crossengin/testing/vitest`, which resolves to `dist/`. On a fresh
checkout `pnpm -r test` cannot load its own configs.

With one exception, and it is the exception the whole design turns on.

## Decision

Three parts.

**1. One sequential workflow, `.github/workflows/ci.yml`**, on `pull_request` and `push: [main]`,
one job `verify` on `ubuntu-latest`:

```
actions/checkout@v4
pnpm/action-setup@v4        version: 9.12.0
actions/setup-node@v4       node-version: 20, cache: pnpm
pnpm install --frozen-lockfile
pnpm --filter @crossengin/testing test     # the only build-independent step
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

**The step order is the design, and the exception above is what licenses it.** Three measurements,
and the first is the decisive one that the original draft of this paragraph did not have.

`packages/testing/package.json` lists exactly **one** workspace dependency — `@crossengin/config`,
and it is a **devDependency**. That package has no `src/` and **no `scripts` at all**, so
`pnpm -r build` produces nothing for it and `tsconfig.json`'s `extends` resolves a committed JSON
file. Its runtime `dependencies` are `vitest` and `zod`, both third-party. So there is no workspace
artifact `@crossengin/testing` could be waiting on.

Second, there are **zero** real `import … from "@crossengin/…"` statements anywhere under
`packages/testing/src`. The breakdown is written out rather than summarised, because the summary was
wrong: **23** textual occurrences of `from "@crossengin/`, of which **20** are string literals
inside `*.test.ts` fixtures (8 distinct specifiers — `@crossengin/auth`, `@crossengin/kernel/ddl`,
`@crossengin/kernel/manifest`, `@crossengin/jobs`, `@crossengin/tenant-lifecycle`,
`@crossengin/types/meta-schema`, `@crossengin/incident-response`, `@crossengin/widgets-pg`) and
**3 are doc comments** — `pg-value-set-domains.ts:307`, `pg-column-bindings.ts:804`, and `ci.ts`'s
own sentence making the claim, **which is therefore its own counterexample**. This ADR and that
comment both said "string literals inside test fixtures" and nothing else; the conclusion held and
the stated measurement did not, which is this repository's most-found class landing on the
measurement the whole step order rests on, for the second time in one increment (the test-kind
census below is the first).

Third, `packages/testing/vitest.config.ts:1` is
`import { vitestPreset } from "./src/vitest-preset.js"` — the **88th** of those configs, and the one
that does not resolve through `dist`. So the twelve rules read the workspace from disk as text and
need nothing built. They are **redundant for coverage** — `pnpm -r test` includes them — and bought
purely for fail-fast, with the arithmetic shown so it is checkable: a drifting pull request
surfaces the failure at 46 s rather than after build + typecheck + test have all run
(149.3 + 130.7 + 200.5 = 480.5 s), so **+46 s on a green pull request against −434 s on a drifting
one**.

No lint job. No separate `operate-web` steps. No Postgres service. Node pinned to the major **20**,
not the 22.22.2 this machine runs, on two agreeing measurements: `engines.node` is `">=20"`, so 20
is the version the repository promises, and `deploy/Dockerfile:6` is `FROM node:20-bookworm-slim`,
so 20 is the only major anything deploys. Testing the floor tests the promise.

**2. `.githooks/pre-commit`, running `pnpm --filter @crossengin/testing test`** — around **ten
seconds warm** (2026-10-26), inside the range nobody bypasses. No path narrowing, because every rule
reads the whole workspace, so a filter would skip exactly the edits they exist to catch. None of the
three sweeps, which are 149/131/200 s and meaningless before a fresh build anyway.

The hook carries **no file or test count**, and that is a correction rather than an omission. It
shipped with "19 files, 663 tests" — the package's **pre**-increment figures, while this increment
took it to 20 / 716 and the review pass below took it to 20 / **723**, moving the number twice in one
commit. A count in a comment is stale by construction (CLAUDE.md's P3 item 1), so the hook says
`re-derive it by running the command`, which is that file's own method for the ADR-0373 figures.

Installed by **`sh .githooks/install-hooks.sh`**, which the root `prepare` script invokes behind the
`git rev-parse --git-dir` guard. The logic is a script and not an inline `git config` because it has
three branches and two of them exist to *not* act — see the addendum, where the inline form was
measured clobbering a foreign hooks path and defeating its own documented undo.

**3. `CI_PIPELINE` in `ci.ts`, and `ci-workflow.ts` as the thirteenth workspace rule.** The pipeline
is declared in TypeScript, where `tsc` and the other twelve rules reach it; the rule reads the YAML
**as text** and compares the two **in both directions** on every test run. ADR-0376's argument
transfers word for word — a compose file is not typechecked, not linted and imported by nothing, so
a deleted line is invisible to every rule and every test, which is how `docker-compose.ai.yml` came
to be ten flags behind the base — and **a workflow YAML is in that state and worse, because the
thing it executes is the fence.** A pull request deleting the `pnpm -r test` step deletes the only
check that would have objected, and reports green.

## Alternatives considered

- **Option A: `pnpm -r build` as its own job with a `dist/` cache, fanning typecheck and test out behind it.**
  - **Pros:** the measured critical path drops from 8.78 min to ~5.9.
  - **Cons:** `dist/` is gitignored and must cross a job boundary as a cache or artifact, so the key
    has to be a content hash over all 943 source files — and a stale hit makes typecheck and test
    green against the **previous** build, which is ADR-0307's conditional green, the exact defect
    class CLAUDE.md records twice. Three jobs each pay install rather than one.
  - **Why not:** the simpler shape fits. 526.7 s of measured suite work against a 10-minute budget
    does not require it, and buying 3 minutes with a second build-correctness mechanism nobody asked
    for is the wrong trade. It is the first remedy named when the budget fires.

- **Option B: add a YAML parser so the rule reads the file properly.**
  - **Pros:** no hand-rolled reader; anchors, flow mappings and block scalars all just work.
  - **Cons:** **no YAML dependency exists anywhere in this workspace**, and `packages/testing` is
    devDepended on by all 89 other members, so this would put third-party code in everything's build
    graph for one file the fence also writes.
  - **Why not:** the honest alternative to a parser is not a smaller parser, it is a **refusal**.
    ADR-0330's rule is to ask Postgres rather than imitate its parser; here there is nothing to ask,
    so the reader enforces one fixed shape and throws on any line it cannot place — which is
    available precisely because the file is one this repository writes and can be required to stay
    simple.

- **Option C: a lint job.**
  - **Pros:** the flat config exists and is good; `recommendedTypeChecked` over 90 packages would
    find real things.
  - **Why not:** measured, it is a hard red today — 1 lint script in 90 members, pointing at
    `next lint` in an app with no eslint config and no eslint dependency. Wiring
    `packages/config/eslint/base.mjs` into 90 members is its own increment, and shipping a CI that
    fails on arrival teaches people to ignore it.

- **Option D: separate `npx next build` / `npx tsc --noEmit` steps for `operate-web`, as CLAUDE.md instructs.**
  - **Why not:** redundant, and measured from the app's own `package.json` rather than reasoned —
    it has `"build": "next build"` and `"typecheck": "tsc -p tsconfig.json --noEmit"`, so
    `pnpm -r build` and `pnpm -r typecheck` already cover it. Only the *test* sweep excludes it,
    because it has no vitest config and no tests. CLAUDE.md's instruction is corrected rather than
    followed.

- **Option E: a Postgres service container.**
  - **Why not:** a workspace-wide grep over all 767 `*.test.ts` for `new Pool`, `new Client` and
    `from "pg"` returns **0 hits**. Every Postgres-backed module is tested against a fake
    connection; the live verification this repo insists on is a human with a throwaway cluster, and
    a service nothing connects to is a minute per run for nothing.

- **Option F: pin Node 22, the version developers run here.**
  - **Pros:** CI matches the local shell exactly.
  - **Why not:** `engines.node` says `">=20"` and `deploy/Dockerfile` ships `node:20-bookworm-slim`,
    so 22 is a version the repository makes no claim about and nothing deploys. A 22-only syntax
    feature passing locally and failing CI is CI doing its job. Floating within the major rather
    than pinning a patch, for the same reason the image does: a patch pin goes stale on every Node
    security release and says nothing extra.

- **Option G: an unguarded `prepare` script.**
  - **Why not:** measured. `.dockerignore:7` excludes `.git`, so inside `deploy/Dockerfile:19`'s
    `RUN pnpm install --frozen-lockfile` there is no repository, and the unguarded form exits
    **128** with `fatal: not in a git directory` — which would stop the deployment image building.
    The guarded form exits 0 in both positions, verified in a directory with no `.git`. And
    `pnpm install --frozen-lockfile` really does run `prepare`, measured on the repo's pinned
    pnpm 9.12.0 and again on 10.33.0.

- **Option H: commit the hook and document `git config core.hooksPath .githooks`, with no `prepare`.**
  - **Pros:** nothing runs on install; no guard to get wrong.
  - **Why not:** a hook nobody installs is a hook that does not exist, which is the condition this
    increment is closing. The `|| true` means the worst case is the status quo — ADR-0334's
    remedy-that-cannot-work is answered by the guard, and the worse failure (breaking
    `pnpm install`) is what Option G measures.

- **Option N: `prepare` sets `core.hooksPath` unconditionally.** *(As shipped, and reverted in review.)*
  - **Why not:** measured in a throwaway repository, both halves. A pre-existing
    `core.hooksPath=/my/own/hooks` became `.githooks` with **no warning**, which takes away hooks
    somebody chose and fails silently — worse than not installing. And
    `git config --unset core.hooksPath` was **re-set on the next `pnpm install`**, so the undo this
    ADR documented did not work: ADR-0334's remedy-that-cannot-work, in the Consequences of the
    increment that cites ADR-0334 three times. The replacement declines on a foreign path, says so
    on stderr, and reads `crossengin.hooks` **before** it writes anything, which is what makes the
    unset stick. All four branches plus the two absent-file branches verified; the detail is in the
    addendum.

- **Option O: an env-var opt-out (`CROSSENGIN_SKIP_HOOKS=1`) instead of a git config key.**
  - **Why not:** the thing being undone is *per clone and persistent*, and an environment variable
    is neither — it would have to be re-exported in every shell that ever runs `pnpm install`, which
    is the same "works until you forget" shape as the `--unset` it replaces. `git config` is where
    the state being changed already lives, so the opt-out and the thing it opts out of are read from
    one place.

- **Option I: narrow the hook — a subset of rules, or a path filter.**
  - **Why not:** around ten seconds warm is inside the range nobody bypasses, so there is nothing to buy; and a
    path filter would be actively wrong, since every rule in `strategy/` reads the *whole* workspace
    from disk, so an edit to the catalog, a store's SQL, a pack's manifest or
    `deploy/docker-compose.yml` can each break one.

- **Option J: declare four chained jobs rather than one, exercising `dependsOn` and `topologicalOrder`.**
  - **Pros:** the schema's graph machinery would have a live reader.
  - **Why not:** two reasons, and the second is decisive. The workflow **is** one sequential
    `runs-on` block, so four jobs would be a declaration that does not describe the artifact — this
    increment's own defect class. And `CiJob.targetMinutes` is `z.number().int()`, so four jobs need
    four ceilings: 1 + 3 + 3 + 4 = **11**, which exceeds a 10-minute budget the measured total
    (8.78) does not. Rounding down to make it fit would be a fence that fires late.

- **Option K: build the rule's reject fixtures from a frozen literal rather than mutating the real file.**
  - **Pros:** a fixture cannot be perturbed by an edit to the shipped workflow.
  - **Why not:** a frozen fixture goes stale silently against a file shape that changed, which is
    ADR-0355's *a measurement taken once goes stale* one artifact over. `mutate()` asserts its
    anchor is present in the real file, so a stale fixture fails loudly. The cost — one real edit
    perturbing several fixtures — is paid by `addedKinds`, below.

- **Option L: delete the five remaining dead contracts (`budgets`, `coverage`, `fixtures`, `flake`, `test-kinds`).**
  - **Why not:** ADR-0337's rule. A callerless symbol is a question, not a verdict, and deleting
    five contracts is a separate decision. `test-kinds.ts` additionally stops being dead the moment
    `ci.ts` has a reader, which is now.

- **Option M: `permissions: contents: read` and a `concurrency:` block on the workflow.**
  - **Pros:** least-privilege for the `GITHUB_TOKEN`, and superseded runs cancelled instead of
    burning 9 minutes.
  - **Why not:** both would be configuration the fence has no comparison for, and the fence's claim
    is that every line in that file which executes anything is declared. A half-fenced security key
    is worse than a named follow-up, so the shipped file has exactly three top-level keys and any
    fourth is reported as `workflow_key_undeclared`. This is open question 1.

## Consequences

- **Positive.** The twelve rules and the 20,185 tests run on every pull request and every push to
  `main`, and 11.7 s of them run before every commit. `ci.ts` has a reader, so its budget, its
  schemas and `test-kinds.ts` stop being dead. The workflow and the hook — two files in exactly the
  state ADR-0376 found `deploy/docker-compose.yml` in — are fenced, in both directions, by a rule
  that runs in the suite they start.
- **Negative, and it is real — but it is narrower than the first draft of this entry claimed.**
  `criticalPathMinutes(CI_PIPELINE)` is **9** against a budget of **10**, and `targetMinutes` is now
  **derived** from `CI_MEASURED_STEP_SECONDS` rather than typed, which is what gives the check a
  triggering event at all. It fires on exactly two, both reachable and both tested: a **new command
  step**, which `measuredStepDisagreements` refuses until it carries a figure; and a
  **re-measurement** whose sum passes 600 s, since `ceil(601/60)` is 11 against a budget of 10. So
  the slack is 73.3 s — the 1.22 minutes this entry called "measured growth", which was the right
  arithmetic under a word that claimed more than the mechanism did. When it fires the remedy is
  Option A or a change to `FAST_CI_BUDGET_MINUTES`; both are named in the constant's doc comment,
  because a refusal naming no remedy is worse than none.
- **Negative, and it is the half the budget cannot see.** Nothing here times a run, so an **existing**
  step getting slower — `pnpm -r test` drifting from 200 s to 500 s with nobody re-measuring — leaves
  `fitsBudget` true for ever. This entry said "the fence **will** fire", which was a claim about
  growth the mechanism cannot observe: ADR-0361's check-that-cannot-fire, inside the increment citing
  it. The honest statement is in `CI_PIPELINE`'s doc comment, and so is the refutation of the obvious
  remedy: `timeout-minutes:` on the job puts the budget in the runner's hands, and it cannot carry
  *this* budget, because the job's wall clock is install + the suite, install is deliberately
  unmeasured, and `timeout-minutes: 10` against an 8.78-minute suite would red the **first green**
  pull request on install latency alone — which is Option C's own argument, that shipping a CI which
  fails on arrival teaches people to ignore it. A generous ceiling is honest and enforceable and
  enforces a different claim (this job does not hang); landing it needs a `CiJob` field, a fifth
  member of `CI_JOB_YAML_KEYS` and a sixteenth finding kind. Today the fence **reports** such a key
  as `job_key_undeclared` rather than forbidding it, which is the demand for a declaration surface
  working as designed. Open question 6.
- **Negative.** `targetMinutes` **excludes `pnpm install --frozen-lockfile`**, and no figure for it
  is invented: it could not be measured here without rewriting a `node_modules` three concurrent
  agents were reading. It is in `CI_MEASURED_STEP_SECONDS` as an explicit `null` rather than an
  absent key, which is ADR-0331's distinction doing real work — an omitted key would be reported as
  an unmeasured step, so `null` is what lets *deliberately unmeasured* be something the declaration
  can say. The budget bounds **the suite**, not a pull request's wall clock, and the real figure is
  9 min plus however long install takes on a cold runner cache.
- **Negative.** The hook checks the **working tree**, not the index. For `git add -A && git commit`
  those are the same; for a partial stage they are not, and the CI sweep is the backstop. And it
  **fails** when pnpm is not on `PATH` rather than passing — a GUI git client without pnpm is
  blocked. Fail-closed on ADR-0334's rule: a hook that quietly does nothing for an unknown fraction
  of commits is worse than none. Its message names `PATH` and the two-line opt-out, and
  **deliberately not `--no-verify`**, which the first version did recommend — a hook telling a
  developer to break a rule CLAUDE.md forbids by name, in the increment whose stated purpose is to
  make that instruction describe something real.
- **Neutral.** `CiJobSchema` gained `steps` and `runsOn`, both defaulted, so every prior declaration
  — including this file's own nine tests — still parses unchanged. `CiStepSchema` is new. A
  `CI_STEP_KINDS` array and a `CiStepKind` alias were added beside it and **deleted in review**: see
  the addendum.
- **Reversibility.** High and cheap in both directions. Deleting `.github/workflows/ci.yml` makes
  `ci-workflow.test.ts` fail loudly rather than quietly, which is the point; deleting the rule and
  the constant returns `ci.ts` to its callerless state. The hook is declined per clone, and
  **persistently**, with `git config crossengin.hooks off` followed by
  `git config --unset core.hooksPath` — the installer reads that key before it writes anything. This
  entry used to say `git config --unset core.hooksPath` alone "undoes its effect per clone", and
  measured, it did not: the next `pnpm install` re-set the path. See the addendum.

## Implementation notes

**What `ci-workflow.ts` reads, and what it refuses.** One fixed shape: two spaces per level,
`on:`/`jobs:` at column 0, a job id at 2, a job key at 4, a step's `- ` at 6, a step key at 8, a
`with:` entry at 10. The precise claim the both-ways comparison rests on, stated exactly because an
approximation of it would be the thing the rule exists to prevent: **every non-blank, non-comment
line is either consumed by the shape, or sits inside a block the rule has already reported as
undeclared, or is refused by name.** There are exactly **two** reported blocks and both are
reachable — an unexpected top-level key (`workflow_key_undeclared`) and an unexpected per-job key
(`job_key_undeclared`, where a `services:` or `strategy:` block lands). Their bodies are skipped
rather than refused because both realistically *have* bodies, so refusing would name the body's
first line instead of the key and each finding would be reachable only for a childless key — a
judgement with no case left (ADR-0375). `CI_JOB_YAML_KEYS` is read by the parse *and* by the audit,
so the set the reader skips and the set the audit reports cannot come to differ.

**`CI_TRIGGER_YAML_KEY.schedule` names a spelling whose body is refused by name**, which is the
honest form of a map member the reader cannot serve and is a correction: as first shipped, the only
reachable case for that member was a **childless** `schedule:`, which GitHub itself rejects, so the
member was the ADR-0375 shape this ADR invokes two paragraphs down for `job_key_undeclared`. A real
`schedule:` carries a `- cron:` list and `CiJob` has no field a cron could be compared against, so
reading one would produce a value nothing in the declaration can contradict — the half-fenced shape
Option M refuses a `permissions:` block for. The refusal names the missing field rather than saying
"unreadable", so the next person adds the declaration instead of widening the parser; it is
`contract_cannot_carry_the_surface` and not `prerequisite_of_unbuilt_surface` (ADR-0336's
distinction). The childless form still parses and still reports `trigger_undeclared`, so both arms
are reachable and both are tested.

Refused by name, each with the line number and the line: a tab; no `jobs:`; zero jobs; a job with
zero steps; a step with neither `uses:` nor `run:`; a step with **both** (GitHub refuses it too, and
accepting it would let the second overwrite the first so the fence compared one body while the other
ran); a block scalar (`run: |`, which cannot be compared as one string, and comparing its first line
would **understate** — the one direction a fence must never fail in); a step key other than `name`,
`uses`, `with`, `run` (an `if:` or an `env:` changes whether or how a step runs); and any
mis-indentation. Full-line comments are skipped; **trailing** comments deliberately are not,
because a `run:` command may contain `#` and a stripper would truncate it.

**Fifteen finding kinds**, with `CI_WORKFLOW_FINDING_MEANINGS` a total `Record` over them — so a
sixteenth is a compile error until it says what it claims — and a test asserting no meaning restates
its own key (ADR-0351's hazard: a map that documents a hazard and asserts nothing).
`CI_TRIGGER_YAML_KEY` is a total map from `ci.ts`'s provider-neutral vocabulary to GitHub's `on:`
spelling, and it lives in the rule and not beside `CI_JOB_TRIGGERS` because `ci.ts` says `push_main`
rather than `on: push` with a branch filter — the spelling belongs with the module that reads the
provider's file.

**`step_order_differs` fires only when the step *sets* agree**, so one reordered step is one finding
rather than two bogus membership findings plus this one. Order is reported at all because it is the
design: the rules step runs before the build on purpose.

**Deliberately not used by the rule: `topologicalOrder` and `kindsCovered`.** A one-job pipeline has
no graph, and `runs: ["unit"]` is one kind — forcing either into the audit would be a use that
proves nothing. They keep their own tests.

**The measured figures, and where they are.** In `CI_MEASURED_STEP_SECONDS` rather than only in a
comment, keyed by the command each figure is for: the four sweeps at `01fda10` on a 4-vCPU/15 GiB
host (within noise of a GitHub `ubuntu-latest` standard runner, so they transfer) — 46.2, 149.3,
130.7, 200.5 — summing to 526.7 s, 8.78 min, **ceiling 9, computed**. `pnpm install
--frozen-lockfile` is an explicit `null` beside them. `measuredStepDisagreements` compares those
keys against the declared command steps in both directions, so the map and the pipeline cannot come
apart, and `targetMinutes` reads the sum. That is what replaced a hand-typed `targetMinutes: 9`
compared by a test against `criticalPathMinutes`, which for a one-job pipeline **is** that literal:
the declaration against itself. `runs: ["unit"]` is measured and not aspirational: over the 771
`*.test.ts` files on 2026-10-26, `toMatchSnapshot`/`toMatchInlineSnapshot` occurs in **0**,
`fast-check` in **0**, `playwright`/`puppeteer` in **0**, `axe-core`/`jest-axe` in **0** and
`new Pool`/`new Client`/`from "pg"` in **0**. One of the ten `TEST_KINDS`, which is a finding in
itself (open question 3).

**And that census now matches itself, which is this repository's most-found class landing on this
increment's own measurement.** Re-run naively, every one of those five patterns returns exactly
**1** — `ci-workflow.test.ts`, the file whose comments quote all five while explaining the figure.
The zeros hold only with that file excluded, so the exclusion is written into both comments as part
of the measurement rather than as a footnote to it: a reader re-deriving the figure otherwise gets
`1` for snapshot tests and concludes one has arrived. Caught by re-measuring before reporting rather
than by review, which is the only thing that would have.

**The mutation battery.** Nine disk mutations, each applied and then reversed by the exact inverse
string replacement with the mutation asserted present first — never `git checkout --`, which
CLAUDE.md forbids by name and which would have discarded three other agents' uncommitted work.
All nine fire and all nine restores are green: the YAML dropping the test sweep; `CI_PIPELINE`
dropping the typecheck step; the declared path outgrowing the budget; the Node pin moving to 18; the
rules step moving after the build; the hook's body replaced by `exec true`; the hook gaining a sweep;
the `prepare` guard dropped; and a `services:` block appearing.

**The first attempt at that battery left a file edited**, and the lesson is worth keeping: a
deletion's inverse cannot be located by a string search, so `s.replace("", original)` is not a
restore. Every mutation is now a non-empty → non-empty swap, and the reverse asserts single
occurrence before writing.

**`exec true` is the one that found a real defect in this increment's own test**, and it is this
repository's most-found class reproduced inside the increment citing it. The hook's doc comment
*quotes* the command it runs, so `expect(hook).toContain(command)` passed with the body replaced —
ADR-0376's finding, in a file where I had written the comment warning about exactly that hazard one
assertion below. Both assertions read a comment-stripped copy now, with a vacuity guard asserting
the strip removed the commentary and kept the body.

**`addedKinds` is the second correction.** The fixtures are mutations of the real workflow, so
breaking the real file moved the baseline each fixture was compared against and one edit produced a
dozen failures — which is what the `step_order_differs` guard exists to avoid, one level out.
Measured over the nine mutations: the six that edit the workflow or the declaration went from
**12–18** failing tests apiece to **2–9**; the three that edit the hook or `prepare` were 1–2 either
way, never passing through the baseline. The residual 9 is not a cascade: deleting a step the
fixtures *anchor* on makes `mutate` fail its own presence guard, which is the guard working.

**Test counts.** `ci-workflow.test.ts` 49 → **52**, `ci.test.ts` 9 → 13 → **19**. The package goes
19 files / 663 tests → **20 / 723**, re-derived statically after the review pass (716 at first
commit; `grep -cE '^\s*(it|test)\(' ` over the 20 files, with **0** `it.each`, so the count is exact
rather than a lower bound). The figure moved twice inside one commit, which is why the hook no longer
quotes one.

**The hand reader was cross-checked against a real YAML parser**, once, as a verification rather
than a dependency: `python3 -c "yaml.safe_load(...)"` over the shipped file agrees with it on every
structural fact — three top-level keys, `{"pull_request": null, "push": {"branches": ["main"]}}`,
job keys `[runs-on, steps]`, and the eight steps in order with their `with` maps. One difference,
and it is the one `CiStepSchema.with`'s doc comment predicts: pyyaml reads `node-version: 20` as the
**integer** 20 where the text reader reads `"20"`. The declaration is `Record<string, string>` for
exactly that reason, and `setup-node` accepts either.

**A typo in an optional declared field fails closed**, measured rather than assumed, because
`CiPipelineSchema.parse` takes `unknown` and `z.object` is non-strict — so `stepz:` is **stripped**
and `steps` defaults to `[]`. The failure is loud: 6 failing tests, led by *agrees with
`CI_PIPELINE` in both directions*, since every workflow step then reads as undeclared. Making the
inner object `.strict()` would turn it into a parse error instead; it was left alone because the
current failure already names the right file and the change would touch a contract nine other
tests exercise.

**Reported, not fixed: the two exported-name collisions**, because measuring them is the whole
answer and the answer is that neither is live. `packages/testing` and `@crossengin/sso` both export
`TEST_OUTCOMES`; `packages/testing` and `@crossengin/security` both export `IMPACT_ORDER`; both
reach 80+ devDependents through `export *`. The question was whether
`pg-value-set-domains.ts`'s resolver can be confused, since it holds the declaration ref
`"@crossengin/sso:TEST_OUTCOMES"` — ADR-0354 records a real defect of exactly this shape, *a
bare-name map holding whichever `SeveritySchema` was scanned last*.

**It cannot.** Run against the real workspace (943 files, 1,450 domains, 0 unresolved):
`TEST_OUTCOMES` resolves to **two** domains, each package-qualified —
`@crossengin/sso packages/sso/src/providers.ts:44` with five members and
`@crossengin/testing packages/testing/src/strategy/flake.ts:5` with four — and
`auditValueSetDomains` keys its candidate index `${domain.package}:${domain.name}` and resolves a
ref through `parseRef`, so `@crossengin/sso:TEST_OUTCOMES` can only match sso's. The only name-only
step in the resolver is `lookup`'s fourth fallback, and it answers `undefined` for a two-way
collision rather than picking one — fail-closed, and unreachable for this name anyway, because both
`z.enum(TEST_OUTCOMES)` uses are in the same file as their declaration and resolve at step one.
`IMPACT_ORDER` is stronger still: it resolves to **0** domains in either package, because both are
`Object.freeze({…})` — a `Record`, not an `as const` array of string literals — so the collector
never records it and it cannot reach the resolver at all.

## Addendum: what an adversarial review found

Seven findings, all applied. Two were claims this document made that measurement refutes, one is a
diagnosis that was wrong about which file was at fault, and four are the shapes this repository keeps
finding landing inside the increment that cites them.

**1. The budget could not fire from the thing this ADR said it guarded.** `targetMinutes: 9` was a
hand-typed literal and `criticalPathMinutes` over a one-job pipeline **is** that literal, so
`expect(criticalPathMinutes(CI_PIPELINE)).toBe(9)` was the declaration compared with itself — and
"the fence **will** fire" was a claim about growth nothing observes. Closed by deriving the ceiling
from `CI_MEASURED_STEP_SECONDS` and fencing that map against the declared steps both ways; the
remaining gap, an existing step getting slower, is stated with the refutation of its obvious remedy
(see Consequences and open question 6). Verified by mutation: `pnpm -r test` re-measured 200.5 →
500.5 makes `budget_exceeded` fire through the rule's main both-ways assertion against the **shipped
YAML**, where before the change no edit to any measurement could move the verdict.

**2. `prepare` clobbered, and the Reversibility paragraph was false.** Measured in a throwaway
repository: `core.hooksPath=/my/own/hooks` → `.githooks` with no warning, and
`git config --unset core.hooksPath` re-set on the next `pnpm install`. Closed by
`.githooks/install-hooks.sh` — declines on a foreign path and says so, reads `crossengin.hooks`
before writing, prints only when it changes something. Four branches plus two absent-file branches
verified; the escape now survives a reinstall. The hook's pnpm-missing message named `--no-verify`,
which CLAUDE.md forbids by name, and names the two-line opt-out instead.

**3. The suite was red on arrival for two reasons, and this increment caused neither.** The first
report of it named only `packages/operate-runtime-pg/src/trigram-index-audit.ts` via
`pg-record-reads.ts`, which was the *second* cause and not the only one. Both are closed, and both
are worth recording because they are the thirteenth rule's own class in two other rules:

- **`pg-value-set-domains.ts`** — ADR-0384 added two `AUTH_OUTCOMES` members and that rule's
  `mirrors` declaration asserts set equality **in both directions**, so widening the contract without
  widening the catalog is a failure by design. Closed by adding `'scheme_not_supported'` and
  `'credential_unrecognized'` to `meta.gateway_pipeline_executions.auth_outcome`'s CHECK; verified by
  reading both sides — the enum has 18 members and the CHECK names the same 18.
- **`pg-record-reads.ts`** — a `pg_catalog` row alias of `schema_name`, which is a catalogued column
  of `meta.tenants`, so it was the first counterexample to ADR-0356's measured zero-collision
  premise. Closed by keeping `pg_catalog`'s own `nspname`, with the reason at the interface.

Neither is a merge-sequencing caveat any more; the note is kept because a reader landing this commit
needs to know the red was not the new rule's, and because "a rule nothing runs" is precisely the
state in which two such drifts can accumulate unseen.

**4. `CI_STEP_KINDS` and `CiStepKind` were new exports with no forcing function** — zero readers and
one, the one asserting the constant equalled its own literal — while `CiStepSchema` spells its
members with `z.literal(...)` and never read the array, so a third member added to one and not the
other was not a compile error. The 6-line comment arguing for "one ordered list rather than two
parallel arrays" described the *schema*. Both deleted. The forcing function is where it already was
and is now asserted: `ci.test.ts` reads `CiStepSchema.options`, and `renderDeclaredStep` is the
compile-time half — verified by mutation, a third member gives
`error TS2339: Property 'run' does not exist` at `ci-workflow.ts:445` and fails the membership test.

**5. The hook carried pre-increment figures** (19 files / 663 tests against the package's 20 / 716,
and 723 after this pass). Replaced by "re-derive it by running the command", with the reasoning on
file. P3 item 1's class, in a file this ADR added.

**6. `CI_TRIGGER_YAML_KEY.schedule` had no reachable case** but a childless `schedule:` GitHub
itself rejects. Closed by a named refusal for its body; see the implementation note.

**7. The import claim was wrong in the measurement and right in the conclusion.** Three of the
`from "@crossengin/` occurrences are doc comments and not test fixtures, and one of the three is the
sentence making the claim. Rewritten with the breakdown and with the decisive measurement it did not
have — `packages/testing`'s only workspace dependency is `@crossengin/config`, a devDependency with
no `src/` and no `scripts`.

**And one thing the review got imprecise, with the measurement.** It said the fence "forbids" the
`timeout-minutes:` key that would make the budget real. It **reports** it, as
`job_key_undeclared`, whose detail names the claim it contradicts and whose remedy is to declare it
— the demand for a declaration surface rather than a prohibition. The distinction matters because
the remedies differ: a refusal would have to be removed, where a finding is cleared by adding the
`CiJob` field the key needs.

**The mutation battery for this pass** is five swaps, each applied and reversed by the exact inverse
string replacement with single occurrence asserted both ways — never `git checkout --`, which
CLAUDE.md forbids and which would have discarded two other agents' uncommitted work. All five fire
and all five restore green: a measured step's key renamed (both directions of
`measuredStepDisagreements`), a sweep re-measured past the budget, a third `CiStep` member,
`--no-verify` put back in the hook's body, and the installer's `!=` flipped to `=`. **The fifth
refused its own reverse**, because the mutation created a *second* occurrence of the mutated string —
the guard doing its job, and the same hazard this ADR already records one paragraph up; reversed with
a longer unique anchor and the installer re-verified against all four branches afterwards.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 1. A `permissions:` block needs a declaration surface before it can land | Platform | — |
| 2. The install step's duration is outside the budget and unmeasured | Platform | — |
| 3. One of ten test kinds | Platform | — |
| 4. `.nvmrc` | Platform | — |
| 5. Five dead contracts | Platform | — |
| 6. A wall-clock ceiling the budget cannot be | Platform | — |

1. **`permissions: contents: read` is the right default and has no comparison here.** The shipped
   file has three top-level keys so that *every* executing line is declared, and a fourth is
   reported as `workflow_key_undeclared`. Landing it means either a declared literal on
   `CiPipeline` or a per-key comparison in the rule — a small surface, and until it exists the
   `GITHUB_TOKEN` runs with whatever the repository's default setting is, which this file cannot
   see. `concurrency:` is the same shape and cheaper, since a cancelled superseded run saves nine
   minutes.

2. **The budget is a bound on the suite and not on a pull request.** `pnpm install
   --frozen-lockfile` could not be measured on this machine without rewriting a `node_modules`
   three concurrent agents were reading, so no figure for it was invented. A first CI run will
   produce one, and when it does the question is whether install belongs in `CI_PIPELINE` as a
   second job — which would make `criticalPathMinutes` the real wall clock and make the budget
   depend on a runner's network, which is why it was left out rather than guessed.

3. **`runs: ["unit"]` is one of ten `TEST_KINDS`**, and the four zero-counts above are the honest
   reason rather than a gap in the pipeline: there are no snapshot, property, e2e or accessibility
   tests to run. `coverage.ts`, `budgets.ts` and `flake.ts` model all three of the missing
   families and remain unread. Whether the pyramid `test-kinds.ts` declares is a target this
   repository wants is a product question, not a wiring one.

4. **There is no `.nvmrc`**, only `engines.node: ">=20"`, so a developer's shell version is
   unpinned — this machine runs 22.22.2 while the workflow and the deployment image both run 20.
   One file, outside this increment's scope; the pin is now written down in three places (`engines`,
   `deploy/Dockerfile`, the workflow) and a test asserts the latter two agree with the first.

5. **The five remaining dead contracts stay**, on ADR-0337's rule. What is now known that was not:
   `test-kinds.ts` has a transitive reader, so the set is five rather than six, and the two
   exported-name collisions in that set are measured non-defects rather than suspicions.

6. **Nothing times a CI run, so an existing step getting slower is invisible to the budget.**
   `fitsBudget` compares declared numbers and fires on a new step or a re-measurement; a `pnpm -r
   test` that drifts from 200 s to 500 s with nobody re-measuring leaves it true. The mechanism is
   the runner's `timeout-minutes:`, and it is open rather than taken for a measured reason: the job's
   wall clock is install + the suite, install is the explicit `null` in `CI_MEASURED_STEP_SECONDS`
   (question 2), so `timeout-minutes: 10` would red the first **green** pull request on install
   latency alone. A generous ceiling is enforceable and enforces a different claim — this job does
   not hang — which is worth having and is not this budget. Landing either needs a `CiJob` field, a
   fifth member of `CI_JOB_YAML_KEYS` and a sixteenth finding kind, and the first CI run that
   produces an install figure is what makes the choice between them decidable. Ordered after
   question 2 for that reason.

## References

- `.github/workflows/ci.yml`, `.githooks/pre-commit`, `.githooks/install-hooks.sh`, root
  `package.json`'s `prepare`
- `packages/testing/src/strategy/ci.ts` (`CI_PIPELINE`, `CiStepSchema`,
  `CI_MEASURED_STEP_SECONDS`, `measuredStepDisagreements`), `ci-workflow.ts`
- ADR-0376 (`apps/operate-server/src/deployment-defaults.test.ts`, the precedent)
- ADR-0335 (`packages/testing/src/strategy/pg-record-retention.ts`, the both-ways precedent)
- `turbo.json`, `deploy/Dockerfile`, `.dockerignore`, `packages/config/eslint/base.mjs`
