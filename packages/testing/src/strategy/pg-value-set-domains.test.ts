import { describe, expect, it } from "vitest";

import { parseCatalogSource, type CatalogTable } from "./pg-column-coverage.js";
import { STORELESS_TABLES } from "./pg-storeless-tables.js";
import {
  auditColumnDefaults,
  auditValueSetDomains,
  catalogValueSets,
  collectSymbolDeclarations,
  collectWorkspaceDomains,
  DOMAIN_LINK_KINDS,
  DOMAIN_LINK_MEANINGS,
  DOMAIN_SITE_KINDS,
  formatColumnDefaultFindings,
  formatValueSetFindings,
  VALUE_SET_DOMAINS,
  VALUE_SET_FINDING_KINDS,
  VALUE_SET_SHAPES,
  ValueSetDomainDeclarationSchema,
  type CatalogValueSet,
  type SymbolDeclaration,
  type ValueSetDomainDeclaration,
  type WorkspaceDomain,
} from "./pg-value-set-domains.js";
import {
  readCatalogSource,
  readWorkspaceSources,
  type WorkspaceSourceFile,
} from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function source(file: string, text: string, pkg = "@crossengin/widgets"): WorkspaceSourceFile {
  return { package: pkg, file, text };
}

function table(over: Partial<CatalogTable> = {}): CatalogTable {
  return {
    schema: "meta",
    name: "widgets",
    columns: [
      {
        name: "status",
        notNull: true,
        hasDefault: false,
        check: "status IN ('open', 'closed')",
        defaultExpression: null,
      },
    ],
    policies: [],
    ...over,
  };
}

function domain(over: Partial<WorkspaceDomain> = {}): WorkspaceDomain {
  return {
    package: "@crossengin/widgets",
    name: "WIDGET_STATUSES",
    kind: "constant",
    file: "packages/widgets/src/widgets.ts",
    line: 3,
    members: ["open", "closed"],
    ...over,
  };
}

function declaration(over: Partial<ValueSetDomainDeclaration> = {}): ValueSetDomainDeclaration {
  return {
    table: "widgets",
    column: "status",
    link: "mirrors",
    ref: "@crossengin/widgets:WIDGET_STATUSES",
    ...over,
  };
}

function audit(
  over: {
    readonly valueSets?: readonly CatalogValueSet[];
    readonly domains?: readonly WorkspaceDomain[];
    readonly declarations?: readonly ValueSetDomainDeclaration[];
    readonly symbols?: readonly SymbolDeclaration[];
    readonly checkedColumns?: ReadonlySet<string>;
  } = {},
): readonly string[] {
  const valueSets = over.valueSets ?? catalogValueSets([table()]);
  return auditValueSetDomains({
    valueSets,
    domains: over.domains ?? [domain()],
    declarations: over.declarations ?? [declaration()],
    symbols: over.symbols ?? [],
    checkedColumns:
      over.checkedColumns ?? new Set(valueSets.map((v) => `${v.table}.${v.column}`)),
  }).map((f) => f.kind);
}

/* ------------------------------------------------------------------ constants */

describe("the vocabulary", () => {
  it("has three link kinds and no fourth", () => {
    // A `widens` kind would ship with zero members. The finding `catalog_exceeds_contract` names
    // the condition if one ever arrives; a link kind nobody uses is a guess.
    expect(DOMAIN_LINK_KINDS).toEqual(["mirrors", "narrows", "catalog_only"]);
  });

  it("gives every link kind a meaning, and every meaning a key", () => {
    expect(Object.keys(DOMAIN_LINK_MEANINGS).sort()).toEqual([...DOMAIN_LINK_KINDS].sort());
    for (const [kind, meaning] of Object.entries(DOMAIN_LINK_MEANINGS)) {
      expect(meaning.length).toBeGreaterThan(40);
      // A meaning that only restates its own key explains nothing.
      expect(meaning.replace(/[^a-z ]/g, "").trim()).not.toBe(kind.replace(/_/g, " "));
    }
  });

  it("names three domain sites and two value-set shapes", () => {
    expect(DOMAIN_SITE_KINDS).toEqual(["constant", "schema_enum", "schema_field"]);
    expect(VALUE_SET_SHAPES).toEqual(["in_list", "equality"]);
  });

  it("has a distinct finding kind per failure", () => {
    expect(new Set(VALUE_SET_FINDING_KINDS).size).toBe(VALUE_SET_FINDING_KINDS.length);
  });
});

