import { z } from "zod";

/**
 * The per-package `typecheck` wiring ADR-0307 introduced, as a rule rather than 87 hand-written files.
 *
 * `tsconfig.json` excludes `**\/*.test.ts` so tests never land in `dist`; that exclusion also kept them
 * out of `tsc` entirely. ADR-0307's fix is a second config per package that puts them back. The fix is
 * only as good as its uniformity: one package that forgets the file, or whose `typecheck` script still
 * reads the build config, is silently back to untypechecked tests — the exact regression the ADR exists
 * to prevent, and an invisible one, because a package that never checks its tests never fails.
 *
 * So the shape is declared here and asserted against the real workspace.
 */

export const TYPECHECK_CONFIG_FILENAME = "tsconfig.typecheck.json";

/** The one `typecheck` script a package with a `src/` directory may have. */
export const TYPECHECK_SCRIPT = `tsc -p ${TYPECHECK_CONFIG_FILENAME}`;

/**
 * Both bases are load-bearing and neither implies the other: the local `./tsconfig.json` carries the
 * package's own `rootDir`/`include`/path wiring, and the shared base is what re-includes the tests and
 * turns emit off. Extending only one of them typechecks *something*, which is the dangerous outcome.
 */
export const TYPECHECK_EXTENDS: readonly [string, string] = [
  "./tsconfig.json",
  "@crossengin/config/typescript/typecheck.json",
];

/**
 * Directories that are workspace members but not packages this rule applies to. Spelled out so that
 * exempting a new one is a visible line in a diff rather than the absence of a file.
 *
 * - `packages/config` ships the configs themselves — JSON only, no `src/`, nothing to check.
 * - `apps/operate-web` is a Next app: its own `tsconfig.json` already includes every `.ts`/`.tsx` with
 *   no test exclusion to undo, and it must keep Next's `plugins`/`jsx` settings rather than this
 *   layout's. It has a `typecheck` script and `pnpm -r typecheck` runs it (ADR-0307 recorded otherwise;
 *   measured, it does), so it is covered — just not by this file's shape.
 */
export const TYPECHECK_EXEMPT_PACKAGE_DIRS: readonly string[] = [
  "packages/config",
  "apps/operate-web",
];

export const TYPECHECK_VIOLATION_KINDS = [
  "missing_script",
  "wrong_script",
  "missing_config",
  "unparseable_config",
  "wrong_extends",
] as const;
export type TypecheckViolationKind = (typeof TYPECHECK_VIOLATION_KINDS)[number];

/** What one workspace directory looks like to the rule. `null` means the file is absent. */
export const WorkspacePackageFactsSchema = z.object({
  /** Workspace-relative directory, POSIX-separated: `packages/kernel`, `apps/operate-server`. */
  dir: z.string().min(1),
  hasSrcDirectory: z.boolean(),
  /** The package's `scripts.typecheck`, or `null` when it declares none. */
  typecheckScript: z.string().nullable(),
  /** Raw text of `tsconfig.typecheck.json`, or `null` when the file does not exist. */
  typecheckConfigText: z.string().nullable(),
});
export type WorkspacePackageFacts = z.infer<typeof WorkspacePackageFactsSchema>;

export interface TypecheckConfigViolation {
  readonly dir: string;
  readonly kind: TypecheckViolationKind;
  readonly detail: string;
}

function extendsOf(text: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)["extends"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) return value;
  return null;
}

/**
 * Reports every way a package departs from the ADR-0307 wiring. An empty array is the invariant
 * holding; each entry names the directory and what to do about it.
 *
 * Exempt directories and packages with no `src/` are skipped. Note that a *missing* `typecheck` script
 * is a violation rather than a reason to skip: using the script's presence as the precondition would
 * make deleting it a way to pass.
 */
export function auditTypecheckConfig(
  packages: readonly WorkspacePackageFacts[],
  exempt: readonly string[] = TYPECHECK_EXEMPT_PACKAGE_DIRS,
): readonly TypecheckConfigViolation[] {
  const exemptSet = new Set(exempt);
  const violations: TypecheckConfigViolation[] = [];

  for (const pkg of packages) {
    if (exemptSet.has(pkg.dir) || !pkg.hasSrcDirectory) continue;

    if (pkg.typecheckScript === null) {
      violations.push({
        dir: pkg.dir,
        kind: "missing_script",
        detail: `declares no "typecheck" script; it must be \`${TYPECHECK_SCRIPT}\``,
      });
    } else if (pkg.typecheckScript.trim() !== TYPECHECK_SCRIPT) {
      violations.push({
        dir: pkg.dir,
        kind: "wrong_script",
        detail: `"typecheck" is \`${pkg.typecheckScript}\`, which does not read ${TYPECHECK_CONFIG_FILENAME}; it must be \`${TYPECHECK_SCRIPT}\``,
      });
    }

    if (pkg.typecheckConfigText === null) {
      violations.push({
        dir: pkg.dir,
        kind: "missing_config",
        detail: `has no ${TYPECHECK_CONFIG_FILENAME}, so its test files are not typechecked (ADR-0307)`,
      });
      continue;
    }

    const bases = extendsOf(pkg.typecheckConfigText);
    if (bases === null) {
      violations.push({
        dir: pkg.dir,
        kind: "unparseable_config",
        detail: `${TYPECHECK_CONFIG_FILENAME} is not JSON with a string or string[] "extends"`,
      });
      continue;
    }
    const missing = TYPECHECK_EXTENDS.filter((base) => !bases.includes(base));
    if (missing.length > 0) {
      violations.push({
        dir: pkg.dir,
        kind: "wrong_extends",
        detail: `${TYPECHECK_CONFIG_FILENAME} extends [${bases.join(", ")}]; missing [${missing.join(", ")}]`,
      });
    }
  }

  return violations;
}

/** One line per violation, for an assertion message that says what to fix without a debugger. */
export function formatTypecheckViolations(
  violations: readonly TypecheckConfigViolation[],
): string {
  return violations.map((v) => `${v.dir}: [${v.kind}] ${v.detail}`).join("\n");
}
