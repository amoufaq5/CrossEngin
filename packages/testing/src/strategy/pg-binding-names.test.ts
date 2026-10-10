import { describe, expect, it } from "vitest";

import {
  auditBindingNames,
  BINDING_NAME_DIVERGENCES,
  BINDING_NAME_FINDING_KINDS,
  BindingNameDivergenceSchema,
  camelOfColumn,
  columnOfCamel,
  DERIVATION_RULES,
  derivationFor,
  derivationTargets,
  DIVERGENCE_KIND_RULES,
  formatBindingNameFindings,
  NAME_DERIVATIONS,
  NAME_DIVERGENCE_KINDS,
  REFUSED_DERIVATIONS,
  summarizeBindingNames,
  type BindingNameAuditInput,
  type NameDerivation,
} from "./pg-binding-names.js";
import {
  parseCatalogSource,
  PG_SCAN_EXEMPT_PACKAGE_DIRS,
  type CatalogColumn,
  type CatalogTable,
} from "./pg-column-coverage.js";
import {
  ColumnBindingSchema,
  scanColumnBindings,
  type ColumnBinding,
} from "./pg-column-bindings.js";
import { readCatalogSource, readWorkspaceSources } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function column(over: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name: "status",
    notNull: true,
    hasDefault: false,
    check: null,
    defaultExpression: null,
    type: "TEXT",
    references: null,
    unique: false,
    comment: null,
    ...over,
  };
}

function table(columns: readonly CatalogColumn[], name = "widgets"): CatalogTable {
  return { schema: "meta", name, columns: [...columns], policies: [] };
}

function binding(over: Partial<ColumnBinding> = {}): ColumnBinding {
  return ColumnBindingSchema.parse({
    file: "packages/widgets/src/store.ts",
    line: 7,
    statement: "insert",
    schema: "meta",
    table: "widgets",
    column: "status",
    kind: "parameter",
    receiver: "widget",
    property: "status",
    receiverType: "Widget",
    literal: null,
    ...over,
  });
}

/* ------------------------------------------------------------- the transform */

describe("the name transform", () => {
  it("is the one this repo's column and field names differ by", () => {
    expect(camelOfColumn("tenant_id")).toBe("tenantId");
    expect(camelOfColumn("attestation_signature_sha256")).toBe("attestationSignatureSha256");
    expect(camelOfColumn("status")).toBe("status");
    expect(columnOfCamel("tenantId")).toBe("tenant_id");
    expect(columnOfCamel("signatureSha256")).toBe("signature_sha256");
  });

  it("round-trips every catalogued column name but four, each named", () => {
    // `camelOfColumn` is total and is what decides agreement; the reverse is lossy on a
    // single-letter segment and on a digit boundary, and the four are spelled out as lines rather
    // than defined away because a general digit rule is unsound — it would turn `fingerprintSha256`
    // into `fingerprint_sha_256`, breaking a column that exists.
    //
    // What the lossiness can cost is bounded: the reverse is used only to *find* a same-type
    // sibling, so a miss is permissive, and a wrong hit would need a real column named
    // `minimum_kanonymity` or `request_count30d`. Neither exists, and none of the four is bound.
    const catalog = parseCatalogSource(readCatalogSource());
    const broken: string[] = [];
    for (const t of catalog) {
      for (const c of t.columns) {
        if (columnOfCamel(camelOfColumn(c.name)) !== c.name) broken.push(`${t.name}.${c.name}`);
      }
    }
    expect([...broken].sort()).toEqual([
      "lineage_nodes.minimum_k_anonymity",
      "ml_consent.minimum_k_anonymity",
      "ml_datasets.minimum_k_anonymity",
      "sdk_client_installations.request_count_30d",
    ]);
    expect(catalog.length).toBeGreaterThanOrEqual(145);
  });
});

/* --------------------------------------------------------------- the vocabulary */

