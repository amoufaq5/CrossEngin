import { describe, expect, it } from "vitest";

import {
  auditRecordReads,
  blankStringBodies,
  collectFieldComments,
  effectiveColumn,
  READ_KIND_RULES,
  formatRecordReadFindings,
  RECORD_READ_DIVERGENCES,
  RECORD_READ_FINDING_KINDS,
  READ_DIVERGENCE_KINDS,
  RecordReadDivergenceSchema,
  resolveRowShapes,
  ROW_FIELD_ALIASES,
  ROW_FIELD_PROVENANCES,
  RowFieldAliasSchema,
  scanRecordReads,
  summarizeRecordReads,
  tableForRead,
  type RecordReadAuditInput,
  type RowShape,
} from "./pg-record-reads.js";
import {
  camelOfColumn,
  DERIVATION_RULES,
  NAME_DERIVATIONS,
  type NameDerivation,
} from "./pg-binding-names.js";
import {
  parseCatalogSource,
  PG_SCAN_EXEMPT_PACKAGE_DIRS,
  type CatalogColumn,
  type CatalogTable,
} from "./pg-column-coverage.js";
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

function source(text: string, file = "packages/widgets/src/records.ts") {
  return { file, package: "@crossengin/widgets", text };
}

const WIDGETS = table([
  column({ name: "id", type: "UUID", hasDefault: true }),
  column({ name: "widget_id", unique: true }),
  column({ name: "tenant_id", type: "UUID", references: "meta.tenants.id" }),
  column({ name: "status" }),
  column({ name: "kind" }),
  column({ name: "created_at", type: "TIMESTAMPTZ" }),
  column({ name: "updated_at", type: "TIMESTAMPTZ" }),
]);

/* ----------------------------------------------------------- one vocabulary */

describe("the vocabulary is the write path's", () => {
  it("imports the derivations rather than restating them", () => {
    // The whole design claim: `admits(column, property, table)` does not care which direction the
    // value is moving, so a second copy of these rules would be a second thing to keep in step.
    expect([...NAME_DERIVATIONS]).toEqual(["business_key", "resolved_surrogate"]);
    const widgetId = WIDGETS.columns.find((c) => c.name === "widget_id");
    expect(widgetId).toBeDefined();
    if (widgetId === undefined) return;
    // The same predicate that explains writing `record.id` into `widget_id` explains reading it back.
    expect(DERIVATION_RULES.business_key.admits(widgetId, "id", WIDGETS)).toBe(true);
  });

  it("says where every row field can come from, as a total map's worth of members", () => {
    // Settled from the SELECTs, not guessed: a join alias reaches another table's column and a
    // parameter echo was never in the database at all, so one "alias" kind would have conflated
    // a checkable claim with an uncheckable one.
    expect([...ROW_FIELD_PROVENANCES]).toEqual([
      "catalogued_column",
      "joined_column",
      "parameter_echo",
      "introspection",
    ]);
  });

  it("ranks the transposition signature first, and the rule's own silence third", () => {
    expect(RECORD_READ_FINDING_KINDS.slice(0, 3)).toEqual([
      "reversed_pair",
      "field_reads_sibling_column",
      "alias_undeclared",
    ]);
  });

  it("requires a divergence and an alias declaration to carry evidence", () => {
    const base = { file: "a/b.ts", field: "kind", column: "attestation_kind" };
    expect(() =>
      RecordReadDivergenceSchema.parse({ ...base, kind: "nested_record", note: "fine" }),
    ).toThrow();
    expect(() =>
      RecordReadDivergenceSchema.parse({ ...base, kind: "nope", note: "x".repeat(40) }),
    ).toThrow();
    expect(() =>
      RecordReadDivergenceSchema.parse({ ...base, kind: "nested_record", note: "x".repeat(40) }),
    ).not.toThrow();
    expect(() =>
      RowFieldAliasSchema.parse({
        alias: "campaign_natural_id",
        provenance: "joined_column",
        aliases: "access_review_campaigns.campaign_id",
        introducedIn: "a/b.ts",
        note: "x".repeat(40),
      }),
    ).not.toThrow();
    // A parameter echo is the one provenance with no column to name, so `aliases` is nullable —
    // and a joined column with a null target would be a declaration that declares nothing.
    expect(() =>
      RowFieldAliasSchema.parse({
        alias: "x_id",
        provenance: "parameter_echo",
        aliases: null,
        introducedIn: "a/b.ts",
        note: "x".repeat(40),
      }),
    ).not.toThrow();
  });

  it("has a kind for every divergence it declares, and no empty kind", () => {
    const used = new Set(RECORD_READ_DIVERGENCES.map((d) => d.kind));
    expect([...READ_DIVERGENCE_KINDS].filter((k) => !used.has(k))).toEqual([]);
  });

  it("says what believing each kind requires, and charges a comment for exactly one", () => {
    // Total over the enum, so a seventh kind cannot land without saying what it costs.
    expect(Object.keys(READ_KIND_RULES).sort()).toEqual([...READ_DIVERGENCE_KINDS].sort());
    for (const rule of Object.values(READ_KIND_RULES)) {
      expect(rule.check.length).toBeGreaterThan(30);
    }
    // ADR-0355's `column_overloaded` rule one side across: the kind that admits a *name* is wrong
    // is the one whose declaration has to land where the next reader looks.
    expect(
      [...READ_DIVERGENCE_KINDS].filter((k) => READ_KIND_RULES[k].requiresFieldComment),
    ).toEqual(["field_overloaded"]);
  });
});

