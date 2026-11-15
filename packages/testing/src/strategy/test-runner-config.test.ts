import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditTestRunnerConfig,
  formatTestRunnerViolations,
  TEST_RUNNER_CONFIG_FILENAMES,
  TEST_RUNNER_EXEMPT_MEMBERS,
  TEST_RUNNER_VIOLATION_KINDS,
  TEST_SCRIPT,
  TestRunnerFactsSchema,
  type TestRunnerFacts,
} from "./test-runner-config.js";

function facts(over: Partial<TestRunnerFacts> = {}): TestRunnerFacts {
  return TestRunnerFactsSchema.parse({
    dir: "packages/example",
    typeScriptFileCount: 12,
    testFileCount: 4,
    testScript: TEST_SCRIPT,
    testRunnerConfig: "vitest.config.ts",
    ...over,
  });
}

describe("the declared shape", () => {
  it("names the filenames vitest reads", () => {
    expect([...TEST_RUNNER_CONFIG_FILENAMES]).toEqual([
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.config.js",
    ]);
  });

  it("exempts exactly one member, and that member carries its consequence", () => {
    // One and not two: `packages/config` tracks zero TypeScript files, so the precondition excludes
    // it mechanically and a declaration for it would excuse nothing — ADR-0386's dead-exemption
    // finding. The consequence is required because a waiver with no bill is not a declaration.
    expect(Object.keys(TEST_RUNNER_EXEMPT_MEMBERS)).toEqual(["apps/operate-web"]);
    for (const [dir, entry] of Object.entries(TEST_RUNNER_EXEMPT_MEMBERS)) {
      expect(entry.reason.length, `${dir} states no reason`).toBeGreaterThan(20);
      expect(entry.consequence.length, `${dir} states no consequence`).toBeGreaterThan(80);
    }
  });

  it("gives every violation kind a producer", () => {
    // A kind no input can reach reads as a judgement the rule makes and does not (ADR-0375).
    const reached = new Set<string>();
    const inputs: readonly TestRunnerFacts[] = [
      facts({ dir: "packages/a", testRunnerConfig: null, testScript: null }),
      facts({ dir: "packages/b", testRunnerConfig: null, testScript: null, testFileCount: 3 }),
      facts({ dir: "packages/c", testScript: null }),
      facts({ dir: "packages/d", testRunnerConfig: null }),
      facts({ dir: "packages/e", testScript: "jest" }),
      facts({ dir: "apps/operate-web", typeScriptFileCount: 58 }),
    ];
    for (const v of auditTestRunnerConfig(inputs)) reached.add(v.kind);
    expect([...reached].sort()).toEqual([...TEST_RUNNER_VIOLATION_KINDS].sort());
  });
});

