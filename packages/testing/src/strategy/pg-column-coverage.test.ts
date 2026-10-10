import { describe, expect, it } from "vitest";

import {
  assignmentTargets,
  auditPgColumnCoverage,
  auditPlatformWriteArms,
  auditScanGaps,
  clauseOf,
  CatalogTableSchema,
  collectImportedNames,
  collectModuleBindings,
  emptyBindings,
  extractSqlStatements,
  foldStringConcatenations,
  formatPgColumnViolations,
  formatScanGaps,
  formatUnresolvedStatements,
  isRequiredColumn,
  normalizeSource,
  parseCatalogSource,
  PG_COLUMN_VIOLATION_KINDS,
  PG_SCAN_EXEMPT_PACKAGE_DIRS,
  PG_SCAN_GAPS,
  PLATFORM_WRITE_ARM_EXEMPT_TABLES,
  platformInsertArm,
  platformUpdateArm,
  formatPlatformWriteArmFindings,
  PG_STATEMENT_EXEMPTIONS,
  PgScanGapSchema,
  PgStatementExemptionSchema,
  resolveBindings,
  SQL_STATEMENT_KINDS,
  SqlStatementSchema,
  stripComments,
  substituteBindings,
  UNRESOLVED_KINDS,
  UnresolvedStatementSchema,
  type CatalogTable,
  type ModuleBindings,
  type SqlStatement,
  type StatementTarget,
  type UnresolvedStatement,
} from "./pg-column-coverage.js";
import { readCatalogSource, scanWorkspaceSql } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

const TIMERS: CatalogTable = CatalogTableSchema.parse({
  schema: "meta",
  name: "widgets",
  columns: [
    { name: "id", notNull: true, hasDefault: true },
    { name: "widget_id", notNull: true, hasDefault: false },
    { name: "kind", notNull: true, hasDefault: false },
    { name: "status", notNull: true, hasDefault: true },
    { name: "note", notNull: false, hasDefault: false },
  ],
});

function statement(over: Partial<SqlStatement> = {}): SqlStatement {
  return SqlStatementSchema.parse({
    file: "packages/x/src/store.ts",
    line: 7,
    kind: "insert",
    schema: "meta",
    table: "widgets",
    columns: ["widget_id", "kind"],
    ...over,
  });
}

/* ---------------------------------------------------------------- the schemas */

describe("the declared shape", () => {
  it("names four statement kinds and three violation kinds", () => {
    expect([...SQL_STATEMENT_KINDS]).toEqual(["insert", "conflict_update", "update", "select"]);
    expect([...PG_COLUMN_VIOLATION_KINDS]).toEqual([
      "unknown_column",
      "missing_required_column",
      "unknown_table",
    ]);
  });

  it("exempts only the directory holding this scanner", () => {
    expect([...PG_SCAN_EXEMPT_PACKAGE_DIRS]).toEqual(["packages/testing"]);
  });

  it("resolves a reference whether it is written inline or through a shared constant", () => {
    // The shared-constant arm is the one that matters: without it the catalog's 196 constant-form
    // references read as `null`, and any rule whose predicate is "this column references nothing"
    // passes for every foreign key in the workspace.
    const [table] = parseCatalogSource(
      `const TENANT_FK: ColumnReference = {\n` +
        `  schema: "meta",\n  table: "tenants",\n  column: "id",\n  onDelete: "CASCADE",\n};\n` +
        `export const META_WIDGETS: TableDefinition = {\n` +
        `  schema: "meta",\n  name: "widgets",\n  columns: [\n` +
        `    { name: "id", type: "UUID", primaryKey: true },\n` +
        `    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },\n` +
        `    { name: "widget_id", type: "TEXT", notNull: true, unique: { constraintName: "w_key" } },\n` +
        `    { name: "owner_id", type: "UUID", references: { schema: "meta", table: "users", column: "id", onDelete: "RESTRICT" } },\n` +
        `  ],\n};\n` +
        `export const META_TABLES: readonly TableDefinition[] = [META_WIDGETS];\n`,
    );
    expect(
      table?.columns.map((c) => ({
        name: c.name,
        type: c.type,
        references: c.references,
        unique: c.unique,
      })),
    ).toEqual([
      { name: "id", type: "UUID", references: null, unique: false },
      { name: "tenant_id", type: "UUID", references: "meta.tenants.id", unique: false },
      { name: "widget_id", type: "TEXT", references: null, unique: true },
      { name: "owner_id", type: "UUID", references: "meta.users.id", unique: false },
    ]);
  });

  it("does not read a table-level unique constraint as a column-level one", () => {
    const [table] = parseCatalogSource(
      `export const META_RUNS: TableDefinition = {\n` +
        `  schema: "meta",\n  name: "runs",\n  columns: [\n` +
        `    { name: "run_id", type: "TEXT", notNull: true },\n  ],\n` +
        `  uniqueConstraints: [{ name: "runs_run_id_key", columns: ["tenant_id", "run_id"] }],\n};\n` +
        `export const META_TABLES: readonly TableDefinition[] = [META_RUNS];\n`,
    );
    expect(table?.columns.find((c) => c.name === "run_id")?.unique).toBe(false);
  });

  it("judges every statement it can read", () => {
    // An empty statement-exemption list is the claim; a line added here needs a reason in the diff.
    expect(PG_STATEMENT_EXEMPTIONS).toEqual([]);
  });

  it("every declared gap parses and carries a reason", () => {
    for (const gap of PG_SCAN_GAPS) {
      expect(() => PgScanGapSchema.parse(gap)).not.toThrow();
      expect(gap.reason.length).toBeGreaterThan(20);
    }
  });

  it("refuses an exemption with no reason and one that suspends nothing", () => {
    expect(() =>
      PgStatementExemptionSchema.parse({
        file: "a",
        table: "b",
        kind: "insert",
        suspends: ["unknown_column"],
        reason: "",
      }),
    ).toThrow();
    expect(() =>
      PgStatementExemptionSchema.parse({
        file: "a",
        table: "b",
        kind: "insert",
        suspends: [],
        reason: "x",
      }),
    ).toThrow();
  });

  it("a column is required only when NOT NULL and defaultless", () => {
    expect(isRequiredColumn({ notNull: true, hasDefault: false })).toBe(true);
    expect(isRequiredColumn({ notNull: true, hasDefault: true })).toBe(false);
    expect(isRequiredColumn({ notNull: false, hasDefault: false })).toBe(false);
  });
});