/* ------------------------------------------------------------- the scanner */

describe("blankStringBodies", () => {
  it("empties a template body while keeping offsets and lines", () => {
    const code = 'const q = `SELECT meta.tenants.tenant_id`;\nconst x = row.tenant_id;';
    const out = blankStringBodies(code);
    expect(out).toHaveLength(code.length);
    expect(out.split("\n")).toHaveLength(2);
    // The SQL's own `meta.tenants` is gone; the TypeScript read survives.
    expect(out).not.toContain("meta.tenants");
    expect(out).toContain("row.tenant_id");
  });

  it("skips a regex literal, whose quote would otherwise pair with a real one", () => {
    // `stripComments`' defect in the other scanner: a pattern may contain a quote, so pairing it
    // blanks the code between. Here the direction is a *lost* read rather than an invented one, and
    // 19 of the scanned files put a quote inside a pattern.
    const code = 'const re = /"([^"]+)"/g;\nconst x = { madeAt: row.created_at };';
    const out = blankStringBodies(code);
    expect(out).toHaveLength(code.length);
    expect(out).toContain('/"([^"]+)"/g');
    expect(out).toContain("row.created_at");
    // And division still reads as division, so a real string after it is still blanked.
    expect(blankStringBodies('const r = a / b; const s = "meta.x";')).toBe(
      'const r = a / b; const s = "      ";',
    );
  });
});

describe("collectFieldComments", () => {
  it("attributes the prose immediately above a field to that field", () => {
    const comments = collectFieldComments([
      source(`interface ClaimedJob {
  /** The **run** id, not the job's — the claim handle renames it. */
  readonly jobId: string;
  readonly jobKind: string;
}`),
    ]);
    expect(comments.get("packages/widgets/src/records.ts::jobId")).toContain("run** id");
    // A field with nothing above it is absent rather than empty, so a declaration cannot be
    // satisfied by a comment that happens to sit elsewhere in the module.
    expect(comments.has("packages/widgets/src/records.ts::jobKind")).toBe(false);
  });
});

describe("effectiveColumn", () => {
  it("follows a joined alias to the column it names, and answers null for a parameter echo", () => {
    const aliases = [
      {
        alias: "campaign_natural_id" as const,
        provenance: "joined_column" as const,
        aliases: "access_review_campaigns.campaign_id",
        introducedIn: "a/b.ts",
        note: "x".repeat(40),
      },
      {
        alias: "instance_text_id" as const,
        provenance: "parameter_echo" as const,
        aliases: null,
        introducedIn: "a/b.ts",
        note: "x".repeat(40),
      },
    ];
    expect(effectiveColumn("campaign_natural_id", aliases)).toBe("campaign_id");
    // Never in the database at all, so there is no column name a divergence could be judged against.
    expect(effectiveColumn("instance_text_id", aliases)).toBeNull();
    expect(effectiveColumn("status", aliases)).toBe("status");
  });
});

