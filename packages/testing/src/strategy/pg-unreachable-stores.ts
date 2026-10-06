import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { stripComments } from "./pg-column-coverage.js";
import { REPO_ROOT, workspaceRoots } from "./workspace-sql-scan.js";

/**
 * The inverse of `pg-storeless-tables.ts`: a store that nothing constructs.
 *
 * That file asks *which catalogued table has no store*. Nothing asked *which store has no caller*,
 * and the two are not the same question — ADR-0335 proved it by **moving** a defect from the first
 * into the second. `meta.feature_flag_targeting_rules` was on the writerless census; it gained
 * `PostgresTargetingRuleStore`, so the census stopped reporting it, and that store is constructed
 * only in its own test file. The table went from a place a rule watches to a place nothing watches,
 * **and the fence read greener for it.**
 *
 * The mechanism behind that is the whole reason this rule has to exist rather than being a tidy-up:
 * `pg-storeless-tables.ts` decides `written` by reading every store's SQL *as text*, so a store with
 * no caller makes its table read as **written** while no deployment has ever put a row in it. The
 * two rules therefore have a blind spot each, in opposite directions, and only together do they say
 * "this record is persisted". This file asserts the second half:
 *
 *   **no exported Postgres store is unreachable without a declaration saying why.**
 *
 * Two signals, which are the same question at two altitudes:
 *
 *  1. **A store constructed only under `*.test.ts`.** Eight when this rule was written and six by
 *     the time it landed, which is the shape to expect: all four of `api-gateway-pg`'s stores were
 *     this before ADR-0335 wired one, and `meta.rate_limit_decisions` had never held a row while the
 *     sliding window was per-replica and per-restart. The count lives nowhere but the declaration
 *     list for that reason — a number in an assertion makes a correct wiring commit fail.
 *  2. **A package nobody imports.** `@crossengin/api-gateway-pg` had **zero importers** — four
 *     stores and a replayer, none reachable from the deployed binary — and no rule in the repo would
 *     have said so. ADR-0335 found it by grepping, and signal 1's eighth member proves a grep is not
 *     repeatable discipline.
 *
 * Signal 2 finds **nothing today**, because last increment closed its only member. That is the
 * awkward shape this family of rules exists to refuse — a check that passes by examining nothing —
 * so the floor is not "finds ≥ 1" (which would be false) but *every scanned package landed in a
 * known bucket, and there were at least as many packages as the workspace has*. A scanner whose
 * directory convention silently stopped matching fails there rather than passing green on zero.
 *
 * **Conservative on purpose.** Reachability is flat: *is there any non-test file that constructs
 * this symbol?* The transitive question — is the module holding that `new` itself reachable — was
 * tried and abandoned, because a naive version reports ten false positives (see
 * `UNREACHABLE_STORES`' closing note). A rule that fails CI on correct code gets deleted; one that
 * under-reports is a floor somebody can raise. So the eight are a **lower bound**, and the
 * transitive case is written down as what this rule cannot see.
 */

/* ------------------------------------------------------------------- reasons */

/**
 * Why an exported Postgres store has no caller. Five members, and the splits are load-bearing.
 *
 * ADR-0330's lesson applies directly — *defining a reason away* is what makes a real distinction
 * inexpressible — and a single flat `built_never_connected` would define away three of them:
 *
 *  - **`substitute_in_use` vs anything else.** With a substitute, the feature *works* — just not
 *    durably, not across replicas and not across a restart. The fix is swapping one constructor.
 *  - **`unpersisted_record` vs the two blocked reasons.** The deployed binary *already produces*
 *    the record on every pass and drops it, so this is one wiring line away and data is being lost
 *    right now. A blocked store has nothing to persist yet; constructing it would change nothing.
 *  - **`prerequisite_of_unbuilt_surface` vs `contract_cannot_carry_the_surface`**, which is the
 *    split that earns its keep: the first is blocked by **ordering** and will be wired once the
 *    route or scheduler beside it lands; the second is blocked by **the contract's own shape** and
 *    cannot be wired honestly until that changes. Merging them sends the next person to write a
 *    route that cannot be written.
 *  - **`no_caller_by_design` is the one reason that must never be assumed**, so it is the one that
 *    has to cite where the decision is recorded. A "deliberate" claim with no ADR behind it is an
 *    opinion, and this list would fill up with them.
 */
export const UNREACHABLE_REASONS = [
  /** A decision was taken not to wire it; `decidedIn` names the ADR that took it. */
  "no_caller_by_design",
  /** The deployed binary satisfies the same interface with a different implementation. */
  "substitute_in_use",
  /**
   * The record is produced by the running binary on every pass and never persisted.
   *
   * No member today, and the reason to keep it is that its one member was wired within the hour:
   * `PostgresPipelineExecutionStore` was declared here and landed in `node.ts` before this rule did,
   * which is the category doing its job — "one constructor away" is actionable in a way that
   * "unwired" is not.
   */
  "unpersisted_record",
  /** Blocked by ordering: the surface it persists is not built yet. `blockedBy` names what must land. */
  "prerequisite_of_unbuilt_surface",
  /** Blocked by shape: the contract cannot express the surface. `blockedBy` names the gap. */
  "contract_cannot_carry_the_surface",
] as const;
export type UnreachableReason = (typeof UNREACHABLE_REASONS)[number];

/** Only a by-design declaration may cite the ADR that decided it, and it must cite one. */
export const DECISION_BEARING_REASONS: readonly UnreachableReason[] = ["no_caller_by_design"];

