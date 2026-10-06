import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCatalogSource } from "./pg-column-coverage.js";
import { STORELESS_TABLES } from "./pg-storeless-tables.js";
import {
  auditCallerlessFlagLists,
  auditUnreachableStores,
  BLOCKER_BEARING_REASONS,
  classifyMember,
  classifySymbol,
  codeOnly,
  countUnreachableByReason,
  DECISION_BEARING_REASONS,
  DRIVER_MODULE_FAMILIES,
  exportedClasses,
  exportedFunctions,
  exportedNames,
  findConstructions,
  findIdentifierUses,
  FLAG_LIST_FINDING_KINDS,
  FLAG_MEMBER,
  FLAG_SURVEY_PATH,
  formatUnreachableFindings,
  importedSpecifiers,
  isErrorBase,
  isTestSite,
  MEMBER_REACHABILITIES,
  MemberFactsSchema,
  ModuleFactsSchema,
  readCallerlessFlagStores,
  scanWorkspaceStores,
  SUBSTITUTE_BEARING_REASONS,
  SYMBOL_REACHABILITIES,
  SymbolFactsSchema,
  subjectOf,
  TEST_CONSTRUCTED_REASONS,
  UNREACHABLE_FINDING_KINDS,
  UNREACHABLE_REASONS,
  UNREACHABLE_SCOPES,
  UNREACHABLE_STORES,
  UnreachableDeclarationSchema,
  type MemberFacts,
  type ModuleFacts,
  type SymbolFacts,
  type UnreachableDeclaration,
  type UnreachableFinding,
} from "./pg-unreachable-stores.js";
import { readCatalogSource, REPO_ROOT } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function symbolFacts(over: Partial<SymbolFacts> = {}): SymbolFacts {
  return SymbolFactsSchema.parse({
    symbol: "PostgresWidgetStore",
    pkg: "packages/widgets-pg",
    declaredIn: "packages/widgets-pg/src/widget-store.ts",
    extendsName: null,
    alsoDeclaredBy: [],
    constructedBy: [],
    constructedByTests: ["packages/widgets-pg/src/widget-store.test.ts"],
    foreignTestMembers: [],
    ...over,
  });
}

function memberFacts(over: Partial<MemberFacts> = {}): MemberFacts {
  return MemberFactsSchema.parse({
    pkg: "packages/widgets-pg",
    name: "@crossengin/widgets-pg",
    isEntrypoint: false,
    isImportable: true,
    files: 12,
    driverClasses: ["PostgresWidgetStore"],
    dependents: ["apps/operate-server"],
    importedBy: ["apps/operate-server/src/node.ts"],
    importedByTests: [],
    ...over,
  });
}

function moduleFacts(over: Partial<ModuleFacts> = {}): ModuleFacts {
  return ModuleFactsSchema.parse({
    pkg: "packages/widgets-pg",
    module: "src/replayer.ts",
    present: true,
    exportedClasses: [],
    exportedNames: ["replayWidgets", "formatWidgetReport"],
    exportedFunctions: ["replayWidgets", "formatWidgetReport"],
    usedBy: [],
    usedByTests: ["packages/widgets-pg/src/replayer.test.ts"],
    usedNames: [],
    ...over,
  });
}

function declaration(over: Partial<UnreachableDeclaration> = {}): UnreachableDeclaration {
  return UnreachableDeclarationSchema.parse({
    scope: "symbol",
    pkg: "packages/widgets-pg",
    symbol: "PostgresWidgetStore",
    reason: "unpersisted_record",
    tables: [],
    consequence: "the widget record is produced on every pass and dropped",
    note: "built by nobody in particular, for the purposes of this test",
    ...over,
  });
}

function moduleDeclaration(over: Partial<UnreachableDeclaration> = {}): UnreachableDeclaration {
  return UnreachableDeclarationSchema.parse({
    scope: "module",
    pkg: "packages/widgets-pg",
    module: "src/replayer.ts",
    entrypoint: "replayWidgets",
    reason: "unpersisted_record",
    tables: [],
    consequence: "the widget drift report is never produced by anything that runs",
    note: "a function-shaped driver, for the purposes of this test",
    ...over,
  });
}

const audit = (
  input: Partial<Parameters<typeof auditUnreachableStores>[0]> = {},
): readonly UnreachableFinding[] =>
  auditUnreachableStores({
    symbols: [],
    members: [memberFacts()],
    modules: [],
    declarations: [],
    catalogTables: [],
    storelessTables: [],
    reachableSubstitutes: [],
    driverFamilyModules: [],
    ...input,
  });

/* ------------------------------------------------------------------ the shape */