/* --------------------------------------------------------------- catalog side */

describe("catalogValueSets", () => {
  it("reads an IN list", () => {
    expect(catalogValueSets([table()])).toEqual([
      {
        table: "widgets",
        column: "status",
        shape: "in_list",
        values: ["open", "closed"],
        defaultExpression: null,
      },
    ]);
  });

  it("reads the `col IS NULL OR col IN (…)` prefix the catalog carries on 29 columns", () => {
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "status",
            notNull: false,
            hasDefault: false,
            check: "status IS NULL OR status IN ('open', 'closed')",
            defaultExpression: null,
          },
        ],
      }),
    ]);
    expect(sets[0]?.values).toEqual(["open", "closed"]);
  });

  it("reads a one-member set written as an equality", () => {
    // `col = 'x'` is a value set of one, and the day its contract gains a second member the catalog
    // widens to an IN list. Treating it as something else would exempt it at exactly that moment.
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "algo",
            notNull: true,
            hasDefault: false,
            check: "algo = 'hmac-sha256'",
            defaultExpression: null,
          },
        ],
      }),
    ]);
    expect(sets).toEqual([
      {
        table: "widgets",
        column: "algo",
        shape: "equality",
        values: ["hmac-sha256"],
        defaultExpression: null,
      },
    ]);
  });

  it("folds a doubled apostrophe back to one", () => {
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "status",
            notNull: true,
            hasDefault: false,
            check: "status IN ('won''t_fix', 'done')",
            defaultExpression: null,
          },
        ],
      }),
    ]);
    expect(sets[0]?.values).toEqual(["won't_fix", "done"]);
  });

  it("ignores a check that is not a value set rather than reporting it", () => {
    // Ranges, patterns and cross-column comparisons are `check-admission.ts`'s taxonomy; a second
    // copy of it here would give two answers to one question.
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "n",
            notNull: true,
            hasDefault: false,
            check: "n >= 0",
            defaultExpression: null,
          },
          {
            name: "v",
            notNull: true,
            hasDefault: false,
            check: "v ~ '^[0-9]+$'",
            defaultExpression: null,
          },
          {
            name: "a",
            notNull: true,
            hasDefault: false,
            check: "a <> b",
            defaultExpression: null,
          },
        ],
      }),
    ]);
    expect(sets).toEqual([]);
  });

  it("ignores an IN list over a different column than the one declaring it", () => {
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "status",
            notNull: true,
            hasDefault: false,
            check: "kind IN ('open', 'closed')",
            defaultExpression: null,
          },
        ],
      }),
    ]);
    expect(sets).toEqual([]);
  });
});

/* -------------------------------------------------------------- domain scan */