/**
 * Only a blocked declaration may name its blocker, and it must name one — so neither kind of
 * blockage can be parked without saying what has to land first. `pg-storeless-tables.ts`'
 * `CONSEQUENCE_BEARING_REASONS` for the same reason: a field that may ride along on any member is a
 * field that can be forgotten.
 */
export const BLOCKER_BEARING_REASONS: readonly UnreachableReason[] = [
  "prerequisite_of_unbuilt_surface",
  "contract_cannot_carry_the_surface",
];

/**
 * Only a `substitute_in_use` declaration may name the substitute, and it must name one — and the
 * audit then checks that the substitute is *itself* constructed outside tests. A claim that
 * something else does this job is checkable, so it is checked; this is `writerless_successor`'s
 * shape in `pg-storeless-tables.ts`.
 */
export const SUBSTITUTE_BEARING_REASONS: readonly UnreachableReason[] = ["substitute_in_use"];

/** `packages/<name>`, where the name ends in `-pg`. The scan derives the set; this pins the shape. */
const PG_PACKAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*-pg$/;
const STORE_SYMBOL = /^Postgres[A-Za-z0-9_]*$/;
const SUBSTITUTE_SYMBOL = /^[A-Z][A-Za-z0-9_]*$/;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const ADR_ID = /^ADR-\d{4}$/;

/** A store declaration names a symbol; a package declaration names none. Nothing may do both. */
export const UNREACHABLE_SCOPES = ["store", "package"] as const;
export type UnreachableScope = (typeof UNREACHABLE_SCOPES)[number];

