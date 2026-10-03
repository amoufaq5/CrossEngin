import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditTypecheckConfig,
  formatTypecheckViolations,
  TYPECHECK_CONFIG_FILENAME,
  TYPECHECK_EXEMPT_PACKAGE_DIRS,
  TYPECHECK_EXTENDS,
  TYPECHECK_SCRIPT,
  TYPECHECK_VIOLATION_KINDS,
  WorkspacePackageFactsSchema,
  type WorkspacePackageFacts,
} from "./typecheck-config.js";

const WELL_FORMED_CONFIG = JSON.stringify({ extends: [...TYPECHECK_EXTENDS] });

function facts(over: Partial<WorkspacePackageFacts> = {}): WorkspacePackageFacts {
  return WorkspacePackageFactsSchema.parse({
    dir: "packages/example",
    hasSrcDirectory: true,
    typecheckScript: TYPECHECK_SCRIPT,
    typecheckConfigText: WELL_FORMED_CONFIG,
    ...over,
  });
}

describe("the declared shape", () => {
  it("names the config file the script reads", () => {
    expect(TYPECHECK_SCRIPT).toBe(`tsc -p ${TYPECHECK_CONFIG_FILENAME}`);
  });

  it("requires both bases", () => {
    expect(TYPECHECK_EXTENDS).toEqual([
      "./tsconfig.json",
      "@crossengin/config/typescript/typecheck.json",
    ]);
  });

  it("exempts only the two documented directories", () => {
    expect([...TYPECHECK_EXEMPT_PACKAGE_DIRS].sort()).toEqual([
      "apps/operate-web",
      "packages/config",
    ]);
  });
});

