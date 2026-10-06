import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { stripComments } from "./pg-column-coverage.js";
import { REPO_ROOT, workspaceRoots } from "./workspace-sql-scan.js";

/**
 * The inverse of `pg-storeless-tables.ts`: a component that nothing constructs.
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
 *   **no exported class is unreachable without a declaration saying why.**
 *
 * ## What ADR-0336 shipped, and the four blind spots it declared about itself
 *
 * ADR-0336's version answered that question only for classes named `Postgres*`, only in
 * `packages/*-pg`, and only for classes. It said so in its own source, and every one of those limits
 * turned out to have **live members** — which is the finding that justified widening it rather than
 * only documenting it:
 *
 *  1. **The symbol predicate.** `Postgres*` was a convention the rule trusted, exactly as
 *     `pg-storeless-tables.ts` trusts `META_TABLES`. Widening it to *every exported class* found
 *     **five drift replayers with no construction site** — `WorkflowReplayer`, `DrReplayer`,
 *     `SloEnforcementReplayer`, `AccessReviewReplayer`, `GatewayReplayer`, each advertised in
 *     CLAUDE.md as a shipped capability and two of them bug-fixed (ADR-0330, ADR-0333) while nothing
 *     called them — plus `TraceCollector`, `SyntheticTracker`, `KeyRotationMigrator`,
 *     `CampaignScheduler`, `RegionRouter` and `WorkflowSignalBridge`.
 *  2. **`apps/*` was out of scope by declaration**, so an app-internal store the app never
 *     constructs — the same defect — was unasked. In scope now, and the walk is per *member* rather
 *     than per `<member>/src`, because `apps/operate-web` has **no `src/`** (its code is `app/`,
 *     `components/`, `lib/`) and a walk hardcoding `src` misses all 300-odd of its files.
 *  3. **`packages/feature-flags-pg`' `CALLERLESS_FLAG_STORES` was a second list naming the same
 *     things with no comparison between them** — ADR-0288's shape. `auditCallerlessFlagLists` now
 *     compares it against this scan's facts **and** against this file's declarations, both
 *     directions, read from disk as text the way `pg-record-retention.ts` reads the erasure's list.
 *  4. **The factory**, which is still open and cannot be closed by a text scan. See
 *     *What this rule cannot see*.
 *
 * And a fifth, found while widening, which is a different shape from the other four:
 *
 *  5. **The unit of analysis is "an exported class, constructed somewhere", and a driver can be a
 *     set of functions.** `packages/incident-response-runtime-pg/src/replayer.ts` exports
 *     `replayIncidents` and `formatIncidentReplayReport` and **no class at all**, so there is no
 *     `new` site to look for and neither the old rule nor a widened symbol predicate can see it. It
 *     is callerless, and CLAUDE.md advertises that module as *"the only way to catch a row edited
 *     into a state the contract forbids but a CHECK constraint permits (ADR-0289)"* — so the one
 *     driver this rule is structurally blind to is, by the repo's own account, the sole detector for
 *     a tamper class. `packages/deploy` is the second live member: it holds the workspace's only
 *     `evaluateFlag()` and exports no class, so it classifies `contracts_only` below.
 *
 * ## Why the unit did not change, measured
 *
 * The general form of signal 5 — *an exported symbol nothing outside its module uses* — was
 * implemented and refused, and the measurement is what refuses it. Over the real workspace it
 * reports **82 of 812 non-test, non-barrel modules**, and the population is almost entirely
 * contracts packages doing exactly what they were built to do: `packages/billing/src/tax.ts`,
 * `packages/ml-training/src/models.ts`, all four `packages/pwa` modules, five `packages/ai-architect/
 * src/policy/*` modules. Eighty-two findings nobody can act on is the wide rule that gets muted,
 * which is worse than a narrow rule that is trusted.
 *
 * It also has a **false-negative mode that a class scan does not**: the reference test is a word
 * match, so a module whose exported names collide with another module's reads as referenced.
 * `api-gateway-pg`, `observability-runtime-pg` and `access-reviews-runtime-pg`'s replayers all
 * export `DriftIssue`, so all three are *absent* from those 82 — the signal misses three of the six
 * members it would exist to find. Noisy and unreliable in one predicate.
 *
 * So the unit stays "an exported class, constructed somewhere", and the function-shaped driver is
 * fenced two narrower ways instead, both two-sided:
 *
 *  - a **`module`-scope declaration** naming the file and its entrypoint, checked four ways
 *    (`unknown_module`, `unknown_entrypoint`, `module_now_has_class`, `overtaken`), so the live
 *    member is named on disk rather than in prose; and
 *  - a **driver-family census** over `DRIVER_MODULE_FAMILIES`, which asserts that every
 *    `src/replayer.ts` in the workspace is accounted for by *one of the two* rules — it either
 *    exports a class the symbol scan tracks, or it carries a module declaration. One glob, with a
 *    floor on how many members it must find, so a family that stopped using the convention fails
 *    rather than passing on zero.
 *
 * ## What this rule cannot see
 *
 * Stated here rather than discovered a fourth time:
 *
 *  - **The factory.** Reachability is flat: *is there any non-test file that constructs this
 *    symbol?* A store constructed by a factory whose factory has no caller reads as reachable. Ten
 *    stores sit in that position today and all ten are *correctly* called reachable — the four
 *    access-review stores via `persisting-runtime.ts`, the four Architect stores via `transcript.ts`,
 *    `PostgresEventLog` via `replayer.ts`/`persistent-engine.ts`, `PostgresSloLatencyEvaluationStore`
 *    via `latency-persisting-engine.ts` — but if one of those factories lost its last caller this
 *    rule would keep calling its stores reachable. ADR-0333's `workflow-workers.ts` is the historical
 *    member of that class. The transitive answer is refused below, with the measurement that refuses
 *    it.
 *  - **A function-shaped driver outside `DRIVER_MODULE_FAMILIES`.** The two named live members are
 *    fenced; a `*-scheduler.ts` or `*-reconciler.ts` of the same shape is not, and the general
 *    predicate is the 82-finding one above.
 *  - **A colliding class name.** Construction sites are attributed **by name, symbol-wide**: eight
 *    packages each declare `FixedClock` and a `new FixedClock()` anywhere credits all eight. That is
 *    deliberate and conservative — a shared site makes every copy read *reachable*, so the rule can
 *    only under-report — and `collidingSymbols` reports the set so the ambiguity is visible rather
 *    than assumed away. Attributing by dependency edge instead would over-report, which is the
 *    direction that fails CI on correct code.
 *  - **A construction in a fake whose filename is not a test convention.** `isTestSite` reads
 *    `*.test.ts` and `test-*.ts`; `packages/access-reviews-runtime/src/fixtures.ts` is the same kind
 *    of module under a third name and reads as a real caller.
 *  - **A dynamic `new (map[kind])()`**, which is counted and reported but could only ever be named
 *    unattributable. Zero today, with a tripwire asserting none mentions a tracked name.
 *  - **Whether a declared reason is true.** Shape, referential integrity and both directions of
 *    membership are checkable; a judgement is not.
 *  - **Whether a reachable construction is on a path any deployment takes.** A store constructed
 *    only under a flag nobody sets is reachable here and dead in practice — the condition
 *    `--workflow-workers` was in before ADR-0333.
 *
 * ## The TypeScript compiler API: refused, and the measurement is the reason
 *
 * A type-aware pass would answer symbol-level reachability through `export *` properly, which is the
 * one thing a text scan cannot do, and it would see a function reference as readily as a `new`. It
 * was measured against this workspace rather than reasoned about, and it is refused on three
 * grounds, in increasing order of severity:
 *
 *  1. **Cost.** 1,026 non-test root files pull in 2,173 program files: `createProgram` 3.5 s, the
 *     checker 1.9 s, `getPreEmitDiagnostics` 20.5 s, **1.2 GB RSS**. This file's test runs inside
 *     `@crossengin/testing`'s ordinary suite.
 *  2. **One program cannot hold 90 packages.** Even with the whole workspace as roots, that run
 *     reports **112 unresolved modules across 30 distinct specifiers** — `apps/operate-web`'s `@/*`
 *     path aliases and every `next/*` import — because the members do not share a `tsconfig`
 *     (`paths`, `jsx`, `lib: dom`). Honest resolution means ninety programs.
 *  3. **The decisive one: cross-package symbols resolve into `dist`.** No `paths` mapping exists;
 *     resolution is NodeNext through each package's `exports`, whose `types` is
 *     `./dist/src/index.d.ts`. Measured on the 69 `new Postgres*` sites in
 *     `apps/operate-server/src/node.ts`: `getAliasedSymbol` lands on
 *     `packages/api-gateway-pg/dist/rate-limit-checker.d.ts`,
 *     `packages/crypto-pg/dist/key-registry.d.ts`, `packages/forensics-pg/dist/checkpoint-store.d.ts`
 *     — *not* on the `src/` files this rule scans. So the symbol at the use site and the symbol at
 *     the declaration are **two different symbols**, and joining them needs either a filename
 *     heuristic (`dist/x.d.ts` → `src/x.ts`, which is the text-level guess the compiler was meant to
 *     replace) or a synthetic `paths` map maintained inside the test — a second copy of the
 *     workspace's module resolution that can drift, whose stale-by-one-package failure mode is
 *     **silent, total over-reporting for that package**.
 *
 * And (3) makes it conditional twice over: the rule would be green only after `pnpm -r build`, and
 * against a *stale* `dist` it would be green on the previous build's declarations. **A rule that is
 * green only after a build is not a rule** — which is why all five strategy rules read the workspace
 * from disk as text. The fifth blind spot strengthens the case both ways and does not change it: a
 * type-aware pass would see the function-shaped driver, and what it would buy is precision on the
 * 82-finding population, where precision on a question whose answers nobody can act on is still
 * noise.
 *
 * The flat text signal is sound **because** it is conservative: it can only under-report, so
 * whatever it declares is a lower bound.
 */

