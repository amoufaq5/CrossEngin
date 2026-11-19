import { z } from "zod";

/**
 * Every workspace member that holds TypeScript runs a test runner over it, or says why it does not.
 *
 * ADR-0382 closed the half of register P1.3 that was about *running* the rules — there is a CI
 * workflow and a pre-commit hook now, so the twelve strategy rules and the whole suite run without a
 * human typing anything. What that increment deliberately did not take is the other half: whether
 * every member has a runner at all. One member does not, and the absence is invisible by
 * construction, because a member that never runs a test never fails one — the same shape
 * `typecheck-config.ts` exists to prevent one tool over.
 *
 * The rule is a **biconditional** and not an assertion about the one exempt member: `count === 0`
 * would pin the defect as the specification (ADR-0372's class), and the natural fix for the
 * resulting red would be to delete the assertion. As a biconditional, half-wiring a runner — a
 * config with no script, or a script with no config — goes red, and the **first real test in an
 * exempt member lands green** once the config, the script and the removal of the exemption line
 * arrive together.
 *
 * The precondition is *tracked TypeScript source* and deliberately **not** a `src/` directory, which
 * is measured rather than preferred: `apps/operate-web` has no `src/` (it is a Next app-router
 * layout of `app/`, `components/`, `lib/`) and 58 tracked `.ts`/`.tsx` files, so a `hasSrcDirectory`
 * precondition would exclude the one member this rule exists to name and the whole thing would be
 * vacuous. `packages/config` is excluded by the same precondition for the opposite reason — it holds
 * **zero** TypeScript files, only JSON — so it is *not* declared exempt: a declaration that excuses
 * something already outside the population is a dead exemption, which is ADR-0386's finding about
 * seven `notForwarded` entries that named fields the fence never compared.
 */

/** The filenames a member may declare its runner in. Vitest reads the first it finds. */
export const TEST_RUNNER_CONFIG_FILENAMES: readonly string[] = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
];

/** The one `test` script a member with a runner may have. */
export const TEST_SCRIPT = "vitest run";

/**
 * A member that holds TypeScript and runs no test runner, with the reason and what it costs.
 *
 * `consequence` is required and is the half that makes this a declaration rather than a waiver: it
 * is what a reader needs in order to disagree, and it is the shape `pg-storeless-tables.ts` and
 * `pg-unreachable-stores.ts` use for the same job. Figures are tracked-source counts — `find` over
 * the directory includes `.next/types/**`, which inflates the file count from 58 to 81 and the line
 * count by ~2,500, and this register has a standing note about a census read off build output.
 */
export const TEST_RUNNER_EXEMPT_MEMBERS: Readonly<
  Record<string, { readonly reason: string; readonly consequence: string }>
> = {
  "apps/operate-web": {
    reason:
      "a Next.js app with no vitest config and no `test` script, so `pnpm -r test` has nothing to run for it",
    consequence:
      "62 .ts/.tsx files, 14,969 lines, 19 pages and 41 `fetch(` call sites have no runner of their own. " +
      "Only the import-free helpers are run, from outside (`packages/testing/src/operate-web.test.ts`: " +
      "`safeNextPath`, the CSV cell, the proxy's cross-site/body/timeout rules and the page security " +
      "headers), and the three `/api` route handlers are checked as text to call them; no page, " +
      "component or route handler is executed by any test. " +
      "It also sets no `noUnusedLocals`, so a change that orphans a binding leaves `tsc` and `next build` " +
      "both green — measured in ADR-0385, where commenting out that increment's one publish line was " +
      "invisible to both. The cost has been paid three times: ADR-0335 shipped a console button that was a " +
      "guaranteed 400 because the request body crosses as a `string`; ADR-0385's fix is fenced by nothing; " +
      "and ADR-0398's `forwardedResponseHeaders` is a pure function with an argued deny-list for which no " +
      "unit test is possible, because there is no runner to add one to.",
  },
};

export const TEST_RUNNER_VIOLATION_KINDS = [
  "no_runner",
  "config_without_script",
  "script_without_config",
  "tests_without_runner",
  "exempt_but_wired",
  "wrong_script",
] as const;
export type TestRunnerViolationKind = (typeof TEST_RUNNER_VIOLATION_KINDS)[number];