export const UnreachableDeclarationSchema = z
  .object({
    scope: z.enum(UNREACHABLE_SCOPES),
    /** The package directory under `packages/`, e.g. `feature-flags-pg`. */
    pkg: z.string().regex(PG_PACKAGE),
    /** The exported class. `store` scope only, and required there. */
    symbol: z.string().regex(STORE_SYMBOL).optional(),
    reason: z.enum(UNREACHABLE_REASONS),
    /**
     * The catalogued tables this store's SQL names. `store` scope only, and **required there even
     * when empty** — `[]` is a signed assertion that this store writes no catalogued table, which
     * ADR-0331 established is a different fact from "nobody said". An optional field would let the
     * interesting half (which table reads as written because of this) be forgotten silently.
     */
    tables: z.array(z.string().regex(QUALIFIED)).optional(),
    /** The implementation in use instead. `substitute_in_use` only. */
    substitutedBy: z.string().regex(SUBSTITUTE_SYMBOL).optional(),
    /** The ADR that decided against wiring it. `no_caller_by_design` only. */
    decidedIn: z.string().regex(ADR_ID).optional(),
    /** What must land before this store can have a caller. The two blocked reasons only. */
    blockedBy: z.string().min(20).optional(),
    /** What a deployment does not get. Required of every member — see the note below. */
    consequence: z.string().min(20),
    /** The evidence: who built it, which ADR, what is constructed instead. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly UnreachableReason[]): boolean => set.includes(value.reason);
    const isStore = value.scope === "store";
    if (isStore !== (value.symbol !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbol"],
        message: `only a store declaration may name a symbol, and it must name one (${value.scope})`,
      });
    }
    if (isStore !== (value.tables !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tables"],
        message: `only a store declaration may name tables, and it must name them — pass [] to assert it writes none (${value.scope})`,
      });
    }
    if (wants(SUBSTITUTE_BEARING_REASONS) !== (value.substitutedBy !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["substitutedBy"],
        message: `only a substitute_in_use declaration may name the substitute, and it must name one (${value.reason})`,
      });
    }
    if (wants(DECISION_BEARING_REASONS) !== (value.decidedIn !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decidedIn"],
        message: `only a no_caller_by_design declaration may cite an ADR, and it must cite one (${value.reason})`,
      });
    }
    if (wants(BLOCKER_BEARING_REASONS) !== (value.blockedBy !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedBy"],
        message: `only a blocked declaration may name its blocker, and it must name one (${value.reason})`,
      });
    }
  });
export type UnreachableDeclaration = z.infer<typeof UnreachableDeclarationSchema>;

/** `feature-flags-pg:PostgresTargetingRuleStore`, or `api-gateway-pg` for a package declaration. */
export function subjectOf(declaration: UnreachableDeclaration): string {
  return declaration.symbol === undefined
    ? declaration.pkg
    : `${declaration.pkg}:${declaration.symbol}`;
}

/* -------------------------------------------------------------------- facts */

export const StoreFactsSchema = z.object({
  symbol: z.string().regex(STORE_SYMBOL),
  pkg: z.string().regex(PG_PACKAGE),
  /** Workspace-relative file holding the `export class`. */
  declaredIn: z.string().min(1),
  /** Non-test files that construct it, anywhere in the workspace. */
  constructedBy: z.array(z.string().min(1)),
  /** Test files that construct it. Separate, because the whole finding is the difference. */
  constructedByTests: z.array(z.string().min(1)),
});
export type StoreFacts = z.infer<typeof StoreFactsSchema>;

export const PgPackageFactsSchema = z.object({
  /** Directory name under `packages/`. */
  pkg: z.string().regex(PG_PACKAGE),
  /** The name in its `package.json`, read rather than derived. */
  name: z.string().min(1),
  /** Other workspace members declaring it in `dependencies` or `devDependencies`. */
  dependents: z.array(z.string().min(1)),
  /** Non-test files outside the package importing it by package name. */
  importedBy: z.array(z.string().min(1)),
  importedByTests: z.array(z.string().min(1)),
});
export type PgPackageFacts = z.infer<typeof PgPackageFactsSchema>;

/* ------------------------------------------------------------ reachability */

export const STORE_REACHABILITIES = ["reachable", "test_only", "unconstructed"] as const;
export type StoreReachability = (typeof STORE_REACHABILITIES)[number];

/**
 * Reachable iff some non-test file constructs it. `unconstructed` is separated from `test_only`
 * because a store nothing constructs *at all* has no unit test either, so "its only caller is a
 * test" would be a false statement about it — and the two want different first moves.
 */
export function classifyStore(facts: StoreFacts): StoreReachability {
  if (facts.constructedBy.length > 0) return "reachable";
  return facts.constructedByTests.length > 0 ? "test_only" : "unconstructed";
}

export const PACKAGE_REACHABILITIES = [
  "reachable",
  "unimported",
  "test_only_importer",
  "declared_unused",
] as const;
export type PackageReachability = (typeof PACKAGE_REACHABILITIES)[number];

/**
 * Reachable iff some non-test file outside the package imports it. The three unreachable buckets
 * name *how*, because each has its own fix: `unimported` is ADR-0335's `api-gateway-pg` exactly
 * (nothing at all), `declared_unused` is the half-finished wiring (somebody added the dependency and
 * stopped), and `test_only_importer` is a package another package only tests against.
 */
export function classifyPgPackage(facts: PgPackageFacts): PackageReachability {
  if (facts.importedBy.length > 0) return "reachable";
  if (facts.importedByTests.length > 0) return "test_only_importer";
  return facts.dependents.length > 0 ? "declared_unused" : "unimported";
}

/* ----------------------------------------------------------------- findings */

export const UNREACHABLE_FINDING_KINDS = [
  /** A store whose only construction sites are test files, with no declaration. **The fence.** */
  "store_test_only",
  /** A store nothing constructs anywhere, not even a test. */
  "store_unconstructed",
  /** A pg package no workspace member depends on and no file imports. **Signal 2's fence.** */
  "package_unimported",
  /** Imported only from test files. */
  "package_test_only_importer",
  /** A dependency declared and never imported — wiring begun and abandoned. */
  "package_declared_unused",
  /** Declared unreachable and now constructed or imported outside tests. */
  "overtaken",
  /** Declares a symbol no pg package exports. */
  "unknown_symbol",
  /** Declares a package directory that is not a pg package. */
  "unknown_package",
  /** The same subject declared twice, which would let two contradictory reasons both pass. */
  "duplicate",
  /** `substitute_in_use` naming something that is not itself constructed outside tests. */
  "unsupported_substitute",
  /** Declares a table `META_TABLES` does not have. */
  "unknown_table",
  /**
   * Declares a table `pg-storeless-tables.ts` also calls writerless. The two rules disagree about
   * the same table: this store's SQL names it, so the SQL scan should have read it as written.
   */
  "table_declared_storeless",
] as const;
export type UnreachableFindingKind = (typeof UNREACHABLE_FINDING_KINDS)[number];

/** Total maps, so a new reachability bucket is a compile error rather than an unreported state. */
const STORE_FINDING_FOR: Record<Exclude<StoreReachability, "reachable">, UnreachableFindingKind> = {
  test_only: "store_test_only",
  unconstructed: "store_unconstructed",
};
const PACKAGE_FINDING_FOR: Record<
  Exclude<PackageReachability, "reachable">,
  UnreachableFindingKind
> = {
  unimported: "package_unimported",
  test_only_importer: "package_test_only_importer",
  declared_unused: "package_declared_unused",
};

export interface UnreachableFinding {
  readonly kind: UnreachableFindingKind;
  /** `pkg` or `pkg:Symbol`, matching `subjectOf`. */
  readonly subject: string;
  readonly detail: string;
}

export interface UnreachableAuditInput {
  readonly stores: readonly StoreFacts[];
  readonly packages: readonly PgPackageFacts[];
  readonly declarations: readonly UnreachableDeclaration[];
  /** `meta.x` names from `META_TABLES`, so a declared table cannot be imaginary. */
  readonly catalogTables: readonly string[];
  /** `STORELESS_TABLES`' subjects, so the two rules cannot disagree in silence. */
  readonly storelessTables: readonly string[];
  /** Substitute symbols with at least one non-test construction site. */
  readonly reachableSubstitutes: readonly string[];
}

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * Phrased from both sides on purpose: the fences read from the *facts* (something unreachable that
 * nothing declares) and `overtaken` / `unknown_symbol` / `unknown_package` read from the
 * *declarations* (a decision the workspace has moved past). A list that can only be wrong by going
 * red is not ADR-0288's `needsAuditEmitter`, which was wrong three times for want of exactly this.
 */
export function auditUnreachableStores(
  input: UnreachableAuditInput,
): readonly UnreachableFinding[] {
  const { stores, packages, declarations, catalogTables, storelessTables, reachableSubstitutes } =
    input;

  const byStore = new Map<string, StoreFacts>();
  const bySymbol = new Map<string, StoreFacts[]>();
  for (const store of stores) {
    byStore.set(`${store.pkg}:${store.symbol}`, store);
    const same = bySymbol.get(store.symbol) ?? [];
    same.push(store);
    bySymbol.set(store.symbol, same);
  }
  const byPackage = new Map<string, PgPackageFacts>();
  for (const pkg of packages) byPackage.set(pkg.pkg, pkg);

  const catalog = new Set(catalogTables);
  const storeless = new Set(storelessTables);
  const substitutes = new Set(reachableSubstitutes);

  const findings: UnreachableFinding[] = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const subject = subjectOf(declaration);
    if (seen.has(subject)) {
      findings.push({
        kind: "duplicate",
        subject,
        detail: `${subject} is declared more than once, so two reasons would both pass`,
      });
      continue;
    }
    seen.add(subject);

    if (!byPackage.has(declaration.pkg)) {
      findings.push({
        kind: "unknown_package",
        subject,
        detail: `${subject} names the package '${declaration.pkg}', which is not a pg package in this workspace — a stale decision`,
      });
      continue;
    }

    if (declaration.substitutedBy !== undefined && !substitutes.has(declaration.substitutedBy)) {
      findings.push({
        kind: "unsupported_substitute",
        subject,
        detail: `${subject} claims ${declaration.substitutedBy} is used instead, and nothing outside tests constructs that either — so the claim that something else does this job is false`,
      });
    }

    for (const table of declaration.tables ?? []) {
      if (!catalog.has(table)) {
        findings.push({
          kind: "unknown_table",
          subject,
          detail: `${subject} names ${table}, which META_TABLES does not declare`,
        });
        continue;
      }
      if (storeless.has(table)) {
        findings.push({
          kind: "table_declared_storeless",
          subject,
          detail: `${subject} names ${table}, which STORELESS_TABLES also declares writerless — this store's SQL names it, so the two rules disagree about the same table`,
        });
      }
    }

    if (declaration.scope === "package") {
      const facts = byPackage.get(declaration.pkg);
      if (facts !== undefined && classifyPgPackage(facts) === "reachable") {
        findings.push({
          kind: "overtaken",
          subject,
          detail: `${subject} is declared unreachable (${declaration.reason}) and ${facts.importedBy.length} non-test file(s) import it now — the decision is overtaken; remove the declaration`,
        });
      }
      continue;
    }

    const facts = byStore.get(subject);
    if (facts === undefined) {
      const elsewhere = (bySymbol.get(declaration.symbol ?? "") ?? []).map((s) => s.pkg);
      findings.push({
        kind: "unknown_symbol",
        subject,
        detail:
          elsewhere.length > 0
            ? `${subject} is declared and ${declaration.symbol ?? ""} is exported by ${elsewhere.join(", ")} instead — the declaration names the wrong package`
            : `${subject} is declared and no pg package exports ${declaration.symbol ?? ""} — renamed or removed`,
      });
      continue;
    }
    if (classifyStore(facts) === "reachable") {
      findings.push({
        kind: "overtaken",
        subject,
        detail: `${subject} is declared unreachable (${declaration.reason}) and ${facts.constructedBy.join(", ")} construct(s) it now — the decision is overtaken; remove the declaration`,
      });
    }
  }

  for (const store of stores) {
    const reachability = classifyStore(store);
    if (reachability === "reachable") continue;
    const subject = `${store.pkg}:${store.symbol}`;
    if (seen.has(subject)) continue;
    findings.push({
      kind: STORE_FINDING_FOR[reachability],
      subject,
      detail:
        reachability === "test_only"
          ? `${subject} (${store.declaredIn}) is constructed only by ${store.constructedByTests.join(", ")} — built, tested and never connected. Its table reads as written to pg-storeless-tables.ts and holds no row. Wire it, or add an UNREACHABLE_STORES line with a reason.`
          : `${subject} (${store.declaredIn}) is constructed nowhere at all, not even by a test`,
    });
  }

  for (const pkg of packages) {
    const reachability = classifyPgPackage(pkg);
    if (reachability === "reachable") continue;
    if (seen.has(pkg.pkg)) continue;
    findings.push({
      kind: PACKAGE_FINDING_FOR[reachability],
      subject: pkg.pkg,
      detail:
        reachability === "unimported"
          ? `${pkg.name} has no dependent and no importer anywhere — ADR-0335's api-gateway-pg shape, where four stores and a replayer were unreachable from the deployed binary`
          : reachability === "declared_unused"
            ? `${pkg.name} is declared a dependency of ${pkg.dependents.join(", ")} and imported by nothing — wiring begun and abandoned`
            : `${pkg.name} is imported only by ${pkg.importedByTests.join(", ")}`,
    });
  }

  return findings;
}

export function formatUnreachableFindings(findings: readonly UnreachableFinding[]): string {
  return findings.map((f) => `[${f.kind}] ${f.detail}`).join("\n");
}

export function countUnreachableByReason(
  declarations: readonly UnreachableDeclaration[],
): ReadonlyMap<UnreachableReason, number> {
  const counts = new Map<UnreachableReason, number>();
  for (const reason of UNREACHABLE_REASONS) counts.set(reason, 0);
  for (const declaration of declarations) {
    counts.set(declaration.reason, (counts.get(declaration.reason) ?? 0) + 1);
  }
  return counts;
}

/* -------------------------------------------------------- reading the source */

/**
 * String contents blanked, quotes and positions kept. Expects comment-stripped text.
 *
 * Why both passes are needed, in order. Comments: a commented-out `new PostgresFoo(` must not count
 * as a caller, and this repo comments heavily — `meta-schema.ts` alone is 11.6k lines of which much
 * is prose. Strings: the declarations below quote these symbol names, and a note that happened to
 * contain `new PostgresTargetingRuleStore(` would make this file argue itself reachable.
 *
 * Blanking rather than deleting, so every later line and column still names the real one. A
 * `${…}` interpolation is blanked with the rest of its template, which is why import specifiers are
 * read from the comment-stripped text instead — a specifier *is* a string literal.
 */
export function blankStringLiterals(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i] ?? "";
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      out += ch;
      i += 1;
      continue;
    }
    const quote = ch;
    out += ch;
    i += 1;
    while (i < n) {
      const c = code[i] ?? "";
      i += 1;
      if (c === "\\") {
        const escaped = code[i] ?? "";
        out += " ";
        out += escaped === "\n" ? "\n" : " ";
        i += 1;
        continue;
      }
      if (c === quote) {
        out += c;
        break;
      }
      out += c === "\n" ? "\n" : " ";
    }
  }
  return out;
}