describe("scanRecordReads", () => {
  const SHAPES = [
    {
      file: "packages/widgets/src/records.ts",
      name: "WidgetRow",
      fields: ["widget_id", "tenant_id", "status", "kind", "created_at", "updated_at"],
      columns: ["widget_id", "tenant_id", "status", "kind", "created_at", "updated_at"],
      table: "widgets",
      foreign: [],
    },
  ];
  const scan = (text: string) => scanRecordReads([source(text)], [WIDGETS], SHAPES);

  it("finds a field read off a row", () => {
    const { reads } = scan("function f(row: WidgetRow) { return { status: row.status, kind: row.kind }; }");
    expect(reads.map((r) => `${r.field}<-${r.column}`)).toEqual(["status<-status", "kind<-kind"]);
  });

  it("does not read a ternary's colon as a field", () => {
    // Six of the first thirty-seven findings were this: `x === null ? null : y` matched a field
    // named `null`, so the key must sit immediately after a `{` or a `,`.
    const { reads } = scan(
      "function f(row: WidgetRow) { return { createdAt: row.created_at === null ? null : row.created_at }; }",
    );
    expect(reads.map((r) => r.field)).toEqual(["createdAt"]);
  });

  it("skips a field whose value is itself an object literal", () => {
    // Its own fields are found on the same pass, so counting the wrapper double-reports every
    // nested record — 2,489 object-valued fields against 290 real reads in the workspace.
    const { reads } = scan("function f(row: WidgetRow) { return { outer: { status: row.status } }; }");
    expect(reads.map((r) => r.field)).toEqual(["status"]);
  });

  it("skips a snake_case key, which is a row copied to a row rather than a record mapping", () => {
    const { reads } = scan(
      "function f(row: WidgetRow) { return { widget_id: row.widget_id, status: row.status }; }",
    );
    expect(reads.map((r) => r.field)).toEqual(["status"]);
  });

  it("ignores a snake_case property the catalog has no column of", () => {
    // Sound rather than convenient: measured over the workspace, every non-column `snake_case`
    // property — an Anthropic `stop_reason`, an OpenAI `prompt_tokens`, a `pg_catalog`
    // `rls_enabled` — is absent from the catalog, so there is no collision to resolve.
    const { reads } = scan(
      "function f(row: WidgetRow) { return { inputTokens: usage.prompt_tokens, status: row.status }; }",
    );
    expect(reads.map((r) => r.field)).toEqual(["status"]);
  });

  it("reports a field read from several columns rather than guessing which it is named for", () => {
    const { reads, derived } = scan(
      "function f(row: WidgetRow) { return { span: row.created_at + row.updated_at }; }",
    );
    expect(reads).toEqual([]);
    expect(derived).toMatchObject([{ field: "span", columns: ["created_at", "updated_at"] }]);
  });

  it("learns the row type from an annotation or from a query generic", () => {
    const annotated = scan("function f(row: WidgetRow) { return { status: row.status }; }");
    expect(annotated.reads[0]?.rowType).toBe("WidgetRow");
    // The generic resolves the table for a read already admitted on its `snake_case` spelling —
    // it is not consulted by the filter, since it names no receiver.
    const generic = scan(
      "const res = await conn.query<WidgetRow>(sql); res.rows.map((row) => ({ madeAt: row.created_at }));",
    );
    expect(generic.reads[0]?.rowType).toBe("WidgetRow");
    // An *anonymous* generic ends the previous one's reach rather than letting it carry: measured,
    // `job-cancellation.ts` would otherwise hand `StateRow` to rows 137 lines later.
    const anonymous = scan(
      "await conn.query<WidgetRow>(a); await conn.query<{ created_at: unknown }>(b);" +
        " rows.map((row) => ({ madeAt: row.created_at }));",
    );
    expect(anonymous.reads[0]?.rowType).toBeNull();
    // With no row type in scope the single-word column is invisible, so the marker is the only
    // signal left and `status` does not carry it.
    expect(scan("const r = { status: row.status };").reads).toEqual([]);
    const marked = scan("const r = { createdAt: row.created_at };");
    expect(marked.reads[0]?.rowType).toBeNull();
  });

  it("groups fields by their enclosing literal rather than by proximity", () => {
    // The reversed-pair finding is about two fields of ONE record; two sibling records in one
    // function would otherwise be compared against each other.
    const { reads } = scan(
      "function f(row: WidgetRow) { return [{ createdAt: row.created_at }, { updatedAt: row.updated_at }]; }",
    );
    expect(new Set(reads.map((r) => r.literal)).size).toBe(2);
  });
});