describe("auditTestRunnerConfig", () => {
  it("passes a correctly wired member", () => {
    expect(auditTestRunnerConfig([facts()])).toEqual([]);
  });

  it("skips a member that tracks no TypeScript", () => {
    // `packages/config` is JSON only. Nothing to test is not a gap.
    expect(
      auditTestRunnerConfig([
        facts({
          dir: "packages/config",
          typeScriptFileCount: 0,
          testFileCount: 0,
          testScript: null,
          testRunnerConfig: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("reports a member with TypeScript and no runner", () => {
    const v = auditTestRunnerConfig([
      facts({ testRunnerConfig: null, testScript: null, testFileCount: 0 }),
    ]);
    expect(v.map((x) => x.kind)).toEqual(["no_runner"]);
    expect(v[0]?.detail).toContain("TEST_RUNNER_EXEMPT_MEMBERS");
  });

  it("reports tests that no runner executes, beside the absence itself", () => {
    // The sharper statement of the same absence, and the one no other workspace rule can see:
    // test files that exist and never run. Reported *beside* `no_runner` rather than instead of it,
    // because an operator fixing one wants to read both.
    const v = auditTestRunnerConfig([
      facts({ testRunnerConfig: null, testScript: null, testFileCount: 7 }),
    ]);
    expect(v.map((x) => x.kind)).toEqual(["no_runner", "tests_without_runner"]);
    expect(v[1]?.detail).toContain("7 test file(s)");
  });

  it("reports each half-wiring, which is what makes this a biconditional", () => {
    expect(auditTestRunnerConfig([facts({ testScript: null })]).map((x) => x.kind)).toEqual([
      "config_without_script",
    ]);
    expect(auditTestRunnerConfig([facts({ testRunnerConfig: null })]).map((x) => x.kind)).toEqual([
      "script_without_config",
    ]);
  });

  it("reports a test script that is not the one script", () => {
    const v = auditTestRunnerConfig([facts({ testScript: "jest" })]);
    expect(v.map((x) => x.kind)).toEqual(["wrong_script"]);
  });

  it("reports an exempt member that has acquired a runner", () => {
    // The direction that makes the first real test in an exempt member land green: the fix for this
    // red is to delete the exemption line, not to weaken an assertion. Asserting `testFileCount === 0`
    // for the exempt member instead would pin the defect as the specification (ADR-0372).
    const v = auditTestRunnerConfig([facts({ dir: "apps/operate-web" })]);
    expect(v.map((x) => x.kind)).toEqual(["exempt_but_wired"]);
    expect(v[0]?.detail).toContain("remove its TEST_RUNNER_EXEMPT_MEMBERS entry");
  });

  it("reports a half-wired exempt member too", () => {
    const v = auditTestRunnerConfig([facts({ dir: "apps/operate-web", testScript: null })]);
    expect(v.map((x) => x.kind)).toEqual(["exempt_but_wired"]);
    expect(v[0]?.detail).toContain('no "test" script');
  });

  it("stays silent for an exempt member that is genuinely unwired", () => {
    expect(
      auditTestRunnerConfig([
        facts({ dir: "apps/operate-web", testRunnerConfig: null, testScript: null, testFileCount: 0 }),
      ]),
    ).toEqual([]);
  });

  it("takes the exemption map as an argument, so the rule is testable without the real one", () => {
    const v = auditTestRunnerConfig(
      [facts({ dir: "packages/zzz", testRunnerConfig: null, testScript: null, testFileCount: 0 })],
      { "packages/zzz": { reason: "r".repeat(30), consequence: "c".repeat(100) } },
    );
    expect(v).toEqual([]);
  });
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Directory names that hold generated output rather than source, so a count over them is inflated. */
const GENERATED_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);

function countTypeScript(absolute: string): { source: number; tests: number } {
  let source = 0;
  let tests = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (GENERATED_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) continue;
      source += 1;
      if (/\.test\.tsx?$/.test(entry)) tests += 1;
    }
  };
  walk(absolute);
  return { source, tests };
}

function workspaceRoots(): readonly string[] {
  const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1] ?? "");
  const roots: string[] = [];
  for (const glob of globs) {
    expect(glob.endsWith("/*"), `unhandled workspace glob '${glob}'`).toBe(true);
    const root = glob.slice(0, -2);
    if (existsSync(join(REPO_ROOT, root))) roots.push(root);
  }
  return roots;
}

function readWorkspace(): readonly TestRunnerFacts[] {
  const collected: TestRunnerFacts[] = [];
  for (const root of workspaceRoots()) {
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      const dir = `${root}/${entry}`;
      const absolute = join(REPO_ROOT, root, entry);
      if (!statSync(absolute).isDirectory()) continue;
      if (!existsSync(join(absolute, "package.json"))) continue;
      const manifest: unknown = JSON.parse(readFileSync(join(absolute, "package.json"), "utf8"));
      const scripts =
        typeof manifest === "object" && manifest !== null
          ? (manifest as Record<string, unknown>)["scripts"]
          : undefined;
      const script =
        typeof scripts === "object" && scripts !== null
          ? (scripts as Record<string, unknown>)["test"]
          : undefined;
      const config =
        TEST_RUNNER_CONFIG_FILENAMES.find((name) => existsSync(join(absolute, name))) ?? null;
      const counted = countTypeScript(absolute);
      collected.push(
        TestRunnerFactsSchema.parse({
          dir,
          typeScriptFileCount: counted.source,
          testFileCount: counted.tests,
          testScript: typeof script === "string" ? script : null,
          testRunnerConfig: config,
        }),
      );
    }
  }
  return collected;
}

describe("the real workspace", () => {
  const members = readWorkspace();

  it("was walked, not silently missed", () => {
    // A discovery bug would make every assertion below vacuous, so the shape is asserted first.
    expect(members.length).toBeGreaterThanOrEqual(80);
    expect(members.map((m) => m.dir)).toContain("packages/kernel");
    expect(members.map((m) => m.dir)).toContain("apps/operate-web");
    // The count must exclude generated output: `.next/types/**` alone takes `apps/operate-web` from
    // 58 tracked files to 81, and a figure read off build output is this register's standing trap.
    const web = members.find((m) => m.dir === "apps/operate-web");
    expect(web?.typeScriptFileCount).toBeGreaterThan(40);
    expect(web?.typeScriptFileCount).toBeLessThan(70);
  });

  it("every exempt member still exists and still tracks TypeScript", () => {
    // An exemption for a member that is gone is a hole waiting for one of that name; an exemption for
    // a member with no TypeScript is a dead line, which is why `packages/config` is not declared.
    const byDir = new Map(members.map((m) => [m.dir, m]));
    for (const dir of Object.keys(TEST_RUNNER_EXEMPT_MEMBERS)) {
      const member = byDir.get(dir);
      expect(member, `exempt member '${dir}' no longer exists`).toBeDefined();
      expect(
        member?.typeScriptFileCount ?? 0,
        `exempt member '${dir}' tracks no TypeScript, so its exemption excuses nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("the one member outside the population really holds no TypeScript", () => {
    // Asserted rather than assumed: if `packages/config` ever gains a `.ts` file it joins the
    // population and needs a runner or a declaration, and this is where that is noticed.
    const config = members.find((m) => m.dir === "packages/config");
    expect(config).toBeDefined();
    expect(config?.typeScriptFileCount).toBe(0);
  });

  it("runs a test runner over every member that holds TypeScript", () => {
    const violations = auditTestRunnerConfig(members);
    expect(formatTestRunnerViolations(violations)).toBe("");
  });
});