describe("the declared shape", () => {
  it("names six reasons, three scopes, five symbol buckets, seven member buckets and seventeen finding kinds", () => {
    expect([...UNREACHABLE_REASONS]).toEqual([
      "no_caller_by_design",
      "substitute_in_use",
      "offline_implementation",
      "unpersisted_record",
      "prerequisite_of_unbuilt_surface",
      "contract_cannot_carry_the_surface",
    ]);
    expect([...UNREACHABLE_SCOPES]).toEqual(["symbol", "module", "member"]);
    expect([...SYMBOL_REACHABILITIES]).toEqual([
      "reachable",
      "diagnostic_type",
      "test_surface",
      "test_only",
      "unconstructed",
    ]);
    expect([...MEMBER_REACHABILITIES]).toEqual([
      "reachable",
      "entrypoint",
      "not_importable",
      "contracts_only",
      "unimported",
      "test_only_importer",
      "declared_unused",
    ]);
    expect(UNREACHABLE_FINDING_KINDS.length).toBe(17);
    expect(FLAG_LIST_FINDING_KINDS.length).toBe(4);
  });

  it("partitions the reasons that bear a field, leaving exactly the two that bear none", () => {
    // ADR-0330's shape, as `pg-storeless-tables.ts` uses it: the bearing sets are asserted disjoint
    // and the remainder is named, so a seventh reason added to none of them fails here rather than
    // quietly carrying any field it likes.
    const bearing = [
      ...DECISION_BEARING_REASONS,
      ...SUBSTITUTE_BEARING_REASONS,
      ...BLOCKER_BEARING_REASONS,
      ...TEST_CONSTRUCTED_REASONS,
    ];
    expect(new Set(bearing).size).toBe(bearing.length);
    const remainder = UNREACHABLE_REASONS.filter((r) => !bearing.includes(r));
    expect([...remainder]).toEqual(["unpersisted_record"]);
  });

  it("requires a class and a table list of a symbol declaration, and forbids both of a member one", () => {
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), scope: "member" })).toThrow();
    expect(() =>
      declaration({ scope: "member", symbol: undefined, tables: undefined }),
    ).not.toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), symbol: undefined })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), tables: undefined })).toThrow();
  });

  it("requires a file and an entrypoint of a module declaration, and forbids both elsewhere", () => {
    expect(() => moduleDeclaration()).not.toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), entrypoint: undefined }),
    ).toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), module: undefined }),
    ).toThrow();
    // A module declaration names no class, and a symbol declaration names no file.
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), symbol: "PostgresWidgetStore" }),
    ).toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...declaration(), module: "src/replayer.ts" }),
    ).toThrow();
    // And a module declaration carries tables, for the same reason a symbol one does.
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), tables: undefined }),
    ).toThrow();
    // A traversal or an absolute path is not a path inside a member.
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), module: "../x/y.ts" }),
    ).toThrow();
    expect(() =>
      UnreachableDeclarationSchema.parse({ ...moduleDeclaration(), module: "/etc/passwd.ts" }),
    ).toThrow();
  });

  it("accepts an empty table list as a signed assertion that this component writes none", () => {
    // ADR-0331's distinction, which is the whole reason the field is required rather than optional:
    // `[]` says "this writes no catalogued table" and an absent field says "nobody looked".
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
    expect(() => declaration({ reason: "no_caller_by_design", decidedIn: "ADR-0335" })).not.toThrow();
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

  it("refuses a member that is not a workspace directory, a bad class name and an empty note", () => {
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), pkg: "widgets-pg" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), pkg: "lib/widgets" })).toThrow();
    // An app is a legal member now — ADR-0336 declared `apps/*` out of scope and it had a live member.
    expect(() => declaration({ pkg: "apps/operate-server" })).not.toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), symbol: "widgetStore" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), note: "too short" })).toThrow();
    expect(() => UnreachableDeclarationSchema.parse({ ...declaration(), consequence: "short" })).toThrow();
  });

  it("names a subject the same way from all three scopes, and cannot confuse two of them", () => {
    expect(subjectOf(declaration())).toBe("packages/widgets-pg:PostgresWidgetStore");
    expect(subjectOf(declaration({ scope: "member", symbol: undefined, tables: undefined }))).toBe(
      "packages/widgets-pg",
    );
    expect(subjectOf(moduleDeclaration())).toBe("packages/widgets-pg::src/replayer.ts");
  });
});

/* --------------------------------------------------------------- reachability */

describe("reachability", () => {
  it("calls a class reachable on any non-test construction site, wherever it is", () => {
    expect(classifySymbol(symbolFacts({ constructedBy: ["apps/operate-server/src/node.ts"] }))).toBe(
      "reachable",
    );
    // Even a site inside its own package counts: the transitive question is a different one, and a
    // naive answer to it reports ten false positives (see the module's header).
    expect(
      classifySymbol(symbolFacts({ constructedBy: ["packages/widgets-pg/src/persisting-engine.ts"] })),
    ).toBe("reachable");
  });

  it("separates test-only from constructed-nowhere", () => {
    expect(classifySymbol(symbolFacts())).toBe("test_only");
    expect(classifySymbol(symbolFacts({ constructedByTests: [] }))).toBe("unconstructed");
  });

  it("exempts a class whose own extends clause names an error type", () => {
    // Mechanical rather than a list of names: an error is constructed by whoever throws it, which is
    // any consumer, so a `new`-site census says nothing about it. Read from the clause, not from the
    // class's own name, which is what makes it a rule and not a naming convention.
    expect(isErrorBase("Error")).toBe(true);
    expect(isErrorBase("JobError")).toBe(true);
    expect(isErrorBase("ns.PgError")).toBe(true);
    expect(isErrorBase("Map")).toBe(false);
    expect(isErrorBase(null)).toBe(false);
    expect(classifySymbol(symbolFacts({ symbol: "Refusal", extendsName: "Error" }))).toBe(
      "diagnostic_type",
    );
    // And the fact beats the exemption: an error type something constructs is simply reachable.
    expect(
      classifySymbol(
        symbolFacts({ extendsName: "Error", constructedBy: ["packages/x/src/throw.ts"] }),
      ),
    ).toBe("reachable");
  });

  it("exempts a class other members' tests construct, but never one in a -pg member", () => {
    // `FixedClock`, `InMemoryKeyStore` and `MockLlmProvider` are public test surface doing their job.
    expect(
      classifySymbol(
        symbolFacts({
          symbol: "FixedClock",
          pkg: "packages/dr-runtime",
          foreignTestMembers: ["packages/dr-runtime-pg"],
        }),
      ),
    ).toBe("test_surface");
    // The hole this bucket would open, closed where it would matter: a Postgres package's classes
    // are persistence, not doubles, so a store another package's test happens to build is still a
    // finding.
    expect(classifySymbol(symbolFacts({ foreignTestMembers: ["apps/operate-server"] }))).toBe(
      "test_only",
    );
  });

  it("classifies a member by how it is unreachable, not merely that it is", () => {
    expect(classifyMember(memberFacts())).toBe("reachable");
    expect(classifyMember(memberFacts({ importedBy: [], dependents: [] }))).toBe("unimported");
    expect(classifyMember(memberFacts({ importedBy: [] }))).toBe("declared_unused");
    expect(
      classifyMember(memberFacts({ importedBy: [], importedByTests: ["packages/x/src/a.test.ts"] })),
    ).toBe("test_only_importer");
  });

  it("exempts a member that is run rather than imported, one nothing could import, and a declarative one", () => {
    // All three read from `package.json` and from the class scan, never from a member's name.
    expect(
      classifyMember(memberFacts({ importedBy: [], dependents: [], isEntrypoint: true })),
    ).toBe("entrypoint");
    expect(
      classifyMember(memberFacts({ importedBy: [], dependents: [], isImportable: false })),
    ).toBe("not_importable");
    // The thirteen contracts packages, derived so they cost no declaration lines — and this is also
    // the bucket that excuses `packages/deploy`, which exports no class and holds the workspace's
    // only `evaluateFlag()`. See the module header's fifth blind spot.
    expect(
      classifyMember(memberFacts({ importedBy: [], dependents: [], driverClasses: [] })),
    ).toBe("contracts_only");
  });
});