/* ------------------------------------------------------------------ the rule */

describe("auditPgColumnCoverage", () => {
  it("passes an INSERT that names every required column", () => {
    expect(auditPgColumnCoverage([TIMERS], [statement()])).toEqual([]);
  });

  it("reports a column the catalog does not declare", () => {
    const v = auditPgColumnCoverage([TIMERS], [statement({ columns: ["widget_id", "kind", "colour"] })]);
    expect(v.map((x) => x.kind)).toEqual(["unknown_column"]);
    expect(v[0]?.columns).toEqual(["colour"]);
  });

  it("reports an INSERT that omits a NOT NULL column with no default", () => {
    const v = auditPgColumnCoverage([TIMERS], [statement({ columns: ["widget_id"] })]);
    expect(v.map((x) => x.kind)).toEqual(["missing_required_column"]);
    expect(v[0]?.columns).toEqual(["kind"]);
    expect(v[0]?.detail).toContain("cannot succeed against a real database");
  });

  it("does not report an omitted column that has a default, or a nullable one", () => {
    expect(auditPgColumnCoverage([TIMERS], [statement({ columns: ["widget_id", "kind"] })])).toEqual([]);
  });

  it("holds only INSERTs to the required-column rule", () => {
    for (const kind of ["update", "conflict_update", "select"] as const) {
      expect(auditPgColumnCoverage([TIMERS], [statement({ kind, columns: ["note"] })])).toEqual([]);
    }
  });

  it("still checks an UPDATE, a conflict clause and a SELECT for unknown columns", () => {
    for (const kind of ["update", "conflict_update", "select"] as const) {
      const v = auditPgColumnCoverage([TIMERS], [statement({ kind, columns: ["colour"] })]);
      expect(v.map((x) => x.kind)).toEqual(["unknown_column"]);
    }
  });

  it("reports an unknown table in a schema the catalog declares", () => {
    const v = auditPgColumnCoverage([TIMERS], [statement({ table: "gadgets" })]);
    expect(v.map((x) => x.kind)).toEqual(["unknown_table"]);
  });

  it("says nothing about a schema the catalog does not describe", () => {
    // `pg_catalog`, `information_schema` and a tenant's own schema are ordinary targets; calling
    // them unknown tables would bury every real finding under dozens of them.
    expect(auditPgColumnCoverage([TIMERS], [statement({ schema: "pg_catalog", table: "pg_class" })])).toEqual(
      [],
    );
  });

  it("does not stack column findings on top of an unknown table", () => {
    const v = auditPgColumnCoverage([TIMERS], [statement({ table: "gadgets", columns: ["nope"] })]);
    expect(v).toHaveLength(1);
  });

  it("honours a narrow exemption and only the rules it suspends", () => {
    const exempt = [
      {
        file: "packages/x/src/store.ts",
        table: "widgets",
        kind: "insert" as const,
        suspends: ["missing_required_column" as const],
        reason: "the column list is rendered from an array checked elsewhere",
      },
    ];
    const stmt = statement({ columns: ["colour"] });
    expect(auditPgColumnCoverage([TIMERS], [stmt], exempt).map((v) => v.kind)).toEqual([
      "unknown_column",
    ]);
  });

  it("formats one line per violation with file and line", () => {
    const text = formatPgColumnViolations(
      auditPgColumnCoverage([TIMERS], [statement({ columns: ["widget_id"] })]),
    );
    expect(text).toContain("packages/x/src/store.ts:7 [missing_required_column]");
  });

  it("every violation kind is reachable", () => {
    const reached = new Set(
      [
        statement({ columns: ["colour"] }),
        statement({ columns: ["widget_id"] }),
        statement({ table: "gadgets" }),
      ].flatMap((s) => auditPgColumnCoverage([TIMERS], [s]).map((v) => v.kind)),
    );
    expect([...reached].sort()).toEqual([...PG_COLUMN_VIOLATION_KINDS].sort());
  });
});