/* ------------------------------------------------------------------- reasons */

/**
 * Why an exported component has no caller. Six members, and the splits are load-bearing.
 *
 * ADR-0330's lesson applies directly — *defining a reason away* is what makes a real distinction
 * inexpressible — and a single flat `built_never_connected` would define away four of them:
 *
 *  - **`substitute_in_use` vs anything else.** With a substitute, the feature *works* — just not
 *    durably, not across replicas, or through a second implementation of the same job. The fix is
 *    swapping one constructor, and the claim is checkable, so it is checked.
 *  - **`offline_implementation` vs the rest.** An in-memory or static implementation of an injected
 *    seam is *supposed* to have no production caller; it exists for a test and for a deployment that
 *    chooses it. Its checked property is the inverse of the others': it must be constructed by at
 *    least one test, because a seam implementation nothing constructs at all is dead rather than
 *    offline.
 *  - **`unpersisted_record` vs the two blocked reasons.** The deployed binary *already produces* the
 *    record on every pass and drops it, so this is one wiring line away and data is being lost right
 *    now. A blocked store has nothing to persist yet; constructing it would change nothing.
 *  - **`prerequisite_of_unbuilt_surface` vs `contract_cannot_carry_the_surface`**, which is the
 *    split that earns its keep: the first is blocked by **ordering** and will be wired once the
 *    route, subcommand or scheduler beside it lands; the second is blocked by **the contract's own
 *    shape** and cannot be wired honestly until that changes. Merging them sends the next person to
 *    write a route that cannot be written.
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
   * An in-memory or static implementation of an injected seam, with no production caller by nature.
   * Checked the other way round from every other reason: at least one test must construct it.
   */
  "offline_implementation",
  /**
   * The record is produced by the running binary on every pass and never persisted.
   *
   * No member today, and the reason to keep it is that its one member was wired within the hour:
   * `PostgresPipelineExecutionStore` was declared here and landed in `node.ts` before this rule did,
   * which is the category doing its job — "one constructor away" is actionable in a way that
   * "unwired" is not.
   */
  "unpersisted_record",
  /** Blocked by ordering: the surface it drives is not built yet. `blockedBy` names what must land. */
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

/**
 * The reason whose declaration is checked for a *test* caller rather than against one.
 *
 * Kept as its own set rather than an `if`, so the four bearing sets partition
 * `UNREACHABLE_REASONS` with exactly the two field-free reasons left over — which a test asserts, so
 * a seventh reason added to none of them fails there instead of silently carrying any field it likes.
 */
export const TEST_CONSTRUCTED_REASONS: readonly UnreachableReason[] = ["offline_implementation"];

/** A workspace member directory: `packages/<name>` or `apps/<name>`. */
const MEMBER_DIR = /^(?:packages|apps)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `packages/<name>-pg`. Persistence lives here, which two classifications turn on. */
const PG_MEMBER = /^packages\/[a-z0-9]+(?:-[a-z0-9]+)*-pg$/;
const CLASS_SYMBOL = /^[A-Z][A-Za-z0-9_]*$/;
const FUNCTION_SYMBOL = /^[a-z][A-Za-z0-9_]*$/;
/**
 * A path inside a member, e.g. `src/replayer.ts`.
 *
 * The `..` guard leads, because the segment character class has to admit `.` for the extension and
 * `-` for a hyphenated filename, and that admits `..` as a whole segment — so a declaration could
 * name a file in another member while passing every per-member check below it.
 */
const MEMBER_PATH = /^(?!.*\.\.)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.tsx?$/;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const ADR_ID = /^ADR-\d{4}$/;

/**
 * What a declaration is about.
 *
 * `symbol` and `member` are ADR-0336's `store` and `package` renamed, because the unit is no longer
 * a Postgres store: it is any exported class, in any member including `apps/*`. `module` is the
 * fifth blind spot's fence — a file whose driver is a set of functions, which has no `new` site for
 * the symbol scan to find.
 */
export const UNREACHABLE_SCOPES = ["symbol", "module", "member"] as const;
export type UnreachableScope = (typeof UNREACHABLE_SCOPES)[number];