describe("auditTypecheckConfig", () => {
  it("passes a correctly wired package", () => {
    expect(auditTypecheckConfig([facts()])).toEqual([]);
  });

  it("reports a missing config file", () => {
    const violations = auditTypecheckConfig([facts({ typecheckConfigText: null })]);
    expect(violations.map((v) => v.kind)).toEqual(["missing_config"]);
    expect(violations[0]?.dir).toBe("packages/example");
  });

  it("reports a missing typecheck script rather than skipping the package", () => {
    const violations = auditTypecheckConfig([facts({ typecheckScript: null })]);
    expect(violations.map((v) => v.kind)).toEqual(["missing_script"]);
  });

  it("reports a script that still reads the build config", () => {
    const violations = auditTypecheckConfig([facts({ typecheckScript: "tsc --noEmit" })]);
    expect(violations.map((v) => v.kind)).toEqual(["wrong_script"]);
  });

  it("accepts whitespace around the script", () => {
    expect(auditTypecheckConfig([facts({ typecheckScript: ` ${TYPECHECK_SCRIPT} ` })])).toEqual([]);
  });

  it("reports extending only the local base", () => {
    const violations = auditTypecheckConfig([
      facts({ typecheckConfigText: JSON.stringify({ extends: "./tsconfig.json" }) }),
    ]);
    expect(violations.map((v) => v.kind)).toEqual(["wrong_extends"]);
    expect(violations[0]?.detail).toContain("@crossengin/config/typescript/typecheck.json");
  });

  it("reports extending only the shared base", () => {
    const violations = auditTypecheckConfig([
      facts({
        typecheckConfigText: JSON.stringify({
          extends: ["@crossengin/config/typescript/typecheck.json"],
        }),
      }),
    ]);
    expect(violations.map((v) => v.kind)).toEqual(["wrong_extends"]);
    expect(violations[0]?.detail).toContain("./tsconfig.json");
  });

  it("accepts an extra base alongside the two required ones", () => {
    expect(
      auditTypecheckConfig([
        facts({
          typecheckConfigText: JSON.stringify({ extends: [...TYPECHECK_EXTENDS, "./other.json"] }),
        }),
      ]),
    ).toEqual([]);
  });

  it("reports a config that is not JSON", () => {
    const violations = auditTypecheckConfig([facts({ typecheckConfigText: "{ nope" })]);
    expect(violations.map((v) => v.kind)).toEqual(["unparseable_config"]);
  });

  it("reports a config with no extends at all", () => {
    const violations = auditTypecheckConfig([
      facts({ typecheckConfigText: JSON.stringify({ compilerOptions: { noEmit: true } }) }),
    ]);
    expect(violations.map((v) => v.kind)).toEqual(["unparseable_config"]);
  });

  it("skips a package with no src directory", () => {
    expect(auditTypecheckConfig([facts({ hasSrcDirectory: false, typecheckConfigText: null })])).toEqual(
      [],
    );
  });

  it("skips an exempt directory", () => {
    expect(
      auditTypecheckConfig([
        facts({ dir: "apps/operate-web", typecheckScript: "tsc --noEmit", typecheckConfigText: null }),
      ]),
    ).toEqual([]);
  });

  it("reports a package the caller did not exempt", () => {
    const violations = auditTypecheckConfig(
      [facts({ dir: "apps/operate-web", typecheckConfigText: null })],
      [],
    );
    expect(violations.map((v) => v.kind)).toEqual(["missing_config"]);
  });

  it("reports both a wrong script and a missing config on one package", () => {
    const violations = auditTypecheckConfig([
      facts({ typecheckScript: "tsc --noEmit", typecheckConfigText: null }),
    ]);
    expect(violations.map((v) => v.kind)).toEqual(["wrong_script", "missing_config"]);
  });

  it("formats one line per violation", () => {
    const formatted = formatTypecheckViolations(
      auditTypecheckConfig([
        facts({ dir: "packages/a", typecheckConfigText: null }),
        facts({ dir: "packages/b", typecheckScript: null }),
      ]),
    );
    expect(formatted.split("\n")).toHaveLength(2);
    expect(formatted).toContain("packages/a: [missing_config]");
    expect(formatted).toContain("packages/b: [missing_script]");
  });

  it("every declared violation kind is reachable", () => {
    const reached = new Set(
      [
        facts({ typecheckScript: null }),
        facts({ typecheckScript: "tsc --noEmit" }),
        facts({ typecheckConfigText: null }),
        facts({ typecheckConfigText: "{ nope" }),
        facts({ typecheckConfigText: JSON.stringify({ extends: "./tsconfig.json" }) }),
      ].flatMap((f) => auditTypecheckConfig([f]).map((v) => v.kind)),
    );
    expect([...reached].sort()).toEqual([...TYPECHECK_VIOLATION_KINDS].sort());
  });
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The globs `pnpm-workspace.yaml` declares, read rather than hardcoded so that adding a workspace root
 * brings its packages under this rule without anyone remembering to.
 */
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

function readWorkspace(): readonly WorkspacePackageFacts[] {
  const collected: WorkspacePackageFacts[] = [];
  for (const root of workspaceRoots()) {
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      const dir = `${root}/${entry}`;
      const absolute = join(REPO_ROOT, root, entry);
      if (!statSync(absolute).isDirectory()) continue;
      const manifestPath = join(absolute, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const scripts =
        typeof manifest === "object" && manifest !== null
          ? (manifest as Record<string, unknown>)["scripts"]
          : undefined;
      const script =
        typeof scripts === "object" && scripts !== null
          ? (scripts as Record<string, unknown>)["typecheck"]
          : undefined;
      const configPath = join(absolute, TYPECHECK_CONFIG_FILENAME);
      collected.push(
        WorkspacePackageFactsSchema.parse({
          dir,
          hasSrcDirectory: existsSync(join(absolute, "src")),
          typecheckScript: typeof script === "string" ? script : null,
          typecheckConfigText: existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
        }),
      );
    }
  }
  return collected;
}

describe("the real workspace", () => {
  const packages = readWorkspace();

  it("was walked, not silently missed", () => {
    // A discovery bug would make every assertion below vacuous, so the count is asserted first.
    expect(packages.length).toBeGreaterThanOrEqual(80);
    expect(packages.map((p) => p.dir)).toContain("packages/kernel");
    expect(packages.map((p) => p.dir)).toContain("apps/operate-server");
  });

  it("every exempt directory still exists", () => {
    // An exemption for a directory that is gone is a hole waiting for a package of that name.
    const dirs = new Set(packages.map((p) => p.dir));
    for (const exempt of TYPECHECK_EXEMPT_PACKAGE_DIRS) {
      expect(dirs.has(exempt), `exempt directory '${exempt}' no longer exists`).toBe(true);
    }
  });

  it("typechecks its test files in every package (ADR-0307)", () => {
    const violations = auditTypecheckConfig(packages);
    expect(formatTypecheckViolations(violations)).toBe("");
  });
});
