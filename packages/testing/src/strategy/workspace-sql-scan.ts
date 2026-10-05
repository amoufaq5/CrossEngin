import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectModuleBindings,
  extractSqlStatements,
  normalizeSource,
  PG_SCAN_EXEMPT_PACKAGE_DIRS,
  UnresolvedStatementSchema,
  type ModuleBindings,
  type SqlStatement,
  type StatementTarget,
  type TableReference,
  type UnresolvedStatement,
} from "./pg-column-coverage.js";

/**
 * One pass over every workspace source file, producing every fact the SQL rules reason about.
 *
 * Impure on purpose and by itself: the rules in `pg-column-coverage.ts` and `pg-storeless-tables.ts`
 * are pure functions over these facts, following `typecheck-config.ts`'s split — the shape is
 * declared in a module that reads nothing, and the real workspace is read in one place.
 *
 * It reads the files from **disk** rather than importing anything, which is what keeps the rules
 * unconditional: `packages/kernel` devDepends on `packages/testing`, so importing the catalog would
 * make the workspace graph cyclic, and reading `packages/kernel/dist` would make the answer depend on
 * whether somebody has run `pnpm -r build`. A rule that is green only after a build is not a rule.
 */

/** The repository root, four levels up from `packages/testing/src/strategy/`. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export const CATALOG_PATH = "packages/kernel/src/bootstrap/meta-schema.ts";

export function readCatalogSource(): string {
  return readFileSync(join(REPO_ROOT, CATALOG_PATH), "utf8");
}

function sourceFilesUnder(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) sourceFilesUnder(absolute, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(absolute);
  }
}

export interface WorkspaceRoots {
  readonly roots: readonly string[];
  /**
   * Globs this walk did not understand. Returned rather than thrown so the caller asserts on them:
   * a walk that silently skipped half the workspace would make every rule over it vacuous.
   */
  readonly unhandledGlobs: readonly string[];
}

/** The workspace roots `pnpm-workspace.yaml` declares, read rather than hardcoded. */
export function workspaceRoots(): WorkspaceRoots {
  const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1] ?? "");
  const roots: string[] = [];
  const unhandledGlobs: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      unhandledGlobs.push(glob);
      continue;
    }
    const root = glob.slice(0, -2);
    if (existsSync(join(REPO_ROOT, root))) roots.push(root);
  }
  return { roots, unhandledGlobs };
}

/**
 * Bindings merged across one package's `src/`, used only as a fallback for names a module imports.
 *
 * Per package rather than per workspace, because `TABLE` means something different in every store
 * file and merging the lot would make it ambiguous everywhere — which would turn this scan into one
 * that finds nothing while passing.
 */
export function mergeBindings(all: readonly ModuleBindings[]): ModuleBindings {
  const strings = new Map<string, string>();
  const arrays = new Map<string, readonly string[]>();
  const ambiguous = new Set<string>();
  for (const bindings of all) {
    for (const [key, value] of bindings.strings) {
      const prior = strings.get(key);
      if (prior !== undefined && prior !== value) ambiguous.add(key);
      else strings.set(key, value);
    }
    for (const [key, value] of bindings.arrays) {
      const prior = arrays.get(key);
      if (prior !== undefined && prior.join("\u0000") !== value.join("\u0000")) ambiguous.add(key);
      else arrays.set(key, value);
    }
    for (const key of bindings.ambiguous) ambiguous.add(key);
  }
  return { strings, arrays, ambiguous };
}

export interface WorkspaceSqlScan {
  readonly files: number;
  readonly statements: readonly SqlStatement[];
  readonly unresolved: readonly UnresolvedStatement[];
  readonly targets: readonly StatementTarget[];
  readonly references: readonly TableReference[];
  readonly unhandledGlobs: readonly string[];
}

export function scanWorkspaceSql(): WorkspaceSqlScan {
  const exempt = new Set(PG_SCAN_EXEMPT_PACKAGE_DIRS);
  const statements: SqlStatement[] = [];
  const unresolved: UnresolvedStatement[] = [];
  const targets: StatementTarget[] = [];
  const references: TableReference[] = [];
  let files = 0;

  const { roots, unhandledGlobs } = workspaceRoots();
  for (const root of roots) {
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      const dir = `${root}/${entry}`;
      if (exempt.has(dir)) continue;
      const src = join(REPO_ROOT, dir, "src");
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;

      const absolute: string[] = [];
      sourceFilesUnder(src, absolute);
      const texts = new Map<string, string>();
      for (const file of absolute) {
        const relative = file.slice(REPO_ROOT.length + 1);
        try {
          texts.set(relative, readFileSync(file, "utf8"));
        } catch (error) {
          unresolved.push(
            UnresolvedStatementSchema.parse({
              file: relative,
              line: 0,
              kind: "unreadable_file",
              snippet: `could not be read as text: ${String(error)}`,
            }),
          );
        }
      }
      const fallback = mergeBindings(
        [...texts.values()].map((text) => collectModuleBindings(normalizeSource(text))),
      );
      for (const [relative, text] of texts) {
        files += 1;
        const extracted = extractSqlStatements(relative, text, fallback);
        statements.push(...extracted.statements);
        unresolved.push(...extracted.unresolved);
        targets.push(...extracted.targets);
        references.push(...extracted.references);
      }
    }
  }

  return { files, statements, unresolved, targets, references, unhandledGlobs };
}