/* ---------------------------------------------------------- row resolution */

describe("resolveRowShapes", () => {
  const CAT = [
    WIDGETS,
    table([column({ name: "widget_id" }), column({ name: "note" }), column({ name: "kind" })], "gadgets"),
  ];

  it("resolves a row interface to the one table containing all its columns", () => {
    const shapes = resolveRowShapes(
      [
        source(`interface WidgetRow {
  readonly widget_id: string;
  readonly tenant_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}`),
      ],
      CAT,
    );
    expect(shapes).toMatchObject([{ name: "WidgetRow", table: "widgets", foreign: [] }]);
  });

  it("tolerates a field the catalog has no column of, which is what a SQL alias looks like", () => {
    // This is what took the workspace resolution from 18 of 28 to 22: `ItemRow`, `DecisionRow` and
    // `event-log.ts`' `Row` each carry an alias, and the remaining fields still pin the table.
    const shapes = resolveRowShapes(
      [
        source(`interface WidgetRow {
  readonly widget_id: string;
  readonly tenant_id: string;
  readonly created_at: unknown;
  readonly parent_natural_id: string;
}`),
      ],
      CAT,
    );
    expect(shapes).toMatchObject([
      { name: "WidgetRow", table: "widgets", foreign: ["parent_natural_id"] },
    ]);
  });

  it("reads a row that extends another, because skipping it is silent rather than smaller", () => {
    const shapes = resolveRowShapes(
      [
        source(`interface WidgetRow extends CancellationColumns {
  readonly widget_id: string;
  readonly tenant_id: string;
  readonly created_at: unknown;
}`),
      ],
      CAT,
    );
    expect(shapes[0]?.table).toBe("widgets");
  });

  it("resolves nothing from a row too short to pin a table", () => {
    const shapes = resolveRowShapes(
      [source("interface WidgetRow {\n  readonly kind: string;\n  readonly note: string;\n}")],
      CAT,
    );
    expect(shapes).toEqual([]);
  });

  it("answers null rather than guessing when several tables contain every field", () => {
    const shapes = resolveRowShapes(
      [
        source(`interface WidgetRow {
  readonly widget_id: string;
  readonly kind: string;
  readonly a_b: string;
}`),
      ],
      [
        table([column({ name: "widget_id" }), column({ name: "kind" }), column({ name: "a_b" })], "one"),
        table([column({ name: "widget_id" }), column({ name: "kind" }), column({ name: "a_b" })], "two"),
      ],
    );
    expect(shapes[0]?.table).toBeNull();
  });
});

/* ------------------------------------------------------------------- audit */

