import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCatalogSource } from "./pg-column-coverage.js";
import { STORELESS_TABLES } from "./pg-storeless-tables.js";
import {
  auditUnreachableStores,
  BLOCKER_BEARING_REASONS,
  classifyPgPackage,
  classifyStore,
  codeOnly,
  countUnreachableByReason,
  DECISION_BEARING_REASONS,
  exportedStoreSymbols,
  findConstructions,
  formatUnreachableFindings,
  importedSpecifiers,
  isTestSite,
  PACKAGE_REACHABILITIES,
  PgPackageFactsSchema,
  scanWorkspaceStores,
  STORE_REACHABILITIES,
  StoreFactsSchema,
  subjectOf,
  SUBSTITUTE_BEARING_REASONS,
  UNREACHABLE_FINDING_KINDS,
  UNREACHABLE_REASONS,
  UNREACHABLE_SCOPES,
  UNREACHABLE_STORES,
  UnreachableDeclarationSchema,
  type PgPackageFacts,
  type StoreFacts,
  type UnreachableDeclaration,
  type UnreachableFinding,
} from "./pg-unreachable-stores.js";
import { readCatalogSource, REPO_ROOT } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function storeFacts(over: Partial<StoreFacts> = {}): StoreFacts {
  return StoreFactsSchema.parse({
    symbol: "PostgresWidgetStore",
    pkg: "widgets-pg",
    declaredIn: "packages/widgets-pg/src/widget-store.ts",
    constructedBy: [],
    constructedByTests: ["packages/widgets-pg/src/widget-store.test.ts"],
    ...over,
  });
}

function pkgFacts(over: Partial<PgPackageFacts> = {}): PgPackageFacts {
  return PgPackageFactsSchema.parse({
    pkg: "widgets-pg",
    name: "@crossengin/widgets-pg",
    dependents: ["apps/operate-server"],
    importedBy: ["apps/operate-server/src/node.ts"],
    importedByTests: [],
    ...over,
  });
}

function declaration(over: Partial<UnreachableDeclaration> = {}): UnreachableDeclaration {
  return UnreachableDeclarationSchema.parse({
    scope: "store",
    pkg: "widgets-pg",
    symbol: "PostgresWidgetStore",
    reason: "unpersisted_record",
    tables: [],
    consequence: "the widget record is produced on every pass and dropped",
    note: "built by nobody in particular, for the purposes of this test",
    ...over,
  });
}

const audit = (
  input: Partial<Parameters<typeof auditUnreachableStores>[0]> = {},
): readonly UnreachableFinding[] =>
  auditUnreachableStores({
    stores: [],
    packages: [pkgFacts()],
    declarations: [],
    catalogTables: [],
    storelessTables: [],
    reachableSubstitutes: [],
    ...input,
  });

/* ------------------------------------------------------------------ the shape */