/** Comments removed and string contents blanked. */
export function codeOnly(source: string): string {
  return blankStringLiterals(stripComments(source));
}

/**
 * Every module specifier one file imports, from the four forms that reach a package: `from "x"`,
 * a side-effect `import "x"`, a dynamic `import("x")` and `require("x")`.
 *
 * Read from comment-stripped text rather than from a substring search for the package name, because
 * a name mentioned in prose or in an error message is not an import — which is the difference
 * between "something imports this package" and "something talks about it".
 */
export function importedSpecifiers(strippedCode: string): readonly string[] {
  return [...strippedCode.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
    (m) => m[1] ?? "",
  );
}

/** Every `export class Postgres…` in one module's text. */
export function exportedStoreSymbols(code: string): readonly string[] {
  return [...code.matchAll(/export\s+(?:abstract\s+)?class\s+(Postgres[A-Za-z0-9_]*)/g)].map(
    (m) => m[1] ?? "",
  );
}

export interface DynamicConstruction {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface ConstructionScan {
  /** The tracked names this text constructs. */
  readonly constructs: readonly string[];
  /**
   * `new` applied to something that is not a (possibly qualified) identifier: `new (expr)()`,
   * `new map[kind]()`. Reported rather than skipped — a scan with a silent "could not read" bucket
   * would be the next member of the class these rules exist to catch — and asserted against both a
   * ceiling and a "mentions no tracked symbol" tripwire by the test.
   */
  readonly dynamic: readonly { readonly line: number; readonly snippet: string }[];
}

/**
 * Which of `names` this text constructs.
 *
 * The constructed name is the **last** identifier of a qualified path, so `new ns.PostgresFoo()`
 * counts — `import * as ns` is a legal way to reach a named export and a scan that missed it would
 * report a reachable store as dead. Parentheses are deliberately *not* required: `new Foo;` with no
 * argument list is a construction, and demanding `(` would have made every zero-argument store read
 * as unreachable.
 */
export function findConstructions(code: string, names: ReadonlySet<string>): ConstructionScan {
  const constructs = new Set<string>();
  const dynamic: { line: number; snippet: string }[] = [];
  const lineOf = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === "\n") line += 1;
    return line;
  };

  for (const match of code.matchAll(/\bnew\s+/g)) {
    const at = (match.index ?? 0) + match[0].length;
    const tail = code.slice(at, at + 200);
    const path = /^(?:[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*)*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(tail);
    if (path === null) {
      dynamic.push({ line: lineOf(at), snippet: tail.slice(0, 60).replace(/\s+/g, " ").trim() });
      continue;
    }
    const name = path[1] ?? "";
    if (names.has(name)) constructs.add(name);
  }
  return { constructs: [...constructs], dynamic };
}