describe("collectWorkspaceDomains", () => {
  it("reads an exported as-const array", () => {
    const { domains } = collectWorkspaceDomains([
      source("packages/widgets/src/a.ts", `export const WIDGET_STATUSES = ["open", "closed"] as const;`),
    ]);
    expect(domains).toEqual([
      {
        package: "@crossengin/widgets",
        name: "WIDGET_STATUSES",
        kind: "constant",
        file: "packages/widgets/src/a.ts",
        line: 1,
        members: ["open", "closed"],
      },
    ]);
  });

  it("requires `as const`, so a mutable list is not a domain", () => {
    const { domains } = collectWorkspaceDomains([
      source("packages/widgets/src/a.ts", `export const DEFAULTS = ["open", "closed"];`),
    ]);
    expect(domains).toEqual([]);
  });

  it("resolves a spread, including across files", () => {
    const { domains, unresolved } = collectWorkspaceDomains([
      source("packages/widgets/src/a.ts", `export const MAC = ["hmac-sha256"] as const;`),
      source("packages/widgets/src/b.ts", `export const SIG = ["ed25519"] as const;`),
      source(
        "packages/widgets/src/c.ts",
        `export const ALL = [...MAC, ...SIG, "x25519"] as const;`,
      ),
    ]);
    expect(unresolved).toEqual([]);
    expect(domains.find((d) => d.name === "ALL")?.members).toEqual([
      "hmac-sha256",
      "ed25519",
      "x25519",
    ]);
  });

  it("reports an unresolvable spread rather than dropping the array", () => {
    const { domains, unresolved } = collectWorkspaceDomains([
      source("packages/widgets/src/a.ts", `export const ALL = [...ELSEWHERE, "x"] as const;`),
    ]);
    expect(domains).toEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.reason).toContain("ELSEWHERE");
  });

  it("resolves an alias, and drops one whose target is not an array", () => {
    // `export const TENANT_STATUSES = TENANT_LIFECYCLE_STATES` is a real alias in the repo, and
    // `export const DATA_KEY_BYTES = AEAD_KEY_BYTES` is a number. Whether the target names an array
    // is only knowable once every file is read, so an alias that does not resolve is dropped rather
    // than reported — it was never a domain.
    const { domains, unresolved } = collectWorkspaceDomains([
      source("packages/widgets/src/a.ts", `export const BASE = ["open"] as const;`),
      source(
        "packages/widgets/src/b.ts",
        `export const ALIAS = BASE;\nexport const BYTES = SOME_NUMBER;`,
      ),
    ]);
    expect(unresolved).toEqual([]);
    expect(domains.find((d) => d.name === "ALIAS")?.members).toEqual(["open"]);
    expect(domains.map((d) => d.name)).not.toContain("BYTES");
  });

  it("reads an exported z.enum bound straight to a name", () => {
    const { domains } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `export const DeadLetterReasonSchema = z.enum(["timeout", "cancelled"]);`,
      ),
    ]);
    expect(domains).toEqual([
      {
        package: "@crossengin/widgets",
        name: "DeadLetterReasonSchema",
        kind: "schema_enum",
        file: "packages/widgets/src/a.ts",
        line: 1,
        members: ["timeout", "cancelled"],
      },
    ]);
  });

  it("reads a schema field, whether inline or by reference", () => {
    const { domains } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `export const KINDS = ["a", "b"] as const;\n` +
          `export const WidgetSchema = z.object({\n` +
          `  kind: z.enum(KINDS),\n` +
          `  engine: z.enum(["postgres", "clickhouse"]).default("postgres"),\n` +
          `});`,
      ),
    ]);
    expect(domains.find((d) => d.name === "WidgetSchema.kind")?.members).toEqual(["a", "b"]);
    expect(domains.find((d) => d.name === "WidgetSchema.engine")?.members).toEqual([
      "postgres",
      "clickhouse",
    ]);
  });

  it("resolves a module-private constant for a field without offering it as a ref", () => {
    // `MANIFEST_PROPOSAL_SOURCES` and `operate-runtime`'s `ENTITLEMENT_STATUSES` are both private and
    // both type an exported schema's field. Without reading them the field is unresolvable; offering
    // them as refs would name something the package does not export.
    const { domains, unresolved } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `const SOURCES = ["ai", "manual"] as const;\n` +
          `export const ProposalSchema = z.object({ source: z.enum(SOURCES) });`,
      ),
    ]);
    expect(unresolved).toEqual([]);
    expect(domains.map((d) => d.name)).toEqual(["ProposalSchema.source"]);
  });

  it("follows the import when a name is declared in several packages", () => {
    // `DATA_CLASSES` is declared in three packages. Without the import step every field typed with
    // it resolves to nothing, and four catalogued columns read as undeclarable.
    const files = [
      source("packages/dr/src/a.ts", `export const DATA_CLASSES = ["public"] as const;`, "@crossengin/dr"),
      source(
        "packages/jobs/src/a.ts",
        `export const DATA_CLASSES = ["public", "pii"] as const;`,
        "@crossengin/jobs",
      ),
      source(
        "packages/files/src/a.ts",
        `import { DATA_CLASSES } from "@crossengin/jobs";\n` +
          `export const FileSchema = z.object({ dataClass: z.enum(DATA_CLASSES) });`,
        "@crossengin/files",
      ),
    ];
    const { domains } = collectWorkspaceDomains(files);
    expect(domains.find((d) => d.name === "FileSchema.dataClass")?.members).toEqual([
      "public",
      "pii",
    ]);
  });

  it("refuses a name bound twice in one file to different contents", () => {
    // The scan has no scoping, so a module-level constant and a function-local one of the same name
    // are two bindings. Keeping the last would be a confident wrong answer about which domain types
    // the field, so the name becomes unresolvable and the field is reported.
    const { domains, unresolved } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `const KINDS = ["a", "b"] as const;\n` +
          `function inner(): void { const KINDS = ["c"] as const; void KINDS; }\n` +
          `export const WidgetSchema = z.object({ kind: z.enum(KINDS) });`,
      ),
    ]);
    expect(domains.map((d) => d.name)).toEqual([]);
    expect(unresolved.map((u) => u.name)).toEqual(["WidgetSchema.kind"]);
  });

  it("reports a field whose enum it cannot read", () => {
    const { unresolved } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `export const WidgetSchema = z.object({ kind: z.enum(SOMETHING_ELSE) });`,
      ),
    ]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.name).toBe("WidgetSchema.kind");
  });

  it("does not read a commented-out array as a domain", () => {
    // A scan over source must strip comments before it believes a match: ADR-0337's own widened
    // scan read this repository's doc comment as a construction site.
    const { domains } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `// export const GHOST = ["a"] as const;\n/* export const ALSO = ["b"] as const; */\n`,
      ),
    ]);
    expect(domains).toEqual([]);
  });

  it("stops one schema's fields leaking into the next", () => {
    const { domains } = collectWorkspaceDomains([
      source(
        "packages/widgets/src/a.ts",
        `export const OneSchema = z.object({ a: z.enum(["x"]) });\n` +
          `export const TwoSchema = z.object({ b: z.enum(["y"]) });`,
      ),
    ]);
    expect(domains.map((d) => d.name).sort()).toEqual(["OneSchema.a", "TwoSchema.b"]);
  });
});