/** What one workspace member looks like to this rule. */
export const TestRunnerFactsSchema = z.object({
  /** Workspace-relative directory, POSIX-separated: `packages/kernel`, `apps/operate-web`. */
  dir: z.string().min(1),
  /** How many `.ts`/`.tsx` files the member tracks. Zero puts it outside the population. */
  typeScriptFileCount: z.number().int().min(0),
  /** How many `*.test.ts`/`*.test.tsx` files it tracks. */
  testFileCount: z.number().int().min(0),
  /** The member's `scripts.test`, or `null` when it declares none. */
  testScript: z.string().nullable(),
  /** The runner config filename present, or `null` when none of them is. */
  testRunnerConfig: z.string().nullable(),
});
export type TestRunnerFacts = z.infer<typeof TestRunnerFactsSchema>;

export interface TestRunnerViolation {
  readonly dir: string;
  readonly kind: TestRunnerViolationKind;
  readonly detail: string;
}

/**
 * Reports every way a member departs from "holds TypeScript ⟺ runs a test runner". An empty array is
 * the invariant holding.
 *
 * A member tracking no TypeScript is outside the population entirely — there is nothing to test, and
 * `packages/config` is the one such member today. Everything else is either wired or declared.
 */
export function auditTestRunnerConfig(
  members: readonly TestRunnerFacts[],
  exempt: Readonly<
    Record<string, { readonly reason: string; readonly consequence: string }>
  > = TEST_RUNNER_EXEMPT_MEMBERS,
): readonly TestRunnerViolation[] {
  const violations: TestRunnerViolation[] = [];

  for (const m of members) {
    if (m.typeScriptFileCount === 0) continue;

    const declared = exempt[m.dir];
    const hasConfig = m.testRunnerConfig !== null;
    const hasScript = m.testScript !== null;

    if (declared !== undefined) {
      // The direction that makes the first real test land green: once a member gains a runner, its
      // exemption is stale and the fix is to delete the line, not to weaken an assertion.
      if (hasConfig || hasScript) {
        violations.push({
          dir: m.dir,
          kind: "exempt_but_wired",
          detail:
            `is declared exempt from the test runner and now has ` +
            `${hasConfig ? `a ${m.testRunnerConfig}` : "no config"} and ` +
            `${hasScript ? `a "test" script` : 'no "test" script'}; ` +
            `remove its TEST_RUNNER_EXEMPT_MEMBERS entry`,
        });
      }
      continue;
    }

    if (!hasConfig && !hasScript) {
      violations.push({
        dir: m.dir,
        kind: "no_runner",
        detail:
          `tracks ${m.typeScriptFileCount} TypeScript file(s) and declares neither a runner config ` +
          `(${TEST_RUNNER_CONFIG_FILENAMES.join(" | ")}) nor a "test" script, so nothing tests it; ` +
          `wire one, or declare it in TEST_RUNNER_EXEMPT_MEMBERS with its consequence`,
      });
      // `tests_without_runner` is the sharper statement of the same absence, so report it beside
      // this one rather than instead of it: a member with test files and no runner has written tests
      // that never run, which no other workspace rule can see.
      if (m.testFileCount > 0) {
        violations.push({
          dir: m.dir,
          kind: "tests_without_runner",
          detail: `tracks ${m.testFileCount} test file(s) that no runner executes`,
        });
      }
      continue;
    }

    if (hasConfig && !hasScript) {
      violations.push({
        dir: m.dir,
        kind: "config_without_script",
        detail: `has ${m.testRunnerConfig} and no "test" script, so \`pnpm -r test\` never runs it`,
      });
    } else if (!hasConfig && hasScript) {
      violations.push({
        dir: m.dir,
        kind: "script_without_config",
        detail:
          `declares a "test" script and none of ${TEST_RUNNER_CONFIG_FILENAMES.join(" | ")}, ` +
          `so the runner has no configuration to read`,
      });
    }

    if (m.testScript !== null && m.testScript.trim() !== TEST_SCRIPT) {
      violations.push({
        dir: m.dir,
        kind: "wrong_script",
        detail: `"test" is \`${m.testScript}\`; it must be \`${TEST_SCRIPT}\``,
      });
    }
  }

  return violations;
}

/** One line per violation, so an assertion message says what to fix without a debugger. */
export function formatTestRunnerViolations(
  violations: readonly TestRunnerViolation[],
): string {
  return violations.map((v) => `${v.dir}: [${v.kind}] ${v.detail}`).join("\n");
}