/* -------------------------------------------------------------------- the rule */

describe("auditUnreachableStores", () => {
  it("passes a reachable class and a reachable member with no declarations", () => {
    expect(audit({ symbols: [symbolFacts({ constructedBy: ["apps/a/src/node.ts"] })] })).toEqual([]);
  });

  it("passes an unreachable class that is declared", () => {
    expect(audit({ symbols: [symbolFacts()], declarations: [declaration()] })).toEqual([]);
  });

  it("reports a test-only class nothing declares — the fence", () => {
    const found = audit({ symbols: [symbolFacts()] });
    expect(found.map((f) => f.kind)).toEqual(["symbol_test_only"]);
    expect(found[0]?.detail).toContain("built, tested and never connected");
    // The sentence that says why this rule is not a duplicate of pg-storeless-tables.ts.
    expect(found[0]?.detail).toContain("reads as written");
  });

  it("reports a class nothing constructs at all, separately", () => {
    const found = audit({ symbols: [symbolFacts({ constructedByTests: [] })] });
    expect(found.map((f) => f.kind)).toEqual(["symbol_unconstructed"]);
  });

  it("reports neither a diagnostic type nor public test surface", () => {
    expect(audit({ symbols: [symbolFacts({ extendsName: "Error" })] })).toEqual([]);
    expect(
      audit({
        symbols: [
          symbolFacts({ pkg: "packages/dr-runtime", foreignTestMembers: ["packages/dr-runtime-pg"] }),
        ],
        members: [memberFacts({ pkg: "packages/dr-runtime", name: "@crossengin/dr-runtime" })],
      }),
    ).toEqual([]);
  });

  it("reports an unimported member with its driver classes named, and ADR-0335's shape", () => {
    const found = audit({ members: [memberFacts({ importedBy: [], dependents: [] })] });
    expect(found.map((f) => f.kind)).toEqual(["member_unimported"]);
    expect(found[0]?.detail).toContain("api-gateway-pg");
    // The driver classes are in the detail because they are the reason it is not `contracts_only`.
    expect(found[0]?.detail).toContain("PostgresWidgetStore");
  });

  it("reports a dependency declared and never imported, and one imported only by tests", () => {
    expect(audit({ members: [memberFacts({ importedBy: [] })] }).map((f) => f.kind)).toEqual([
      "member_declared_unused",
    ]);
    expect(
      audit({
        members: [memberFacts({ importedBy: [], importedByTests: ["packages/x/src/a.test.ts"] })],
      }).map((f) => f.kind),
    ).toEqual(["member_test_only_importer"]);
  });

  it("reports a declaration a caller has overtaken, in all three scopes", () => {
    const symbol = audit({
      symbols: [symbolFacts({ constructedBy: ["apps/a/src/node.ts"] })],
      declarations: [declaration()],
    });
    expect(symbol.map((f) => f.kind)).toEqual(["overtaken"]);
    expect(symbol[0]?.detail).toContain("remove the declaration");

    const member = audit({
      declarations: [declaration({ scope: "member", symbol: undefined, tables: undefined })],
    });
    expect(member.map((f) => f.kind)).toEqual(["overtaken"]);

    const module = audit({
      modules: [
        moduleFacts({ usedBy: ["apps/a/src/verify.ts"], usedNames: ["replayWidgets"] }),
      ],
      declarations: [moduleDeclaration()],
    });
    expect(module.map((f) => f.kind)).toEqual(["overtaken"]);
    expect(module[0]?.detail).toContain("replayWidgets");
  });

  it("reports a module declaration whose file is gone, whose entrypoint is gone, or which grew a class", () => {
    expect(
      audit({ modules: [moduleFacts({ present: false })], declarations: [moduleDeclaration()] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["unknown_module"]);
    expect(
      audit({
        modules: [moduleFacts({ exportedNames: ["formatWidgetReport"] })],
        declarations: [moduleDeclaration()],
      }).map((f) => f.kind),
    ).toEqual(["unknown_entrypoint"]);
    // The handover between the two units: a module that gains a class is the symbol rule's problem,
    // so the module declaration has to go rather than sit beside it and excuse the class too.
    const grew = audit({
      modules: [moduleFacts({ exportedClasses: ["WidgetReplayer"] })],
      declarations: [moduleDeclaration()],
    });
    expect(grew.map((f) => f.kind)).toEqual(["module_now_has_class"]);
    expect(grew[0]?.detail).toContain("delete the module declaration");
  });

  it("reports a driver-family module that is accounted for no way at all — signal 5's fence", () => {
    const found = audit({ driverFamilyModules: [moduleFacts()] });
    expect(found.map((f) => f.kind)).toEqual(["driver_module_unaccounted"]);
    expect(found[0]?.detail).toContain("looks for a 'new' site");
    // It names what nothing referenced, which is what an author needs to act on.
    expect(found[0]?.detail).toContain("replayWidgets");
  });

  it("accounts for a driver-family module three ways, and the third is the one that was missing", () => {
    // One: a class in it is the symbol rule's to answer for.
    expect(audit({ driverFamilyModules: [moduleFacts({ exportedClasses: ["X"] })] })).toEqual([]);
    // Two: a declaration is this rule's.
    expect(
      audit({
        modules: [moduleFacts()],
        driverFamilyModules: [moduleFacts()],
        declarations: [moduleDeclaration()],
      }),
    ).toEqual([]);
    // Three: something outside it names an invocable export, so it is reachable on its own terms.
    // Without this arm, a module that went from declared-unreachable to genuinely wired landed in a
    // finding telling its author to wire what they had just wired — which is what ADR-0337 hit.
    expect(
      audit({
        driverFamilyModules: [
          moduleFacts({ usedBy: ["apps/operate-server/src/node.ts"], usedNames: ["replayWidgets"] }),
        ],
      }),
    ).toEqual([]);
    // A *test* naming it is not an account, for `isTestSite`'s reason everywhere else in this file.
    expect(
      audit({
        driverFamilyModules: [
          moduleFacts({ usedByTests: ["packages/widgets-pg/src/replayer.test.ts"] }),
        ],
      }).map((f) => f.kind),
    ).toEqual(["driver_module_unaccounted"]);
  });

  it("says so differently when there is nothing to ask about at all", () => {
    // A family module whose driver is a const or an arrow seeds no name, so the question cannot be
    // asked. It stays unaccounted — the safe direction — and the detail says why, rather than
    // claiming nothing references a list that is empty.
    const found = audit({
      driverFamilyModules: [moduleFacts({ exportedFunctions: [], exportedNames: ["REPLAY_KINDS"] })],
    });
    expect(found.map((f) => f.kind)).toEqual(["driver_module_unaccounted"]);
    expect(found[0]?.detail).toContain("exports no class and no function");
  });

  it("reports a declaration naming a class nothing exports, and says if another member has it", () => {
    const gone = audit({ symbols: [], declarations: [declaration()] });
    expect(gone.map((f) => f.kind)).toEqual(["unknown_symbol"]);
    expect(gone[0]?.detail).toContain("renamed or removed");

    const moved = audit({
      symbols: [symbolFacts({ pkg: "packages/gadgets-pg" })],
      members: [
        memberFacts(),
        memberFacts({ pkg: "packages/gadgets-pg", name: "@crossengin/gadgets-pg" }),
      ],
      declarations: [declaration()],
    });
    // Both findings land, and that is right: one broken declaration, and a class in another member
    // that nothing has decided about. `pg-storeless-tables.ts` makes the same pairing for a
    // `writerless_successor`.
    expect(moved.map((f) => f.kind)).toEqual(["unknown_symbol", "symbol_test_only"]);
    expect(moved[0]?.detail).toContain("exported by packages/gadgets-pg instead");
  });

  it("reports a declaration naming a member this workspace does not have", () => {
    const found = audit({ members: [], declarations: [declaration()] });
    expect(found.map((f) => f.kind)).toEqual(["unknown_package"]);
  });

  it("reports the same subject declared twice", () => {
    const found = audit({
      symbols: [symbolFacts()],
      declarations: [declaration(), declaration({ reason: "unpersisted_record" })],
    });
    expect(found.map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("reports a substitute that is not itself constructed outside tests", () => {
    // `writerless_successor`'s shape: a reason that asserts something positive about another symbol
    // is the reason that rots when that symbol is abandoned too.
    const d = declaration({ reason: "substitute_in_use", substitutedBy: "InMemoryWidgetStore" });
    const found = audit({ symbols: [symbolFacts()], declarations: [d] });
    expect(found.map((f) => f.kind)).toEqual(["unsupported_substitute"]);
    expect(found[0]?.detail).toContain("something else does this job is false");
    expect(
      audit({
        symbols: [symbolFacts()],
        declarations: [d],
        reachableSubstitutes: ["InMemoryWidgetStore"],
      }),
    ).toEqual([]);
  });

  it("reports an offline implementation no test constructs either — the inverted check", () => {
    // Every other reason is checked against a caller; this one is checked for one. A seam
    // implementation nothing builds at all is dead rather than offline, so the reason is wrong.
    const d = declaration({ reason: "offline_implementation" });
    expect(
      audit({ symbols: [symbolFacts({ constructedByTests: [] })], declarations: [d] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["offline_implementation_unconstructed"]);
    expect(audit({ symbols: [symbolFacts()], declarations: [d] })).toEqual([]);
  });

  it("reports a declared table the catalog does not have", () => {
    const found = audit({
      symbols: [symbolFacts()],
      declarations: [declaration({ tables: ["meta.widgets"] })],
    });
    expect(found.map((f) => f.kind)).toEqual(["unknown_table"]);
  });

  it("reports a table the storeless rule also calls writerless — the two rules disagreeing", () => {
    const found = audit({
      symbols: [symbolFacts()],
      declarations: [declaration({ tables: ["meta.widgets"] })],
      catalogTables: ["meta.widgets"],
      storelessTables: ["meta.widgets"],
    });
    expect(found.map((f) => f.kind)).toEqual(["table_declared_storeless"]);
    expect(found[0]?.detail).toContain("disagree about the same table");
  });

  it("every finding kind is reachable", () => {
    const reached = new Set<string>([
      ...audit({ symbols: [symbolFacts()] }).map((f) => f.kind),
      ...audit({ symbols: [symbolFacts({ constructedByTests: [] })] }).map((f) => f.kind),
      ...audit({ members: [memberFacts({ importedBy: [], dependents: [] })] }).map((f) => f.kind),
      ...audit({ members: [memberFacts({ importedBy: [], importedByTests: ["x.test.ts"] })] }).map(
        (f) => f.kind,
      ),
      ...audit({ members: [memberFacts({ importedBy: [] })] }).map((f) => f.kind),
      ...audit({ driverFamilyModules: [moduleFacts()] }).map((f) => f.kind),
      ...audit({
        symbols: [symbolFacts({ constructedBy: ["a.ts"] })],
        declarations: [declaration()],
      }).map((f) => f.kind),
      ...audit({ declarations: [declaration()] }).map((f) => f.kind),
      ...audit({ members: [], declarations: [declaration()] }).map((f) => f.kind),
      ...audit({ modules: [moduleFacts({ present: false })], declarations: [moduleDeclaration()] }).map(
        (f) => f.kind,
      ),
      ...audit({
        modules: [moduleFacts({ exportedNames: [] })],
        declarations: [moduleDeclaration()],
      }).map((f) => f.kind),
      ...audit({
        modules: [moduleFacts({ exportedClasses: ["X"] })],
        declarations: [moduleDeclaration()],
      }).map((f) => f.kind),
      ...audit({ symbols: [symbolFacts()], declarations: [declaration(), declaration()] }).map(
        (f) => f.kind,
      ),
      ...audit({
        symbols: [symbolFacts()],
        declarations: [declaration({ reason: "substitute_in_use", substitutedBy: "InMemoryX" })],
      }).map((f) => f.kind),
      ...audit({
        symbols: [symbolFacts({ constructedByTests: [] })],
        declarations: [declaration({ reason: "offline_implementation" })],
      }).map((f) => f.kind),
      ...audit({
        symbols: [symbolFacts()],
        declarations: [declaration({ tables: ["meta.widgets"] })],
      }).map((f) => f.kind),
      ...audit({
        symbols: [symbolFacts()],
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
    expect(formatUnreachableFindings(audit({ symbols: [symbolFacts()] }))).toContain(
      "[symbol_test_only]",
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
    // Not hypothetical: an ad-hoc scan of this very module read its own doc comment, which contains
    // the literal text `new PostgresTargetingRuleStore(`, as a construction site — and the store read
    // as reachable. Both passes are load-bearing.
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

  it("finds an exported class with its extends clause, abstract or not, and nothing else", () => {
    expect(
      exportedClasses(
        codeOnly(
          [
            "export class PostgresA {}",
            "export abstract class PostgresB extends Base {}",
            "export class Boom extends Error {}",
            "export class Impl implements Seam {}",
            "class PostgresC {}",
          ].join("\n"),
        ),
      ),
    ).toEqual([
      { name: "PostgresA", extendsName: null },
      { name: "PostgresB", extendsName: "Base" },
      { name: "Boom", extendsName: "Error" },
      // `implements` is not `extends`, and reading the clause rather than the whole head is what
      // keeps a seam implementation out of the diagnostic bucket.
      { name: "Impl", extendsName: null },
    ]);
  });

  it("finds only the invocable exports, which is what a classless driver module is asked about", () => {
    // Narrower than `exportedNames` deliberately: three replayers export `DriftIssue` and two
    // export an `EnforcementSummary`, so crediting a module because one of *those* names appears
    // somewhere would make the third accounted-for arm vacuous. A driver is invoked.
    const code = codeOnly(
      [
        "export const KINDS = [] as const;",
        "export interface DriftIssue { a: 1 }",
        "export type Kind = string;",
        "export async function replayIncidents() {}",
        "export function formatIncidentReplayReport() {}",
        "export function* walk() {}",
        "function hidden() {}",
        "export const run = () => {};",
      ].join("\n"),
    );
    expect([...exportedFunctions(code)]).toEqual([
      "replayIncidents",
      "formatIncidentReplayReport",
      "walk",
    ]);
    // The limit, stated rather than hidden: a const-arrow driver is not seen, which leaves its
    // module unaccounted (the safe direction) and fails the family's own invariant assertion.
    expect(exportedFunctions(code)).not.toContain("run");
  });

  it("finds every exported name, so a declared module entrypoint can be checked against reality", () => {
    const names = exportedNames(
      codeOnly(
        [
          "export const KINDS = [] as const;",
          "export type Kind = string;",
          "export interface Report { a: 1 }",
          "export async function replayIncidents() {}",
          "export function formatIncidentReplayReport() {}",
          "function hidden() {}",
          "export { hidden as shown };",
        ].join("\n"),
      ),
    );
    expect([...names].sort()).toEqual([
      "KINDS",
      "Kind",
      "Report",
      "formatIncidentReplayReport",
      "replayIncidents",
      "shown",
    ]);
  });

  it("finds a bare identifier use, which is how a function-shaped entrypoint is asked about", () => {
    expect(
      findIdentifierUses(codeOnly("const r = await replayIncidents(conn);"), new Set(["replayIncidents"])),
    ).toEqual(["replayIncidents"]);
    // Word-bounded, so a longer name is not a use of a shorter one.
    expect(
      findIdentifierUses(codeOnly("replayIncidentsLater();"), new Set(["replayIncidents"])),
    ).toEqual([]);
    // And a mention in prose or in a string is not a use, for the same reason a `new` is not.
    expect(
      findIdentifierUses(codeOnly('// replayIncidents is unused\nconst s = "replayIncidents";'), new Set(["replayIncidents"])),
    ).toEqual([]);
    expect(findIdentifierUses("anything", new Set())).toEqual([]);
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
  const bucketed = (bucket: string): readonly SymbolFacts[] =>
    scan.symbols.filter((s) => classifySymbol(s) === bucket);
  const reachable = bucketed("reachable");
  const unreachable = scan.symbols.filter((s) => {
    const b = classifySymbol(s);
    return b === "test_only" || b === "unconstructed";
  });

  const liveAudit = (
    declarations: readonly UnreachableDeclaration[],
    symbols: readonly SymbolFacts[] = scan.symbols,
  ): ReturnType<typeof auditUnreachableStores> =>
    auditUnreachableStores({
      symbols,
      members: scan.memberFacts,
      modules: scan.modules,
      declarations,
      catalogTables,
      storelessTables,
      reachableSubstitutes: scan.reachableSubstitutes,
      driverFamilyModules: scan.driverFamilyModules,
    });

  it("walked the workspace and resolved every member it should have", () => {
    // **The vacuity guard this rule needs most.** Several of its signals have no live member, so
    // "finds ≥ 1" would be a false floor and a rule asserting nothing is the exact failure this
    // family exists to prevent. The assertion is therefore that the scan *examined and resolved*
    // everything: every root glob understood, a floor of files, a floor of members, and every one
    // landing in a known bucket.
    expect(scan.unhandledGlobs).toEqual([]);
    expect(scan.files).toBeGreaterThanOrEqual(1700);
    expect(scan.members.length).toBeGreaterThanOrEqual(88);
    expect(new Set(scan.memberFacts.map((m) => m.pkg)).size).toBe(scan.memberFacts.length);
    for (const member of scan.memberFacts) {
      expect(MEMBER_REACHABILITIES).toContain(classifyMember(member));
      expect(member.name, member.pkg).toBe(`@crossengin/${member.pkg.split("/")[1] ?? ""}`);
    }
    for (const facts of scan.symbols) expect(SYMBOL_REACHABILITIES).toContain(classifySymbol(facts));
    // Both `-pg` and `-runtime-pg` are present, and so are apps and non-pg packages, so none of the
    // three widenings is quietly matching nothing.
    const dirs = scan.memberFacts.map((m) => m.pkg);
    expect(dirs).toContain("packages/kernel-pg");
    expect(dirs).toContain("packages/workflow-runtime-pg");
    expect(dirs).toContain("packages/observability-runtime");
    expect(dirs).toContain("apps/operate-server");
  });

  it("reads apps/operate-web, which has no src/ and was the stated reason apps were out of scope", () => {
    // ADR-0336 declared `apps/*` out of scope and named this specific hole: a walk hardcoding
    // `<member>/src` misses a Next app entirely. The floor is on this one member because a walk that
    // silently stopped reaching it would take all 43 of its files with it and still pass every
    // other assertion here.
    expect(scan.filesByMember.get("apps/operate-web") ?? 0).toBeGreaterThanOrEqual(30);
    expect(existsSync(join(REPO_ROOT, "apps/operate-web", "src"))).toBe(false);
    // And it is exempt by a fact rather than by its name: it publishes no `main` and no `.` export.
    const web = scan.memberFacts.find((m) => m.pkg === "apps/operate-web");
    expect(web?.isImportable).toBe(false);
    expect(web === undefined ? "missing" : classifyMember(web)).toBe("not_importable");
  });

  it("found most classes reachable, which is the direction that would be catastrophic to get wrong", () => {
    // A site matcher that stopped matching would report every class unreachable — over-reporting is
    // the direction that fails CI on correct code, so the floor is on the *reachable* count, and the
    // widened predicate makes that worse rather than better: there are five times as many candidates
    // now. The ceiling on the other side is deliberately loose: wiring lowers it, and a legitimately
    // declared new member must not break it, so it guards only against a collapse.
    expect(scan.symbols.length).toBeGreaterThanOrEqual(280);
    expect(reachable.length).toBeGreaterThanOrEqual(240);
    expect(unreachable.length).toBeLessThanOrEqual(40);
    // ADR-0335's wiring, pinned: `PostgresRateLimitChecker` was one of api-gateway-pg's four
    // callerless stores until that increment constructed it in `node.ts`. If it ever goes back to
    // test-only, this rule should be the thing that says so.
    const checker = scan.symbols.find((s) => s.symbol === "PostgresRateLimitChecker");
    expect(checker).toBeDefined();
    expect(checker === undefined ? "missing" : classifySymbol(checker)).toBe("reachable");
  });

  it("both mechanical exemptions have live members and neither is over-reaching", () => {
    // An exemption over a convention nobody uses would be a dead branch; one that swallowed the
    // fence's own population would be a muted rule. Both sides asserted.
    const diagnostics = bucketed("diagnostic_type");
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.length).toBeLessThanOrEqual(30);
    for (const facts of diagnostics) expect(isErrorBase(facts.extendsName), facts.symbol).toBe(true);

    const surface = bucketed("test_surface");
    expect(surface.length).toBeGreaterThanOrEqual(4);
    expect(surface.length).toBeLessThanOrEqual(40);
    for (const facts of surface) {
      expect(facts.foreignTestMembers.length, facts.symbol).toBeGreaterThan(0);
      // The hole closed where it would matter: persistence is never public test surface.
      expect(facts.pkg.endsWith("-pg"), facts.symbol).toBe(false);
    }
  });

  it("the contracts_only exemption has live members and never swallows a -pg member", () => {
    const contracts = scan.memberFacts.filter((m) => classifyMember(m) === "contracts_only");
    // Two-sided: these thirteen cost no declaration lines, and if the driver-class scan broke every
    // member would land here and the rule would pass having examined nothing.
    expect(contracts.length).toBeGreaterThanOrEqual(8);
    expect(contracts.length).toBeLessThanOrEqual(30);
    for (const member of contracts) {
      expect(member.driverClasses, member.pkg).toEqual([]);
      expect(member.pkg.endsWith("-pg"), member.pkg).toBe(false);
    }
    // The named live member of this exemption's own blind spot, pinned so it cannot be forgotten:
    // `packages/deploy` holds the workspace's only `evaluateFlag()` and exports no class.
    const deploy = scan.memberFacts.find((m) => m.pkg === "packages/deploy");
    expect(deploy?.driverClasses).toEqual([]);
    expect(deploy === undefined ? "missing" : classifyMember(deploy)).toBe("contracts_only");
  });

  it("attributes every construction it can see, reports colliding names, and hides nothing dynamic", () => {
    // Zero dynamic constructions today. Asserted as a tripwire rather than an equality: the day a
    // store is constructed through `new (map[kind])()` this scan cannot attribute it, and the honest
    // failure is here rather than in a silent "reachable".
    expect(scan.dynamic.filter((d) => d.snippet.includes("Postgres"))).toEqual([]);
    expect(scan.dynamic.length).toBeLessThanOrEqual(20);
    // Collisions are real now that the predicate is every class: eight members each declare
    // `FixedClock`. They are reported rather than asserted empty, and the direction is conservative —
    // a shared site makes every copy read reachable, so the rule can only under-report.
    expect(scan.collidingSymbols.length).toBeLessThanOrEqual(12);
    const colliding = new Set(scan.collidingSymbols.map((s) => s.slice(0, s.indexOf(":"))));
    expect(colliding.has("FixedClock")).toBe(true);
    for (const facts of scan.symbols) {
      expect(facts.alsoDeclaredBy.includes(facts.pkg), facts.symbol).toBe(false);
      if (facts.alsoDeclaredBy.length > 0) expect(colliding.has(facts.symbol)).toBe(true);
    }
  });

  it("no exported class is unreachable without a declaration saying why", () => {
    // The assertion this file exists for. A component built, tested and never connected is a failure
    // at the moment it lands, rather than a defect somebody finds by grepping three increments later.
    expect(formatUnreachableFindings(liveAudit(UNREACHABLE_STORES))).toBe("");
  });

  it("declares exactly the unreachable classes, and every declaration parses", () => {
    const declared = new Set(UNREACHABLE_STORES.map((d) => subjectOf(d)));
    expect(declared.size).toBe(UNREACHABLE_STORES.length);
    for (const d of UNREACHABLE_STORES) {
      expect(() => UnreachableDeclarationSchema.parse(d)).not.toThrow();
    }
    // Both directions, as plain set equality over subjects. The count is deliberately *not* asserted
    // — several of these are being wired as this lands, and a number here would make a correct
    // wiring commit fail for the wrong reason. The list is the only place a name is written down.
    const symbolSubjects = UNREACHABLE_STORES.filter((d) => d.scope === "symbol").map((d) =>
      subjectOf(d),
    );
    expect(symbolSubjects.slice().sort()).toEqual(
      unreachable.map((s) => `${s.pkg}:${s.symbol}`).sort(),
    );
  });

  it("every declaration names a member, a class or a file, and a path that exists", () => {
    for (const d of UNREACHABLE_STORES) {
      expect(existsSync(join(REPO_ROOT, d.pkg)), d.pkg).toBe(true);
      if (d.module !== undefined) {
        expect(existsSync(join(REPO_ROOT, d.pkg, d.module)), `${d.pkg}/${d.module}`).toBe(true);
        continue;
      }
      if (d.symbol === undefined) continue;
      const facts = scan.symbols.find((s) => s.symbol === d.symbol && s.pkg === d.pkg);
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
      expect(adrs.some((f) => f.startsWith(`${number}-`)), `${id} has no file in docs/adr`).toBe(true);
    }
  });

  it("every declared table is catalogued, and the two SQL rules agree about it", () => {
    // The join between this rule and `pg-storeless-tables.ts`, and the reason both are needed: that
    // rule reads a store's SQL as a writer, so a store with no caller makes its table read as
    // **written** while no deployment has ever put a row in it. A table in both lists would mean
    // the two disagree, and the audit reports it.
    const tables = UNREACHABLE_STORES.flatMap((d) => d.tables ?? []);
    expect(tables.length).toBeGreaterThanOrEqual(5);
    for (const table of tables) {
      expect(catalogTables, table).toContain(table);
      expect(storelessTables, table).not.toContain(table);
    }
  });

  it("every substitute a declaration names is itself constructed outside tests", () => {
    const substitutes = UNREACHABLE_STORES.flatMap((d) =>
      d.substitutedBy === undefined ? [] : [d.substitutedBy],
    );
    expect(substitutes.length).toBeGreaterThanOrEqual(1);
    for (const name of substitutes) expect(scan.reachableSubstitutes, name).toContain(name);
  });

  it("the driver family is real, the glob still matches, and the class parse has not collapsed", () => {
    // **Two-sided, and the two sides guard different things since the third accounted-for arm
    // landed.** The floor is on how many members the glob finds: a file-level predicate that stopped
    // matching reports nothing and passes silently, which is the opposite failure from the
    // over-reporting the reachable-symbol floor guards. The ceiling on *classless* members no longer
    // says anything about accounting — a classless module can be accounted for by being referenced —
    // so what it guards now is the **class parse**: if `exportedClasses` stopped matching, all six
    // would read classless at once and three of this file's other assertions would still pass.
    expect([...DRIVER_MODULE_FAMILIES]).toEqual(["replayer.ts"]);
    expect(scan.driverFamilyModules.length).toBeGreaterThanOrEqual(6);
    const classless = scan.driverFamilyModules.filter((m) => m.exportedClasses.length === 0);
    expect(classless.length).toBeLessThanOrEqual(3);
    // Every member must have something the third arm can ask about, so the "nothing to ask" branch
    // stays a tripwire rather than a silent pass-through: a const-arrow driver joining the family
    // fails here, naming the module, instead of being reported as unreferenced.
    for (const module of scan.driverFamilyModules) {
      expect(module.present, `${module.pkg}/${module.module}`).toBe(true);
      expect(module.exportedFunctions.length, `${module.pkg}/${module.module}`).toBeGreaterThan(0);
    }
    // The fifth blind spot's named live member, pinned by both halves of what makes it invisible to
    // a `new X(` scan: no class, and a driver that is a function.
    const incident = scan.driverFamilyModules.find(
      (m) => m.pkg === "packages/incident-response-runtime-pg",
    );
    expect(incident?.module).toBe("src/replayer.ts");
    expect(incident?.exportedClasses).toEqual([]);
    expect(incident?.exportedFunctions).toContain("replayIncidents");
  });

  it("would catch a classless driver module that nothing runs, and clears one that something does", () => {
    // The control pair that replaces a count, so the arm's liveness does not depend on which
    // replayers happen to be wired this week. Built from the **real** scan: take the one classless
    // family module the workspace has and flip the only fact that accounts for it.
    const incident = scan.driverFamilyModules.find((m) => m.exportedClasses.length === 0);
    expect(incident).toBeDefined();
    const others = scan.driverFamilyModules.filter(
      (m) => !(m.pkg === incident?.pkg && m.module === incident?.module),
    );
    const withFamily = (
      family: readonly ModuleFacts[],
    ): readonly string[] =>
      auditUnreachableStores({
        symbols: scan.symbols,
        members: scan.memberFacts,
        modules: scan.modules,
        declarations: UNREACHABLE_STORES,
        catalogTables,
        storelessTables,
        reachableSubstitutes: scan.reachableSubstitutes,
        driverFamilyModules: family,
      }).map((f) => `${f.kind}:${f.subject}`);

    const unrun = ModuleFactsSchema.parse({ ...(incident ?? moduleFacts()), usedBy: [], usedNames: [] });
    expect(withFamily([...others, unrun])).toEqual([
      `driver_module_unaccounted:${unrun.pkg}::${unrun.module}`,
    ]);
    const run = ModuleFactsSchema.parse({
      ...(incident ?? moduleFacts()),
      usedBy: ["apps/operate-server/src/node.ts"],
      usedNames: [incident?.exportedFunctions[0] ?? "replayIncidents"],
    });
    expect(withFamily([...others, run])).toEqual([]);
  });

  it("would catch the defect it was written for, in both directions", () => {
    // The fence finding nothing is indistinguishable from the fence being broken, so the controls are
    // built from the *real* scan rather than from a name that a concurrent wiring commit could move.
    //
    // One: a reachable class whose non-test sites are taken away must be reported.
    const victim = reachable[0];
    expect(victim).toBeDefined();
    const stripped = SymbolFactsSchema.parse({
      ...(victim ?? symbolFacts()),
      constructedBy: [],
      constructedByTests: ["packages/x/src/x.test.ts"],
      // Both exemptions neutralised, so the control exercises the fence rather than a bucket.
      extendsName: null,
      foreignTestMembers: [],
    });
    const others = scan.symbols.filter(
      (s) => !(s.symbol === stripped.symbol && s.pkg === stripped.pkg),
    );
    expect(
      liveAudit(UNREACHABLE_STORES, [...others, stripped]).map((f) => `${f.kind}:${f.subject}`),
    ).toEqual([`symbol_test_only:${stripped.pkg}:${stripped.symbol}`]);

    // Two: a class with a live caller cannot be parked as unreachable.
    const parked = UnreachableDeclarationSchema.parse({
      scope: "symbol",
      pkg: victim?.pkg ?? "packages/widgets-pg",
      symbol: victim?.symbol ?? "PostgresWidgetStore",
      reason: "unpersisted_record",
      tables: [],
      consequence: "a false claim, written to prove the rule reads the workspace",
      note: "a false claim, written to prove the rule reads the workspace",
    });
    expect(liveAudit([...UNREACHABLE_STORES, parked]).map((f) => `${f.kind}:${f.subject}`)).toEqual([
      `overtaken:${parked.pkg}:${parked.symbol}`,
    ]);
  });

  it("would catch a member nobody imports, which is the signal with one live member", () => {
    // `api-gateway-pg` is the right victim: this is literally its state before ADR-0335, and it
    // exports driver classes, so it cannot fall into the `contracts_only` exemption.
    const gateway = scan.memberFacts.find((m) => m.pkg === "packages/api-gateway-pg");
    expect(gateway).toBeDefined();
    expect(gateway?.driverClasses.length ?? 0).toBeGreaterThan(0);
    const orphaned = MemberFactsSchema.parse({
      ...(gateway ?? memberFacts()),
      dependents: [],
      importedBy: [],
      importedByTests: [],
    });
    const findings = auditUnreachableStores({
      symbols: [],
      members: [orphaned],
      modules: [],
      declarations: [],
      catalogTables,
      storelessTables,
      reachableSubstitutes: scan.reachableSubstitutes,
      driverFamilyModules: [],
    });
    expect(findings.map((f) => `${f.kind}:${f.subject}`)).toEqual([
      "member_unimported:packages/api-gateway-pg",
    ]);
  });

  it("the test-module convention it relies on is real and in use", () => {
    // `isTestSite`'s `test-*.ts` half is insurance against a hole nothing currently falls into, and
    // insurance over a convention that does not exist would be a dead branch.
    const withFakes = readdirSync(join(REPO_ROOT, "packages")).filter((pkg) =>
      existsSync(join(REPO_ROOT, "packages", pkg, "src", "test-fakes.ts")),
    );
    expect(withFakes.length).toBeGreaterThanOrEqual(8);
    for (const pkg of withFakes) expect(isTestSite(`packages/${pkg}/src/test-fakes.ts`)).toBe(true);
  });
});

/* ------------------------------------------------- the second list, both ways */

describe("the callerless flag-store list", () => {
  const scan = scanWorkspaceStores();
  const flagSymbols = scan.symbols.filter((s) => s.pkg === FLAG_MEMBER);
  const listed = readCallerlessFlagStores();

  it("reads that list out of its own declaration and nothing beside it", () => {
    // Bounded to the `Object.freeze([...])` after the name, for `readProtectedTables`' reason:
    // `EXPORTED_STORE_SYMBOLS` sits a few lines below and names all three of the package's stores
    // *including the reachable one*, so a loose scan would pick up `PostgresKillSwitchStore` from the
    // wrong declaration and invert the comparison.
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed).not.toContain("PostgresKillSwitchStore");
    expect(existsSync(join(REPO_ROOT, FLAG_SURVEY_PATH))).toBe(true);
    // A parse whose failure mode is "found nothing" would make this comparison vacuous in exactly
    // the case it exists for, so it refuses instead.
    expect(() => readCallerlessFlagStores(join(REPO_ROOT, "docs"))).toThrow();
  });

  it("agrees with this scan and with UNREACHABLE_STORES, in both directions", () => {
    // Three facts compared, not two: comparing the two lists alone would pass while both were stale
    // together. ADR-0336 shipped them with no comparison at all, which is ADR-0288's shape.
    expect(flagSymbols.length).toBeGreaterThanOrEqual(3);
    expect(
      auditCallerlessFlagLists({
        listed,
        symbols: flagSymbols,
        declarations: UNREACHABLE_STORES,
      }),
    ).toEqual([]);
  });

  it("would catch each way the two lists can drift apart", () => {
    const base = { symbols: flagSymbols, declarations: UNREACHABLE_STORES };
    // That list names something this scan calls reachable.
    expect(
      auditCallerlessFlagLists({ ...base, listed: [...listed, "PostgresKillSwitchStore"] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["flag_list_overtaken"]);
    // That list names something nothing exports.
    expect(
      auditCallerlessFlagLists({ ...base, listed: [...listed, "PostgresGhostStore"] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["flag_list_unknown_symbol"]);
    // That list has a gap this scan can see — and the same omission is also a disagreement with
    // UNREACHABLE_STORES, so both findings land and they are different facts.
    const dropped = auditCallerlessFlagLists({ ...base, listed: listed.slice(1) });
    expect(dropped.map((f) => f.kind).sort()).toEqual(["flag_list_incomplete", "flag_lists_disagree"]);
    expect(dropped.every((f) => f.symbol === listed[0])).toBe(true);
    // And the reverse direction: declared here, absent there.
    const extra = UnreachableDeclarationSchema.parse({
      scope: "symbol",
      pkg: FLAG_MEMBER,
      symbol: "PostgresKillSwitchStore",
      reason: "unpersisted_record",
      tables: [],
      consequence: "a false claim, written to prove the cross-check reads both lists",
      note: "a false claim, written to prove the cross-check reads both lists",
    });
    expect(
      auditCallerlessFlagLists({ ...base, listed, declarations: [...UNREACHABLE_STORES, extra] }).map(
        (f) => `${f.kind}:${f.symbol}`,
      ),
    ).toEqual(["flag_lists_disagree:PostgresKillSwitchStore"]);
  });

  it("every flag-list finding kind is reachable", () => {
    const reached = new Set<string>([
      ...auditCallerlessFlagLists({
        listed: [...listed, "PostgresKillSwitchStore"],
        symbols: flagSymbols,
        declarations: UNREACHABLE_STORES,
      }).map((f) => f.kind),
      ...auditCallerlessFlagLists({
        listed: [...listed, "PostgresGhostStore"],
        symbols: flagSymbols,
        declarations: UNREACHABLE_STORES,
      }).map((f) => f.kind),
      ...auditCallerlessFlagLists({
        listed: listed.slice(1),
        symbols: flagSymbols,
        declarations: UNREACHABLE_STORES,
      }).map((f) => f.kind),
    ]);
    expect([...reached].sort()).toEqual([...FLAG_LIST_FINDING_KINDS].sort());
  });
});