/* ------------------------------------------------------------ text machinery */

describe("stripComments", () => {
  it("removes both comment forms and preserves every newline", () => {
    const source = 'const a = 1; // name: "x"\n/* notNull\n true */\nconst b = 2;\n';
    const stripped = stripComments(source);
    expect(stripped).not.toContain("notNull");
    expect(stripped).not.toContain('name: "x"');
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("leaves a `//` inside a string alone", () => {
    expect(stripComments('const a = "http://x";')).toBe('const a = "http://x";');
  });
});

describe("foldStringConcatenations", () => {
  it("joins adjacent literals and keeps the separator's newlines", () => {
    const folded = foldStringConcatenations('const q = "INSERT INTO t (a," +\n  " b)";');
    expect(folded).toContain("INSERT INTO t (a,");
    expect(folded).toContain("b)");
    expect(folded.split("\n")).toHaveLength(2);
  });

  it("refuses a fold that would break the delimiter", () => {
    const source = `const q = 'a' + "it's";`;
    expect(foldStringConcatenations(source)).toBe(source);
  });

  it("leaves a dynamic concatenation unresolved", () => {
    expect(foldStringConcatenations('const q = "a" + n;')).toBe('const q = "a" + n;');
  });
});

describe("collectModuleBindings", () => {
  const bind = (code: string): ModuleBindings =>
    resolveBindings(collectModuleBindings(normalizeSource(code)), new Set());

  it("reads a module const", () => {
    expect(bind('const TABLE = "widgets";').strings.get("TABLE")).toBe("widgets");
  });

  it("reads a `??` default, literal or named", () => {
    expect(bind('const s = opts.schema ?? "meta";').strings.get("s")).toBe("meta");
    expect(bind('const D = "meta";\nconst s = opts.schema ?? D;').strings.get("s")).toBe("meta");
  });

  it("reads a parameter property and a getter", () => {
    expect(bind('class S { private readonly schema = "meta"; }').strings.get("this.schema")).toBe("meta");
    expect(
      bind('const T = "widgets";\nclass S { private get table(): string { return `meta.${T}`; } }')
        .strings.get("this.table"),
    ).toBe("meta.widgets");
  });

  it("follows an alias through a constructor", () => {
    const code = 'const T = "widgets";\nclass S { constructor(o) { const schema = o.schema ?? "meta"; this.schema = schema; this.table = `${this.schema}.${T}`; } }';
    expect(bind(code).strings.get("this.table")).toBe("meta.widgets");
  });

  it("reads an array, frozen or bare, and its join", () => {
    expect(bind('const C = Object.freeze(["a", "b"]);').arrays.get("C")).toEqual(["a", "b"]);
    expect(bind('const C = ["a", "b"];\nconst L = C.join(", ");').strings.get("L")).toBe("a, b");
  });

  it("evaluates a map over object literals", () => {
    const code = 'const B = [{ column: "a", bind: (r) => r.a }, { column: "b", bind: (r) => r.b }];\nconst C = B.map((e) => e.column);';
    expect(bind(code).arrays.get("C")).toEqual(["a", "b"]);
  });

  it("marks a name bound twice to different values ambiguous rather than picking one", () => {
    const bindings = bind('const T = "a";\nfunction f() { const T = "b"; }');
    expect(bindings.ambiguous.has("T")).toBe(true);
    expect(substituteBindings("${T}", bindings)).toBeNull();
  });

  it("does not invent a value for an undefaulted parameter", () => {
    // `entity-ops.ts` takes a tenant's own table as an argument; guessing would turn a genuinely
    // dynamic statement into a confident wrong finding.
    expect(bind("function f(table: string) {}").strings.has("table")).toBe(false);
  });
});

describe("collectImportedNames and the fallback", () => {
  it("reads a named import, type-only and aliased", () => {
    const names = collectImportedNames(
      'import { A, type B, C as D } from "./x.js";\nimport type { E } from "./y.js";',
    );
    expect([...names].sort()).toEqual(["A", "B", "D", "E"]);
  });

  it("consults a sibling's binding only for a name the module imported", () => {
    const fallback = resolveBindings(collectModuleBindings('const SHARED = "a, b";\nconst OTHER = "x";'), new Set());
    const own = collectModuleBindings('import { SHARED } from "./records.js";');
    const resolved = resolveBindings(own, collectImportedNames('import { SHARED } from "./records.js";'), fallback);
    expect(resolved.strings.get("SHARED")).toBe("a, b");
    expect(resolved.strings.has("OTHER")).toBe(false);
  });
});

describe("substituteBindings", () => {
  const bindings = resolveBindings(
    collectModuleBindings('const SCHEMA = "meta";\nconst C = ["a", "b"];'),
    new Set(),
  );

  it("resolves a name and a join", () => {
    expect(substituteBindings("${SCHEMA}.t", bindings)).toBe("meta.t");
    expect(substituteBindings("${C.join(', ')}", bindings)).toBe("a, b");
  });

  it("refuses rather than resolving an unknown expression to nothing", () => {
    // A `${conditions.join(" AND ")}` resolving to "" would read as a statement with no predicate.
    expect(substituteBindings("${conditions.join(' AND ')}", bindings)).toBeNull();
    expect(substituteBindings("${nope}", bindings)).toBeNull();
  });
});

describe("clauseOf and assignmentTargets", () => {
  it("stops a SET clause at the first clause keyword", () => {
    expect(clauseOf(" a = $1, b = $2 WHERE id = $3").trim()).toBe("a = $1, b = $2");
    expect(clauseOf(" a = $1 RETURNING *").trim()).toBe("a = $1");
  });

  it("stops at the end of the template literal", () => {
    expect(clauseOf(" a = $1`,\n [x])").trim()).toBe("a = $1");
  });

  it("splits on top-level commas only", () => {
    expect(assignmentTargets("a = coalesce(x, y), b = $1").map((s) => s.trim())).toEqual(["a", "b"]);
  });
});

/* ------------------------------------------------------- end-to-end extraction */

describe("extractSqlStatements", () => {
  const SOURCE = `
const SCHEMA = "meta";
const TABLE = "widgets";
const COLS = ["widget_id", "kind"];
export class Store {
  async upsert(): Promise<void> {
    await this.conn.query(
      \`INSERT INTO \${SCHEMA}.\${TABLE} (\${COLS.join(", ")})
       VALUES ($1, $2)
       ON CONFLICT (widget_id) DO UPDATE
         SET kind = EXCLUDED.kind, note = EXCLUDED.note\`,
      [a, b],
    );
    await this.conn.query(\`UPDATE \${SCHEMA}.\${TABLE} SET note = $2 WHERE widget_id = $1\`, [a, b]);
    await this.conn.query(\`SELECT widget_id, kind FROM \${SCHEMA}.\${TABLE} WHERE widget_id = $1\`, [a]);
  }
}
`;

  it("reads the insert, its conflict clause, the update and the select", () => {
    const { statements, unresolved } = extractSqlStatements("f.ts", SOURCE);
    expect(unresolved).toEqual([]);
    expect(statements.map((s) => `${s.kind}:${s.columns.join("|")}`)).toEqual([
      "insert:widget_id|kind",
      "conflict_update:kind|note",
      "select:widget_id|kind",
      "update:note",
    ]);
    for (const s of statements) expect(`${s.schema}.${s.table}`).toBe("meta.widgets");
  });

  it("reports a target it cannot resolve rather than skipping it", () => {
    const { statements, unresolved } = extractSqlStatements(
      "f.ts",
      "const q = `INSERT INTO ${t} (a) VALUES ($1)`;",
    );
    expect(statements).toEqual([]);
    expect(unresolved.map((u) => u.kind)).toEqual(["unresolved_target"]);
    expect(formatUnresolvedStatements(unresolved)).toContain("f.ts:1");
  });

  it("reports a column list it cannot resolve rather than skipping it", () => {
    const { unresolved } = extractSqlStatements(
      "f.ts",
      'const q = `INSERT INTO meta.widgets (${cols}) VALUES ($1)`;',
    );
    expect(unresolved.map((u) => u.kind)).toEqual(["unresolved_columns"]);
  });

  it("silently skips a SELECT with an expression, an alias or a star", () => {
    // A read is a bonus check held to a stricter admission rule: reporting `count(*)` as a gap
    // would make the unresolved bucket unreadable, and an unreadable bucket is the next silence.
    for (const sql of [
      "SELECT count(*) FROM meta.widgets",
      "SELECT w.kind FROM meta.widgets w",
      "SELECT * FROM meta.widgets",
      "SELECT kind, now() FROM meta.widgets",
    ]) {
      const { statements, unresolved } = extractSqlStatements("f.ts", `const q = \`${sql}\`;`);
      expect(statements.filter((s) => s.kind === "select")).toEqual([]);
      expect(unresolved).toEqual([]);
    }
  });

  it("does not attribute one statement's conflict clause to another's table", () => {
    const source = [
      'const q1 = `INSERT INTO meta.alpha (a) VALUES ($1)`;',
      'const q2 = `INSERT INTO meta.beta (b) VALUES ($1) ON CONFLICT (b) DO UPDATE SET b = EXCLUDED.b`;',
    ].join("\n");
    const { statements } = extractSqlStatements("f.ts", source);
    const conflict = statements.find((s) => s.kind === "conflict_update");
    expect(conflict?.table).toBe("beta");
  });

  it("sees through a literal NUL byte", () => {
    // ADR-0332 found four source files invisible to ripgrep because they held one, discovered only
    // because a grep for a symbol returned nothing from the file defining it. This scan reads bytes
    // rather than lines, so a NUL is not a hiding place — pinned, so nobody has to find out twice.
    const { statements } = extractSqlStatements(
      "f.ts",
      'const SCHEMA = "meta";\u0000\nconst q = `INSERT INTO ${SCHEMA}.widgets (a) VALUES ($1)`;',
    );
    expect(statements.map((s) => s.table)).toEqual(["widgets"]);
  });

  it("collects every table its SQL names, including the reads a statement cannot be made of", () => {
    // The census rule asks a wider question than the column rules: which tables does any SQL here
    // *name*. A join and a non-bare column list are both silently skipped as statements, and both
    // still name a table — `recipient-resolver.ts` reaches `meta.users` only this way.
    const source = [
      "const SCHEMA = \"meta\";",
      "const q1 = `SELECT ${COLS} FROM ${SCHEMA}.alpha a JOIN ${SCHEMA}.beta b ON b.id = a.b_id`;",
      "const q2 = `DELETE FROM ${SCHEMA}.gamma WHERE id = $1`;",
      "const q3 = `TRUNCATE TABLE ${SCHEMA}.delta`;",
    ].join("\n");
    const { references, statements } = extractSqlStatements("f.ts", source);
    expect(statements.filter((s) => s.kind === "select")).toEqual([]);
    expect(references.map((r) => `${r.via}:${r.schema ?? "?"}.${r.table}`)).toEqual([
      "from:meta.alpha",
      "join:meta.beta",
      "delete:meta.gamma",
      "truncate:meta.delta",
    ]);
  });

  it("keeps a table whose schema did not resolve, with a null schema", () => {
    // `FROM ${this.schema}.access_review_evidence`, where `schema` is a destructured parameter
    // default this scan does not follow. Discarding it reads a real reader as no reader at all.
    const { references } = extractSqlStatements(
      "f.ts",
      "const q = `SELECT a, b FROM ${this.schema}.access_review_evidence WHERE x = $1`;",
    );
    expect(references).toEqual([
      { file: "f.ts", line: 1, schema: null, table: "access_review_evidence", via: "from" },
    ]);
  });

  it("does not invent a reference from a string that merely looks like a table name", () => {
    // Deliberately not reading bindings: a prose error message spells `meta.users`, and a false
    // reference would mean the census stops requiring a declaration for that table — the one
    // direction in which a mistake here loosens the fence rather than tightening it.
    const { references } = extractSqlStatements(
      "f.ts",
      'const MSG = "meta.users carries no tenant_id";\nconst T = "meta.widgets";',
    );
    expect(references).toEqual([]);
  });

  it("names the original file's line after comments and folds", () => {
    const source = [
      "// a comment",
      "/* a block",
      "   comment */",
      'const q =\n  "INSERT INTO meta.widgets (a," +\n  " b) VALUES ($1, $2)";',
    ].join("\n");
    const { statements } = extractSqlStatements("f.ts", source);
    expect(statements[0]?.line).toBe(5);
  });
});

/* ---------------------------------------------------------------- scan gaps */

describe("auditScanGaps", () => {
  const entry = (over: Partial<UnresolvedStatement> = {}): UnresolvedStatement =>
    UnresolvedStatementSchema.parse({
      file: "packages/x/src/store.ts",
      line: 3,
      kind: "unresolved_columns",
      snippet: "UPDATE on meta.widgets: unresolved interpolation in `${UPDATE_ASSIGNMENTS}`",
      ...over,
    });

  const gap = {
    file: "packages/x/src/store.ts",
    expression: "UPDATE_ASSIGNMENTS",
    reason: "rendered from an array this file's INSERT names in full",
  };

  it("accounts for a declared gap and reports an undeclared one", () => {
    expect(auditScanGaps([entry()], [gap]).undeclared).toEqual([]);
    const other = entry({ snippet: "UPDATE on meta.widgets: unresolved interpolation in `${other}`" });
    expect(auditScanGaps([other], [gap]).undeclared).toHaveLength(1);
  });

  it("matches on file as well as expression", () => {
    expect(auditScanGaps([entry({ file: "packages/y/src/store.ts" })], [gap]).undeclared).toHaveLength(1);
  });

  it("reports a gap nothing matched, because a stale exemption is a hole", () => {
    expect(auditScanGaps([], [gap]).unused).toEqual([gap]);
    expect(formatScanGaps([gap])).toContain("UPDATE_ASSIGNMENTS");
  });

  it("every unresolved kind is declared", () => {
    expect([...UNRESOLVED_KINDS]).toEqual([
      "unresolved_target",
      "unresolved_columns",
      "unterminated_statement",
      "unreadable_file",
    ]);
  });
});

describe("auditPlatformWriteArms", () => {
  const withPolicies = (policies: readonly string[]): CatalogTable =>
    CatalogTableSchema.parse({
      schema: "meta",
      name: "widgets",
      columns: [{ name: "tenant_id", notNull: false, hasDefault: false }],
      policies: policies.map((command, i) => ({
        name: `p${i.toString()}`,
        command,
        using: command === "INSERT" ? null : "tenant_id IS NULL",
        check: command === "INSERT" ? "tenant_id IS NULL AND current_setting('x', true) = 'on'" : null,
      })),
    });

  const update = (kind: "update" | "conflict_update" | "insert"): StatementTarget => ({
    file: "packages/x/src/store.ts",
    line: 4,
    kind,
    schema: "meta",
    table: "widgets",
  });

  it("reports a platform-writable table a store updates with no UPDATE arm", () => {
    const findings = auditPlatformWriteArms(
      [withPolicies(["ALL", "SELECT", "INSERT"])],
      [update("conflict_update")],
    );
    expect(findings.map((f) => f.table)).toEqual(["meta.widgets"]);
    expect(findings[0]?.writers).toEqual(["packages/x/src/store.ts"]);
    expect(formatPlatformWriteArmFindings(findings)).toContain("row-level security policy");
  });

  it("passes once the arm exists", () => {
    expect(
      auditPlatformWriteArms(
        [withPolicies(["ALL", "SELECT", "INSERT", "UPDATE"])],
        [update("conflict_update")],
      ),
    ).toEqual([]);
  });

  it("says nothing about a table nothing updates", () => {
    // Append-only by contract as well as by catalog: there is no disagreement to report.
    expect(
      auditPlatformWriteArms([withPolicies(["ALL", "SELECT", "INSERT"])], [update("insert")]),
    ).toEqual([]);
  });

  it("says nothing about a table with no platform INSERT arm", () => {
    // Outside ADR-0332's split entirely, so nothing there was ever classified; the `ALL`-scope
    // isolation policy's USING serves the UPDATE for a tenant-scoped writer.
    expect(
      auditPlatformWriteArms([withPolicies(["ALL"])], [update("update")]),
    ).toEqual([]);
  });

  it("honours a table exemption", () => {
    expect(
      auditPlatformWriteArms(
        [withPolicies(["ALL", "SELECT", "INSERT"])],
        [update("update")],
        ["meta.widgets"],
      ),
    ).toEqual([]);
    expect(PLATFORM_WRITE_ARM_EXEMPT_TABLES).toEqual([]);
  });
});

/* ------------------------------------------------------------ the real workspace */

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const scan = scanWorkspaceSql();
  const metaStatements = scan.statements.filter((s) => s.schema === "meta");

  it("read the catalog, rather than silently reading nothing", () => {
    // Every assertion below is vacuous if the catalog came back empty — which it did, once, because
    // `META_TABLES`' opening bracket was found in `readonly TableDefinition[]`. So the shape of the
    // catalog is asserted before it is used for anything.
    expect(catalog.length).toBeGreaterThanOrEqual(145);
    const timers = catalog.find((t) => t.name === "workflow_timers");
    expect(timers?.columns.map((c) => c.name)).toContain("kind");
    expect(timers?.columns.find((c) => c.name === "kind")).toEqual({
      name: "kind",
      notNull: true,
      hasDefault: false,
      check: "kind IN ('absolute_at', 'relative_after', 'cron_schedule', 'business_hours')",
      defaultExpression: null,
      type: "TEXT",
      references: null,
      unique: false,
      comment: null,
    });
    // The two fields `pg-value-set-domains.ts` reads, asserted here rather than only there, so one
    // parser serves both rules and a regression in it fails where the parser lives.
    expect(
      catalog
        .find((t) => t.name === "tenants")
        ?.columns.find((c) => c.name === "status")?.defaultExpression,
    ).toBe("'active'");
    // And the three `pg-binding-names.ts` reads. `references` matters most: 196 of the catalog's
    // 233 references are one of three shared `ColumnReference` constants, so a parser reading only
    // the inline object form answers `null` for 84% of them — and the business-key derivation's
    // "references nothing" predicate would then be vacuously true for a foreign key.
    const byTarget = new Map<string, number>();
    for (const table of catalog) {
      for (const column of table.columns) {
        if (column.references === null) continue;
        byTarget.set(column.references, (byTarget.get(column.references) ?? 0) + 1);
      }
    }
    expect(byTarget.get("meta.tenants.id")).toBe(99);
    expect(byTarget.get("meta.users.id")).toBe(97);
    expect(byTarget.get("meta.sso_providers.id")).toBe(4);
    expect(catalog.every((t) => t.columns.every((c) => c.type !== null))).toBe(true);
    // A column-level `unique` is how this catalog marks a row's own business key; a table-level
    // `uniqueConstraints` entry is deliberately not read as one, which `job_runs` is the case for.
    const campaigns = catalog.find((t) => t.name === "access_review_campaigns");
    expect(campaigns?.columns.find((c) => c.name === "campaign_id")?.unique).toBe(true);
    expect(campaigns?.columns.find((c) => c.name === "id")?.unique).toBe(false);
    const jobRuns = catalog.find((t) => t.name === "job_runs");
    expect(jobRuns?.columns.find((c) => c.name === "run_id")?.unique).toBe(false);
    // A column with a default is not required; one that is a primary-key member is, said or not.
    const tenants = catalog.find((t) => t.name === "tenants");
    expect(tenants?.columns.find((c) => c.name === "id")?.hasDefault).toBe(true);
    const required = tenants?.columns.filter((c) => isRequiredColumn(c)).map((c) => c.name) ?? [];
    expect(required).toContain("slug");
    expect(required).toContain("schema_name");
    // `id` has `uuid_generate_v7()` and `status` has `'active'`: a default makes a NOT NULL column
    // optional in an INSERT, which is the distinction a restated list keeps getting wrong.
    expect(required).not.toContain("id");
    expect(required).not.toContain("status");
    // And the column's own source prose, read from the *unstripped* source because
    // `stripComments` preserves newlines and not offsets. Both spellings the catalog uses are one
    // rule: `// …` above the literal, and `{` then `// …` then `name:` inside it.
    expect(jobRuns?.columns.find((c) => c.name === "cancel_requested_at")?.comment).toContain(
      "`cancel_requested_at` *is* the cancellation",
    );
    expect(jobRuns?.columns.find((c) => c.name === "cancelled_at_checkpoint")?.comment).toContain(
      "Which guarantee was actually met",
    );
    // A column with nothing above it reads `null`, not the prose of the column before it.
    expect(jobRuns?.columns.find((c) => c.name === "cancel_reason")?.comment).toBeNull();
    expect(jobRuns?.columns.find((c) => c.name === "job_id")?.comment).toBeNull();
    // It is not read from `/** … */`, which in this catalog documents the table and not a column.
    const commented = catalog.flatMap((t) =>
      t.columns.filter((c) => c.comment !== null).map((c) => `${t.name}.${c.name}`),
    );
    expect(commented.length).toBeGreaterThanOrEqual(40);
    expect(commented).toContain("job_runs.started_at");
  });

  it("scanned the workspace, rather than silently finding nothing", () => {
    // The failure mode this file exists to prevent is a check that passes because its extraction
    // reached nothing. So the coverage is asserted as a floor, and a drop in it fails here.
    expect(scan.files).toBeGreaterThanOrEqual(700);
    expect(metaStatements.length).toBeGreaterThanOrEqual(200);
    expect(new Set(metaStatements.map((s) => s.table)).size).toBeGreaterThanOrEqual(60);
    expect(metaStatements.filter((s) => s.kind === "insert").length).toBeGreaterThanOrEqual(45);
    const files = new Set(scan.statements.map((s) => s.file));
    expect(files).toContain("packages/workflow-runtime-pg/src/timer-store.ts");
    expect(files).toContain("packages/feature-flags-pg/src/flag-store.ts");
    expect(files).toContain("apps/operate-server/src/audit-log-store.ts");
  });

  it("every statement it could not read is a declared gap (ADR-0332)", () => {
    // The loud unknown bucket. A statement this scan cannot parse must be *named*, with the reason
    // it cannot be parsed, or it is the next silence rather than the end of this one.
    const { undeclared } = auditScanGaps(scan.unresolved);
    expect(formatUnresolvedStatements(undeclared)).toBe("");
  });

  it("every declared gap still describes a real statement", () => {
    // A gap nothing matches is a hole waiting for a statement of that shape, exactly as the
    // typecheck rule asserts its exempt directories still exist.
    const { unused } = auditScanGaps(scan.unresolved);
    expect(formatScanGaps(unused)).toBe("");
  });

  it("no statement names a column the catalog does not declare, or omits one it requires", () => {
    const violations = auditPgColumnCoverage(catalog, scan.statements, PG_STATEMENT_EXEMPTIONS);
    expect(formatPgColumnViolations(violations)).toBe("");
  });

  it("would catch the defect it was written for", () => {
    // The scan finding nothing is indistinguishable from the scan being broken, so one real
    // statement is mutated and the rule is asked about it: `meta.workflow_timers` without `kind` is
    // the live defect this increment found by hand.
    const timers = scan.statements.find(
      (s) => s.table === "workflow_timers" && s.kind === "insert",
    );
    expect(timers).toBeDefined();
    const withoutKind = SqlStatementSchema.parse({
      ...timers,
      columns: timers?.columns.filter((c) => c !== "kind"),
    });
    const violations = auditPgColumnCoverage(catalog, [withoutKind]);
    expect(violations.map((v) => v.kind)).toEqual(["missing_required_column"]);
    expect(violations[0]?.columns).toEqual(["kind"]);

    const renamed = SqlStatementSchema.parse({ ...timers, columns: ["timer_id", "knid"] });
    expect(auditPgColumnCoverage(catalog, [renamed]).map((v) => v.kind)).toEqual([
      "unknown_column",
      "missing_required_column",
    ]);
  });

  it("every platform-writable table a store updates has an UPDATE arm (ADR-0332)", () => {
    // The second axis of the same class: a fake `PgConnection` answers every statement, so it is
    // blind to the policy for exactly the reason it is blind to a missing column. Lane C of this
    // increment found `meta.dr_drill_executions` classified append-only from its INSERT-only store
    // rather than from its contract, and a platform-scope upsert was refused by RLS.
    const findings = auditPlatformWriteArms(
      catalog,
      scan.targets,
      PLATFORM_WRITE_ARM_EXEMPT_TABLES,
    );
    expect(formatPlatformWriteArmFindings(findings)).toBe("");
  });

  it("reads the policy arms it reasons about, rather than finding none", () => {
    // Without this the rule above passes vacuously whenever the policy parse breaks.
    const flags = catalog.find((t) => t.name === "feature_flags");
    expect(new Set(flags?.policies.map((p) => p.command))).toEqual(
      new Set(["ALL", "SELECT", "INSERT", "UPDATE"]),
    );
    expect(platformInsertArm(flags ?? ({} as never))?.name).toBe("feature_flags_platform_write");
    expect(platformUpdateArm(flags ?? ({} as never))?.name).toBe("feature_flags_platform_update");
    const split = catalog.filter((t) => platformInsertArm(t) !== undefined);
    expect(split.length).toBeGreaterThanOrEqual(30);
    expect(split.filter((t) => platformUpdateArm(t) !== undefined).length).toBeGreaterThanOrEqual(12);
    // A table with no platform arm at all is outside the rule, and most of the catalog is.
    expect(catalog.filter((t) => platformInsertArm(t) === undefined).length).toBeGreaterThan(100);
  });

  it("defaults to no fallback bindings", () => {
    expect(emptyBindings().strings.size).toBe(0);
    expect(emptyBindings().arrays.size).toBe(0);
    expect(emptyBindings().ambiguous.size).toBe(0);
  });
});