describe("the declared shape", () => {
  it("names five reasons, two scopes, three store buckets, four package buckets and twelve finding kinds", () => {
    expect([...UNREACHABLE_REASONS]).toEqual([
      "no_caller_by_design",
      "substitute_in_use",
      "unpersisted_record",
      "prerequisite_of_unbuilt_surface",
      "contract_cannot_carry_the_surface",
    ]);
    expect([...UNREACHABLE_SCOPES]).toEqual(["store", "package"]);
    expect([...STORE_REACHABILITIES]).toEqual(["reachable", "test_only", "unconstructed"]);
    expect([...PACKAGE_REACHABILITIES]).toEqual([
      "reachable",
      "unimported",
      "test_only_importer",
      "declared_unused",
    ]);
    expect(UNREACHABLE_FINDING_KINDS.length).toBe(12);
  });

  it("partitions the reasons that bear a field, leaving exactly the one that bears none", () => {
    // ADR-0330's shape, as `pg-storeless-tables.ts` uses it: the bearing sets are asserted disjoint
    // and the remainder is named, so a sixth reason added to neither fails here rather than quietly
    // carrying any field it likes.
    const bearing = [...DECISION_BEARING_REASONS, ...SUBSTITUTE_BEARING_REASONS, ...BLOCKER_BEARING_REASONS];
    expect(new Set(bearing).size).toBe(bearing.length);
    const remainder = UNREACHABLE_REASONS.filter((r) => !bearing.includes(r));
    expect([...remainder]).toEqual(["unpersisted_record"]);
  });

  it("requires a symbol and a table list of a store declaration, and forbids both of a package one", () => {
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...declaration(), scope: "package" }),
    ).toThrow();
    expect(() =>
      declaration({ scope: "package", symbol: undefined, tables: undefined }),
    ).not.toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), symbol: undefined })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), tables: undefined })).toThrow();
  });

  it("accepts an empty table list as a signed assertion that this store writes none", () => {
    // ADR-0331's distinction, which is the whole reason the field is required rather than optional:
    // `[]` says "this store writes no catalogued table" and an absent field says "nobody looked".
    expect(declaration({ tables: [] }).tables).toEqual([]);
    expect(() => declaration({ tables: ["meta.widgets"] })).not.toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), tables: ["widgets"] })).toThrow();
  });

  it("requires a substitute of substitute_in_use and only then", () => {
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...declaration(), reason: "substitute_in_use" }),
    ).toThrow();
    expect(() =>
      declaration({ reason: "substitute_in_use", substitutedBy: "InMemoryWidgetStore" }),
    ).not.toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...declaration(), substitutedBy: "InMemoryWidgetStore" }),
    ).toThrow();
  });

  it("requires an ADR of no_caller_by_design and only then", () => {
    // The one reason that must never be assumed is the one that has to cite where it was decided.
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...declaration(), reason: "no_caller_by_design" }),
    ).toThrow();
    expect(() =>
      declaration({ reason: "no_caller_by_design", decidedIn: "ADR-0335" }),
    ).not.toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({
        ...declaration(),
        reason: "no_caller_by_design",
        decidedIn: "0335",
      }),
    ).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), decidedIn: "ADR-0335" })).toThrow();
  });

  it("requires a blocker of either blocked reason, and only of those", () => {
    for (const reason of BLOCKER_BEARING_REASONS) {
      expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), reason })).toThrow();
      expect(() =>
        declaration({ reason, blockedBy: "a route that does not exist in the server yet" }),
      ).not.toThrow();
    }
    expect(() =>
      UnreachableDeclarationSchema.parse({
        ...declaration(),
        blockedBy: "a route that does not exist in the server yet",
      }),
    ).toThrow();
  });

  it("refuses a package name that is not a pg package, a bad symbol and an empty note", () => {
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), pkg: "widgets" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), symbol: "WidgetStore" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), note: "too short" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), consequence: "short" })).toThrow();
  });

  it("names a subject the same way from both scopes", () => {
    expect(subjectOf(declaration())).toBe("widgets-pg:PostgresWidgetStore");
    expect(subjectOf(declaration({ scope: "package", symbol: undefined, tables: undefined }))).toBe(
      "widgets-pg",
    );
  });
});

/* --------------------------------------------------------------- reachability */

describe("reachability", () => {
  it("calls a store reachable on any non-test construction site, wherever it is", () => {
    expect(classifyStore(storeFacts({ constructedBy: ["apps/operate-server/src/node.ts"] }))).toBe(
      "reachable",
    );
    // Even a site inside its own package counts: the transitive question is a different one, and a
    // naive answer to it reports ten false positives (see the module's closing note).
    expect(
      classifyStore(storeFacts({ constructedBy: ["packages/widgets-pg/src/persisting-engine.ts"] })),
    ).toBe("reachable");
  });

  it("separates test-only from constructed-nowhere", () => {
    expect(classifyStore(storeFacts())).toBe("test_only");
    expect(classifyStore(storeFacts({ constructedByTests: [] }))).toBe("unconstructed");
  });

  it("classifies a package by how it is unreachable, not merely that it is", () => {
    expect(classifyPgPackage(pkgFacts())).toBe("reachable");
    expect(classifyPgPackage(pkgFacts({ importedBy: [], dependents: [] }))).toBe("unimported");
    expect(classifyPgPackage(pkgFacts({ importedBy: [] }))).toBe("declared_unused");
    expect(
      classifyPgPackage(pkgFacts({ importedBy: [], importedByTests: ["packages/x/src/a.test.ts"] })),
    ).toBe("test_only_importer");
  });
});