/**
 * Whether a construction site counts as a test.
 *
 * `*.test.ts` is the convention, and `test-*.ts` is the second half that is easy to miss: ten
 * packages keep a `src/test-fakes.ts` — a module that is production by filename and exists only for
 * tests. A store constructed there would read as reachable while no deployment ever loads it, which
 * is this rule's own defect shape one level down. Derived from the name rather than from a
 * maintained list, so a new `test-fakes.ts` is covered the day it lands.
 *
 * What it does not reach: a helper named something else. `packages/access-reviews-runtime/src/
 * fixtures.ts` and `packages/billing-runtime/src/test-fixtures.ts` are the same kind of module under
 * two naming conventions, and only the second is caught.
 */
export function isTestSite(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /\.test\.tsx?$/.test(base) || /^test-.*\.tsx?$/.test(base);
}

/* --------------------------------------------------------------- the scan */

/**
 * The impure half, in one place.
 *
 * **The walk is local rather than `workspace-sql-scan.ts`'**, and the two differences are both
 * load-bearing rather than stylistic:
 *
 *  - That walk **excludes `*.test.ts` by construction**, and this rule's entire question is whether
 *    a construction site is a test. Reusing it would answer "no site at all" for all eight.
 *  - It walks `<pkg>/src` only, and `apps/operate-web` has **no `src/`** — its code is in `app/`,
 *    `components/` and `lib/`. A store constructed there would read as unreachable.
 *
 * Changing the shared walk to suit this rule would change the input of the two SQL rules that depend
 * on it, so what is shared is what can be: `REPO_ROOT` and `workspaceRoots()` (where the workspace
 * is, read from `pnpm-workspace.yaml`) and `stripComments` (how to ignore prose).
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", ".turbo", ".git"]);

export interface WorkspaceMember {
  /** `packages/foo` or `apps/bar`. */
  readonly dir: string;
  readonly name: string;
}

export interface WorkspaceStoreScan {
  readonly files: number;
  readonly members: readonly WorkspaceMember[];
  readonly packages: readonly PgPackageFacts[];
  readonly stores: readonly StoreFacts[];
  readonly reachableSubstitutes: readonly string[];
  readonly dynamic: readonly DynamicConstruction[];
  readonly unhandledGlobs: readonly string[];
  /** Symbol names exported by more than one pg package, which this scan cannot key apart. */
  readonly collidingSymbols: readonly string[];
}