describe("auditRecordReads", () => {
  const SHAPE: RowShape = {
    file: "packages/widgets/src/records.ts",
    name: "WidgetRow",
    fields: ["widget_id", "tenant_id", "status", "kind", "created_at", "updated_at"],
    columns: ["widget_id", "tenant_id", "status", "kind", "created_at", "updated_at"],
    table: "widgets",
    foreign: [],
  };

  function inputOf(text: string, over: Partial<RecordReadAuditInput> = {}): RecordReadAuditInput {
    const { reads } = scanRecordReads([source(text)], [WIDGETS], [SHAPE]);
    return { catalog: [WIDGETS], reads, rowShapes: [SHAPE], divergences: [], aliases: [], ...over };
  }

  it("is silent when the names agree", () => {
    const input = inputOf("function f(row: WidgetRow) { return { status: row.status }; }");
    expect(auditRecordReads(input)).toEqual([]);
    expect(summarizeRecordReads(input).agreeing).toBe(1);
  });

  it("is silent for a derivation, and counts it as derived", () => {
    const input = inputOf("function f(row: WidgetRow) { return { id: row.widget_id }; }");
    expect(auditRecordReads(input)).toEqual([]);
    expect(summarizeRecordReads(input).derived.business_key).toBe(1);
  });

  it("reports a reversed pair in one record, which no declaration can excuse", () => {
    const input = inputOf(
      "function f(row: WidgetRow) { return { createdAt: row.updated_at, updatedAt: row.created_at }; }",
    );
    const findings = auditRecordReads(input);
    expect(findings[0]?.kind).toBe("reversed_pair");
    expect(findings[0]?.detail).toContain("each field is filled from the");
    // Declaring both halves does not silence it.
    const declared = auditRecordReads({
      ...input,
      divergences: [
        { file: SHAPE.file, field: "createdAt", column: "updated_at", kind: "qualifier_differs", note: "x".repeat(40) },
        { file: SHAPE.file, field: "updatedAt", column: "created_at", kind: "qualifier_differs", note: "x".repeat(40) },
      ],
    });
    expect(declared.some((f) => f.kind === "reversed_pair")).toBe(true);
  });

  it("reports a field reading a sibling column of the same declared type", () => {
    const input = inputOf("function f(row: WidgetRow) { return { kind: row.status }; }");
    expect(auditRecordReads(input)).toMatchObject([
      { kind: "field_reads_sibling_column", field: "kind" },
    ]);
  });

  it("accepts a declared sibling divergence only when the note names the sibling", () => {
    const text = "function f(row: WidgetRow) { return { kind: row.status }; }";
    const declare = (note: string) =>
      auditRecordReads(
        inputOf(text, {
          divergences: [
            { file: SHAPE.file, field: "kind", column: "status", kind: "nested_record", note },
          ],
        }),
      );
    expect(declare("a sub-record's own field, which the column prefixes for flattening.")).toMatchObject(
      [{ kind: "field_reads_sibling_column" }],
    );
    expect(declare("a sub-record's field; the `kind` column carries the record's own kind instead.")).toEqual([]);
  });

  it("charges a field_overloaded declaration a comment on the interface itself", () => {
    const text = "function f(row: WidgetRow) { return { madeAt: row.created_at }; }";
    const d = {
      file: SHAPE.file,
      field: "madeAt",
      column: "created_at",
      kind: "field_overloaded" as const,
      note: "the field is named for when the record was made and the column is the row's creation.",
    };
    // Declared and uncommented: the declaration lives in this directory and the next person reads
    // the interface, so the kind that says a *name* is wrong has to land there too.
    expect(auditRecordReads(inputOf(text, { divergences: [d] })).map((f) => f.kind)).toEqual([
      "field_overload_uncommented",
    ]);
    expect(
      auditRecordReads(
        inputOf(text, {
          divergences: [d],
          fieldComments: new Map([[`${SHAPE.file}::madeAt`, "`madeAt` is the row's creation."]]),
        }),
      ),
    ).toEqual([]);
    // A comment that does not name the field is a comment about something else.
    expect(
      auditRecordReads(
        inputOf(text, {
          divergences: [d],
          fieldComments: new Map([[`${SHAPE.file}::madeAt`, "see the store for the join."]]),
        }),
      ).map((f) => f.kind),
    ).toEqual(["field_overload_uncommented"]);
  });

  it("reports an undeclared divergence, and a stale or duplicated declaration", () => {
    const text = "function f(row: WidgetRow) { return { madeAt: row.created_at }; }";
    expect(auditRecordReads(inputOf(text))).toMatchObject([
      { kind: "undeclared_read_divergence", field: "madeAt" },
    ]);
    const d = {
      file: SHAPE.file,
      field: "madeAt",
      column: "created_at",
      kind: "qualifier_differs" as const,
      note: "the contract calls the moment the row was made `madeAt`; it is the same instant.",
    };
    expect(auditRecordReads(inputOf(text, { divergences: [d] }))).toEqual([]);
    expect(
      auditRecordReads(inputOf("const x = 1;", { divergences: [d] })).map((f) => f.kind),
    ).toContain("divergence_overtaken");
    expect(
      auditRecordReads(inputOf(text, { divergences: [d, d] })).map((f) => f.kind),
    ).toContain("divergence_duplicate");
  });

  it("says when a read's row type resolves to no shape, but only where a derivation is lost", () => {
    // The gap is real — `StoredInstanceRow extends StoredCancellationColumns` was skipped entirely
    // and three reads off it silently resolved to no table — but a row whose every read agrees
    // needed no table, and firing there is noise.
    const diverging = inputOf("function f(row: GhostRow) { return { madeAt: row.created_at }; }");
    expect(auditRecordReads(diverging).map((f) => f.kind)).toContain("row_type_unknown");
    const agreeing = inputOf("function f(row: GhostRow) { return { status: row.status }; }");
    expect(auditRecordReads(agreeing).map((f) => f.kind)).not.toContain("row_type_unknown");
  });

  it("reports an undeclared alias, because there the rule is not asking at all", () => {
    const aliased: RowShape = { ...SHAPE, foreign: ["parent_natural_id"] };
    const findings = auditRecordReads(
      inputOf("const x = 1;", { rowShapes: [aliased] }),
    );
    expect(findings).toMatchObject([{ kind: "alias_undeclared", field: "parent_natural_id" }]);
    const declared = auditRecordReads(
      inputOf("const x = 1;", {
        rowShapes: [aliased],
        aliases: [
          {
            alias: "parent_natural_id",
            provenance: "joined_column",
            aliases: "widgets.widget_id",
            introducedIn: "packages/widgets/src/store.ts",
            note: "the parent's business key, reached by the join in the store's SELECT_JOINED.",
          },
        ],
      }),
    );
    expect(declared).toEqual([]);
  });

  it("reports an alias declaration no row carries any more", () => {
    expect(
      auditRecordReads(
        inputOf("const x = 1;", {
          aliases: [
            {
              alias: "gone_natural_id",
              provenance: "parameter_echo",
              aliases: null,
              introducedIn: "packages/widgets/src/store.ts",
              note: "an alias left behind by a SELECT that no longer projects it at all.",
            },
          ],
        }),
      ).map((f) => f.kind),
    ).toContain("alias_overtaken");
  });

  it("reports a row interface that should resolve and does not", () => {
    const unresolved: RowShape = { ...SHAPE, table: null };
    expect(
      auditRecordReads(inputOf("const x = 1;", { rowShapes: [unresolved] })).map((f) => f.kind),
    ).toContain("row_table_ambiguous");
  });

  it("formats findings one per line", () => {
    const findings = auditRecordReads(
      inputOf("function f(row: WidgetRow) { return { madeAt: row.created_at }; }"),
    );
    expect(formatRecordReadFindings(findings)).toContain("undeclared_read_divergence:");
    expect(formatRecordReadFindings([])).toBe("");
  });
});