describe("the vocabulary", () => {
  it("has two derivations, each stating why it is principled and why it is tight", () => {
    expect([...NAME_DERIVATIONS]).toEqual(["business_key", "resolved_surrogate"]);
    for (const name of NAME_DERIVATIONS) {
      expect(DERIVATION_RULES[name].because.length).toBeGreaterThan(40);
      expect(DERIVATION_RULES[name].tightness.length).toBeGreaterThan(40);
    }
  });

  it("keeps each refused derivation beside the measurement that refuses it", () => {
    expect(REFUSED_DERIVATIONS.length).toBeGreaterThanOrEqual(4);
    for (const r of REFUSED_DERIVATIONS) {
      expect(r.rule.length).toBeGreaterThan(10);
      // A refutation that cites no figure is an opinion; every one of these is a count.
      expect(r.refutation).toMatch(/\d/);
    }
  });

  it("ranks the transposition signature first, and its two escape hatches next", () => {
    expect(BINDING_NAME_FINDING_KINDS.slice(0, 4)).toEqual([
      "transposed_pair",
      "property_names_sibling_column",
      "sibling_unaddressed",
      "overload_uncommented",
    ]);
  });

  it("says, per divergence kind, what believing a declaration of it requires", () => {
    // A total map, so a sixth kind cannot land without stating its own check. Exactly one kind
    // asks for something outside this directory, and it is the one that admits the column's name
    // is wrong rather than merely vaguer.
    expect([...NAME_DIVERGENCE_KINDS].sort()).toEqual(
      Object.keys(DIVERGENCE_KIND_RULES).sort(),
    );
    for (const kind of NAME_DIVERGENCE_KINDS) {
      expect(DIVERGENCE_KIND_RULES[kind].check.length).toBeGreaterThan(30);
    }
    expect(
      NAME_DIVERGENCE_KINDS.filter((k) => DIVERGENCE_KIND_RULES[k].requiresCatalogComment),
    ).toEqual(["column_overloaded"]);
  });

  it("requires a divergence declaration to carry evidence, not just a kind", () => {
    const base = {
      table: "widgets",
      column: "status",
      property: "kind",
      kind: "qualifier_differs" as const,
    };
    expect(() => BindingNameDivergenceSchema.parse({ ...base, note: "it is fine" })).toThrow();
    expect(() =>
      BindingNameDivergenceSchema.parse({ ...base, kind: "nope", note: "x".repeat(40) }),
    ).toThrow();
    expect(() =>
      BindingNameDivergenceSchema.parse({ ...base, note: "x".repeat(40) }),
    ).not.toThrow();
  });

  it("parses every shipped declaration and names a kind that exists", () => {
    for (const d of BINDING_NAME_DIVERGENCES) {
      expect(() => BindingNameDivergenceSchema.parse(d)).not.toThrow();
      expect(NAME_DIVERGENCE_KINDS).toContain(d.kind);
    }
  });

  it("has a member for every kind, so none was invented and left empty", () => {
    // The vocabulary was settled *from* the adjudications — 17 convention names came back and
    // these five are what they collapse onto — so an empty kind would mean one was invented first
    // after all. Four of the six this module was drafted with had no member and are gone.
    const used = new Set(BINDING_NAME_DIVERGENCES.map((d) => d.kind));
    expect([...NAME_DIVERGENCE_KINDS].filter((k) => !used.has(k))).toEqual([]);
  });
});

/* ---------------------------------------------------------------- derivations */

describe("the business_key derivation", () => {
  const widgets = table([
    column({ name: "id", type: "UUID", hasDefault: true }),
    column({ name: "widget_id", unique: true }),
    column({ name: "tenant_id", type: "UUID", references: "meta.tenants.id" }),
    column({ name: "owner_id", type: "TEXT" }),
  ]);

  it("explains a record's own id written into its single-column-unique business key", () => {
    expect(derivationFor(binding({ column: "widget_id", property: "id" }), widgets)).toBe(
      "business_key",
    );
  });

  it("refuses a foreign key, which identifies another row", () => {
    expect(derivationFor(binding({ column: "tenant_id", property: "id" }), widgets)).toBeNull();
  });

  it("refuses a non-unique `*_id`, which identifies nothing", () => {
    // This is the whole content of the derivation. Without the UNIQUE requirement the rule admits
    // `record.id` into any non-FK `*_id` column, and 72 catalogued tables have more than one.
    expect(derivationFor(binding({ column: "owner_id", property: "id" }), widgets)).toBeNull();
  });

  it("admits a record's id into at most one column of the table", () => {
    expect(derivationTargets("business_key", "id", widgets)).toEqual(["widget_id"]);
  });
});