function filesUnder(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) filesUnder(absolute, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(absolute);
  }
}

function readPackageName(dir: string): string | null {
  const manifest = join(REPO_ROOT, dir, "package.json");
  if (!existsSync(manifest)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function declaredDependencies(dir: string): ReadonlySet<string> {
  const manifest = join(REPO_ROOT, dir, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const out = new Set<string>();
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const block = (parsed as Record<string, unknown>)[field];
    if (typeof block !== "object" || block === null) continue;
    for (const key of Object.keys(block)) out.add(key);
  }
  return out;
}

export function scanWorkspaceStores(
  substituteNames: readonly string[] = UNREACHABLE_STORES.flatMap((d) =>
    d.substitutedBy === undefined ? [] : [d.substitutedBy],
  ),
): WorkspaceStoreScan {
  const { roots, unhandledGlobs } = workspaceRoots();

  const members: WorkspaceMember[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      if (SKIP_DIRS.has(entry)) continue;
      const dir = `${root}/${entry}`;
      if (!statSync(join(REPO_ROOT, dir)).isDirectory()) continue;
      const name = readPackageName(dir);
      if (name === null) continue;
      members.push({ dir, name });
    }
  }

  // `packages/*-pg` also matches `packages/*-runtime-pg`, so the set is derived from one readdir and
  // keyed by directory — globbing both would list every `-runtime-pg` package twice and quietly
  // double the denominator of every count below.
  const pgMembers = members.filter(
    (m) => m.dir.startsWith("packages/") && PG_PACKAGE.test(m.dir.slice("packages/".length)),
  );

  const tracked = new Set<string>(substituteNames);
  const declaredIn = new Map<string, { pkg: string; file: string }>();
  // Two packages exporting one symbol name would make this map lose a store silently, which is the
  // shape of defect these rules exist to end. Collected and asserted empty rather than assumed.
  const collidingSymbols: string[] = [];
  for (const member of pgMembers) {
    const src = join(REPO_ROOT, member.dir, "src");
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    const absolute: string[] = [];
    filesUnder(src, absolute);
    for (const file of absolute) {
      const relative = file.slice(REPO_ROOT.length + 1);
      if (isTestSite(relative)) continue;
      for (const symbol of exportedStoreSymbols(codeOnly(readFileSync(file, "utf8")))) {
        tracked.add(symbol);
        const prior = declaredIn.get(symbol);
        if (prior !== undefined) collidingSymbols.push(`${symbol}: ${prior.file} and ${relative}`);
        declaredIn.set(symbol, { pkg: member.dir.slice("packages/".length), file: relative });
      }
    }
  }

  const sites = new Map<string, { prod: string[]; tests: string[] }>();
  const imports = new Map<string, { prod: string[]; tests: string[] }>();
  const dynamic: DynamicConstruction[] = [];
  const pgByName = new Map(pgMembers.map((m) => [m.name, m.dir]));

  let files = 0;
  for (const member of members) {
    const absolute: string[] = [];
    filesUnder(join(REPO_ROOT, member.dir), absolute);
    for (const file of absolute) {
      const relative = file.slice(REPO_ROOT.length + 1);
      // Two passes over one read, because the two questions want different text: a construction must
      // not be found inside a string, and an import specifier *is* a string.
      const stripped = stripComments(readFileSync(file, "utf8"));
      const code = blankStringLiterals(stripped);
      files += 1;
      const test = isTestSite(relative);

      const found = findConstructions(code, tracked);
      for (const symbol of found.constructs) {
        const entry = sites.get(symbol) ?? { prod: [], tests: [] };
        (test ? entry.tests : entry.prod).push(relative);
        sites.set(symbol, entry);
      }
      for (const d of found.dynamic) {
        dynamic.push({ file: relative, line: d.line, snippet: d.snippet });
      }

      for (const specifier of importedSpecifiers(stripped)) {
        const root = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier;
        const dir = pgByName.get(root);
        if (dir === undefined || dir === member.dir) continue;
        const entry = imports.get(dir) ?? { prod: [], tests: [] };
        (test ? entry.tests : entry.prod).push(relative);
        imports.set(dir, entry);
      }
    }
  }

  const stores: StoreFacts[] = [];
  for (const [symbol, where] of [...declaredIn].sort(([a], [b]) => a.localeCompare(b))) {
    const site = sites.get(symbol) ?? { prod: [], tests: [] };
    stores.push(
      StoreFactsSchema.parse({
        symbol,
        pkg: where.pkg,
        declaredIn: where.file,
        constructedBy: site.prod.slice().sort(),
        constructedByTests: site.tests.slice().sort(),
      }),
    );
  }

  // One parse per manifest, not one per (member, pg package) pair.
  const dependencyMap = new Map(members.map((m) => [m.dir, declaredDependencies(m.dir)]));

  const packages: PgPackageFacts[] = [];
  for (const member of pgMembers) {
    const dependents = members
      .filter((m) => m.dir !== member.dir && (dependencyMap.get(m.dir)?.has(member.name) ?? false))
      .map((m) => m.dir)
      .sort();
    const imported = imports.get(member.dir) ?? { prod: [], tests: [] };
    packages.push(
      PgPackageFactsSchema.parse({
        pkg: member.dir.slice("packages/".length),
        name: member.name,
        dependents,
        importedBy: imported.prod.slice().sort(),
        importedByTests: imported.tests.slice().sort(),
      }),
    );
  }

  const reachableSubstitutes = substituteNames.filter(
    (name) => (sites.get(name)?.prod.length ?? 0) > 0,
  );

  return {
    files,
    members,
    packages,
    stores,
    reachableSubstitutes: [...new Set(reachableSubstitutes)],
    dynamic,
    unhandledGlobs,
    collidingSymbols,
  };
}

/* ------------------------------------------------------ the declaration */

/**
 * Every unreachable Postgres store, with the reason it has no caller.
 *
 * **This list is expected to shrink, and it shrank while being written.** It was seeded with eight;
 * `PostgresIdempotencyStore` and `PostgresPipelineExecutionStore` were wired into
 * `apps/operate-server/src/node.ts` before this rule landed, and the rule reported both as
 * `overtaken` rather than passing — which is the whole mechanism. A member that gains a caller has
 * its line deleted; a declaration the workspace has moved past is a test failure, not a stale
 * comment.
 *
 * Ordered by package, because the clusters are the finding: three of six are
 * `incident-response-runtime-pg`, which is one ADR's worth of stores (ADR-0296) that never grew a
 * surface, and two are `feature-flags-pg`, where the same four-eyes apparatus blocks both.
 *
 * ## What is not here: module reachability, and why it cannot be the fence
 *
 * Reachability here is **flat**: any non-test construction site counts, wherever it sits. The
 * transitive question — *is the module holding that `new` itself reachable?* — was implemented twice
 * and shipped neither time, and the second attempt is the one worth writing down.
 *
 * The naive version (grep for importers of `./<base>.js`, skip `index.ts`) reports **ten false
 * positives**:
 *
 *     PostgresAccessReviewCampaignStore / DecisionStore / EvidenceStore / ItemStore  <- persisting-runtime.ts
 *     PostgresArchitectMessageStore / ProposalStore / SessionStore / ToolInvocationStore  <- transcript.ts
 *     PostgresEventLog  <- replayer.ts, persistent-engine.ts
 *     PostgresSloLatencyEvaluationStore  <- latency-persisting-engine.ts
 *
 * Every one of those modules is re-exported through its package's `index.ts` and imported **by
 * package root** — `from "@crossengin/access-reviews-runtime-pg"` — so a relative-specifier grep
 * finds nothing. `PostgresAccessReviewEvidenceStore` was verified reachable by hand last increment
 * (`node.ts` → `buildAccessReviewsLifecycle` → `access-reviews-lifecycle.ts` →
 * `persisting-runtime.ts`), which is how the error was caught. Over-reporting is the direction that
 * **fails CI on correct code**, and a rule that cries wolf gets deleted rather than fixed.
 *
 * So the second attempt did it properly: entrypoints taken from every workspace `package.json`
 * **`bin`** field — never from a filename that looks like a CLI, since `src/cli.ts` is the argv
 * *parser* and does not import the command bodies, which over-reported by five — resolved through
 * relative specifiers, package-root specifiers and `exports` subpaths, mapping `dist/x.js` back to
 * its source. Three entrypoints (`kernel-pg/bin/crossengin-pg.ts`, `architect-cli/bin/crossengin.ts`,
 * `operate-server/bin/operate-server.ts`), zero unresolvable imports, **760 of 1026 non-test files
 * reached**.
 *
 * **And the measurement is what refuses it.** Of the stores declared below, the modules holding
 * `PostgresTargetingRuleStore`, `PostgresRouteRegistry` and `PostgresCustomerCommsStore` all come
 * back **reached** — because an `index.ts` carrying `export * from "./targeting-rule-store.js"` is
 * imported by package root, so every module in every root-imported package is reachable whether or
 * not one line of it is ever used. Module reachability is therefore **not** symbol reachability, and
 * for this workspace it is close to vacuous: it answers "reached" for exactly the stores this rule
 * exists to report. Answering it properly needs symbol-level use analysis through `export *`, which
 * is a type-aware pass and not a text scan. (The same measurement shows `apps/operate-web` is
 * absent from the graph entirely — a Next app declares no `bin` — so 266 non-test files would read
 * as orphaned, which is the other half of why it cannot fence.)
 *
 * The flat signal is sound *because* it is conservative: it can only under-report. Whatever is
 * declared below is a lower bound.
 */
export const UNREACHABLE_STORES: readonly UnreachableDeclaration[] = Object.freeze([
  /* ------------------------------------------------------- api-gateway-pg (1) */
  {
    scope: "store",
    pkg: "api-gateway-pg",
    symbol: "PostgresRouteRegistry",
    reason: "substitute_in_use",
    substitutedBy: "InMemoryRouteRegistry",
    tables: ["meta.gateway_routes"],
    consequence:
      "`meta.gateway_routes` is empty: `compileOperateServer` derives routes from the manifest into an `InMemoryRouteRegistry` at boot, so the stored row's version negotiation, sunset date and `rate_limit_policy_id` have no reader — the policy id a decision row carries comes from `--rate-limit-policy` on argv instead.",
    note: "The last of this package's four stores. ADR-0335 wired `PostgresRateLimitChecker` and this increment's gateway lane wired `PostgresIdempotencyStore` and `PostgresPipelineExecutionStore`; this one stays, because a per-row registry is a different *model* from compiling the manifest rather than merely an unwired one — it would let a route exist that no manifest declares. The TTL cache here is the evidence it was written for a world where rows change under a running server.",
  },

  /* ------------------------------------------------------ feature-flags-pg (2) */
  {
    scope: "store",
    pkg: "feature-flags-pg",
    symbol: "PostgresFeatureFlagStore",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "an evaluator, and only then an authoring surface — in that order, which is the correction that matters. Nothing in the contract blocks the store (it round-trips every one of the seven flag kinds) and an authoring route would be config-grade, wanting --notification-template-routes' four-eyes apparatus (ADR-0313) exactly as the targeting-rule store does. But a route alone would store flags nothing reads: NOTHING IN THE WORKSPACE EVALUATES A FEATURE FLAG. Every ingredient is modelled and none composed (isFlagActive, isFlagInEnvironment, parseDefaultValue, findActiveKillSwitch, chooseTargetingRule, computeStableBucket), no function takes a flag plus a context and returns a value, and each of the 17 EVALUATION_REASONS appears only in evaluations.ts, its own test, and the CHECK on meta.feature_flag_evaluations.reason — zero producers, which FLAG_EVALUATION_REASON_PRODUCERS now states as a total map. There is no source either: a flag has no manifest field, no CLI flag, no env var and no route, so a flag here is neither a stored record nor a boot declaration but a modelled domain with no mechanism. Building the route first is therefore the one ordering that cannot work.",
    tables: ["meta.feature_flags"],
    consequence:
      "No flag can be authored by any deployment, so `meta.feature_flags` is empty everywhere — which is exactly why ADR-0296's kill-switch `flag_id` foreign key is `addable but not added` (ADR-0291 will not add a key it cannot prove every row satisfies), and why `PostgresKillSwitchStore`, which *is* reachable through `observability-runtime-pg`, writes a `flag_id` that resolves to nothing.",
    note: "ADR-0300 built this store after finding the table had drifted 18 columns and 3 flag kinds behind its contract. It closed the drift and added no caller, so the table is still the ADR-0300 class with a store in front of it.",
  },
  {
    scope: "store",
    pkg: "feature-flags-pg",
    symbol: "PostgresTargetingRuleStore",
    reason: "no_caller_by_design",
    decidedIn: "ADR-0335",
    tables: ["meta.feature_flag_targeting_rules"],
    consequence:
      "A flag's targeting rules can be read back and written by nothing, so `chooseTargetingRule` evaluates an empty rule set in every deployment and the ten targeting rule kinds with their FNV-1a sticky bucketing are unreachable from a database.",
    note: "**The store this rule exists for.** ADR-0335 shipped no authoring route deliberately and the reasoning is sound — a rule changes what the deployment serves, so it is at least config-grade and would need `--notification-template-routes`' four-eyes apparatus (ADR-0313) — but the table left `pg-storeless-tables.ts`' census when this store landed, so the fence read greener for a place that went from watched to unwatched. The decision survives the rule naming it; that is the point.",
  },

  /* ------------------------------------------ incident-response-runtime-pg (3) */
  {
    scope: "store",
    pkg: "incident-response-runtime-pg",
    symbol: "PostgresRunbookExecutionStore",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a runbook-execution surface: `RunbookExecution` and its per-step outcomes are complete in the contract and `IncidentExecutor` has no method that starts one, so a route and a step-outcome writer have to land beside this store. Ordering, not shape.",
    tables: ["meta.incident_runbook_executions"],
    consequence:
      "A runbook execution and its per-step outcomes are never recorded, so a postmortem opens on an incident whose remediation is not reconstructible from the database, and the revision guard this store carries has never guarded a row.",
    note: "ADR-0296 built this and the two below — `the three stores that were dead since Phase 1` — each with its own revision guard. `operate-server` grew the incident *record* routes (ADR-0293, ADR-0294) and no runbook surface, so nothing has ever constructed it outside `runbook-store.test.ts`.",
  },
  {
    scope: "store",
    pkg: "incident-response-runtime-pg",
    symbol: "PostgresPostmortemStore",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a postmortem route on the incident surface. `IncidentExecutor.attachPostmortem` exists and is reachable, so the only missing piece is the HTTP edge and the store beside it — the narrowest of these three.",
    tables: ["meta.incident_postmortems"],
    consequence:
      "`attachPostmortem` has no durable sink, so a blameless postmortem and its prioritized action items live only in the in-memory incident record — and the four-eyes rule on review (`author ∉ reviewers`) is enforced against a value that is never stored.",
    note: "ADR-0296's reasoning for the revision guard here was that `a postmortem is edited by humans over days`, which is also the clearest statement of why this store is wanted rather than redundant.",
  },
  {
    scope: "store",
    pkg: "incident-response-runtime-pg",
    symbol: "PostgresCustomerCommsStore",
    reason: "contract_cannot_carry_the_surface",
    blockedBy:
      "a tenant-scoped read path that the table's shape cannot currently provide. `meta.incident_communications` is platform-wide — no `tenant_id`, no RLS, like the incident it describes — while `affected_tenants` is one of the audiences, so the surface a tenant would actually read cannot be served from this row at all. The store's own comment names it: `nothing tenant-facing is wired to this store even though affected_tenants is one of the audiences`. Wiring it would persist communications no tenant can be shown, which is why this one is not merely next in a queue.",
    tables: ["meta.incident_communications"],
    consequence:
      "Customer communications are not stored, so the GDPR 72h breach-notification deadline the contract enforces is never recorded against a published notice and a deployment cannot show what it told whom, when, or that it retracted anything.",
    note: "ADR-0296's third store. Its own comment names the missing half: platform-wide with no tenant-scoped read path, `which is also why nothing tenant-facing is wired to this store even though affected_tenants is one of the audiences`.",
  },
]);