/* --------------------------------------------------------------- workspace */

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const sources = readWorkspaceSources();
  const scanned = sources.files.filter(
    (f) => !PG_SCAN_EXEMPT_PACKAGE_DIRS.some((dir: string) => f.file.startsWith(dir)),
  );
  const rowShapes = resolveRowShapes(scanned, catalog);
  const { reads, derived } = scanRecordReads(scanned, catalog, rowShapes);
  const input: RecordReadAuditInput = {
    catalog,
    reads,
    rowShapes,
    divergences: RECORD_READ_DIVERGENCES,
    aliases: ROW_FIELD_ALIASES,
    // Read from the **unexempted** sources, because a `field_overloaded` declaration's comment has
    // to be found wherever the interface lives, which is not always a package with SQL in it.
    fieldComments: collectFieldComments(sources.files),
  };
  const summary = summarizeRecordReads(input);

  it("read the workspace, rather than silently reading nothing", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(800);
    expect(catalog.length).toBeGreaterThanOrEqual(145);
    expect(reads.length).toBeGreaterThanOrEqual(250);
    expect(rowShapes.length).toBeGreaterThanOrEqual(25);
  });

  it("agrees by default, which is the only reason a name rule is worth having", () => {
    expect(summary.agreeing).toBeGreaterThanOrEqual(240);
    expect(summary.agreeing / summary.total).toBeGreaterThan(0.85);
  });

  it("resolves a table for nearly every read, so the derivations are available", () => {
    // The write path knows its table from the statement; this one has to find it. A sharp drop
    // here means the interface scan has stopped matching and every divergence became a declaration.
    expect(summary.tableResolved).toBeGreaterThanOrEqual(250);
    expect(summary.tableResolved / summary.total).toBeGreaterThan(0.85);
    expect(rowShapes.filter((s) => s.table !== null).length).toBeGreaterThanOrEqual(20);
  });

  it("accounts for every divergence, by derivation or by declaration", () => {
    const findings = auditRecordReads(input);
    expect(formatRecordReadFindings(findings)).toBe("");
    expect(findings).toEqual([]);
  });

  it("derives what it claims to derive, and declares the rest", () => {
    expect(summary.derived.business_key).toBeGreaterThanOrEqual(7);
    expect(summary.declared).toBeGreaterThanOrEqual(15);
    // The declarations must not be carrying the rule: agreement is the norm, not the exception.
    expect(summary.declared).toBeLessThan(summary.agreeing / 5);
  });

  it("reports a field derived from several columns rather than comparing it to one", () => {
    expect(derived.length).toBeGreaterThanOrEqual(2);
    for (const d of derived) expect(d.columns.length).toBeGreaterThan(1);
  });

  it("fires on the real tree when one read is pointed at a sibling column", () => {
    // The live control, on the real tree rather than a fixture: take an agreeing read whose table
    // resolved and repoint it at a same-type sibling of the column it reads — one-sided, so this
    // is the transposition's *half*, which no reversed-pair check would catch.
    const victim = reads.find((r) => {
      if (r.field !== camelOfColumn(r.column)) return false;
      const t = tableForRead(r, rowShapes, catalog);
      const col = t?.columns.find((c) => c.name === r.column);
      if (t === null || col === undefined) return false;
      return t.columns.some((c) => c.name !== r.column && c.type === col.type);
    });
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const table = tableForRead(victim, rowShapes, catalog);
    expect(table).not.toBeNull();
    const victimColumn = table?.columns.find((c) => c.name === victim.column);
    const sibling = table?.columns.find(
      (c) => c.name !== victim.column && c.type === victimColumn?.type,
    );
    expect(sibling).toBeDefined();
    if (sibling === undefined) return;
    const findings = auditRecordReads({
      ...input,
      reads: reads.map((r) => (r === victim ? { ...r, column: sibling.name } : r)),
    });
    expect(findings.map((f) => f.kind)).toContain("field_reads_sibling_column");
    expect(findings.some((f) => f.field === victim.field && f.file === victim.file)).toBe(true);
  });

  it("fires on the real tree when two reads in one record are reversed", () => {
    // Two agreeing same-type reads of one object literal, swapped. Keyed on the literal because
    // the pair has to be of ONE record — two sibling records in one function are not a transposition.
    const byLiteral = new Map<string, typeof reads>();
    for (const r of reads) {
      if (r.field !== camelOfColumn(r.column)) continue;
      const key = `${r.file}#${r.literal.toString()}`;
      byLiteral.set(key, [...(byLiteral.get(key) ?? []), r]);
    }
    let pair: readonly [(typeof reads)[number], (typeof reads)[number]] | null = null;
    for (const group of byLiteral.values()) {
      const table = group[0] === undefined ? null : tableForRead(group[0], rowShapes, catalog);
      if (table === null) continue;
      const typeOf = (name: string) => table.columns.find((c) => c.name === name)?.type;
      const found = group.find(
        (a) => group.find((b) => b !== a && typeOf(a.column) === typeOf(b.column)) !== undefined,
      );
      const other = group.find((b) => b !== found && typeOf(b.column) === typeOf(found?.column ?? ""));
      if (found !== undefined && other !== undefined) {
        pair = [found, other];
        break;
      }
    }
    expect(pair).not.toBeNull();
    if (pair === null) return;
    const [a, b] = pair;
    const swapped = reads.map((r) =>
      r === a ? { ...r, column: b.column } : r === b ? { ...r, column: a.column } : r,
    );
    const findings = auditRecordReads({ ...input, reads: swapped });
    expect(findings[0]?.kind).toBe("reversed_pair");
    expect(findings[0]?.detail).toContain("each field is filled from the");
  });

  it("every derivation still names one column, over the whole catalog", () => {
    // ADR-0355's assertion, re-asked here because this rule reads the same map: a derivation whose
    // tightness has lapsed is a guess, and the read path would inherit it silently.
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
          const targets = t.columns.filter((c) => DERIVATION_RULES[d].admits(c, property, t));
          if (targets.length > 1) ambiguous.push(`${d}: ${t.name}.${property}`);
        }
      }
    }
    expect(ambiguous).toEqual([]);
  });
});