describe("the resolved_surrogate derivation", () => {
  const items = table([
    column({ name: "campaign_id", type: "UUID", references: "meta.campaigns.id" }),
    column({ name: "item_id", type: "UUID", references: "meta.items.id" }),
  ]);

  it("explains a resolver's `<noun>Uuid` local written into `<noun>_id`", () => {
    expect(
      derivationFor(
        binding({ column: "campaign_id", kind: "local", receiver: null, property: "campaignUuid" }),
        items,
      ),
    ).toBe("resolved_surrogate");
  });

  it("is pinned to its own noun, so it names one column and no other", () => {
    expect(derivationTargets("resolved_surrogate", "campaignUuid", items)).toEqual(["campaign_id"]);
    expect(
      derivationFor(
        binding({ column: "item_id", kind: "local", receiver: null, property: "campaignUuid" }),
        items,
      ),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------- the audit */

describe("auditBindingNames", () => {
  function inputOf(over: Partial<BindingNameAuditInput> = {}): BindingNameAuditInput {
    return {
      catalog: [
        table([
          column({ name: "id", type: "UUID", hasDefault: true }),
          column({ name: "widget_id", unique: true }),
          column({ name: "status" }),
          column({ name: "kind" }),
          column({ name: "created_at", type: "TIMESTAMPTZ" }),
          column({ name: "updated_at", type: "TIMESTAMPTZ" }),
        ]),
      ],
      bindings: [],
      divergences: [],
      ...over,
    };
  }

  it("is silent when the names agree", () => {
    expect(auditBindingNames(inputOf({ bindings: [binding()] }))).toEqual([]);
    expect(summarizeBindingNames(inputOf({ bindings: [binding()] })).agreeing).toBe(1);
  });

  it("is silent for a derivation, and counts it as derived rather than declared", () => {
    const bindings = [binding({ column: "widget_id", property: "id" })];
    expect(auditBindingNames(inputOf({ bindings }))).toEqual([]);
    expect(summarizeBindingNames(inputOf({ bindings })).derived.business_key).toBe(1);
  });

  it("reports a transposed pair inside one statement, needing no declaration", () => {
    // The defect class the whole rule exists for: two columns in one VALUES list each bound from
    // the other's name. No declaration can excuse it, so none is consulted.
    const bindings = [
      binding({ column: "created_at", property: "updatedAt" }),
      binding({ column: "updated_at", property: "createdAt" }),
    ];
    const findings = auditBindingNames(inputOf({ bindings }));
    expect(findings.filter((f) => f.kind === "transposed_pair")).toHaveLength(1);
    expect(findings[0]?.detail).toContain("each column is bound from the other's name");
  });

  it("reports a property naming a sibling column of the same declared type", () => {
    const findings = auditBindingNames(
      inputOf({ bindings: [binding({ column: "status", property: "kind" })] }),
    );
    expect(findings).toMatchObject([{ kind: "property_names_sibling_column", column: "status" }]);
  });

  it("does not raise the sibling signal when the two columns are different types", () => {
    // 16 of the 17 bindings this fires on in the real workspace are the business-key convention —
    // a TEXT `<prefix>_id` beside a UUID `id` — so the type is what separates a transposition from
    // the house's two-identifier shape.
    const findings = auditBindingNames(
      inputOf({ bindings: [binding({ column: "widget_id", property: "id" })] }),
    );
    expect(findings).toEqual([]);
  });

  it("accepts a declared sibling divergence only when the note names the sibling", () => {
    const declare = (note: string): BindingNameAuditInput =>
      inputOf({
        bindings: [binding({ column: "status", property: "kind" })],
        divergences: [
          { table: "widgets", column: "status", property: "kind", kind: "nested_record", note },
        ],
      });
    // The highest-risk declaration in the file: an adjudication that never looked at the column
    // the value could have belonged in cannot have ruled the confusion out.
    expect(auditBindingNames(declare("a sub-record's own field, which the column prefixes."))).
      toMatchObject([{ kind: "sibling_unaddressed", column: "status" }]);
    expect(
      auditBindingNames(
        declare("a sub-record's field; the top-level `kind` column takes decision.kind instead."),
      ),
    ).toEqual([]);
  });

  it("requires the catalog itself to carry an overload the declaration admits", () => {
    const widgets = table([column({ name: "started_at", type: "TIMESTAMPTZ" })]);
    const bindings = [
      binding({ column: "started_at", kind: "local", receiver: null, property: "fireAt" }),
    ];
    const divergences = [
      {
        table: "widgets",
        column: "started_at",
        property: "fireAt",
        kind: "column_overloaded" as const,
        note: "the queue's visibility column; the claim predicate filters and orders on it.",
      },
    ];
    expect(auditBindingNames({ catalog: [widgets], bindings, divergences })).toMatchObject([
      { kind: "overload_uncommented", column: "started_at" },
    ]);
    // The comment must name the column, so prose attributed from the line above cannot satisfy it.
    const neighbour = table([
      column({ name: "started_at", type: "TIMESTAMPTZ", comment: "a note about something else" }),
    ]);
    expect(auditBindingNames({ catalog: [neighbour], bindings, divergences })).toMatchObject([
      { kind: "overload_uncommented" },
    ]);
    const commented = table([
      column({
        name: "started_at",
        type: "TIMESTAMPTZ",
        comment: "`started_at` is the queue's visibility column and not a start time",
      }),
    ]);
    expect(auditBindingNames({ catalog: [commented], bindings, divergences })).toEqual([]);
  });

  it("requires every other divergence to be declared, and reports a stale declaration", () => {
    const bindings = [binding({ column: "created_at", property: "recordedAt" })];
    expect(auditBindingNames(inputOf({ bindings }))).toMatchObject([
      { kind: "undeclared_divergence", column: "created_at" },
    ]);
    const declaration = {
      table: "widgets",
      column: "created_at",
      property: "recordedAt",
      kind: "qualifier_differs" as const,
      note: "the contract calls the moment the row was recorded `recordedAt`; the column is the same fact.",
    };
    expect(auditBindingNames(inputOf({ bindings, divergences: [declaration] }))).toEqual([]);
    expect(auditBindingNames(inputOf({ divergences: [declaration] }))).toMatchObject([
      { kind: "divergence_overtaken" },
    ]);
    expect(
      auditBindingNames(inputOf({ bindings, divergences: [declaration, declaration] })),
    ).toMatchObject([{ kind: "divergence_duplicate" }]);
  });

  it("reports a declaration on a column the catalog does not declare", () => {
    expect(
      auditBindingNames(
        inputOf({
          divergences: [
            {
              table: "widgets",
              column: "gone",
              property: "x",
              kind: "qualifier_differs" as const,
              note: "a declaration left behind by a column that was renamed or removed entirely.",
            },
          ],
        }),
      ).map((f) => f.kind),
    ).toContain("divergence_unknown_column");
  });

  it("reports a derivation that has stopped naming one column", () => {
    // The derivation's tightness is re-asked against the catalog every run rather than trusted
    // from a measurement taken once: a second single-column-unique `*_id` makes `business_key` a
    // guess, and the rule says so instead of silently widening.
    const widened = table([
      column({ name: "widget_id", unique: true }),
      column({ name: "external_id", unique: true }),
    ]);
    const findings = auditBindingNames({
      catalog: [widened],
      bindings: [binding({ column: "widget_id", property: "id" })],
      divergences: [],
    });
    expect(findings).toMatchObject([{ kind: "derivation_ambiguous", column: "widget_id" }]);
    expect(findings[0]?.detail).toContain("external_id");
  });

  it("has no opinion about a literal, or about a column the catalog does not declare", () => {
    const bindings = [
      binding({ kind: "literal", receiver: null, property: null, receiverType: null, literal: "x" }),
      binding({ table: "elsewhere" }),
    ];
    expect(auditBindingNames(inputOf({ bindings }))).toEqual([]);
    const summary = summarizeBindingNames(inputOf({ bindings }));
    expect(summary.literals).toBe(1);
    expect(summary.uncatalogued).toBe(1);
  });

  it("formats findings one per line", () => {
    const findings = auditBindingNames(
      inputOf({ bindings: [binding({ column: "created_at", property: "recordedAt" })] }),
    );
    expect(formatBindingNameFindings(findings)).toContain("undeclared_divergence: widgets.created_at");
    expect(formatBindingNameFindings([])).toBe("");
  });
});

/* --------------------------------------------------------------- the workspace */

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const sources = readWorkspaceSources();
  const scanned = sources.files.filter(
    (f) => !PG_SCAN_EXEMPT_PACKAGE_DIRS.some((dir: string) => f.file.startsWith(dir)),
  );
  const { bindings } = scanColumnBindings(scanned);
  const input: BindingNameAuditInput = {
    catalog,
    bindings,
    divergences: BINDING_NAME_DIVERGENCES,
  };
  const summary = summarizeBindingNames(input);

  it("read the workspace, rather than silently reading nothing", () => {
    expect(sources.unnamedPackages).toEqual([]);
    expect(scanned.length).toBeGreaterThanOrEqual(800);
    expect(bindings.length).toBeGreaterThanOrEqual(700);
    expect(catalog.length).toBeGreaterThanOrEqual(145);
  });

  it("agrees by default: the exact-name case is the overwhelming majority", () => {
    // The rule is only worth having because agreement is the norm. If this floor ever dropped
    // sharply, the transform would have stopped describing this repo and the declaration list
    // would be doing the work instead of the rule.
    expect(summary.agreeing).toBeGreaterThanOrEqual(650);
    expect(summary.agreeing / (summary.total - summary.literals)).toBeGreaterThan(0.85);
    expect(summary.uncatalogued).toBe(0);
  });

  it("accounts for every divergence, by derivation or by declaration", () => {
    const findings = auditBindingNames(input);
    expect(formatBindingNameFindings(findings)).toBe("");
    expect(findings).toEqual([]);
  });

  it("derives what it claims to derive", () => {
    expect(summary.derived.business_key).toBeGreaterThanOrEqual(14);
    expect(summary.derived.resolved_surrogate).toBeGreaterThanOrEqual(8);
    expect(summary.declared).toBe(BINDING_NAME_DIVERGENCES.length > 0 ? summary.declared : 0);
    // Every declaration is matched by a binding, which `divergence_overtaken` asserts above; this
    // pins that the declaration list is not carrying the rule on its own.
    expect(summary.declared).toBeLessThan(summary.agreeing / 10);
  });

  it("fires on the real tree when one binding is made to name a sibling column", () => {
    // The live control: take a real agreeing binding and point it at its table's other
    // TIMESTAMPTZ. Pinning it to a binding that exists rather than to one that might is why this
    // is checked against the scan rather than a fixture.
    const victim = bindings.find(
      (b) => b.table === "job_runs" && b.column === "claim_expires_at" && b.property !== null,
    );
    expect(victim).toBeDefined();
    const findings = auditBindingNames({
      ...input,
      bindings: bindings.map((b) => (b === victim ? { ...b, property: "completedAt" } : b)),
    });
    expect(findings).toMatchObject([
      { kind: "property_names_sibling_column", table: "job_runs", column: "claim_expires_at" },
    ]);
  });

  it("fires on the real tree when two bindings in one statement are transposed", () => {
    const group = bindings.filter(
      (b) =>
        b.table === "job_runs" &&
        b.statement === "insert" &&
        (b.column === "input_data_class" || b.column === "output_data_class"),
    );
    expect(group.length).toBeGreaterThanOrEqual(2);
    const [first, second] = [group[0], group[1]];
    const swapped = bindings.map((b) => {
      if (b !== first && b !== second) return b;
      const other = b === first ? second : first;
      return { ...b, property: camelOfColumn(other?.column ?? "") };
    });
    const findings = auditBindingNames({ ...input, bindings: swapped });
    expect(findings.some((f) => f.kind === "transposed_pair")).toBe(true);
    // Both are TEXT with the same six-value CHECK, so no constraint could catch the swap and no
    // type comparison could either — which is exactly the case the signature exists for.
    expect(findings[0]?.kind).toBe("transposed_pair");
  });

  it("every derivation still names exactly one column, over the whole catalog", () => {
    // The soundness argument, asserted rather than cited: for every table and every property any
    // binding could carry, the set of columns the derivation would admit it into is at most one.
    // The property has to be fixed per candidate set — deriving it from the column under test
    // makes the predicate trivially true and the assertion vacuous.
    const ambiguous: string[] = [];
    for (const t of catalog) {
      const properties = new Map<NameDerivation, Set<string>>([
        ["business_key", new Set(["id"])],
        [
          "resolved_surrogate",
          new Set(
            t.columns
              .filter((c) => c.name.endsWith("_id"))
              .map((c) => `${camelOfColumn(c.name.slice(0, -3))}Uuid`),
          ),
        ],
      ]);
      for (const d of NAME_DERIVATIONS) {
        for (const property of properties.get(d) ?? []) {
          const targets = derivationTargets(d, property, t);
          if (targets.length > 1) ambiguous.push(`${d}: ${t.name}.${property} -> ${targets.join(", ")}`);
        }
      }
    }
    expect(ambiguous).toEqual([]);
  });
});