/* -------------------------------------------------------------- declarations */

describe("the declaration shape", () => {
  it("accepts a mirrors link with nothing else", () => {
    expect(ValueSetDomainDeclarationSchema.safeParse(declaration()).success).toBe(true);
  });

  it("refuses a mirrors or narrows link with no ref", () => {
    expect(ValueSetDomainDeclarationSchema.safeParse(declaration({ ref: null })).success).toBe(
      false,
    );
  });

  it("refuses a catalog_only link that names a domain, or gives no reason", () => {
    expect(
      ValueSetDomainDeclarationSchema.safeParse(
        declaration({ link: "catalog_only", because: "x".repeat(25) }),
      ).success,
    ).toBe(false);
    expect(
      ValueSetDomainDeclarationSchema.safeParse(declaration({ link: "catalog_only", ref: null }))
        .success,
    ).toBe(false);
    expect(
      ValueSetDomainDeclarationSchema.safeParse(
        declaration({ link: "catalog_only", ref: null, because: "x".repeat(25) }),
      ).success,
    ).toBe(true);
  });

  it("refuses a narrows link missing any of except, guardedBy or because", () => {
    const base = { ...declaration({ link: "narrows" }) };
    expect(ValueSetDomainDeclarationSchema.safeParse(base).success).toBe(false);
    expect(
      ValueSetDomainDeclarationSchema.safeParse({ ...base, except: ["x"] }).success,
    ).toBe(false);
    expect(
      ValueSetDomainDeclarationSchema.safeParse({
        ...base,
        except: ["x"],
        guardedBy: "@crossengin/widgets:Guard",
      }).success,
    ).toBe(false);
    expect(
      ValueSetDomainDeclarationSchema.safeParse({
        ...base,
        except: ["x"],
        guardedBy: "@crossengin/widgets:Guard",
        because: "y".repeat(25),
      }).success,
    ).toBe(true);
  });

  it("refuses except or guardedBy on a link that is not narrows", () => {
    expect(
      ValueSetDomainDeclarationSchema.safeParse(declaration({ except: ["x"] })).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------- the audit */

describe("auditValueSetDomains", () => {
  it("is silent when a mirrors link matches exactly", () => {
    expect(audit()).toEqual([]);
  });

  it("reports a value the contract emits and the CHECK refuses", () => {
    expect(audit({ domains: [domain({ members: ["open", "closed", "archived"] })] })).toEqual([
      "contract_exceeds_catalog",
    ]);
  });

  it("reports a value the CHECK admits and nothing emits", () => {
    expect(audit({ domains: [domain({ members: ["open"] })] })).toEqual([
      "catalog_exceeds_contract",
    ]);
  });

  it("reports both directions for a disjoint domain, which is how META_DEPLOYMENTS drifted", () => {
    expect(audit({ domains: [domain({ members: ["a", "b"] })] })).toEqual([
      "contract_exceeds_catalog",
      "catalog_exceeds_contract",
    ]);
  });

  it("reports a value-set CHECK nothing declares", () => {
    expect(audit({ declarations: [] })).toEqual(["undeclared"]);
  });

  it("separates a declaration for a column with no CHECK from one for a column with a range", () => {
    expect(
      audit({
        declarations: [declaration({ column: "n" })],
        checkedColumns: new Set(["widgets.n"]),
      }),
    ).toContain("not_a_value_set");
    expect(
      audit({ declarations: [declaration({ column: "n" })], checkedColumns: new Set() }),
    ).toContain("unknown_column");
  });

  it("reports a duplicate declaration rather than letting array order decide", () => {
    expect(audit({ declarations: [declaration(), declaration()] })).toEqual([
      "duplicate_declaration",
    ]);
  });

  it("reports a ref that resolves to nothing, or to more than one domain", () => {
    expect(audit({ declarations: [declaration({ ref: "@crossengin/widgets:GONE" })] })).toEqual([
      "ref_unresolved",
    ]);
    expect(audit({ declarations: [declaration({ ref: "no-colon" })] })).toEqual([
      "ref_unresolved",
    ]);
    expect(
      audit({ domains: [domain(), domain({ file: "packages/widgets/src/b.ts" })] }),
    ).toEqual(["ref_ambiguous"]);
  });

  it("reports a narrowing whose except names members the domain does not have", () => {
    const kinds = audit({
      domains: [domain({ members: ["open", "closed", "archived"] })],
      declarations: [
        declaration({
          link: "narrows",
          except: ["archived", "ghost"],
          guardedBy: "@crossengin/widgets:Guard",
          because: "z".repeat(25),
        }),
      ],
      symbols: [
        {
          package: "@crossengin/widgets",
          name: "Guard",
          file: "packages/widgets/src/g.ts",
          text: `const Guard = ["archived", "ghost"];`,
        },
      ],
    });
    expect(kinds).toContain("narrowing_stale");
  });

  it("accepts a narrowing whose guard names every excluded member", () => {
    expect(
      audit({
        domains: [domain({ members: ["open", "closed", "archived"] })],
        declarations: [
          declaration({
            link: "narrows",
            except: ["archived"],
            guardedBy: "@crossengin/widgets:Guard",
            because: "z".repeat(25),
          }),
        ],
        symbols: [
          {
            package: "@crossengin/widgets",
            name: "Guard",
            file: "packages/widgets/src/g.ts",
            text: `if (v === "archived") throw new Error("no");`,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reports a guard that does not exist, or that never names an excluded member", () => {
    const narrows = declaration({
      link: "narrows",
      except: ["archived"],
      guardedBy: "@crossengin/widgets:Guard",
      because: "z".repeat(25),
    });
    expect(
      audit({
        domains: [domain({ members: ["open", "closed", "archived"] })],
        declarations: [narrows],
        symbols: [],
      }),
    ).toEqual(["guard_unproven"]);
    expect(
      audit({
        domains: [domain({ members: ["open", "closed", "archived"] })],
        declarations: [narrows],
        symbols: [
          {
            package: "@crossengin/widgets",
            name: "Guard",
            file: "packages/widgets/src/g.ts",
            text: `return WINDOW[v] !== null;`,
          },
        ],
      }),
    ).toEqual(["guard_unproven"]);
  });

  it("contradicts a catalog_only link the moment a domain enumerates the CHECK", () => {
    const catalogOnly = declaration({
      link: "catalog_only",
      ref: null,
      because: "z".repeat(25),
    });
    expect(audit({ declarations: [catalogOnly], domains: [] })).toEqual([]);
    expect(audit({ declarations: [catalogOnly], domains: [domain()] })).toEqual([
      "catalog_only_contradicted",
    ]);
  });

  it("does not contradict a catalog_only link over a merely overlapping domain", () => {
    // A superset is not a contradiction: SSO_SESSION_STATUSES strictly contains api_keys.status's
    // three values and is about a federated session. Exact enumeration is the claim being denied.
    expect(
      audit({
        declarations: [declaration({ link: "catalog_only", ref: null, because: "z".repeat(25) })],
        domains: [domain({ members: ["open", "closed", "archived"] })],
      }),
    ).toEqual([]);
  });

  it("formats a finding so the column and the remedy are both in the line", () => {
    const findings = auditValueSetDomains({
      valueSets: catalogValueSets([table()]),
      domains: [domain({ members: ["open", "closed", "archived"] })],
      declarations: [declaration()],
      symbols: [],
      checkedColumns: new Set(["widgets.status"]),
    });
    const text = formatValueSetFindings(findings);
    expect(text).toContain("[contract_exceeds_catalog] widgets.status");
    expect(text).toContain('"archived"');
    expect(text).toContain("widen the CHECK");
  });
});

/* ------------------------------------------------------ defaults, declaration-free */

describe("auditColumnDefaults", () => {
  it("reports a default the column's own CHECK refuses", () => {
    const sets = catalogValueSets([
      table({
        columns: [
          {
            name: "engine",
            notNull: true,
            hasDefault: true,
            check: "engine IN ('postgres', 'clickhouse')",
            defaultExpression: "'auto'",
          },
        ],
      }),
    ]);
    const findings = auditColumnDefaults(sets);
    expect(findings).toHaveLength(1);
    expect(formatColumnDefaultFindings(findings)).toContain("raises 23514");
  });

  it("is silent for a default the CHECK admits, and for one that is not a literal", () => {
    expect(
      auditColumnDefaults(
        catalogValueSets([
          table({
            columns: [
              {
                name: "status",
                notNull: true,
                hasDefault: true,
                check: "status IN ('open', 'closed')",
                defaultExpression: "'open'",
              },
              {
                name: "kind",
                notNull: true,
                hasDefault: true,
                check: "kind IN ('a', 'b')",
                defaultExpression: "pick_kind()",
              },
            ],
          }),
        ]),
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------- the real workspace */

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const valueSets = catalogValueSets(catalog);
  const sources = readWorkspaceSources();
  const scan = collectWorkspaceDomains(sources.files);
  const symbols = collectSymbolDeclarations(sources.files);
  const checkedColumns = new Set<string>();
  for (const t of catalog) {
    for (const c of t.columns) if (c.check !== null) checkedColumns.add(`${t.name}.${c.name}`);
  }

  it("read the workspace, rather than silently reading nothing", () => {
    // Every assertion below is vacuous if the scan came back empty, and a scan that finds nothing is
    // the failure mode every rule in this directory has to fence first.
    expect(sources.unnamedPackages).toEqual([]);
    expect(sources.unhandledGlobs).toEqual([]);
    expect(scan.filesScanned).toBeGreaterThanOrEqual(850);
    expect(catalog.length).toBeGreaterThanOrEqual(145);
    expect(checkedColumns.size).toBeGreaterThanOrEqual(700);
    expect(valueSets.length).toBeGreaterThanOrEqual(270);
    expect(symbols.length).toBeGreaterThanOrEqual(4000);
  });

  it("resolves every domain it finds", () => {
    // An unresolved domain is not a failure of the catalog — it is this scanner admitting it cannot
    // read something, and a rule with a silent could-not-read bucket is the next silence rather than
    // the end of this one.
    expect(scan.unresolved.map((u) => `${u.package}:${u.name}`)).toEqual([]);
    expect(scan.domains.length).toBeGreaterThanOrEqual(1200);
    const kinds = new Set(scan.domains.map((d) => d.kind));
    // All three sites have live members; a kind that stopped matching would otherwise pass.
    expect([...kinds].sort()).toEqual(["constant", "schema_enum", "schema_field"]);
  });

  it("declares every catalogued value set, and every declaration names one", () => {
    const findings = auditValueSetDomains({
      valueSets,
      domains: scan.domains,
      declarations: VALUE_SET_DOMAINS,
      symbols,
      checkedColumns,
    });
    expect(formatValueSetFindings(findings)).toBe("");
    expect(VALUE_SET_DOMAINS.length).toBe(valueSets.length);
  });

  it("parses every declaration", () => {
    for (const declared of VALUE_SET_DOMAINS) {
      const parsed = ValueSetDomainDeclarationSchema.safeParse(declared);
      expect(
        parsed.success ? "" : `${declared.table}.${declared.column}: ${parsed.error.message}`,
      ).toBe("");
    }
  });

  it("declares each column once, and each catalogued value set is one column", () => {
    const keys = VALUE_SET_DOMAINS.map((d) => `${d.table}.${d.column}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The audit keys on an *unqualified* table name, which is sound only while the catalog is one
    // schema. Two same-named tables in two schemas would collapse into one entry and the second
    // would read as declared without ever being compared.
    const catalogued = valueSets.map((v) => `${v.table}.${v.column}`);
    expect(new Set(catalogued).size).toBe(catalogued.length);
    expect(new Set(catalog.map((t) => t.schema))).toEqual(new Set(["meta"]));
  });

  it("keeps the exception surface small, and every exception a real one", () => {
    const byLink = new Map<string, number>();
    for (const d of VALUE_SET_DOMAINS) byLink.set(d.link, (byLink.get(d.link) ?? 0) + 1);
    // A floor on `mirrors` rather than an equality: the figure moves whenever a table lands, and the
    // point of the floor is that the rule cannot degrade into one that declares everything an
    // exception. The ceiling on the other two is the part worth guarding.
    expect(byLink.get("mirrors") ?? 0).toBeGreaterThanOrEqual(270);
    expect(byLink.get("catalog_only") ?? 0).toBeLessThanOrEqual(10);
    expect(byLink.get("narrows") ?? 0).toBeLessThanOrEqual(5);
  });

  it("gives every column default a value its own CHECK admits", () => {
    expect(formatColumnDefaultFindings(auditColumnDefaults(valueSets))).toBe("");
  });

  it("would have caught META_DEPLOYMENTS, in both directions, on all four columns", () => {
    // The negative control, and the reason this rule exists. Until ADR-0353 these four CHECKs had
    // been authored independently of `DeploymentRecordSchema`, the only record the table stores:
    // `target` was entirely disjoint from `DEPLOY_TARGETS`, `app_kind` differed on 6 of 9 members by
    // hyphen-versus-underscore, and `environment` and `strategy` differed by one value each way. No
    // nesting test could see any of it, and the kernel assertion that stood over `target` pinned
    // three values no `DeployTarget` has ever had.
    const before = readCatalogSource()
      .replace(
        "\"app_kind IN ('web', 'marketing', 'docs-site', 'ops', 'cdc-shipper', 'hl7-listener', 'virus-scanner', 'gpu-inference', 'mobile-shell')\"",
        "\"app_kind IN ('web', 'marketing', 'docs_site', 'ops', 'cdc_shipper', 'hl7_listener', 'virus_scanner', 'gpu_inference', 'mobile_shell')\"",
      )
      .replace(
        "\"environment IN ('local', 'preview', 'staging', 'production')\"",
        "\"environment IN ('preview', 'staging', 'production', 'sandbox')\"",
      )
      .replace(
        "\"target IN ('vercel', 'fly_machines', 'supabase', 'cloudflare', 'typesense_cloud', 'inngest_cloud', 'clickhouse_cloud', 'ghcr', 'app_store', 'play_store')\"",
        "\"target IN ('vercel_edge', 'vercel_node', 'fly_machine', 'fly_gpu', 'supabase_functions', 'cloudflare_worker', 'appstore_connect', 'play_console', 'helm_release', 'docs_pages')\"",
      )
      .replace(
        "\"strategy IN ('atomic', 'rolling', 'blue_green', 'canary')\"",
        "\"strategy IN ('rolling', 'blue_green', 'canary', 'recreate')\"",
      );
    // If a substitution stopped matching, the control would silently become the current catalog and
    // assert that a passing tree passes.
    expect(before).not.toBe(readCatalogSource());
    const drifted = parseCatalogSource(before);
    const findings = auditValueSetDomains({
      valueSets: catalogValueSets(drifted),
      domains: scan.domains,
      declarations: VALUE_SET_DOMAINS,
      symbols,
      checkedColumns,
    });
    expect(
      findings.map((f) => `${f.kind} ${f.table}.${f.column}`).sort(),
    ).toEqual([
      "catalog_exceeds_contract deployments.app_kind",
      "catalog_exceeds_contract deployments.environment",
      "catalog_exceeds_contract deployments.strategy",
      "catalog_exceeds_contract deployments.target",
      "contract_exceeds_catalog deployments.app_kind",
      "contract_exceeds_catalog deployments.environment",
      "contract_exceeds_catalog deployments.strategy",
      "contract_exceeds_catalog deployments.target",
    ]);
  });

  it("would catch an enum member added without widening its CHECK", () => {
    // ADR-0300 shipped exactly this — `FLAG_KINDS` seven members wide against a four-member CHECK —
    // and ADR-0334's `pending_deletion` and ADR-0351's `'v4'` would have been it had either author
    // forgotten the catalog half of their commit. Simulated on the declaration's own domain rather
    // than by editing a package, so the control holds whichever enum moves next.
    const widened = scan.domains.map((d) =>
      d.package === "@crossengin/tenant-lifecycle" && d.name === "TENANT_LIFECYCLE_STATES"
        ? { ...d, members: [...d.members, "quarantined"] }
        : d,
    );
    expect(widened).not.toEqual(scan.domains);
    const findings = auditValueSetDomains({
      valueSets,
      domains: widened,
      declarations: VALUE_SET_DOMAINS,
      symbols,
      checkedColumns,
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.kind).toBe("contract_exceeds_catalog");
    expect(findings.map((f) => `${f.table}.${f.column}`)).toContain("tenants.status");
  });

  it("would catch a catalogued CHECK that nobody declared", () => {
    const findings = auditValueSetDomains({
      valueSets,
      domains: scan.domains,
      declarations: VALUE_SET_DOMAINS.slice(1),
      symbols,
      checkedColumns,
    });
    expect(findings.map((f) => f.kind)).toEqual(["undeclared"]);
  });

  it("every catalog_only table is one the storeless census already declares writerless", () => {
    // The cross-rule join that makes `catalog_only`'s reasons checkable rather than prose: all five
    // are tables `pg-storeless-tables.ts` declares for an independent reason (`out_of_band`,
    // `superseded`, `unbuilt_subsystem`), so "the catalog is the only place these values are written
    // down" rests on something a machine can re-check. Writing a store for one of them fails here,
    // which is the moment to decide what domain governs its column — deliberately an assertion and
    // not a finding kind, because a store writing a SQL literal is not itself a defect.
    const writerless = new Set(STORELESS_TABLES.map((t) => t.table));
    const catalogOnly = VALUE_SET_DOMAINS.filter((d) => d.link === "catalog_only");
    expect(catalogOnly.length).toBeGreaterThan(0);
    expect(
      catalogOnly.map((d) => `meta.${d.table}`).filter((t) => !writerless.has(t)),
    ).toEqual([]);
  });

  it("resolves the one narrowing against the guard that enforces it", () => {
    const narrowing = VALUE_SET_DOMAINS.find((d) => d.link === "narrows");
    expect(narrowing?.guardedBy).toBe("@crossengin/notifications:DigestBatchSchema");
    const guard = symbols.filter(
      (s) => s.package === "@crossengin/notifications" && s.name === "DigestBatchSchema",
    );
    expect(guard).toHaveLength(1);
    // Not merely present: the guard's own text names both excluded members, which is what separates
    // a narrowing somebody enforces from a divergence somebody wrote a sentence about.
    for (const excluded of narrowing?.except ?? [])
      expect(guard[0]?.text).toContain(`"${excluded}"`);
  });
});

describe("collectSymbolDeclarations", () => {
  it("spans a function body past an object type in its parameter list", () => {
    const [declared] = collectSymbolDeclarations([
      source(
        "packages/widgets/src/g.ts",
        `export function guard(input: { frequency: string }): boolean {\n` +
          `  return input.frequency !== "immediate";\n` +
          `}`,
      ),
    ]);
    expect(declared?.name).toBe("guard");
    expect(declared?.text).toContain('"immediate"');
  });

  it("spans a class body rather than stopping at a method's parameter list", () => {
    const [declared] = collectSymbolDeclarations([
      source(
        "packages/widgets/src/g.ts",
        `export class Guard {\n  check(v: string): boolean {\n    return v !== "never";\n  }\n}`,
      ),
    ]);
    expect(declared?.name).toBe("Guard");
    expect(declared?.text).toContain('"never"');
  });

  it("spans a const to its own statement end, not into the next one", () => {
    const declarations = collectSymbolDeclarations([
      source(
        "packages/widgets/src/g.ts",
        `export const A = z.object({}).superRefine(() => "first");\n` +
          `export const B = z.object({}).superRefine(() => "second");`,
      ),
    ]);
    expect(declarations.map((d) => d.name)).toEqual(["A", "B"]);
    expect(declarations[0]?.text).toContain("first");
    expect(declarations[0]?.text).not.toContain("second");
  });
});
