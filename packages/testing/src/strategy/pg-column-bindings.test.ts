import { describe, expect, it } from "vitest";

import {
  auditColumnBindings,
  BINDING_GAPS,
  BINDING_STATEMENT_KINDS,
  BindingGapSchema,
  BOUND_DOMAIN_OUTCOMES,
  buildDomainLookup,
  canonicalDomainRef,
  COLUMN_BINDING_FINDING_KINDS,
  COLUMN_BINDING_KINDS,
  ColumnBindingSchema,
  collectStoreTypes,
  extractColumnBindings,
  formatColumnBindingFindings,
  objectLiteralFields,
  pickByOrigin,
  resolveBoundDomain,
  resolveLocalDomain,
  scanColumnBindings,
  summarizeColumnBindings,
  UNCONSTRAINED_BINDINGS,
  UnconstrainedBindingSchema,
  UNRESOLVED_BINDING_KINDS,
  type CatalogColumnValueSet,
  type ColumnBinding,
  type ColumnBindingAuditInput,
  type DeclaredColumnDomain,
} from "./pg-column-bindings.js";
import { PG_SCAN_EXEMPT_PACKAGE_DIRS, parseCatalogSource } from "./pg-column-coverage.js";
import { STORELESS_TABLES } from "./pg-storeless-tables.js";
import {
  catalogValueSets,
  collectWorkspaceDomains,
  VALUE_SET_DOMAINS,
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

function bindingsOf(text: string): readonly ColumnBinding[] {
  return extractColumnBindings("packages/widgets/src/store.ts", text).bindings;
}

function unresolvedOf(text: string): readonly { kind: string; column: string | null }[] {
  return extractColumnBindings("packages/widgets/src/store.ts", text).unresolved.map((u) => ({
    kind: u.kind,
    column: u.column,
  }));
}

function domain(over: Partial<WorkspaceDomain> = {}): WorkspaceDomain {
  return {
    package: "@crossengin/widgets",
    name: "WIDGET_STATUSES",
    kind: "constant",
    file: "packages/widgets/src/widgets.ts",
    line: 3,
    members: ["open", "closed"],
    typedBy: null,
    ...over,
  };
}

function lookupOf(
  domains: readonly WorkspaceDomain[],
  sources: readonly WorkspaceSourceFile[] = [],
): ReturnType<typeof buildDomainLookup> {
  return buildDomainLookup(domains, collectStoreTypes(sources));
}

/* ------------------------------------------------------------- the vocabulary */

describe("the vocabulary", () => {
  it("names the three statement shapes that put a value into a column", () => {
    expect(BINDING_STATEMENT_KINDS).toEqual(["insert", "conflict_update", "update"]);
  });

  it("separates a receiver's field from a bare local, because they resolve differently", () => {
    expect(COLUMN_BINDING_KINDS).toEqual(["parameter", "local", "literal"]);
  });

  it("ranks the findings by severity, with the two symbol defects first", () => {
    expect(COLUMN_BINDING_FINDING_KINDS.slice(0, 4)).toEqual([
      "ref_contradicts_binding",
      "binding_domain_unexported",
      "literal_refused_by_check",
      "inline_union_exceeds_check",
    ]);
  });

  it("has an outcome for each thing a bound field's type can say", () => {
    expect(BOUND_DOMAIN_OUTCOMES).toEqual([
      "named",
      "inline_union",
      "unconstrained",
      "unresolved",
    ]);
  });

  it("refuses a binding record whose kind and fields disagree", () => {
    const base = {
      file: "packages/widgets/src/store.ts",
      line: 4,
      statement: "insert" as const,
      schema: "meta",
      table: "widgets",
      column: "status",
      receiver: null,
      property: null,
      receiverType: null,
      literal: null,
    };
    expect(() => ColumnBindingSchema.parse({ ...base, kind: "parameter" })).toThrow(
      /must name the receiver and the property/,
    );
    expect(() =>
      ColumnBindingSchema.parse({ ...base, kind: "local", receiver: "w", property: "status" }),
    ).toThrow(/names an identifier and no receiver/);
    expect(() => ColumnBindingSchema.parse({ ...base, kind: "literal" })).toThrow(
      /must carry its value/,
    );
  });
});

/* ------------------------------------------------------- extractColumnBindings */

describe("extractColumnBindings", () => {
  it("maps a column to its own VALUES expression and then to its parameter", () => {
    expect(
      bindingsOf(`
        async insert(widget: Widget): Promise<void> {
          await this.conn.query(
            \`INSERT INTO meta.widgets (id, status, kind) VALUES ($1, $2, $3)\`,
            [widget.id, widget.status, widget.kind],
          );
        }
      `),
    ).toMatchObject([
      { column: "id", kind: "parameter", receiver: "widget", property: "id" },
      { column: "status", kind: "parameter", receiver: "widget", property: "status" },
      { column: "kind", kind: "parameter", receiver: "widget", property: "kind" },
    ]);
  });

  it("follows a reordered VALUES list rather than zipping the column list", () => {
    // `platform-users.ts` writes exactly this: column order is not parameter order, and `status`
    // arrives from a literal rather than from any parameter. A zip reports `id <- params[0]`.
    const bindings = bindingsOf(`
      async provision(input: CreateUserInput): Promise<void> {
        await this.conn.query(
          \`INSERT INTO meta.users (id, email, status) VALUES ($3::uuid, $1, 'active')\`,
          [input.email, input.displayName, input.id],
        );
      }
    `);
    expect(bindings).toMatchObject([
      { column: "id", kind: "parameter", property: "id" },
      { column: "email", kind: "parameter", property: "email" },
      { column: "status", kind: "literal", literal: "active" },
    ]);
  });

  it("refuses a position at or past a spread, and keeps the ones before it", () => {
    // The gap that taught the rule: with `...RATES` at position 3, `$5` cannot be located, while
    // `$1` and `$2` are untouched by it.
    const extraction = extractColumnBindings(
      "packages/widgets/src/store.ts",
      `
        async upsert(evidence: Evidence): Promise<void> {
          await this.conn.query(
            \`INSERT INTO meta.widgets (id, kind, a, b, status) VALUES ($1, $2, $3, $4, $5)\`,
            [evidence.id, evidence.kind, ...RATES.map((r) => evidence[r]), evidence.status],
          );
        }
      `,
    );
    expect(extraction.bindings.map((b) => b.column)).toEqual(["id", "kind"]);
    expect(extraction.unresolved).toMatchObject([
      { kind: "params_after_spread", column: "a" },
      { kind: "params_after_spread", column: "b" },
      { kind: "params_after_spread", column: "status" },
    ]);
    expect(extraction.unresolved[0]?.detail).toContain("at position 3");
  });

  it("takes the parameter array from the call that encloses the statement", () => {
    // The first measurement of this rule took "the next query call" and resolved 56 positions
    // against another method's array, because `tx.query(\`INSERT …\`, […])` opens *before* the
    // statement it carries.
    expect(
      bindingsOf(`
        async first(a: Widget): Promise<void> {
          await tx.query(\`INSERT INTO meta.widgets (status) VALUES ($1)\`, [a.status]);
        }
        async second(b: Gadget): Promise<void> {
          await tx.query(\`INSERT INTO meta.gadgets (kind) VALUES ($1)\`, [b.kind]);
        }
      `),
    ).toMatchObject([
      { table: "widgets", column: "status", receiver: "a" },
      { table: "gadgets", column: "kind", receiver: "b" },
    ]);
  });

  it("steps over a query call's type argument", () => {
    expect(
      bindingsOf(`
        async insert(w: Widget): Promise<void> {
          await tx.query<{ id: string }>(
            \`INSERT INTO meta.widgets (status) VALUES ($1)\`,
            [w.status],
          );
        }
      `),
    ).toMatchObject([{ column: "status", receiver: "w", property: "status" }]);
  });

  it("follows a const the next call passes, including a ternary of two templates", () => {
    // `timer-store.ts` builds its SQL as `const sql = cond ? \`INSERT …\` : \`INSERT …\``, and
    // reading only to the first closing backtick left six of its bindings unlocated.
    expect(
      bindingsOf(`
        async upsert(p: Projection): Promise<void> {
          const sql = p.preserve
            ? \`INSERT INTO meta.widgets (status) VALUES ($1)\`
            : \`INSERT INTO meta.widgets (status, kind) VALUES ($1, $2)\`;
          await this.conn.query(sql, [p.status, p.kind]);
        }
      `),
    ).toMatchObject([
      { column: "status", receiver: "p", property: "status" },
      { column: "status", receiver: "p", property: "status" },
      { column: "kind", receiver: "p", property: "kind" },
    ]);
  });

  it("refuses a const whose SQL the following call does not pass", () => {
    expect(
      unresolvedOf(`
        const sql = \`INSERT INTO meta.widgets (status) VALUES ($1)\`;
        await this.conn.query(other, [x.status]);
      `),
    ).toEqual([{ kind: "params_not_located", column: "status" }]);
  });

  it("inherits an EXCLUDED assignment from the INSERT rather than treating it as a source", () => {
    const bindings = bindingsOf(`
      await this.conn.query(
        \`INSERT INTO meta.widgets (id, status) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status\`,
        [w.id, w.status],
      );
    `);
    expect(bindings.filter((b) => b.statement === "conflict_update")).toMatchObject([
      { column: "status", kind: "parameter", receiver: "w", property: "status" },
    ]);
  });

  it("reports an EXCLUDED assignment naming a column the INSERT does not list", () => {
    expect(
      unresolvedOf(`
        await this.conn.query(
          \`INSERT INTO meta.widgets (id) VALUES ($1)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status\`,
          [w.id],
        );
      `),
    ).toEqual([{ kind: "excluded_column_not_inserted", column: "status" }]);
  });

  it("reads a plain UPDATE's assignments", () => {
    expect(
      bindingsOf(`
        async advance(update: Advance): Promise<void> {
          await this.conn.query(
            \`UPDATE meta.widgets SET status = $2, kind = 'manual' WHERE id = $1\`,
            [update.id, update.status],
          );
        }
      `),
    ).toMatchObject([
      { statement: "update", column: "status", receiver: "update", property: "status" },
      { statement: "update", column: "kind", kind: "literal", literal: "manual" },
    ]);
  });

  it("records a bare identifier as a local, with its own annotated type", () => {
    expect(
      bindingsOf(`
        async setStatus(id: string, status: TenantStatus): Promise<void> {
          await this.conn.query(\`UPDATE meta.widgets SET status = $2 WHERE id = $1\`, [id, status]);
        }
      `),
    ).toMatchObject([
      { kind: "local", receiver: null, property: "status", receiverType: "TenantStatus" },
    ]);
  });

  it("prefers a nearer literal-union annotation over a wider named one", () => {
    // `job-engine.ts` declares `disposition: JobRunDisposition` six members wide and then passes a
    // parameter annotated `"failed" | "dead-lettered"`. Reading past the union to the named type
    // would claim four members the column does not admit are bound here.
    const bindings = bindingsOf(`
      interface Result { readonly disposition: JobRunDisposition }
      async finalize(id: string, disposition: "failed" | "dead-lettered"): Promise<void> {
        await this.conn.query(\`UPDATE meta.widgets SET status = $2 WHERE id = $1\`, [id, disposition]);
      }
    `);
    expect(bindings[0]?.receiverType).toBe('"failed" | "dead-lettered"');
  });

  it("leaves receiverType null when the module annotates the receiver nowhere", () => {
    expect(
      bindingsOf(`
        rows.map((p) => this.conn.query(\`UPDATE meta.widgets SET status = $1\`, [p.status]));
      `),
    ).toMatchObject([{ receiverType: null, receiver: "p" }]);
  });

  it("reports every way a statement can fail to yield a symbol", () => {
    const kinds = new Set<string>();
    for (const text of [
      "`INSERT INTO meta.widgets (${COLS}) VALUES ($1)`",
      "`INSERT INTO meta.widgets (count(*)) VALUES ($1)`",
      "`INSERT INTO meta.widgets (status) SELECT $1`",
      "`INSERT INTO meta.widgets (status) VALUES (${PLACEHOLDERS})`",
      "`INSERT INTO meta.widgets (status, kind) VALUES ($1)`",
      "`UPDATE meta.widgets SET ${assignments}`",
      "this.conn.query(`INSERT INTO meta.widgets (status) VALUES ($1)`, params)",
      "this.conn.query(`INSERT INTO meta.widgets (status) VALUES ($2)`, [a.b])",
      "this.conn.query(`INSERT INTO meta.widgets (status) VALUES ($1)`, [MAP[x.y]])",
      "this.conn.query(`INSERT INTO meta.widgets (status) VALUES (CASE WHEN a THEN 'x' END)`, [])",
    ]) {
      for (const u of extractColumnBindings("packages/widgets/src/store.ts", text).unresolved) {
        kinds.add(u.kind);
      }
    }
    expect([...kinds].sort()).toEqual(
      [
        "column_list_unresolved",
        "columns_not_bare",
        "params_not_an_array",
        "params_too_short",
        "parameter_not_a_property",
        "set_clause_unresolved",
        "value_not_a_parameter",
        "values_arity_mismatch",
        "values_clause_absent",
        "values_clause_unresolved",
      ].sort(),
    );
    // Every kind in the enum is either exercised above or exercised by its own test; none is
    // unreachable, which is what a vocabulary nobody can produce would be.
    expect(UNRESOLVED_BINDING_KINDS.length).toBe(13);
  });
});

/* --------------------------------------------------------- objectLiteralFields */

describe("objectLiteralFields", () => {
  it("keeps the whole initialiser, including a call with a string argument", () => {
    // The off-by-one this replaces swallowed the `)` after a string literal, so the depth counter
    // never returned to zero and the field list truncated at the first `.default("…")`. It hid
    // `ChainCheckpointSchema.algorithm` and `CreateTenantInputSchema.region`.
    expect([
      ...objectLiteralFields(`
        sequenceNumber: z.number().int(),
        algorithm: z.enum(HASH_ALGORITHMS).default("sha256"),
        rootHash: z.string().regex(SHA256_REGEX),
      `),
    ]).toEqual([
      ["sequenceNumber", "z.number().int()"],
      ["algorithm", 'z.enum(HASH_ALGORITHMS).default("sha256")'],
      ["rootHash", "z.string().regex(SHA256_REGEX)"],
    ]);
  });

  it("does not descend into a nested object", () => {
    const fields = objectLiteralFields(`a: z.object({ b: z.string() }), c: z.number()`);
    expect([...fields.keys()]).toEqual(["a", "c"]);
  });
});

/* ------------------------------------------------------------ collectStoreTypes */

describe("collectStoreTypes", () => {
  const sources = [
    source(
      "packages/widgets/src/widgets.ts",
      `
        export const WIDGET_STATUSES = ["open", "closed"] as const;
        export type WidgetStatus = (typeof WIDGET_STATUSES)[number];
        export const StatusSchema = z.enum(WIDGET_STATUSES);
        export const WidgetSchema = z.object({
          status: StatusSchema,
          kind: z.enum(["a", "b"]),
          label: z.string(),
        });
        export type Widget = z.infer<typeof WidgetSchema>;
        export interface Projection {
          readonly status: WidgetStatus;
          readonly note: string;
          readonly role: "system" | "user";
        }
      `,
    ),
  ];
  const index = collectStoreTypes(sources);

  it("reads a named enum schema and the constant it references", () => {
    expect(index.enumSchemas.get("StatusSchema")).toMatchObject([
      { reference: "WIDGET_STATUSES", members: null },
    ]);
  });

  it("reads an inline enum schema's members", () => {
    const inline = collectStoreTypes([
      source("packages/widgets/src/x.ts", `export const KSchema = z.enum(["a", "b"]);`),
    ]);
    expect(inline.enumSchemas.get("KSchema")?.[0]?.members).toEqual(["a", "b"]);
  });

  it("reads an exported schema's field initialisers and its interfaces' field types", () => {
    expect(index.schemaFields.get("WidgetSchema.status")?.[0]?.text).toBe("StatusSchema");
    expect(index.objectFields.get("Projection.status")?.[0]?.text).toBe("WidgetStatus");
    expect(index.objectFields.get("Projection.role")?.[0]?.text).toBe('"system" | "user"');
  });

  it("reads both alias idioms", () => {
    expect(index.enumAliases.get("WidgetStatus")?.[0]?.constant).toBe("WIDGET_STATUSES");
    expect(index.inferAliases.get("Widget")?.[0]?.text).toBe("WidgetSchema");
  });

  it("records which package each file imports a name from", () => {
    const importing = collectStoreTypes([
      source(
        "packages/store/src/s.ts",
        `import { SeveritySchema } from "@crossengin/incident-response";`,
        "@crossengin/store",
      ),
    ]);
    expect(importing.importsByFile.get("packages/store/src/s.ts")?.get("SeveritySchema")).toBe(
      "@crossengin/incident-response",
    );
  });
});

/* --------------------------------------------------------------- pickByOrigin */

describe("pickByOrigin", () => {
  const imports = new Map([
    ["packages/store/src/s.ts", new Map([["SEVERITIES", "@crossengin/incident-response"]])],
  ]);
  const candidates = [
    { package: "@crossengin/incident-response", file: "packages/incident-response/src/a.ts" },
    { package: "@crossengin/observability", file: "packages/observability/src/b.ts" },
  ];

  it("resolves a same-named symbol through the referencing file's import", () => {
    // This is the step whose absence produced four of the first measurement's "contradictions":
    // `incident-response`'s SEVERITIES is sev1..sev5 and `observability`'s is P0..P3, and a
    // bare-name map holds whichever was scanned last.
    expect(
      pickByOrigin(candidates, ["SEVERITIES"], "packages/store/src/s.ts", "@crossengin/store", imports),
    ).toBe(candidates[0]);
  });

  it("prefers the same file, then the same package", () => {
    expect(
      pickByOrigin(candidates, ["SEVERITIES"], "packages/observability/src/b.ts", "@crossengin/x", imports),
    ).toBe(candidates[1]);
    expect(
      pickByOrigin(candidates, ["SEVERITIES"], "packages/other/src/c.ts", "@crossengin/observability", imports),
    ).toBe(candidates[1]);
  });

  it("answers null rather than guessing between two it cannot separate", () => {
    expect(
      pickByOrigin(candidates, ["SEVERITIES"], "packages/other/src/c.ts", "@crossengin/other", imports),
    ).toBeNull();
    expect(pickByOrigin(undefined, ["X"], "f", "p", imports)).toBeNull();
    expect(pickByOrigin([], ["X"], "f", "p", imports)).toBeNull();
  });

  it("takes a single candidate wherever it lives", () => {
    expect(
      pickByOrigin([candidates[0]!], ["SEVERITIES"], "packages/other/src/c.ts", "@crossengin/o", imports),
    ).toBe(candidates[0]);
  });
});

/* ----------------------------------------------------------- canonicalDomainRef */

describe("canonicalDomainRef", () => {
  it("follows a schema field to the constant it is typed by", () => {
    const lookup = lookupOf([
      domain({ name: "WIDGET_STATUSES" }),
      domain({
        name: "WidgetSchema.status",
        kind: "schema_field",
        typedBy: "@crossengin/widgets:WIDGET_STATUSES",
      }),
    ]);
    expect(canonicalDomainRef("@crossengin/widgets:WidgetSchema.status", lookup)).toBe(
      "@crossengin/widgets:WIDGET_STATUSES",
    );
  });

  it("follows a re-export alias, so ADR-0334's deliberate re-export is not a second spelling", () => {
    const lookup = lookupOf([
      domain({ package: "@crossengin/tenant-lifecycle", name: "TENANT_LIFECYCLE_STATES" }),
      domain({
        package: "@crossengin/operate-server",
        name: "TENANT_STATUSES",
        typedBy: "@crossengin/tenant-lifecycle:TENANT_LIFECYCLE_STATES",
      }),
    ]);
    expect(canonicalDomainRef("@crossengin/operate-server:TENANT_STATUSES", lookup)).toBe(
      "@crossengin/tenant-lifecycle:TENANT_LIFECYCLE_STATES",
    );
  });

  it("leaves a constant and an unknown ref alone, and terminates on a cycle", () => {
    const lookup = lookupOf([
      domain({ name: "A", typedBy: "@crossengin/widgets:B" }),
      domain({ name: "B", typedBy: "@crossengin/widgets:A" }),
    ]);
    expect(canonicalDomainRef("@crossengin/widgets:WIDGET_STATUSES", lookupOf([domain()]))).toBe(
      "@crossengin/widgets:WIDGET_STATUSES",
    );
    expect(canonicalDomainRef("@crossengin/nope:X", lookupOf([]))).toBe("@crossengin/nope:X");
    // A cycle is impossible in valid TypeScript; it terminates at the ref it comes back to rather
    // than looping, which is the only property worth asserting.
    expect(canonicalDomainRef("@crossengin/widgets:A", lookup)).toBe("@crossengin/widgets:A");
  });
});

/* ------------------------------------------------------------ resolveBoundDomain */

describe("resolveBoundDomain", () => {
  const sources = [
    source(
      "packages/widgets/src/widgets.ts",
      `
        export const WIDGET_STATUSES = ["open", "closed"] as const;
        export type WidgetStatus = (typeof WIDGET_STATUSES)[number];
        export const StatusSchema = z.enum(WIDGET_STATUSES);
        export const WidgetSchema = z.object({
          status: StatusSchema,
          kind: z.enum(["a", "b"]),
          label: z.string().min(1),
          count: z.number().int(),
        });
        export type Widget = z.infer<typeof WidgetSchema>;
        export interface Projection {
          readonly status: WidgetStatus;
          readonly role: "system" | "user";
          readonly note: string;
          readonly bag: Record<string, unknown>;
        }
      `,
    ),
  ];
  const domains = collectWorkspaceDomains(sources).domains;
  const lookup = lookupOf(domains, sources);
  const at = (type: string, field: string) =>
    resolveBoundDomain(type, field, lookup, "packages/widgets/src/widgets.ts", "@crossengin/widgets");

  it("answers a schema field typed by a named enum schema with the constant behind it", () => {
    expect(at("Widget", "status")).toMatchObject({
      outcome: "named",
      ref: "@crossengin/widgets:WIDGET_STATUSES",
      nameable: true,
    });
  });

  it("answers an inline z.enum field with the schema field itself, which is all there is to name", () => {
    expect(at("Widget", "kind")).toMatchObject({
      outcome: "named",
      ref: "@crossengin/widgets:WidgetSchema.kind",
      members: ["a", "b"],
    });
  });

  it("answers an interface field aliased to a constant", () => {
    expect(at("Projection", "status")).toMatchObject({
      outcome: "named",
      ref: "@crossengin/widgets:WIDGET_STATUSES",
    });
  });

  it("answers an inline literal union with its members and no ref", () => {
    expect(at("Projection", "role")).toMatchObject({
      outcome: "inline_union",
      ref: null,
      members: ["system", "user"],
    });
  });

  it("calls a string-typed field unconstrained, in both the zod and the interface spellings", () => {
    // `z.string().min(1)` as much as a bare `z.string()`: against a value set, a refinement that is
    // not an enum leaves the CHECK as the only thing that refuses a wrong value.
    expect(at("Widget", "label")).toMatchObject({ outcome: "unconstrained" });
    expect(at("Projection", "note")).toMatchObject({ outcome: "unconstrained" });
  });

  it("reports, rather than guessing, when nothing names the domain", () => {
    expect(at("Projection", "bag").outcome).toBe("unresolved");
    expect(at("Widget", "count").outcome).toBe("unresolved");
    expect(at("Nothing", "status")).toMatchObject({
      outcome: "unresolved",
      reason: expect.stringContaining("nothing named `Nothing`"),
    });
    expect(at("Widget", "absent")).toMatchObject({
      outcome: "unresolved",
      reason: expect.stringContaining("declares no field"),
    });
  });

  it("marks a domain its package does not export as not nameable", () => {
    const privateSources = [
      source(
        "packages/widgets/src/p.ts",
        `
          const PRIVATE_STATUSES = ["open", "closed"] as const;
          export const PrivateSchema = z.object({ status: z.enum(PRIVATE_STATUSES) });
        `,
      ),
    ];
    const privateDomains = collectWorkspaceDomains(privateSources).domains;
    const resolved = resolveBoundDomain(
      "Private",
      "status",
      lookupOf(privateDomains, privateSources),
      "packages/widgets/src/p.ts",
      "@crossengin/widgets",
    );
    expect(resolved).toMatchObject({
      outcome: "named",
      ref: "@crossengin/widgets:PRIVATE_STATUSES",
      nameable: false,
    });
  });

  it("resolveLocalDomain asks what the identifier itself is, not what declares a field of its name", () => {
    expect(
      resolveLocalDomain(
        "WidgetStatus",
        lookup,
        "packages/widgets/src/widgets.ts",
        "@crossengin/widgets",
      ),
    ).toMatchObject({ outcome: "named", ref: "@crossengin/widgets:WIDGET_STATUSES" });
  });
});

/* ------------------------------------------------------------ auditColumnBindings */

describe("auditColumnBindings", () => {
  const storeText = `
    async insert(w: Widget): Promise<void> {
      await this.conn.query(
        \`INSERT INTO meta.widgets (status) VALUES ($1)\`,
        [w.status],
      );
    }
  `;
  const contractText = `
    export const WIDGET_STATUSES = ["open", "closed"] as const;
    export const WidgetSchema = z.object({ status: z.enum(WIDGET_STATUSES) });
  `;
  const rivalText = `export const WIDGET_STATUSES = ["open", "closed"] as const;`;

  function inputOf(over: Partial<ColumnBindingAuditInput> = {}): ColumnBindingAuditInput {
    const sources = [
      source("packages/widgets/src/widgets.ts", contractText),
      source("packages/widgets/src/store.ts", storeText),
    ];
    const extraction = extractColumnBindings("packages/widgets/src/store.ts", storeText);
    return {
      valueSets: [{ table: "widgets", column: "status", values: ["open", "closed"] }],
      declarations: [
        { table: "widgets", column: "status", ref: "@crossengin/widgets:WIDGET_STATUSES" },
      ],
      bindings: extraction.bindings,
      unresolved: extraction.unresolved,
      lookup: lookupOf(collectWorkspaceDomains(sources).domains, sources),
      packageOfFile: new Map(sources.map((s) => [s.file, s.package])),
      gaps: [],
      unconstrained: [],
      ...over,
    };
  }

  it("is silent when the declaration names the symbol the store binds", () => {
    expect(auditColumnBindings(inputOf())).toEqual([]);
    expect(summarizeColumnBindings(inputOf()).agreeing).toBe(1);
  });

  it("reports a ref naming a different symbol with the same members", () => {
    // The control for the whole rule: two constants of identical membership in two packages. A
    // member comparison cannot tell them apart, which is exactly why ADR-0353 could not.
    const sources = [
      source("packages/widgets/src/widgets.ts", contractText),
      source("packages/widgets/src/store.ts", storeText),
      source("packages/rival/src/rival.ts", rivalText, "@crossengin/rival"),
    ];
    const findings = auditColumnBindings(
      inputOf({
        declarations: [
          { table: "widgets", column: "status", ref: "@crossengin/rival:WIDGET_STATUSES" },
        ],
        lookup: lookupOf(collectWorkspaceDomains(sources).domains, sources),
      }),
    );
    expect(findings).toMatchObject([{ kind: "ref_contradicts_binding", column: "status" }]);
    expect(findings[0]?.detail).toContain("@crossengin/widgets:WIDGET_STATUSES");
    expect(findings[0]?.detail).toContain("@crossengin/rival:WIDGET_STATUSES");
  });

  it("accepts either spelling of one domain", () => {
    expect(
      auditColumnBindings(
        inputOf({
          declarations: [
            {
              table: "widgets",
              column: "status",
              ref: "@crossengin/widgets:WidgetSchema.status",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("reports an unexported bound domain instead of a contradiction, because no ref can be right", () => {
    const privateContract = `
      const WIDGET_STATUSES = ["open", "closed"] as const;
      export const WidgetSchema = z.object({ status: z.enum(WIDGET_STATUSES) });
    `;
    const sources = [
      source("packages/widgets/src/widgets.ts", privateContract),
      source("packages/widgets/src/store.ts", storeText),
    ];
    const findings = auditColumnBindings(
      inputOf({ lookup: lookupOf(collectWorkspaceDomains(sources).domains, sources) }),
    );
    expect(findings).toMatchObject([{ kind: "binding_domain_unexported", column: "status" }]);
    expect(findings[0]?.detail).toContain("Export the bound constant, or converge");
  });

  it("checks a SQL literal against the CHECK with no declaration involved", () => {
    const literalStore = `
      await this.conn.query(\`INSERT INTO meta.widgets (status) VALUES ('wedged')\`, []);
    `;
    const extraction = extractColumnBindings("packages/widgets/src/store.ts", literalStore);
    expect(
      auditColumnBindings(inputOf({ bindings: extraction.bindings, unresolved: extraction.unresolved })),
    ).toMatchObject([{ kind: "literal_refused_by_check", column: "status" }]);
  });

  it("checks an inline union as a subset, because one write path need not cover the domain", () => {
    const unionStore = `
      async advance(id: string, status: "open" | "wedged"): Promise<void> {
        await this.conn.query(\`UPDATE meta.widgets SET status = $2 WHERE id = $1\`, [id, status]);
      }
    `;
    const sources = [
      source("packages/widgets/src/widgets.ts", contractText),
      source("packages/widgets/src/store.ts", unionStore),
    ];
    const extraction = extractColumnBindings("packages/widgets/src/store.ts", unionStore);
    const findings = auditColumnBindings(
      inputOf({
        bindings: extraction.bindings,
        unresolved: extraction.unresolved,
        lookup: lookupOf(collectWorkspaceDomains(sources).domains, sources),
        packageOfFile: new Map(sources.map((s) => [s.file, s.package])),
      }),
    );
    expect(findings).toMatchObject([{ kind: "inline_union_exceeds_check" }]);
    expect(findings[0]?.detail).toContain("wedged");
    // A strict subset is correct and silent.
    const narrow = unionStore.replace('"open" | "wedged"', '"open"');
    const narrowed = extractColumnBindings("packages/widgets/src/store.ts", narrow);
    expect(
      auditColumnBindings(
        inputOf({
          bindings: narrowed.bindings,
          unresolved: narrowed.unresolved,
          lookup: lookupOf(
            collectWorkspaceDomains([
              source("packages/widgets/src/widgets.ts", contractText),
              source("packages/widgets/src/store.ts", narrow),
            ]).domains,
            sources,
          ),
        }),
      ),
    ).toEqual([]);
  });

  it("requires an unconstrained binding to be declared, and reports a stale declaration", () => {
    const looseContract = `export const WidgetSchema = z.object({ status: z.string() });`;
    const sources = [
      source("packages/widgets/src/widgets.ts", looseContract),
      source("packages/widgets/src/store.ts", storeText),
    ];
    const loose = inputOf({ lookup: lookupOf(collectWorkspaceDomains(sources).domains, sources) });
    expect(auditColumnBindings(loose)).toMatchObject([
      { kind: "unconstrained_undeclared", column: "status" },
    ]);
    expect(
      auditColumnBindings({
        ...loose,
        unconstrained: [
          {
            table: "widgets",
            column: "status",
            type: "WidgetSchema",
            field: "status",
            note: "declared so that a fifth one of these is visible in a diff rather than silent.",
          },
        ],
      }),
    ).toEqual([]);
    expect(
      auditColumnBindings({
        ...inputOf(),
        unconstrained: [
          {
            table: "widgets",
            column: "status",
            type: "WidgetSchema",
            field: "status",
            note: "declared so that a fifth one of these is visible in a diff rather than silent.",
          },
        ],
      }),
    ).toMatchObject([{ kind: "unconstrained_overtaken" }]);
  });

  it("requires an unresolved binding to be declared, both directions", () => {
    const opaque = "`INSERT INTO meta.widgets (status) VALUES (${PLACEHOLDERS})`";
    const extraction = extractColumnBindings("packages/widgets/src/store.ts", opaque);
    const base = inputOf({ bindings: extraction.bindings, unresolved: extraction.unresolved });
    expect(auditColumnBindings(base)).toMatchObject([{ kind: "gap_undeclared" }]);
    const gap = {
      file: "packages/widgets/src/store.ts",
      table: "widgets",
      kind: "values_clause_unresolved" as const,
      note: "the VALUES list is rendered by a helper over the record.",
    };
    expect(auditColumnBindings({ ...base, gaps: [gap] })).toEqual([]);
    expect(auditColumnBindings({ ...base, gaps: [gap, gap] })).toMatchObject([
      { kind: "gap_duplicate" },
    ]);
    expect(auditColumnBindings({ ...inputOf(), gaps: [gap] })).toMatchObject([
      { kind: "gap_overtaken" },
    ]);
  });

  it("reports a bound value-set column that VALUE_SET_DOMAINS does not declare", () => {
    expect(auditColumnBindings(inputOf({ declarations: [] }))).toMatchObject([
      { kind: "column_undeclared", column: "status" },
    ]);
  });

  it("formats findings one per line", () => {
    const findings = auditColumnBindings(inputOf({ declarations: [] }));
    expect(formatColumnBindingFindings(findings)).toContain("column_undeclared: widgets.status");
    expect(formatColumnBindingFindings([])).toBe("");
  });
});

/* ------------------------------------------------------------ the declarations */

describe("the declaration shapes", () => {
  it("requires a gap to name a reason long enough to be one", () => {
    expect(() =>
      BindingGapSchema.parse({ file: "a.ts", table: "widgets", kind: "values_clause_unresolved", note: "short" }),
    ).toThrow();
    expect(() =>
      BindingGapSchema.parse({ file: "a.ts", table: "widgets", kind: "nope", note: "x".repeat(40) }),
    ).toThrow();
  });

  it("requires an unconstrained declaration to name the field and the consequence", () => {
    expect(() =>
      UnconstrainedBindingSchema.parse({
        table: "widgets",
        column: "status",
        type: "T",
        field: "status",
        note: "too short",
      }),
    ).toThrow();
  });

  it("parses every shipped declaration", () => {
    for (const gap of BINDING_GAPS) expect(() => BindingGapSchema.parse(gap)).not.toThrow();
    for (const u of UNCONSTRAINED_BINDINGS) {
      expect(() => UnconstrainedBindingSchema.parse(u)).not.toThrow();
    }
  });
});

/* --------------------------------------------------------------- the workspace */

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const valueSets: readonly CatalogColumnValueSet[] = catalogValueSets(catalog);
  const sources = readWorkspaceSources();
  const scanned = sources.files.filter(
    (f) => !PG_SCAN_EXEMPT_PACKAGE_DIRS.some((dir: string) => f.file.startsWith(dir)),
  );
  const scan = collectWorkspaceDomains(sources.files);
  const index = collectStoreTypes(sources.files);
  const lookup = buildDomainLookup(scan.domains, index);
  const extraction = scanColumnBindings(scanned);
  const input: ColumnBindingAuditInput = {
    valueSets,
    declarations: VALUE_SET_DOMAINS as readonly DeclaredColumnDomain[],
    bindings: extraction.bindings,
    unresolved: extraction.unresolved,
    lookup,
    packageOfFile: new Map(sources.files.map((f) => [f.file, f.package])),
    gaps: BINDING_GAPS,
    unconstrained: UNCONSTRAINED_BINDINGS,
  };
  const summary = summarizeColumnBindings(input);

  it("read the workspace, rather than silently reading nothing", () => {
    // Every assertion below is vacuous if the scan came back empty, and a scan that finds nothing
    // is the failure mode every rule in this directory has to fence first.
    expect(sources.unnamedPackages).toEqual([]);
    expect(scanned.length).toBeGreaterThanOrEqual(800);
    expect(valueSets.length).toBeGreaterThanOrEqual(270);
    expect(extraction.bindings.length).toBeGreaterThanOrEqual(600);
    expect(index.schemaFields.size).toBeGreaterThanOrEqual(4000);
    expect(index.objectFields.size).toBeGreaterThanOrEqual(5000);
    expect(index.enumAliases.size).toBeGreaterThanOrEqual(500);
  });

  it("checks a floor's worth of value-set columns against the symbol their writer binds", () => {
    // `checked` counts columns and `agreeing` counts bindings, which is why the second is larger: a
    // column two statements write is checked twice. Both floors are one-sided and on the *checked*
    // side, for `pg-unreachable-stores.ts`' reason — an extractor that stopped matching would check
    // nothing and sail past a ceiling. 164 of the 287 sit on tables `pg-storeless-tables.ts`
    // already declares writerless, which is the bound on how high either can go.
    expect(summary.checked).toBeGreaterThanOrEqual(55);
    expect(summary.agreeing).toBeGreaterThanOrEqual(70);
    expect(summary.literals).toBeGreaterThanOrEqual(18);
    expect(summary.unresolvedTypes).toBe(0);
  });

  it("finds nothing", () => {
    const findings = auditColumnBindings(input);
    expect(formatColumnBindingFindings(findings)).toBe("");
    expect(findings).toEqual([]);
  });

  it("fires on the real tree when one declaration is pointed at another domain", () => {
    // The live control: the same inputs, with `operate_tenant_manifests.source` re-pointed at the
    // status domain beside it. ADR-0354's finding was exactly this shape, differing only in that
    // the two domains had identical members.
    const findings = auditColumnBindings({
      ...input,
      declarations: input.declarations.map((d) =>
        d.table === "operate_tenant_manifests" && d.column === "source"
          ? { ...d, ref: "@crossengin/operate-server:MANIFEST_PROPOSAL_STATUSES" }
          : d,
      ),
    });
    expect(findings).toMatchObject([
      { kind: "ref_contradicts_binding", table: "operate_tenant_manifests", column: "source" },
    ]);
  });

  it("agrees with collectWorkspaceDomains about what every typedBy reference means", () => {
    // The two indexes answer different questions about one declaration — `collectWorkspaceDomains`
    // what its members are, `collectStoreTypes` what symbol it names — so their agreement is
    // asserted rather than assumed from a shared parser.
    let compared = 0;
    for (const d of scan.domains) {
      if (d.typedBy === null) continue;
      const target = lookup.byRef.get(d.typedBy);
      if (target === undefined) continue; // a module-private target is nameable by nothing.
      compared += 1;
      expect({ ref: d.typedBy, members: [...target.members].sort() }).toEqual({
        ref: d.typedBy,
        members: [...d.members].sort(),
      });
    }
    expect(compared).toBeGreaterThanOrEqual(400);
  });

  it("marks only aliases and references as typedBy, never a constant with members of its own", () => {
    const constants = scan.domains.filter((d) => d.kind === "constant");
    expect(constants.length).toBeGreaterThanOrEqual(600);
    const aliases = constants.filter((d) => d.typedBy !== null);
    // A re-export alias is rare and deliberate; ADR-0334's `TENANT_STATUSES` is one of them.
    expect(aliases.length).toBeLessThanOrEqual(10);
    expect(aliases.map((d) => `${d.package}:${d.name}`)).toContain(
      "@crossengin/operate-server:TENANT_STATUSES",
    );
  });

  it("declares a gap for every unresolved binding that touches a value-set column", () => {
    // Asserted through the audit above; this pins the size so a sweep that resolved half of them
    // and left the declarations behind is visible rather than silent.
    expect(BINDING_GAPS.length).toBeGreaterThanOrEqual(20);
    expect(BINDING_GAPS.length).toBeLessThanOrEqual(40);
    const files = new Set(BINDING_GAPS.map((g) => g.file));
    expect(files.size).toBeGreaterThanOrEqual(15);
  });

  it("keeps the unconstrained set small and on one table, which is the fact worth watching", () => {
    expect(UNCONSTRAINED_BINDINGS.length).toBe(summary.unconstrained);
    expect(new Set(UNCONSTRAINED_BINDINGS.map((u) => u.table))).toEqual(
      new Set(["notification_dispatches"]),
    );
  });

  it("cannot check a column on a table declared writerless, which bounds the whole rule", () => {
    const writerless = new Set(STORELESS_TABLES.map((t) => t.table.replace(/^meta\./, "")));
    const unreachable = valueSets.filter((v) => writerless.has(v.table));
    expect(unreachable.length).toBeGreaterThanOrEqual(150);
    // None of them has a binding, which is what makes the two rules consistent: a table with no
    // store has nothing to bind, so this rule's silence there is `pg-storeless-tables.ts`' finding
    // and not a second one.
    const bound = new Set(extraction.bindings.map((b) => `${b.table}.${b.column}`));
    expect(unreachable.filter((v) => bound.has(`${v.table}.${v.column}`))).toEqual([]);
  });
});