/* -------------------------------------------------------------------- the rule */

describe("auditUnreachableStores", () => {
  it("passes a reachable store and a reachable package with no declarations", () => {
    expect(audit({ stores: [storeFacts({ constructedBy: ["apps/a/src/node.ts"] })] })).toEqual([]);
  });

  it("passes an unreachable store that is declared", () => {
    expect(audit({ stores: [storeFacts()], declarations: [declaration()] })).toEqual([]);
  });

  it("reports a test-only store nothing declares — the fence", () => {
    const found = audit({ stores: [storeFacts()] });
    expect(found.map((f) => f.kind)).toEqual(["store_test_only"]);
    expect(found[0]?.detail).toContain("built, tested and never connected");
    // The sentence that says why this rule is not a duplicate of pg-storeless-tables.ts.
    expect(found[0]?.detail).toContain("reads as written");
  });

  it("reports a store nothing constructs at all, separately", () => {
    const found = audit({ stores: [storeFacts({ constructedByTests: [] })] });
    expect(found.map((f) => f.kind)).toEqual(["store_unconstructed"]);
  });

  it("reports an unimported package, and names ADR-0335's shape", () => {
    const found = audit({ packages: [pkgFacts({ importedBy: [], dependents: [] })] });
    expect(found.map((f) => f.kind)).toEqual(["package_unimported"]);
    expect(found[0]?.detail).toContain("api-gateway-pg");
  });

  it("reports a dependency declared and never imported, and one imported only by tests", () => {
    expect(audit({ packages: [pkgFacts({ importedBy: [] })] }).map((f) => f.kind)).toEqual([
      "package_declared_unused",
    ]);
    expect(
      audit({
        packages: [pkgFacts({ importedBy: [], importedByTests: ["packages/x/src/a.test.ts"] })],
      }).map((f) => f.kind),
    ).toEqual(["package_test_only_importer"]);
  });

  it("reports a declaration a caller has overtaken, in both scopes", () => {
    const store = audit({
      stores: [storeFacts({ constructedBy: ["apps/a/src/node.ts"] })],
      declarations: [declaration()],
    });
    expect(store.map((f) => f.kind)).toEqual(["overtaken"]);
    expect(store[0]?.detail).toContain("remove the declaration");

    const pkg = audit({
      declarations: [declaration({ scope: "package", symbol: undefined, tables: undefined })],
    });
    expect(pkg.map((f) => f.kind)).toEqual(["overtaken"]);
  });

  it("reports a declaration naming a symbol nothing exports, and says if another package has it", () => {
    const gone = audit({ stores: [], declarations: [declaration()] });
    expect(gone.map((f) => f.kind)).toEqual(["unknown_symbol"]);
    expect(gone[0]?.detail).toContain("renamed or removed");

    const moved = audit({
      stores: [storeFacts({ pkg: "gadgets-pg" })],
      packages: [pkgFacts(), pkgFacts({ pkg: "gadgets-pg", name: "@crossengin/gadgets-pg" })],
      declarations: [declaration()],
    });
    // Both findings land, and that is right: one broken declaration, and a store in another package
    // that nothing has decided about. `pg-storeless-tables.ts` makes the same pairing for a
    // `writerless_successor`.
    expect(moved.map((f) => f.kind)).toEqual(["unknown_symbol", "store_test_only"]);
    expect(moved[0]?.detail).toContain("exported by gadgets-pg instead");
  });

  it("reports a declaration naming a package that is not a pg package here", () => {
    const found = audit({ packages: [], declarations: [declaration()] });
    expect(found.map((f) => f.kind)).toEqual(["unknown_package"]);
  });

  it("reports the same subject declared twice", () => {
    const found = audit({
      stores: [storeFacts()],
      declarations: [declaration(), declaration({ reason: "unpersisted_record" })],
    });
    expect(found.map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("reports a substitute that is not itself constructed outside tests", () => {
    // `writerless_successor`'s shape: a reason that asserts something positive about another symbol
    // is the reason that rots when that symbol is abandoned too.
    const d = declaration({ reason: "substitute_in_use", substitutedBy: "InMemoryWidgetStore" });
    const found = audit({ stores: [storeFacts()], declarations: [d] });
    expect(found.map((f) => f.kind)).toEqual(["unsupported_substitute"]);
    expect(found[0]?.detail).toContain("something else does this job is false");
    expect(
      audit({
        stores: [storeFacts()],
        declarations: [d],
        reachableSubstitutes: ["InMemoryWidgetStore"],
      }),
    ).toEqual([]);
  });

  it("reports a declared table the catalog does not have", () => {
    const found = audit({
      stores: [storeFacts()],
      declarations: [declaration({ tables: ["meta.widgets"] })],
    });
    expect(found.map((f) => f.kind)).toEqual(["unknown_table"]);
  });

  it("reports a table the storeless rule also calls writerless — the two rules disagreeing", () => {
    const found = audit({
      stores: [storeFacts()],
      declarations: [declaration({ tables: ["meta.widgets"] })],
      catalogTables: ["meta.widgets"],
      storelessTables: ["meta.widgets"],
    });
    expect(found.map((f) => f.kind)).toEqual(["table_declared_storeless"]);
    expect(found[0]?.detail).toContain("disagree about the same table");
  });

  it("every finding kind is reachable", () => {
    const reached = new Set<string>([
      ...audit({ stores: [storeFacts()] }).map((f) => f.kind),
      ...audit({ stores: [storeFacts({ constructedByTests: [] })] }).map((f) => f.kind),
      ...audit({ packages: [pkgFacts({ importedBy: [], dependents: [] })] }).map((f) => f.kind),
      ...audit({
        packages: [pkgFacts({ importedBy: [], importedByTests: ["x.test.ts"] })],
      }).map((f) => f.kind),
      ...audit({ packages: [pkgFacts({ importedBy: [] })] }).map((f) => f.kind),
      ...audit({
        stores: [storeFacts({ constructedBy: ["a.ts"] })],
        declarations: [declaration()],
      }).map((f) => f.kind),
      ...audit({ declarations: [declaration()] }).map((f) => f.kind),
      ...audit({ packages: [], declarations: [declaration()] }).map((f) => f.kind),
      ...audit({ stores: [storeFacts()], declarations: [declaration(), declaration()] }).map(
        (f) => f.kind,
      ),
      ...audit({
        stores: [storeFacts()],
        declarations: [declaration({ reason: "substitute_in_use", substitutedBy: "InMemoryX" })],
      }).map((f) => f.kind),
      ...audit({
        stores: [storeFacts()],
        declarations: [declaration({ tables: ["meta.widgets"] })],
      }).map((f) => f.kind),
      ...audit({
        stores: [storeFacts()],
        declarations: [declaration({ tables: ["meta.widgets"] })],
        catalogTables: ["meta.widgets"],
        storelessTables: ["meta.widgets"],
      }).map((f) => f.kind),
    ]);
    expect([...reached].sort()).toEqual([...UNREACHABLE_FINDING_KINDS].sort());
  });

  it("counts every reason, including the ones nothing uses", () => {
    const counts = countUnreachableByReason([declaration()]);
    expect(counts.get("unpersisted_record")).toBe(1);
    expect(counts.get("no_caller_by_design")).toBe(0);
    expect([...counts.keys()].sort()).toEqual([...UNREACHABLE_REASONS].sort());
  });

  it("formats findings one per line with the kind in front", () => {
    expect(formatUnreachableFindings([])).toBe("");
    expect(formatUnreachableFindings(audit({ stores: [storeFacts()] }))).toContain(
      "[store_test_only]",
    );
  });
});

/* --------------------------------------------------------- reading the source */

describe("reading the source", () => {
  it("does not count a commented-out construction, in either comment form", () => {
    const code = codeOnly(`
      // const a = new PostgresWidgetStore(conn);
      /* const b = new PostgresWidgetStore(conn); */
      const c = 1;
    `);
    expect(findConstructions(code, new Set(["PostgresWidgetStore"])).constructs).toEqual([]);
  });

  it("does not count a construction written inside a string", () => {
    // This file's own notes quote these symbol names; without blanking, the declaration list would
    // argue itself reachable.
    const code = codeOnly('const note = "nothing calls new PostgresWidgetStore(conn) anywhere";');
    expect(findConstructions(code, new Set(["PostgresWidgetStore"])).constructs).toEqual([]);
  });

  it("keeps line numbers and quotes while blanking what is between them", () => {
    const blanked = codeOnly('const a = "one\\ntwo";\nconst b = 2;');
    // Two lines in, two lines out — an escape sequence is blanked character for character, so a
    // reported line number still names the real line.
    expect(blanked.split("\n").length).toBe(2);
    expect(blanked.startsWith('const a = "')).toBe(true);
    expect(blanked).toContain('";');
    expect(blanked).not.toContain("one");
    expect(blanked.length).toBe('const a = "one\\ntwo";\nconst b = 2;'.length);
  });

  it("counts a bare, a namespaced, a generic and a parenless construction", () => {
    const names = new Set(["PostgresWidgetStore"]);
    for (const source of [
      "const a = new PostgresWidgetStore(conn);",
      "const a = new ns.PostgresWidgetStore(conn);",
      "const a = new PostgresWidgetStore<Widget>(conn);",
      "const a = new PostgresWidgetStore;",
      "const a = new\n  PostgresWidgetStore(conn);",
    ]) {
      expect(findConstructions(codeOnly(source), names).constructs, source).toEqual([
        "PostgresWidgetStore",
      ]);
    }
  });

  it("does not count a longer identifier that starts with the name", () => {
    expect(
      findConstructions(
        codeOnly("const a = new PostgresWidgetStoreV2(conn);"),
        new Set(["PostgresWidgetStore"]),
      ).constructs,
    ).toEqual([]);
  });

  it("reports a construction it cannot attribute rather than skipping it", () => {
    // `new (map[kind])()` is the shape this scan structurally cannot attribute. Reported, because a
    // scan with a silent "could not read" bucket would be the next member of the class these rules
    // exist to catch.
    const scan = findConstructions(codeOnly("const a = new (registry[kind])(conn);"), new Set());
    expect(scan.dynamic.length).toBe(1);
    expect(scan.dynamic[0]?.line).toBe(1);
  });

  it("finds an exported store class, abstract or not, and nothing else", () => {
    expect(
      exportedStoreSymbols(
        codeOnly(
          "export class PostgresA {}\nexport abstract class PostgresB {}\nexport class Other {}\nclass PostgresC {}",
        ),
      ),
    ).toEqual(["PostgresA", "PostgresB"]);
  });

  it("reads a specifier from each of the four forms that reach a package", () => {
    expect(
      importedSpecifiers(`
        import { a } from "@crossengin/widgets-pg";
        import "@crossengin/side-effect-pg";
        export { b } from "./local.js";
        const c = await import("@crossengin/dynamic-pg");
        const d = require("@crossengin/legacy-pg");
      `),
    ).toEqual([
      "@crossengin/widgets-pg",
      "@crossengin/side-effect-pg",
      "./local.js",
      "@crossengin/dynamic-pg",
      "@crossengin/legacy-pg",
    ]);
  });

  it("treats both test conventions as test sites, and a production module as neither", () => {
    expect(isTestSite("packages/a/src/x.test.ts")).toBe(true);
    expect(isTestSite("packages/a/src/x.test.tsx")).toBe(true);
    // The half that is easy to miss: ten packages keep a `src/test-fakes.ts`, a module that is
    // production by filename and exists only for tests. A store constructed there would otherwise
    // read as reachable while no deployment ever loads it.
    expect(isTestSite("packages/a/src/test-fakes.ts")).toBe(true);
    expect(isTestSite("packages/a/src/test-fixtures.ts")).toBe(true);
    expect(isTestSite("packages/a/src/store.ts")).toBe(false);
    // And the limit of the convention, stated rather than hidden: a helper named something else is
    // a production file to this rule.
    expect(isTestSite("packages/access-reviews-runtime/src/fixtures.ts")).toBe(false);
  });
});

/* -------------------------------------------------------------- the workspace */

describe("the real workspace", () => {
  const scan = scanWorkspaceStores();
  const catalogTables = parseCatalogSource(readCatalogSource()).map((t) => `${t.schema}.${t.name}`);
  const storelessTables = STORELESS_TABLES.map((d) => d.table);
  const reachable = scan.stores.filter((s) => classifyStore(s) === "reachable");
  const unreachable = scan.stores.filter((s) => classifyStore(s) !== "reachable");

  const liveAudit = (
    declarations: readonly UnreachableDeclaration[],
    stores: readonly StoreFacts[] = scan.stores,
  ): ReturnType<typeof auditUnreachableStores> =>
    auditUnreachableStores({
      stores,
      packages: scan.packages,
      declarations,
      catalogTables,
      storelessTables,
      reachableSubstitutes: scan.reachableSubstitutes,
    });

  it("walked the workspace and resolved every package it should have", () => {
    // **The vacuity guard this rule needs most.** Signal 2 finds nothing today — ADR-0335 closed its
    // only member — so "finds ≥ 1" would be a false floor and a rule asserting nothing is the exact
    // failure this family exists to prevent. The assertion is therefore that the scan *examined and
    // resolved* everything: every root glob understood, a floor of files, a floor of pg packages,
    // and every one of them landing in a known bucket.
    expect(scan.unhandledGlobs).toEqual([]);
    expect(scan.files).toBeGreaterThanOrEqual(1500);
    expect(scan.packages.length).toBeGreaterThanOrEqual(18);
    // `packages/*-pg` also matches `packages/*-runtime-pg`, so the set is derived from one readdir
    // and keyed by directory. A doubled denominator would make every count below look better.
    expect(new Set(scan.packages.map((p) => p.pkg)).size).toBe(scan.packages.length);
    expect(scan.collidingSymbols).toEqual([]);
    for (const pkg of scan.packages) {
      expect(PACKAGE_REACHABILITIES).toContain(classifyPgPackage(pkg));
      // A renamed package would make its import edges unfindable and read as unimported.
      expect(pkg.name, pkg.pkg).toBe(`@crossengin/${pkg.pkg}`);
    }
    for (const store of scan.stores) expect(STORE_REACHABILITIES).toContain(classifyStore(store));
    // Both `-pg` and `-runtime-pg` are present, so the suffix predicate is not quietly matching one.
    expect(scan.packages.map((p) => p.pkg)).toContain("kernel-pg");
    expect(scan.packages.map((p) => p.pkg)).toContain("workflow-runtime-pg");
  });

  it("found most stores reachable, which is the direction that would be catastrophic to get wrong", () => {
    // A site matcher that stopped matching would report all 55 stores unreachable — over-reporting
    // is the direction that fails CI on correct code, so the floor is on the *reachable* count. The
    // ceiling on the other side is deliberately loose: wiring a store lowers it, and a legitimately
    // declared ninth must not break it, so it guards only against a collapse.
    expect(scan.stores.length).toBeGreaterThanOrEqual(50);
    expect(reachable.length).toBeGreaterThanOrEqual(40);
    expect(unreachable.length).toBeLessThanOrEqual(12);
    // ADR-0335's wiring, pinned: `PostgresRateLimitChecker` was one of api-gateway-pg's four
    // callerless stores until that increment constructed it in `node.ts`. If it ever goes back to
    // test-only, this rule should be the thing that says so.
    const checker = scan.stores.find((s) => s.symbol === "PostgresRateLimitChecker");
    expect(checker).toBeDefined();
    expect(checker === undefined ? "missing" : classifyStore(checker)).toBe("reachable");
  });

  it("attributes every construction it can see, and nothing hides behind a dynamic one", () => {
    // Zero today. Asserted as a tripwire rather than an equality: the day a store is constructed
    // through `new (map[kind])()` this scan cannot attribute it, and the honest failure is here
    // rather than in a silent "reachable".
    expect(scan.dynamic.filter((d) => d.snippet.includes("Postgres"))).toEqual([]);
    expect(scan.dynamic.length).toBeLessThanOrEqual(20);
  });

  it("no exported Postgres store is unreachable without a declaration saying why", () => {
    // The assertion this file exists for. A store built, tested and never connected is a failure at
    // the moment it lands, rather than a defect somebody finds by grepping three increments later.
    expect(formatUnreachableFindings(liveAudit(UNREACHABLE_STORES))).toBe("");
  });

  it("declares exactly the unreachable stores, and every declaration parses", () => {
    const declared = new Set(UNREACHABLE_STORES.map((d) => subjectOf(d)));
    expect(declared.size).toBe(UNREACHABLE_STORES.length);
    for (const d of UNREACHABLE_STORES) {
      expect(() => UnreachableDeclarationSchema.parse(d)).not.toThrow();
    }
    // Both directions, as plain set equality over subjects. The count is deliberately *not* asserted
    // — three of these are being wired as this lands, and a number here would make a correct wiring
    // commit fail for the wrong reason. The list is the only place a name is written down.
    expect([...declared].sort()).toEqual(
      unreachable.map((s) => `${s.pkg}:${s.symbol}`).sort(),
    );
  });

  it("every declaration names a package, a symbol and a file that exist", () => {
    for (const d of UNREACHABLE_STORES) {
      expect(existsSync(join(REPO_ROOT, "packages", d.pkg)), d.pkg).toBe(true);
      if (d.symbol === undefined) continue;
      const facts = scan.stores.find((s) => s.symbol === d.symbol && s.pkg === d.pkg);
      expect(facts, subjectOf(d)).toBeDefined();
      expect(existsSync(join(REPO_ROOT, facts?.declaredIn ?? "")), facts?.declaredIn).toBe(true);
    }
  });

  it("every cited ADR is a real ADR file", () => {
    // An owner nothing can be looked up in is a note rather than evidence (`pg-storeless-tables.ts`
    // makes the same demand of its `owner` field). A by-design claim citing an ADR that does not
    // exist is the one failure mode that reason has.
    const adrs = readdirSync(join(REPO_ROOT, "docs", "adr"));
    const cited = UNREACHABLE_STORES.flatMap((d) => (d.decidedIn === undefined ? [] : [d.decidedIn]));
    expect(cited.length).toBeGreaterThanOrEqual(1);
    for (const id of cited) {
      const number = id.slice("ADR-".length);
      expect(
        adrs.some((f) => f.startsWith(`${number}-`)),
        `${id} has no file in docs/adr`,
      ).toBe(true);
    }
  });

  it("every declared table is catalogued, and the two SQL rules agree about it", () => {
    // The join between this rule and `pg-storeless-tables.ts`, and the reason both are needed: that
    // rule reads a store's SQL as a writer, so a store with no caller makes its table read as
    // **written** while no deployment has ever put a row in it. A table in both lists would mean
    // the two disagree, and the audit reports it.
    const tables = UNREACHABLE_STORES.flatMap((d) => d.tables ?? []);
    expect(tables.length).toBeGreaterThanOrEqual(UNREACHABLE_STORES.filter((d) => d.scope === "store").length);
    for (const table of tables) {
      expect(catalogTables, table).toContain(table);
      expect(storelessTables, table).not.toContain(table);
    }
  });

  it("every substitute a declaration names is itself constructed outside tests", () => {
    const substitutes = UNREACHABLE_STORES.flatMap((d) =>
      d.substitutedBy === undefined ? [] : [d.substitutedBy],
    );
    for (const name of substitutes) expect(scan.reachableSubstitutes, name).toContain(name);
  });

  it("would catch the defect it was written for, in both directions", () => {
    // The fence finding nothing is indistinguishable from the fence being broken, so the controls are
    // built from the *real* scan rather than from a name that a concurrent wiring commit could move.
    //
    // One: a reachable store whose non-test sites are taken away must be reported.
    const victim = reachable[0];
    expect(victim).toBeDefined();
    const stripped = StoreFactsSchema.parse({
      ...(victim ?? storeFacts()),
      constructedBy: [],
      constructedByTests: ["packages/x/src/x.test.ts"],
    });
    const others = scan.stores.filter((s) => s.symbol !== stripped.symbol);
    expect(
      liveAudit(UNREACHABLE_STORES, [...others, stripped]).map((f) => `${f.kind}:${f.subject}`),
    ).toEqual([`store_test_only:${stripped.pkg}:${stripped.symbol}`]);

    // Two: a store with a live caller cannot be parked as unreachable.
    const parked = UnreachableDeclarationSchema.parse({
      scope: "store",
      pkg: victim?.pkg ?? "widgets-pg",
      symbol: victim?.symbol ?? "PostgresWidgetStore",
      reason: "unpersisted_record",
      tables: [],
      consequence: "a false claim, written to prove the rule reads the workspace",
      note: "a false claim, written to prove the rule reads the workspace",
    });
    expect(
      liveAudit([...UNREACHABLE_STORES, parked]).map((f) => `${f.kind}:${f.subject}`),
    ).toEqual([`overtaken:${parked.pkg}:${parked.symbol}`]);
  });

  it("would catch a package nobody imports, which is the signal with no live member", () => {
    // Signal 2's only member was closed last increment, so the only way to show the rule works is to
    // take a real package's import edges away. `api-gateway-pg` is the right victim: this is
    // literally its state before ADR-0335.
    const gateway = scan.packages.find((p) => p.pkg === "api-gateway-pg");
    expect(gateway).toBeDefined();
    const orphaned = PgPackageFactsSchema.parse({
      ...(gateway ?? pkgFacts()),
      dependents: [],
      importedBy: [],
      importedByTests: [],
    });
    const findings = auditUnreachableStores({
      stores: [],
      packages: [orphaned],
      declarations: [],
      catalogTables,
      storelessTables,
      reachableSubstitutes: scan.reachableSubstitutes,
    });
    expect(findings.map((f) => `${f.kind}:${f.subject}`)).toEqual([
      "package_unimported:api-gateway-pg",
    ]);
  });

  it("the test-module convention it relies on is real and in use", () => {
    // `isTestSite`'s `test-*.ts` half is insurance against a hole nothing currently falls into, and
    // insurance over a convention that does not exist would be a dead branch. Thirteen such modules
    // exist, so the branch is live.
    const testModules = scan.stores.length > 0 ? readdirSync(join(REPO_ROOT, "packages")) : [];
    const withFakes = testModules.filter((pkg) =>
      existsSync(join(REPO_ROOT, "packages", pkg, "src", "test-fakes.ts")),
    );
    expect(withFakes.length).toBeGreaterThanOrEqual(8);
    for (const pkg of withFakes) expect(isTestSite(`packages/${pkg}/src/test-fakes.ts`)).toBe(true);
  });
});