export const UnreachableDeclarationSchema = z
  .object({
    scope: z.enum(UNREACHABLE_SCOPES),
    /** The member directory, e.g. `packages/feature-flags-pg` or `apps/operate-server`. */
    pkg: z.string().regex(MEMBER_DIR),
    /** The exported class. `symbol` scope only, and required there. */
    symbol: z.string().regex(CLASS_SYMBOL).optional(),
    /** The file inside the member, e.g. `src/replayer.ts`. `module` scope only. */
    module: z.string().regex(MEMBER_PATH).optional(),
    /**
     * The exported function that would be called if anything ran this module. `module` scope only.
     * One name rather than the whole export list, because the audit asserts it *is* exported and
     * that nothing outside the module names it — a claim about a list would be weaker in both halves.
     */
    entrypoint: z.string().regex(FUNCTION_SYMBOL).optional(),
    reason: z.enum(UNREACHABLE_REASONS),
    /**
     * The catalogued tables this component's SQL names. `symbol` and `module` scope, and **required
     * there even when empty** — `[]` is a signed assertion that it writes no catalogued table, which
     * ADR-0331 established is a different fact from "nobody said". An optional field would let the
     * interesting half (which table reads as written because of this) be forgotten silently.
     */
    tables: z.array(z.string().regex(QUALIFIED)).optional(),
    /** The implementation in use instead. `substitute_in_use` only. */
    substitutedBy: z.string().regex(CLASS_SYMBOL).optional(),
    /** The ADR that decided against wiring it. `no_caller_by_design` only. */
    decidedIn: z.string().regex(ADR_ID).optional(),
    /** What must land before this can have a caller. The two blocked reasons only. */
    blockedBy: z.string().min(20).optional(),
    /** What a deployment does not get. Required of every member. */
    consequence: z.string().min(20),
    /** The evidence: who built it, which ADR, what is constructed instead. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly UnreachableReason[]): boolean => set.includes(value.reason);
    const demand = (
      path: string,
      present: boolean,
      wanted: boolean,
      message: string,
    ): void => {
      if (present === wanted) return;
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    const isSymbol = value.scope === "symbol";
    const isModule = value.scope === "module";
    demand(
      "symbol",
      value.symbol !== undefined,
      isSymbol,
      `only a symbol declaration may name a class, and it must name one (${value.scope})`,
    );
    demand(
      "module",
      value.module !== undefined,
      isModule,
      `only a module declaration may name a file, and it must name one (${value.scope})`,
    );
    demand(
      "entrypoint",
      value.entrypoint !== undefined,
      isModule,
      `only a module declaration may name an entrypoint, and it must name one (${value.scope})`,
    );
    demand(
      "tables",
      value.tables !== undefined,
      isSymbol || isModule,
      `a symbol or module declaration must name its tables — pass [] to assert it writes none (${value.scope})`,
    );
    demand(
      "substitutedBy",
      value.substitutedBy !== undefined,
      wants(SUBSTITUTE_BEARING_REASONS),
      `only a substitute_in_use declaration may name the substitute, and it must name one (${value.reason})`,
    );
    demand(
      "decidedIn",
      value.decidedIn !== undefined,
      wants(DECISION_BEARING_REASONS),
      `only a no_caller_by_design declaration may cite an ADR, and it must cite one (${value.reason})`,
    );
    demand(
      "blockedBy",
      value.blockedBy !== undefined,
      wants(BLOCKER_BEARING_REASONS),
      `only a blocked declaration may name its blocker, and it must name one (${value.reason})`,
    );
  });
export type UnreachableDeclaration = z.infer<typeof UnreachableDeclarationSchema>;

/**
 * `packages/feature-flags-pg:PostgresTargetingRuleStore`,
 * `packages/incident-response-runtime-pg::src/replayer.ts`, or `packages/deploy` for a member.
 *
 * A module subject carries a doubled colon so a path containing one could never collide with a
 * symbol subject — the two namespaces are joined in one `seen` set.
 */
export function subjectOf(declaration: UnreachableDeclaration): string {
  if (declaration.symbol !== undefined) return `${declaration.pkg}:${declaration.symbol}`;
  if (declaration.module !== undefined) return `${declaration.pkg}::${declaration.module}`;
  return declaration.pkg;
}

/* -------------------------------------------------------------------- facts */

export const SymbolFactsSchema = z.object({
  symbol: z.string().regex(CLASS_SYMBOL),
  /** The member declaring it. */
  pkg: z.string().regex(MEMBER_DIR),
  /** Workspace-relative file holding the `export class`. */
  declaredIn: z.string().min(1),
  /**
   * The `extends` clause's head identifier, or null. Read so that a class whose own clause names an
   * error type can be classified `diagnostic_type` mechanically rather than by a maintained list of
   * names — an error is constructed by whoever throws it, which is any consumer.
   */
  extendsName: z.string().min(1).nullable(),
  /** Other members declaring the same class name. Non-empty means attribution is by name only. */
  alsoDeclaredBy: z.array(z.string().regex(MEMBER_DIR)),
  /** Non-test files that construct it, anywhere in the workspace. */
  constructedBy: z.array(z.string().min(1)),
  /** Test files that construct it. Separate, because the whole finding is the difference. */
  constructedByTests: z.array(z.string().min(1)),
  /** Members other than the declaring one whose *tests* construct it. */
  foreignTestMembers: z.array(z.string().regex(MEMBER_DIR)),
});
export type SymbolFacts = z.infer<typeof SymbolFactsSchema>;

export const MemberFactsSchema = z.object({
  /** Directory, e.g. `packages/deploy` or `apps/operate-web`. */
  pkg: z.string().regex(MEMBER_DIR),
  /** The name in its `package.json`, read rather than derived. */
  name: z.string().min(1),
  /** True when `package.json` declares a `bin`: a member that is run, not imported. */
  isEntrypoint: z.boolean(),
  /** True when it declares `main` or a `"."` export, i.e. anything can import it at all. */
  isImportable: z.boolean(),
  /** Scanned source files, so a member the walk never reached cannot read as unimported. */
  files: z.number().int().nonnegative(),
  /** Exported classes that are not diagnostic types. Empty means a declarative package. */
  driverClasses: z.array(z.string().regex(CLASS_SYMBOL)),
  /** Other workspace members declaring it in `dependencies` or `devDependencies`. */
  dependents: z.array(z.string().min(1)),
  /** Non-test files outside the member importing it by package name. */
  importedBy: z.array(z.string().min(1)),
  importedByTests: z.array(z.string().min(1)),
});
export type MemberFacts = z.infer<typeof MemberFactsSchema>;

export const ModuleFactsSchema = z.object({
  pkg: z.string().regex(MEMBER_DIR),
  /** Path inside the member, e.g. `src/replayer.ts`. */
  module: z.string().regex(MEMBER_PATH),
  /** Whether the file exists on disk. */
  present: z.boolean(),
  /** Exported class names, if any. A non-empty list means the symbol scan already covers it. */
  exportedClasses: z.array(z.string().regex(CLASS_SYMBOL)),
  /** Exported names of every kind, used to check that a declared entrypoint really is exported. */
  exportedNames: z.array(z.string().min(1)),
  /** Non-test files outside this module, and outside its member's barrel, naming the entrypoint. */
  entrypointUsedBy: z.array(z.string().min(1)),
  entrypointUsedByTests: z.array(z.string().min(1)),
});
export type ModuleFacts = z.infer<typeof ModuleFactsSchema>;

/* ------------------------------------------------------------ reachability */

export const SYMBOL_REACHABILITIES = [
  "reachable",
  /** Its own `extends` clause names an error type: constructed by whoever throws it. */
  "diagnostic_type",
  /** Constructed by tests in a member other than its own: it is public test surface, in use. */
  "test_surface",
  "test_only",
  "unconstructed",
] as const;
export type SymbolReachability = (typeof SYMBOL_REACHABILITIES)[number];

/** `extends Error`, `extends JobError`, `extends ns.PgError`. */
export function isErrorBase(extendsName: string | null): boolean {
  if (extendsName === null) return false;
  const head = extendsName.slice(extendsName.lastIndexOf(".") + 1);
  return head === "Error" || /Error$/.test(head);
}

/**
 * Reachable iff some non-test file constructs it; then the three ways of being callerless-but-fine
 * or callerless-and-not, in the order the facts allow.
 *
 * `reachable` is checked first because it is the only *fact* among the five; the rest are readings
 * of an absence. `diagnostic_type` precedes `test_surface` because an error type that happens to be
 * constructed by another package's test is still an error type. And `test_surface` is **refused to a
 * `-pg` member**: a Postgres package's classes are persistence, not test doubles, so a store
 * constructed only by some other package's test must not be excused by this bucket — which is the
 * one hole this classification opens, and it is closed where it would matter.
 */
export function classifySymbol(facts: SymbolFacts): SymbolReachability {
  if (facts.constructedBy.length > 0) return "reachable";
  if (isErrorBase(facts.extendsName)) return "diagnostic_type";
  if (facts.foreignTestMembers.length > 0 && !PG_MEMBER.test(facts.pkg)) return "test_surface";
  return facts.constructedByTests.length > 0 ? "test_only" : "unconstructed";
}

export const MEMBER_REACHABILITIES = [
  "reachable",
  /** Declares a `bin`: it is run rather than imported, so having no importer is its nature. */
  "entrypoint",
  /** Declares no `main` and no `"."` export, so nothing could import it: `packages/config`. */
  "not_importable",
  /**
   * No importer and no exported driver class — a declarative contracts package, which is a great
   * many of this workspace's 87. Derived, not declared, so the thirteen members in it cost no lines.
   */
  "contracts_only",
  "unimported",
  "test_only_importer",
  "declared_unused",
] as const;
export type MemberReachability = (typeof MEMBER_REACHABILITIES)[number];

/**
 * Reachable iff some non-test file outside the member imports it; then the ways of not being.
 *
 * Three buckets are exemptions and four are findings. The exemptions are read from `package.json`
 * and from the class scan rather than from a list of member names: `entrypoint` is a declared `bin`,
 * `not_importable` is the absence of `main` and of a `"."` export, and `contracts_only` is the
 * absence of any exported driver class. That last one is what keeps the thirteen contracts packages
 * out of the declaration list, and it is also this classification's own blind spot — see
 * `packages/deploy` in the module's header, where a complete function-shaped flag subsystem with the
 * workspace's only `evaluateFlag()` is excused as declarative because it exports no class.
 *
 * `unimported` is ADR-0335's `api-gateway-pg` exactly (nothing at all), `declared_unused` is the
 * half-finished wiring (somebody added the dependency and stopped), and `test_only_importer` is a
 * member another member only tests against.
 */
export function classifyMember(facts: MemberFacts): MemberReachability {
  if (facts.importedBy.length > 0) return "reachable";
  if (facts.isEntrypoint) return "entrypoint";
  if (!facts.isImportable) return "not_importable";
  if (facts.driverClasses.length === 0) return "contracts_only";
  if (facts.importedByTests.length > 0) return "test_only_importer";
  return facts.dependents.length > 0 ? "declared_unused" : "unimported";
}

/* ----------------------------------------------------------------- findings */

export const UNREACHABLE_FINDING_KINDS = [
  /** A class whose only construction sites are test files, with no declaration. **The fence.** */
  "symbol_test_only",
  /** A class nothing constructs anywhere, not even a test. */
  "symbol_unconstructed",
  /** A member no workspace member depends on and no file imports. **Signal 2's fence.** */
  "member_unimported",
  /** Imported only from test files. */
  "member_test_only_importer",
  /** A dependency declared and never imported — wiring begun and abandoned. */
  "member_declared_unused",
  /**
   * A module in a declared driver family that neither exports a tracked class nor carries a module
   * declaration. **Signal 5's fence**, and the cross-rule join between the two units.
   */
  "driver_module_unaccounted",
  /** Declared unreachable and now constructed, imported or called outside tests. */
  "overtaken",
  /** Declares a class no member exports. */
  "unknown_symbol",
  /** Declares a member directory this workspace does not have. */
  "unknown_package",
  /** A module declaration naming a file that is not on disk. */
  "unknown_module",
  /** A module declaration whose entrypoint that file does not export. */
  "unknown_entrypoint",
  /** A module declaration whose file now exports a class, so the symbol rule covers it instead. */
  "module_now_has_class",
  /** The same subject declared twice, which would let two contradictory reasons both pass. */
  "duplicate",
  /** `substitute_in_use` naming something that is not itself constructed outside tests. */
  "unsupported_substitute",
  /** `offline_implementation` naming something no test constructs either: dead, not offline. */
  "offline_implementation_unconstructed",
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
const SYMBOL_FINDING_FOR: Record<
  Exclude<SymbolReachability, "reachable" | "diagnostic_type" | "test_surface">,
  UnreachableFindingKind
> = {
  test_only: "symbol_test_only",
  unconstructed: "symbol_unconstructed",
};
const MEMBER_FINDING_FOR: Record<
  Exclude<MemberReachability, "reachable" | "entrypoint" | "not_importable" | "contracts_only">,
  UnreachableFindingKind
> = {
  unimported: "member_unimported",
  test_only_importer: "member_test_only_importer",
  declared_unused: "member_declared_unused",
};

export interface UnreachableFinding {
  readonly kind: UnreachableFindingKind;
  /** `pkg`, `pkg:Symbol` or `pkg::path`, matching `subjectOf`. */
  readonly subject: string;
  readonly detail: string;
}

export interface UnreachableAuditInput {
  readonly symbols: readonly SymbolFacts[];
  readonly members: readonly MemberFacts[];
  readonly modules: readonly ModuleFacts[];
  readonly declarations: readonly UnreachableDeclaration[];
  /** `meta.x` names from `META_TABLES`, so a declared table cannot be imaginary. */
  readonly catalogTables: readonly string[];
  /** `STORELESS_TABLES`' subjects, so the two rules cannot disagree in silence. */
  readonly storelessTables: readonly string[];
  /** Substitute symbols with at least one non-test construction site. */
  readonly reachableSubstitutes: readonly string[];
  /**
   * Every module in a declared driver family, so one of the two rules has to account for it. The
   * fence for a driver that is a set of functions and so has no `new` site to look for.
   */
  readonly driverFamilyModules: readonly ModuleFacts[];
}

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * Phrased from both sides on purpose: the fences read from the *facts* (something unreachable that
 * nothing declares) and `overtaken` / `unknown_*` / `module_now_has_class` read from the
 * *declarations* (a decision the workspace has moved past). A list that can only be wrong by going
 * red is not ADR-0288's `needsAuditEmitter`, which was wrong three times for want of exactly this.
 */
export function auditUnreachableStores(
  input: UnreachableAuditInput,
): readonly UnreachableFinding[] {
  const {
    symbols,
    members,
    modules,
    declarations,
    catalogTables,
    storelessTables,
    reachableSubstitutes,
    driverFamilyModules,
  } = input;

  const bySymbol = new Map<string, SymbolFacts>();
  const byName = new Map<string, SymbolFacts[]>();
  for (const facts of symbols) {
    bySymbol.set(`${facts.pkg}:${facts.symbol}`, facts);
    const same = byName.get(facts.symbol) ?? [];
    same.push(facts);
    byName.set(facts.symbol, same);
  }
  const byMember = new Map<string, MemberFacts>();
  for (const member of members) byMember.set(member.pkg, member);
  const byModule = new Map<string, ModuleFacts>();
  for (const module of modules) byModule.set(`${module.pkg}::${module.module}`, module);

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

    const member = byMember.get(declaration.pkg);
    if (member === undefined) {
      findings.push({
        kind: "unknown_package",
        subject,
        detail: `${subject} names the member '${declaration.pkg}', which this workspace does not have — a stale decision`,
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

    if (declaration.scope === "member") {
      if (classifyMember(member) === "reachable") {
        findings.push({
          kind: "overtaken",
          subject,
          detail: `${subject} is declared unreachable (${declaration.reason}) and ${String(member.importedBy.length)} non-test file(s) import it now — the decision is overtaken; remove the declaration`,
        });
      }
      continue;
    }

    if (declaration.scope === "module") {
      const facts = byModule.get(subject);
      if (facts === undefined || !facts.present) {
        findings.push({
          kind: "unknown_module",
          subject,
          detail: `${subject} is declared and that file is not on disk — renamed or removed`,
        });
        continue;
      }
      if (!facts.exportedNames.includes(declaration.entrypoint ?? "")) {
        findings.push({
          kind: "unknown_entrypoint",
          subject,
          detail: `${subject} declares the entrypoint ${declaration.entrypoint ?? ""}, which that module does not export — so the claim that nothing calls it is about a name that no longer exists`,
        });
      }
      if (facts.exportedClasses.length > 0) {
        findings.push({
          kind: "module_now_has_class",
          subject,
          detail: `${subject} exports the class(es) ${facts.exportedClasses.join(", ")} now, so the symbol rule covers this module — delete the module declaration and declare the class if it has no caller`,
        });
      }
      if (facts.entrypointUsedBy.length > 0) {
        findings.push({
          kind: "overtaken",
          subject,
          detail: `${subject} is declared unreachable (${declaration.reason}) and ${facts.entrypointUsedBy.join(", ")} name(s) ${declaration.entrypoint ?? ""} now — the decision is overtaken; remove the declaration`,
        });
      }
      continue;
    }

    const facts = bySymbol.get(subject);
    if (facts === undefined) {
      const elsewhere = (byName.get(declaration.symbol ?? "") ?? []).map((s) => s.pkg);
      findings.push({
        kind: "unknown_symbol",
        subject,
        detail:
          elsewhere.length > 0
            ? `${subject} is declared and ${declaration.symbol ?? ""} is exported by ${elsewhere.join(", ")} instead — the declaration names the wrong member`
            : `${subject} is declared and no member exports ${declaration.symbol ?? ""} — renamed or removed`,
      });
      continue;
    }
    const reachability = classifySymbol(facts);
    if (reachability === "reachable") {
      findings.push({
        kind: "overtaken",
        subject,
        detail: `${subject} is declared unreachable (${declaration.reason}) and ${facts.constructedBy.join(", ")} construct(s) it now — the decision is overtaken; remove the declaration`,
      });
    }
    if (
      TEST_CONSTRUCTED_REASONS.includes(declaration.reason) &&
      facts.constructedByTests.length === 0
    ) {
      findings.push({
        kind: "offline_implementation_unconstructed",
        subject,
        detail: `${subject} is declared an offline implementation and no test constructs it either — an injected seam nothing builds is dead rather than offline, so the reason is wrong`,
      });
    }
  }

  for (const facts of symbols) {
    const reachability = classifySymbol(facts);
    if (
      reachability === "reachable" ||
      reachability === "diagnostic_type" ||
      reachability === "test_surface"
    ) {
      continue;
    }
    const subject = `${facts.pkg}:${facts.symbol}`;
    if (seen.has(subject)) continue;
    findings.push({
      kind: SYMBOL_FINDING_FOR[reachability],
      subject,
      detail:
        reachability === "test_only"
          ? `${subject} (${facts.declaredIn}) is constructed only by ${facts.constructedByTests.join(", ")} — built, tested and never connected. A store's table reads as written to pg-storeless-tables.ts and holds no row. Wire it, or add an UNREACHABLE_STORES line with a reason.`
          : `${subject} (${facts.declaredIn}) is constructed nowhere at all, not even by a test`,
    });
  }

  for (const member of members) {
    const reachability = classifyMember(member);
    if (
      reachability === "reachable" ||
      reachability === "entrypoint" ||
      reachability === "not_importable" ||
      reachability === "contracts_only"
    ) {
      continue;
    }
    if (seen.has(member.pkg)) continue;
    findings.push({
      kind: MEMBER_FINDING_FOR[reachability],
      subject: member.pkg,
      detail:
        reachability === "unimported"
          ? `${member.name} has no dependent and no importer anywhere, and exports the driver class(es) ${member.driverClasses.join(", ")} — ADR-0335's api-gateway-pg shape, where four stores and a replayer were unreachable from the deployed binary`
          : reachability === "declared_unused"
            ? `${member.name} is declared a dependency of ${member.dependents.join(", ")} and imported by nothing — wiring begun and abandoned`
            : `${member.name} is imported only by ${member.importedByTests.join(", ")}`,
    });
  }

  for (const facts of driverFamilyModules) {
    if (facts.exportedClasses.length > 0) continue;
    const subject = `${facts.pkg}::${facts.module}`;
    if (seen.has(subject)) continue;
    findings.push({
      kind: "driver_module_unaccounted",
      subject,
      detail: `${subject} is in a declared driver family, exports no class, and carries no module declaration — so neither this rule's symbol scan (which looks for a 'new' site) nor pg-storeless-tables.ts can say whether anything runs it. Wire it, or add an UNREACHABLE_STORES line with scope 'module'.`,
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

/* ------------------------------------------- the second list, compared both ways */

/**
 * `packages/feature-flags-pg`' `CALLERLESS_FLAG_STORES` names the same things this file names, and
 * ADR-0336 shipped both without a comparison between them — which is ADR-0288's shape exactly, and
 * ADR-0334 established that *location* was never what made `needsAuditEmitter` wrong: the absence of
 * a both-ways comparison was.
 *
 * Read from disk **as text**, like `pg-record-retention.ts` reads the erasure's protected set, for
 * the reason that keeps all five rules unconditional: `packages/testing` has no workspace
 * dependencies, so importing `@crossengin/feature-flags-pg` would make the graph cyclic and reading
 * its `dist` would make the answer depend on whether someone ran `pnpm -r build`.
 *
 * Three facts are compared, not two, because comparing the two lists alone would pass while both
 * were stale together: each list is compared against **the scan**, and then against each other.
 */
export const FLAG_LIST_FINDING_KINDS = [
  /** Named callerless over there and constructed outside tests here: that list is stale. */
  "flag_list_overtaken",
  /** Callerless by the scan and absent from that list: that list has a gap. */
  "flag_list_incomplete",
  /** Named over there and not declared here, or the reverse: the two lists disagree. */
  "flag_lists_disagree",
  /** Named over there and no member exports it. */
  "flag_list_unknown_symbol",
] as const;
export type FlagListFindingKind = (typeof FLAG_LIST_FINDING_KINDS)[number];

export interface FlagListFinding {
  readonly kind: FlagListFindingKind;
  readonly symbol: string;
  readonly detail: string;
}

export const FLAG_SURVEY_PATH = join(
  "packages",
  "feature-flags-pg",
  "src",
  "subsystem-survey.ts",
);
export const FLAG_MEMBER = "packages/feature-flags-pg";

/**
 * The symbols `CALLERLESS_FLAG_STORES` names, read out of that one declaration.
 *
 * Bounded to the `Object.freeze([...])` that follows the name rather than scanning the file, for
 * `readProtectedTables`' reason: `EXPORTED_STORE_SYMBOLS` sits a few lines below and names all
 * three of the package's stores including the reachable one, so a loose scan would pick up
 * `PostgresKillSwitchStore` from the wrong declaration and invert the comparison. It **refuses
 * rather than guessing** if the shape stops holding, because a parse whose failure mode is "found
 * nothing" would make this comparison vacuous in exactly the case it exists for.
 */
export function readCallerlessFlagStores(root: string = REPO_ROOT): readonly string[] {
  const src = readFileSync(join(root, FLAG_SURVEY_PATH), "utf8");
  const start = src.indexOf("export const CALLERLESS_FLAG_STORES");
  if (start < 0) {
    throw new Error(`CALLERLESS_FLAG_STORES not found in ${FLAG_SURVEY_PATH}`);
  }
  const open = src.indexOf("Object.freeze([", start);
  if (open < 0) {
    throw new Error(`CALLERLESS_FLAG_STORES is not an Object.freeze([...]) literal`);
  }
  const close = src.indexOf("\n]);", open);
  if (close < 0) throw new Error(`CALLERLESS_FLAG_STORES' array literal is unterminated`);
  const body = src.slice(open, close);
  const symbols = [...body.matchAll(/\bsymbol:\s*"([A-Z][A-Za-z0-9_]*)"/g)].map((m) => m[1] ?? "");
  if (symbols.length === 0) {
    throw new Error(`CALLERLESS_FLAG_STORES parsed to no symbols; the parse no longer matches`);
  }
  return symbols;
}

export interface FlagListAuditInput {
  /** What that list names. */
  readonly listed: readonly string[];
  /** This scan's facts for `packages/feature-flags-pg` only. */
  readonly symbols: readonly SymbolFacts[];
  /** This file's declarations, so the two lists are compared directly as well. */
  readonly declarations: readonly UnreachableDeclaration[];
}

/** Both directions against the facts, then both directions against each other. */
export function auditCallerlessFlagLists(
  input: FlagListAuditInput,
): readonly FlagListFinding[] {
  const { listed, symbols, declarations } = input;
  const facts = new Map(symbols.map((s) => [s.symbol, s]));
  const callerless = new Set(
    symbols.filter((s) => classifySymbol(s) !== "reachable").map((s) => s.symbol),
  );
  const declaredHere = new Set(
    declarations
      .filter((d) => d.pkg === FLAG_MEMBER && d.scope === "symbol" && d.symbol !== undefined)
      .map((d) => d.symbol ?? ""),
  );
  const there = new Set(listed);
  const findings: FlagListFinding[] = [];

  for (const symbol of [...there].sort()) {
    const fact = facts.get(symbol);
    if (fact === undefined) {
      findings.push({
        kind: "flag_list_unknown_symbol",
        symbol,
        detail: `CALLERLESS_FLAG_STORES names ${symbol}, which ${FLAG_MEMBER} does not export — renamed or removed`,
      });
      continue;
    }
    if (classifySymbol(fact) === "reachable") {
      findings.push({
        kind: "flag_list_overtaken",
        symbol,
        detail: `CALLERLESS_FLAG_STORES calls ${symbol} callerless and ${fact.constructedBy.join(", ")} construct(s) it now — remove it there`,
      });
      // One defect, one finding: a reachable symbol is *supposed* to be absent from this file's
      // declarations, so reporting the absence as a disagreement too would name the same fix twice
      // and point the second one the wrong way.
      continue;
    }
    if (!declaredHere.has(symbol)) {
      findings.push({
        kind: "flag_lists_disagree",
        symbol,
        detail: `${symbol} is named callerless in ${FLAG_SURVEY_PATH} and is not declared in UNREACHABLE_STORES — the two lists disagree`,
      });
    }
  }
  for (const symbol of [...callerless].sort()) {
    if (there.has(symbol)) continue;
    findings.push({
      kind: "flag_list_incomplete",
      symbol,
      detail: `${symbol} is callerless by this scan and CALLERLESS_FLAG_STORES does not name it — add it there, or wire it`,
    });
  }
  for (const symbol of [...declaredHere].sort()) {
    if (there.has(symbol)) continue;
    findings.push({
      kind: "flag_lists_disagree",
      symbol,
      detail: `${symbol} is declared in UNREACHABLE_STORES and ${FLAG_SURVEY_PATH} does not name it — the two lists disagree`,
    });
  }
  return findings;
}

/* -------------------------------------------------------- reading the source */

/**
 * String contents blanked, quotes and positions kept. Expects comment-stripped text.
 *
 * Why both passes are needed, in order. Comments: a commented-out `new PostgresFoo(` must not count
 * as a caller, and this repo comments heavily — `meta-schema.ts` alone is 11.6k lines of which much
 * is prose. Strings: the declarations below quote these symbol names, and a note that happened to
 * contain `new PostgresTargetingRuleStore(` would make this file argue itself reachable. That is not
 * hypothetical — it happened to an ad-hoc scan of this very module during the increment that widened
 * it, which read the doc comment above and reported the store as constructed.
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

export interface ExportedClass {
  readonly name: string;
  /** The `extends` clause's head identifier, or null. */
  readonly extendsName: string | null;
}

/**
 * Every `export class X` in one module's text, with its `extends` clause.
 *
 * The clause is read because it is what makes the `diagnostic_type` exemption mechanical: a class
 * extending an error type is constructed by whoever throws it, which is any consumer, so a
 * `new`-site census says nothing about it. Reading the clause rather than matching `/Error$/` on the
 * class's *own* name is the difference between a rule and a naming convention — `PermanentError`
 * would match either way, but a `Refusal extends Error` matches only the clause.
 */
export function exportedClasses(code: string): readonly ExportedClass[] {
  return [
    ...code.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)([^{]*)\{/g),
  ].map((m) => {
    const head = m[2] ?? "";
    const base = /\bextends\s+([A-Za-z_$][A-Za-z0-9_$.]*)/.exec(head);
    return { name: m[1] ?? "", extendsName: base === null ? null : (base[1] ?? null) };
  });
}

/** Every exported name of any kind, used to check a declared module entrypoint really exists. */
export function exportedNames(code: string): readonly string[] {
  const out = new Set<string>();
  const declared =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const m of code.matchAll(declared)) out.add(m[1] ?? "");
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
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

/** Which of `names` this text mentions as a bare word. Used for a function-shaped entrypoint. */
export function findIdentifierUses(code: string, names: ReadonlySet<string>): readonly string[] {
  if (names.size === 0) return [];
  const out = new Set<string>();
  for (const word of code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    if (names.has(word)) out.add(word);
  }
  return [...out];
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
 *    a construction site is a test. Reusing it would answer "no site at all" for every member of
 *    the class.
 *  - It walks `<member>/src` only, and `apps/operate-web` has **no `src/`** — its code is in
 *    `app/`, `components/` and `lib/`. ADR-0336 declared that as the reason `apps/*` was out of
 *    scope; the walk here is per *member* so those files are read, and the test asserts a floor on
 *    them specifically so the hole cannot reopen silently.
 *
 * Changing the shared walk to suit this rule would change the input of the two SQL rules that depend
 * on it, so what is shared is what can be: `REPO_ROOT` and `workspaceRoots()` (where the workspace
 * is, read from `pnpm-workspace.yaml`) and `stripComments` (how to ignore prose).
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", ".turbo", ".git"]);

/**
 * Module basenames that are drivers by convention, whose members must be accounted for by one of
 * the two rules — the fence for a driver that is a set of functions.
 *
 * **One entry, deliberately, and the limit is the point.** The general predicate ("an exported
 * symbol nothing outside its module uses") measures at 82 unactionable findings with a
 * colliding-name false-negative mode, so it cannot fence; a family whose convention is real and
 * whose membership is asserted can. Six packages ship a `src/replayer.ts`, five export a class and
 * one does not, which is how the fifth blind spot was found. A driver family that is not in this set
 * is **not fenced**, and adding one is a visible line in a diff — `typecheck-config.ts`' shape for
 * its two exemptions.
 */
export const DRIVER_MODULE_FAMILIES: readonly string[] = Object.freeze(["replayer.ts"]);

export interface WorkspaceMember {
  /** `packages/foo` or `apps/bar`. */
  readonly dir: string;
  readonly name: string;
}

export interface WorkspaceStoreScan {
  readonly files: number;
  readonly filesByMember: ReadonlyMap<string, number>;
  readonly members: readonly WorkspaceMember[];
  readonly memberFacts: readonly MemberFacts[];
  readonly symbols: readonly SymbolFacts[];
  readonly modules: readonly ModuleFacts[];
  readonly driverFamilyModules: readonly ModuleFacts[];
  readonly reachableSubstitutes: readonly string[];
  readonly dynamic: readonly DynamicConstruction[];
  readonly unhandledGlobs: readonly string[];
  /**
   * Class names exported by more than one member. Reported rather than asserted away: construction
   * sites are attributed by name, so a colliding name's copies all share one verdict. Conservative —
   * a shared site makes every copy read reachable — and visible, which is the half that matters.
   */
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

interface Manifest {
  readonly name: string | null;
  readonly isEntrypoint: boolean;
  readonly isImportable: boolean;
  readonly dependencies: ReadonlySet<string>;
}

/**
 * One parse per `package.json`, answering all three questions it is asked.
 *
 * `isEntrypoint` and `isImportable` are the two exemptions `classifyMember` applies, and both are
 * read here rather than inferred from a member's name: a `bin` field is the deployment's own
 * statement that this member is run, and the absence of `main` and of a `"."` export means nothing
 * *could* import it — `packages/config` publishes only JSON subpaths, and `apps/operate-web`
 * publishes nothing at all.
 */
function readManifest(dir: string): Manifest | null {
  const path = join(REPO_ROOT, dir, "package.json");
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : null;
  const exports = record["exports"];
  const hasDotExport =
    typeof exports === "object" && exports !== null && Object.hasOwn(exports, ".");
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const block = record[field];
    if (typeof block !== "object" || block === null) continue;
    for (const key of Object.keys(block)) dependencies.add(key);
  }
  return {
    name,
    isEntrypoint: record["bin"] !== undefined,
    isImportable: typeof record["main"] === "string" || hasDotExport,
    dependencies,
  };
}

export function scanWorkspaceStores(
  substituteNames: readonly string[] = UNREACHABLE_STORES.flatMap((d) =>
    d.substitutedBy === undefined ? [] : [d.substitutedBy],
  ),
  declaredModules: readonly UnreachableDeclaration[] = UNREACHABLE_STORES.filter(
    (d) => d.scope === "module",
  ),
): WorkspaceStoreScan {
  const { roots, unhandledGlobs } = workspaceRoots();

  const members: WorkspaceMember[] = [];
  const manifests = new Map<string, Manifest>();
  for (const root of roots) {
    for (const entry of readdirSync(join(REPO_ROOT, root))) {
      if (SKIP_DIRS.has(entry)) continue;
      const dir = `${root}/${entry}`;
      if (!statSync(join(REPO_ROOT, dir)).isDirectory()) continue;
      const manifest = readManifest(dir);
      if (manifest === null || manifest.name === null) continue;
      members.push({ dir, name: manifest.name });
      manifests.set(dir, manifest);
    }
  }

  // Every class in every member, keyed by (member, symbol). Keying by symbol alone would lose a copy
  // silently, and eight members each declare `FixedClock` — the shape of defect these rules exist to
  // end, one level down.
  const declarations = new Map<string, { member: string; file: string; extendsName: string | null }>();
  const copiesOf = new Map<string, string[]>();
  const memberFileLists = new Map<string, string[]>();
  for (const member of members) {
    const absolute: string[] = [];
    filesUnder(join(REPO_ROOT, member.dir), absolute);
    memberFileLists.set(member.dir, absolute);
    for (const file of absolute) {
      const relative = file.slice(REPO_ROOT.length + 1);
      if (isTestSite(relative)) continue;
      for (const found of exportedClasses(codeOnly(readFileSync(file, "utf8")))) {
        declarations.set(`${member.dir}:${found.name}`, {
          member: member.dir,
          file: relative,
          extendsName: found.extendsName,
        });
        const copies = copiesOf.get(found.name) ?? [];
        if (!copies.includes(member.dir)) copies.push(member.dir);
        copiesOf.set(found.name, copies);
      }
    }
  }

  const tracked = new Set<string>([...copiesOf.keys(), ...substituteNames]);
  const entrypoints = new Set<string>(
    declaredModules.flatMap((d) => (d.entrypoint === undefined ? [] : [d.entrypoint])),
  );
  // A module defines its own entrypoint, so its own text names it: without this the question
  // "does anything call it" answers yes for every function-shaped driver, which is the whole class.
  const entrypointOwner = new Map<string, string>(
    declaredModules.flatMap((d) =>
      d.entrypoint === undefined ? [] : [[d.entrypoint, `${d.pkg}::${d.module ?? ""}`] as const],
    ),
  );
  const declaredModuleKeys = new Set(declaredModules.map((d) => `${d.pkg}::${d.module ?? ""}`));
  const familyModuleKeys = new Set<string>();

  const sites = new Map<string, { prod: string[]; tests: string[] }>();
  const imports = new Map<string, { prod: string[]; tests: string[] }>();
  const uses = new Map<string, { prod: string[]; tests: string[] }>();
  const dynamic: DynamicConstruction[] = [];
  const memberByName = new Map(members.map((m) => [m.name, m.dir]));
  const filesByMember = new Map<string, number>();
  const moduleTexts = new Map<string, string>();

  let files = 0;
  for (const member of members) {
    const absolute = memberFileLists.get(member.dir) ?? [];
    filesByMember.set(member.dir, absolute.length);
    for (const file of absolute) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const inMember = relative.slice(member.dir.length + 1);
      // Two passes over one read, because the two questions want different text: a construction must
      // not be found inside a string, and an import specifier *is* a string.
      const stripped = stripComments(readFileSync(file, "utf8"));
      const code = blankStringLiterals(stripped);
      files += 1;
      const test = isTestSite(relative);

      if (!test) {
        const base = inMember.slice(inMember.lastIndexOf("/") + 1);
        if (DRIVER_MODULE_FAMILIES.includes(base)) {
          familyModuleKeys.add(`${member.dir}::${inMember}`);
        }
        if (declaredModuleKeys.has(`${member.dir}::${inMember}`)) {
          moduleTexts.set(`${member.dir}::${inMember}`, code);
        }
        if (familyModuleKeys.has(`${member.dir}::${inMember}`)) {
          moduleTexts.set(`${member.dir}::${inMember}`, code);
        }
      }

      const found = findConstructions(code, tracked);
      for (const symbol of found.constructs) {
        const entry = sites.get(symbol) ?? { prod: [], tests: [] };
        (test ? entry.tests : entry.prod).push(relative);
        sites.set(symbol, entry);
      }
      for (const d of found.dynamic) {
        dynamic.push({ file: relative, line: d.line, snippet: d.snippet });
      }

      // A barrel re-export is not a caller, so a member's own `index.ts` is excluded from the
      // entrypoint question — otherwise `export * from "./replayer.js"` would answer it.
      const isOwnBarrel = inMember === "src/index.ts" || inMember === "index.ts";
      const fileKey = `${member.dir}::${inMember}`;
      if (!isOwnBarrel) {
        for (const name of findIdentifierUses(code, entrypoints)) {
          if (entrypointOwner.get(name) === fileKey) continue;
          const entry = uses.get(name) ?? { prod: [], tests: [] };
          (test ? entry.tests : entry.prod).push(relative);
          uses.set(name, entry);
        }
      }

      for (const specifier of importedSpecifiers(stripped)) {
        const root = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier;
        const dir = memberByName.get(root);
        if (dir === undefined || dir === member.dir) continue;
        const entry = imports.get(dir) ?? { prod: [], tests: [] };
        (test ? entry.tests : entry.prod).push(relative);
        imports.set(dir, entry);
      }
    }
  }

  const symbols: SymbolFacts[] = [];
  for (const [key, where] of [...declarations].sort(([a], [b]) => a.localeCompare(b))) {
    const symbol = key.slice(where.member.length + 1);
    const site = sites.get(symbol) ?? { prod: [], tests: [] };
    const owners = copiesOf.get(symbol) ?? [where.member];
    const foreign = [
      ...new Set(
        site.tests
          .map((f) => f.split("/").slice(0, 2).join("/"))
          .filter((m) => !owners.includes(m)),
      ),
    ].sort();
    symbols.push(
      SymbolFactsSchema.parse({
        symbol,
        pkg: where.member,
        declaredIn: where.file,
        extendsName: where.extendsName,
        alsoDeclaredBy: owners.filter((m) => m !== where.member).sort(),
        constructedBy: site.prod.slice().sort(),
        constructedByTests: site.tests.slice().sort(),
        foreignTestMembers: foreign,
      }),
    );
  }

  const classesByMember = new Map<string, string[]>();
  for (const facts of symbols) {
    if (isErrorBase(facts.extendsName)) continue;
    const list = classesByMember.get(facts.pkg) ?? [];
    list.push(facts.symbol);
    classesByMember.set(facts.pkg, list);
  }

  const memberFacts: MemberFacts[] = [];
  for (const member of members) {
    const manifest = manifests.get(member.dir);
    const dependents = members
      .filter(
        (m) => m.dir !== member.dir && (manifests.get(m.dir)?.dependencies.has(member.name) ?? false),
      )
      .map((m) => m.dir)
      .sort();
    const imported = imports.get(member.dir) ?? { prod: [], tests: [] };
    memberFacts.push(
      MemberFactsSchema.parse({
        pkg: member.dir,
        name: member.name,
        isEntrypoint: manifest?.isEntrypoint ?? false,
        isImportable: manifest?.isImportable ?? false,
        files: filesByMember.get(member.dir) ?? 0,
        driverClasses: (classesByMember.get(member.dir) ?? []).slice().sort(),
        dependents,
        importedBy: imported.prod.slice().sort(),
        importedByTests: imported.tests.slice().sort(),
      }),
    );
  }

  const moduleFactsFor = (key: string, declaredEntrypoint: string | null): ModuleFacts => {
    const split = key.indexOf("::");
    const pkg = key.slice(0, split);
    const module = key.slice(split + 2);
    const code = moduleTexts.get(key);
    const use = declaredEntrypoint === null ? undefined : uses.get(declaredEntrypoint);
    return ModuleFactsSchema.parse({
      pkg,
      module,
      present: code !== undefined,
      exportedClasses: code === undefined ? [] : exportedClasses(code).map((c) => c.name),
      exportedNames: code === undefined ? [] : exportedNames(code),
      entrypointUsedBy: (use?.prod ?? []).slice().sort(),
      entrypointUsedByTests: (use?.tests ?? []).slice().sort(),
    });
  };

  const modules = declaredModules.map((d) =>
    moduleFactsFor(`${d.pkg}::${d.module ?? ""}`, d.entrypoint ?? null),
  );
  const driverFamilyModules = [...familyModuleKeys]
    .sort()
    .map((key) => moduleFactsFor(key, null));

  const reachableSubstitutes = substituteNames.filter(
    (name) => (sites.get(name)?.prod.length ?? 0) > 0,
  );

  return {
    files,
    filesByMember,
    members,
    memberFacts,
    symbols,
    modules,
    driverFamilyModules,
    reachableSubstitutes: [...new Set(reachableSubstitutes)],
    dynamic,
    unhandledGlobs,
    collidingSymbols: [...copiesOf]
      .filter(([, owners]) => owners.length > 1)
      .map(([symbol, owners]) => `${symbol}: ${owners.join(", ")}`)
      .sort(),
  };
}

/* ------------------------------------------------------ the declaration */

/**
 * Every unreachable exported component, with the reason it has no caller.
 *
 * **This list is expected to shrink, and it shrank while being written — twice.** ADR-0336 seeded it
 * with eight; `PostgresIdempotencyStore` and `PostgresPipelineExecutionStore` were wired into
 * `apps/operate-server/src/node.ts` before that rule landed, and the rule reported both as
 * `overtaken` rather than passing. The widened version was seeded with twenty-one, and
 * `UnroutableChannelSender` was **deleted** from `apps/operate-server` while this file was being
 * written. A member that gains a caller has its line deleted; a declaration the workspace has moved
 * past is a test failure, not a stale comment.
 *
 * Ordered by member, because the clusters are the finding. Three of the six drift replayers are the
 * same decision taken five times — a verification pass with no subcommand to invoke it — and three
 * stores are `incident-response-runtime-pg`, which is one ADR's worth (ADR-0296) that never grew a
 * surface.
 */
export const UNREACHABLE_STORES: readonly UnreachableDeclaration[] = Object.freeze([
  /* ------------------------------------------------------------- apps (0) */
  // `apps/operate-server`'s `UnroutableChannelSender` was the first `apps/*` member of this class,
  // found the day the predicate widened to include apps at all, and it was deleted rather than
  // declared: `drainOnce` already asks the registry whether a channel has a sender, so the class was
  // a second answer to a question something else answered. The empty section is kept as the record
  // that `apps/*` is in scope — ADR-0336 declared it out — so a future member lands here rather than
  // in a rule that does not look.

  /* ------------------------------------------------- access-reviews-runtime (0) */
  // `CampaignScheduler` was declared here as `substitute_in_use` and is gone: the app declares its
  // own `AccessReviewCampaignScheduler` in `access-reviews-lifecycle.ts` and constructs it, so there
  // were two interval drivers over one runtime and the package's was the dead one. Deleted rather
  // than declared, which is the outcome this rule is for — and the second one in a day, after
  // `apps/operate-server`'s `UnroutableChannelSender`. A callerless class is a question, not a
  // verdict: often the answer is that it should not exist.

  /* ---------------------------------------------- access-reviews-runtime-pg (1) */
  {
    scope: "symbol",
    pkg: "packages/access-reviews-runtime-pg",
    symbol: "AccessReviewReplayer",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a verification surface to invoke a replayer from: there is no `replay` or `verify` subcommand on either binary and no scheduler calls one, so all six of this workspace's drift replayers are in the same position. The narrowest honest shape is a `crossengin-pg verify` subcommand taking a scope and printing the report each replayer already formats; a route would need `--audit-read-routes`' apparatus, since a drift report names other tenants' rows. Ordering, not shape.",
    tables: [],
    consequence:
      "A campaign, item or decision row edited into a state the contract forbids but a CHECK constraint permits is never detected — the re-parse-on-read that `verifyCampaignRowShape` performs is the only detector for it, and nothing performs it.",
    note: "CLAUDE.md advertises this package as `persists campaigns/items/decisions, wraps the runtime, and ships a replayer`. The replayer ships and is constructed only by `replayer.test.ts`.",
  },

  /* --------------------------------------------------------- api-gateway-pg (2) */
  {
    scope: "symbol",
    pkg: "packages/api-gateway-pg",
    symbol: "GatewayReplayer",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the same verification surface the other five replayers want, and here the ordering argument is ADR-0336's own open end: `--gateway-execution-capture` gave this reader rows to read in the same increment that declared it had no caller, which is ADR-0335's shape in a new place — a store with a writer and a reader with nothing calling it. The rows are the product (a queryable forensic record of request handling) rather than inert, which is the difference argued; it is not decisive.",
    tables: [],
    consequence:
      "`meta.gateway_pipeline_executions` accumulates sampled executions that nothing ever reads, so `pass_with_4xx_or_5xx`, `deny_without_4xx_or_5xx`, the out-of-order stage check and the orphaned rate-limit decision check are all unreachable — and ADR-0335 made `meta.rate_limit_decisions` writable, so the orphan check now has one half of its join and not the other.",
    note: "Named as an open end in ADR-0336 and reported by no rule at the time, because the symbol predicate was `Postgres*`. It is the clearest single justification for widening it.",
  },
  {
    scope: "symbol",
    pkg: "packages/api-gateway-pg",
    symbol: "PostgresRouteRegistry",
    reason: "substitute_in_use",
    substitutedBy: "InMemoryRouteRegistry",
    tables: ["meta.gateway_routes"],
    consequence:
      "`meta.gateway_routes` is empty: `compileOperateServer` derives routes from the manifest into an `InMemoryRouteRegistry` at boot, so the stored row's version negotiation, sunset date and `rate_limit_policy_id` have no reader — the policy id a decision row carries comes from `--rate-limit-policy` on argv instead.",
    note: "The last of this package's four stores. ADR-0335 wired `PostgresRateLimitChecker` and ADR-0336 wired `PostgresIdempotencyStore` and `PostgresPipelineExecutionStore`; this one stays, because a per-row registry is a different *model* from compiling the manifest rather than merely an unwired one — it would let a route exist that no manifest declares. The TTL cache here is the evidence it was written for a world where rows change under a running server.",
  },

  /* ----------------------------------------------------------------- crypto (1) */
  {
    scope: "symbol",
    pkg: "packages/crypto",
    symbol: "InMemoryAuditSink",
    reason: "offline_implementation",
    tables: [],
    consequence:
      "Nothing is lost by this class having no caller. What its absence of a *production* counterpart costs is separate and real: `auditKeyManagement`'s findings have no durable sink in any deployment, because no `CryptoAuditSink` implementation outside this one exists anywhere in the workspace.",
    note: "The in-memory implementation of the `CryptoAuditSink` seam, constructed by three of its own tests and offered to a caller that injects it. Declared rather than excused by the `test_surface` bucket because no *other* member's tests construct it, so this rule cannot tell it from a dead driver without the declaration — which is the honest state: it is an offline implementation of a seam with no live implementation beside it.",
  },

  /* ------------------------------------------------------------ dr-runtime-pg (1) */
  {
    scope: "symbol",
    pkg: "packages/dr-runtime-pg",
    symbol: "DrReplayer",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the verification surface the other five replayers want. This one is the sharpest argument for building it: ADR-0333 found that the failover and drill stores dropped every state transition, scored a deployment breaching both its RPO and RTO as `ready: true`, and gave this replayer the `projection_disagrees_with_record` issue kind that makes the divergence visible — so the detector for ADR-0333's defect was fixed in the increment that found it and has still never run. Ordering, not shape.",
    tables: [],
    consequence:
      "A failover or drill row whose `record` JSONB disagrees with its projected columns is never reported, which is exactly the state ADR-0333's `DO NOTHING` upserts left behind in any deployment that ran them.",
    note: "Bug-fixed by ADR-0333 (`projection_disagrees_with_record` added) while nothing constructed it; constructed only by `replayer.test.ts`.",
  },

  /* ------------------------------------------------------ feature-flags-pg (2) */
  {
    scope: "symbol",
    pkg: "packages/feature-flags-pg",
    symbol: "PostgresFeatureFlagStore",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "an evaluator, and only then an authoring surface — in that order, which is the correction that matters. Nothing in the contract blocks the store (it round-trips every one of the seven flag kinds) and an authoring route would be config-grade, wanting --notification-template-routes' four-eyes apparatus (ADR-0313) exactly as the targeting-rule store does. But a route alone would store flags nothing reads: NOTHING IN THE WORKSPACE EVALUATES A FEATURE FLAG. Every ingredient is modelled and none composed (isFlagActive, isFlagInEnvironment, parseDefaultValue, findActiveKillSwitch, chooseTargetingRule, computeStableBucket), no function takes a flag plus a context and returns a value, and each of the 17 EVALUATION_REASONS appears only in evaluations.ts, its own test, and the CHECK on meta.feature_flag_evaluations.reason — zero producers, which FLAG_EVALUATION_REASON_PRODUCERS states as a total map. There is no source either: a flag has no manifest field, no CLI flag, no env var and no route, so a flag here is neither a stored record nor a boot declaration but a modelled domain with no mechanism. Building the route first is therefore the one ordering that cannot work.",
    tables: ["meta.feature_flags"],
    consequence:
      "No flag can be authored by any deployment, so `meta.feature_flags` is empty everywhere — which is exactly why ADR-0296's kill-switch `flag_id` foreign key is `addable but not added` (ADR-0291 will not add a key it cannot prove every row satisfies), and why `PostgresKillSwitchStore`, which *is* reachable through `observability-runtime-pg`, writes a `flag_id` that resolves to nothing.",
    note: "ADR-0300 built this store after finding the table had drifted 18 columns and 3 flag kinds behind its contract. It closed the drift and added no caller, so the table is still the ADR-0300 class with a store in front of it. `packages/deploy` holds the workspace's only `evaluateFlag()` and has no importer; which of the two flag subsystems is real is a product decision, not a wiring step.",
  },
  {
    scope: "symbol",
    pkg: "packages/feature-flags-pg",
    symbol: "PostgresTargetingRuleStore",
    reason: "no_caller_by_design",
    decidedIn: "ADR-0335",
    tables: ["meta.feature_flag_targeting_rules"],
    consequence:
      "A flag's targeting rules can be read back and written by nothing, so `chooseTargetingRule` evaluates an empty rule set in every deployment and the ten targeting rule kinds with their FNV-1a sticky bucketing are unreachable from a database.",
    note: "**The store this rule exists for.** ADR-0335 shipped no authoring route deliberately and the reasoning is sound — a rule changes what the deployment serves, so it is at least config-grade and would need `--notification-template-routes`' four-eyes apparatus (ADR-0313) — but the table left `pg-storeless-tables.ts`' census when this store landed, so the fence read greener for a place that went from watched to unwatched. The decision survives the rule naming it; that is the point.",
  },

  /* ------------------------------------------ incident-response-runtime-pg (4) */
  {
    scope: "module",
    pkg: "packages/incident-response-runtime-pg",
    module: "src/replayer.ts",
    entrypoint: "replayIncidents",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the verification surface the five class-shaped replayers want. It is declared separately because of *how* it was missed rather than why it is unwired: this module exports `replayIncidents` and `formatIncidentReplayReport` and **no class at all**, so a rule whose unit is `new X(` has no site to look for and is structurally blind to it. Ordering, not shape — the subcommand that invokes the other five invokes this one.",
    tables: ["meta.incidents"],
    consequence:
      "An incident row edited into a state `IncidentRecordSchema` forbids but the table's CHECK constraints permit is never detected. CLAUDE.md names this module's re-parse as `the only way to catch` that (ADR-0289), so the sole detector for a tamper class has never run.",
    note: "**The fifth blind spot's named live member.** The only non-test reference to `formatIncidentReplayReport` anywhere is `dist/replayer.d.ts`, which is build output rather than a caller. `module` scope exists for this declaration and is checked four ways — the file must be on disk, it must export the named entrypoint, it must still export no class, and nothing outside it may name the entrypoint — so if a class is added here the declaration fails with `module_now_has_class` and the symbol rule takes over.",
  },
  {
    scope: "symbol",
    pkg: "packages/incident-response-runtime-pg",
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
    scope: "symbol",
    pkg: "packages/incident-response-runtime-pg",
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
    scope: "symbol",
    pkg: "packages/incident-response-runtime-pg",
    symbol: "PostgresCustomerCommsStore",
    reason: "contract_cannot_carry_the_surface",
    blockedBy:
      "a tenant-scoped read path that the table's shape cannot currently provide. `meta.incident_communications` is platform-wide — no `tenant_id`, no RLS, like the incident it describes — while `affected_tenants` is one of the audiences, so the surface a tenant would actually read cannot be served from this row at all. The store's own comment names it: `nothing tenant-facing is wired to this store even though affected_tenants is one of the audiences`. Wiring it would persist communications no tenant can be shown, which is why this one is not merely next in a queue.",
    tables: ["meta.incident_communications"],
    consequence:
      "Customer communications are not stored, so the GDPR 72h breach-notification deadline the contract enforces is never recorded against a published notice and a deployment cannot show what it told whom, when, or that it retracted anything.",
    note: "ADR-0296's third store. Its own comment names the missing half: platform-wide with no tenant-scoped read path, `which is also why nothing tenant-facing is wired to this store even though affected_tenants is one of the audiences`.",
  },

  /* --------------------------------------------------------------- kernel-pg (1) */
  {
    scope: "symbol",
    pkg: "packages/kernel-pg",
    symbol: "KeyRotationMigrator",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a key-rotation surface on either binary. `planColumnKeyRotation` and `reencryptColumnSql` are pure and reachable through the package's exports, and this class is the thing that would *execute* a plan against a live cluster — so what is missing is a `crossengin-pg rotate-keys` subcommand taking a key handle and a plan, plus the operator confirmation a re-encrypting UPDATE over a populated PHI column needs. Ordering, not shape.",
    tables: [],
    consequence:
      "A pgcrypto key rotation is planned and never executed: `crypto-pg`'s registry can mark a key rotated while every encrypted column still holds ciphertext under the old key, so the registry's claim and the data disagree and nothing in the workspace closes the gap.",
    note: "`encryption-writepath.ts` ships the planner, the SQL emitter, the formatter and this executor; the first three are exercised through `kernel-pg`'s CLI and the executor is constructed only by its own test.",
  },

  /* --------------------------------------------------------- observability-runtime (2) */
  {
    scope: "symbol",
    pkg: "packages/observability-runtime",
    symbol: "TraceCollector",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a span emitter on the request path. The collector stitches gateway, workflow and notification spans into a tree from `RecordedSpan`s, and nothing in the workspace *produces* a `RecordedSpan`: `api-gateway-runtime` records a `PipelineExecution` per request and no span, and there is no OTel exporter, no trace-context propagation beyond `sdk-clients`' contract and no sink. So this is the flag subsystem's shape one domain over — a modelled domain whose producer does not exist — and the collector is the half that was built. Ordering, not shape: the contract is fine.",
    tables: [],
    consequence:
      "No deployment can answer which workflow a request started or which notification a workflow sent, because no trace is ever assembled; `childContext` and the span tree are unreachable from anything that runs.",
    note: "CLAUDE.md advertises it as `a TraceCollector that stitches gateway → workflow → notification spans into a tree`. Constructed only by `tracing.test.ts`.",
  },
  {
    scope: "symbol",
    pkg: "packages/observability-runtime",
    symbol: "SyntheticTracker",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a synthetic prober. `evaluateSynthetic` and `consecutiveFailures` are pure and the tracker holds the rolling window, but nothing *runs* a `SyntheticCheck`: there is no HTTP prober, no scheduler tick for one, and `--slo-config` wires only the availability and latency engines. So the consecutive-failure detector has no results to detect from. Ordering, not shape.",
    tables: [],
    consequence:
      "Declared synthetic checks are never executed, so a surface that is down for every real user while serving no requests — the one failure an availability SLO over observed traffic cannot see — raises nothing.",
    note: "The other half of `observability-runtime`'s unreached surface. The availability and latency engines in the same package are both reachable through `observability-runtime-pg`'s persisting engines, which is the contrast that makes these two declarations sharp rather than a blanket statement about the package.",
  },

  /* ------------------------------------------------------ observability-runtime-pg (1) */
  {
    scope: "symbol",
    pkg: "packages/observability-runtime-pg",
    symbol: "SloEnforcementReplayer",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the verification surface the other five replayers want. Ordering, not shape.",
    tables: [],
    consequence:
      "The three SLO drift conditions — an `ongoing` action with no open incident, two open incidents for one surface, and a `paged` action whose policy had no channels — are never checked, so ADR-0294's duplicate-declaration guard and ADR-0325's undelivered-page accounting have no auditor.",
    note: "`records.ts` and both persisting engines in this package are reachable from `node.ts`; the replayer beside them is constructed only by `replayer.test.ts`.",
  },

  /* --------------------------------------------------------- operate-runtime (1) */
  {
    scope: "symbol",
    pkg: "packages/operate-runtime",
    symbol: "InMemoryEntitlementResolver",
    reason: "offline_implementation",
    tables: [],
    consequence:
      "Nothing: `operate-server` resolves entitlements through `operate-runtime-pg`'s entitlement store, which is the production implementation of the same seam.",
    note: "The in-memory implementation of `EntitlementResolver`, constructed by 22 of its own tests. Declared rather than excused by `test_surface` because only this package's own tests build it, so the rule cannot distinguish it from a dead driver without the declaration — and that is the right place for the judgement, since the fact that no *other* package needs it is exactly what makes it a local fixture rather than public test surface.",
  },

  /* -------------------------------------------------------- residency-runtime (1) */
  {
    scope: "symbol",
    pkg: "packages/residency-runtime",
    symbol: "RegionRouter",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a routing decision on the request path. `operate-server`'s residency routes read and write a tenant's profile through `residency-runtime-pg`'s directory, and nothing consults `decideRegionRouting` before serving a request — so the router, which is the stateful half that caches a directory and answers per request, has no position in the pipeline to occupy. ADR-0077's Q6 gates multi-region on demand, which is why this is ordering rather than a defect: the surface is deliberately thin.",
    tables: [],
    consequence:
      "A residency profile is stored and never enforced: a tenant whose profile forbids a serving region is served from it anyway, because nothing asks the router before dispatch.",
    note: "`decideRegionRouting` (the pure half, in the same module) *is* reachable; the class is constructed only by `router.test.ts`. CLAUDE.md calls this package `small: a tenant→region directory interface, decideRegionRouting and serving-region affinity selection`, which is accurate about what exists and silent about what runs.",
  },

  /* ------------------------------------------------------- workflow-runtime-pg (1) */
  {
    scope: "symbol",
    pkg: "packages/workflow-runtime-pg",
    symbol: "WorkflowReplayer",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the verification surface the other five replayers want, and this is the second one bug-fixed while callerless: ADR-0330 found `compareInstanceProjection` reporting drift on **every healthy instance** that had any timestamp column set, because it compared a node-postgres `Date` with `!==` against an ISO string, and ADR-0334 gave `timerProjectionSignature` the `fireCount`/`nextFireAt` comparison that makes a stopped cron timer visible. Both fixes are to a detector that has never run. Ordering, not shape.",
    tables: [],
    consequence:
      "A workflow instance whose projected row disagrees with its event log is never detected and never resynced, so ADR-0334's stopped cron timer and any projection the fold and the table disagree about persist silently — in the one subsystem whose authority is an append-only log that the projection is only a cache of.",
    note: "`resyncInstance` is the repair this replayer drives. Constructed only by `replayer.test.ts`.",
  },

  /* ----------------------------------------------------- workflow-signal-bridge (3) */
  {
    scope: "member",
    pkg: "packages/workflow-signal-bridge",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "a registered gateway handler for it in `apps/operate-server`. `createSignalBridgeHandler` builds the handler and `node.ts` never calls it — the package has **zero importers**, which is `api-gateway-pg`'s condition before ADR-0335 — so what must land is a CLI flag naming the route, the signal name and the HMAC secret source, next to `--bounce-webhook`, which is the same shape of inbound verified webhook and *is* wired. Ordering, not shape.",
    consequence:
      "No inbound webhook can deliver a signal to a workflow instance in any deployment, so `submitSignal`'s correlation, its exactly-once dedup and the `deliveries` list ADR-0332 built have no external producer — every signal in production comes from inside the process or from nowhere.",
    note: "**Found the day the member predicate widened past `packages/*-pg`.** CLAUDE.md says this package `ships as a registered gateway handler with typed bridge outcomes → HTTP statuses`; it ships the handler and nothing registers it. Declared at `member` scope as well as per class, because the two facts are different: the package has no importer *and* its driver has no construction site, and wiring the route closes both.",
  },
  {
    scope: "symbol",
    pkg: "packages/workflow-signal-bridge",
    symbol: "WorkflowSignalBridge",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the gateway handler registration the member declaration above names. This class is what `createSignalBridgeHandler` constructs, so it gains a caller in the same commit the route does.",
    tables: [],
    consequence:
      "The HMAC verification, the correlation-key extraction by field path and the typed bridge outcomes are unreachable from any request, so an inbound webhook that would start or advance a workflow is refused by the gateway as an unknown route.",
    note: "Constructed only by `bridge.test.ts`. Its sibling extractors (`FieldPathExtractor`, `FixedExtractor`, `FirstFieldExtractor`) *are* constructed by `gateway-handler.ts`, which is itself callerless — the factory blind spot in miniature, and the reason those three are not reported while this one is.",
  },
  {
    scope: "symbol",
    pkg: "packages/workflow-signal-bridge",
    symbol: "StaticSecretResolver",
    reason: "prerequisite_of_unbuilt_surface",
    blockedBy:
      "the same gateway handler registration. It is the declaration-driven implementation of `SecretResolver` — a list of per-tenant secrets with a replay tolerance — and a deployment mounting the bridge supplies it from the environment the way `NOTIFICATION_BOUNCE_SECRET` is supplied today.",
    tables: [],
    consequence:
      "Nothing beyond the bridge's own absence. It is named here rather than as an offline implementation because it is not a test double: it is the resolver a real deployment would use, and the only `SecretResolver` implementation in the workspace.",
    note: "Constructed only by `secret-resolver.test.ts`. The distinction from `InMemoryAuditSink` and `InMemoryEntitlementResolver` is the one `offline_implementation` exists to mark: those two have a production counterpart or none is wanted, while this one *is* the production implementation of a subsystem that is not mounted.",
  },
]);
