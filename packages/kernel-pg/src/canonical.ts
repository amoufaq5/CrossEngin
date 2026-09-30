import type { ColumnReference, TableDefinition } from "@crossengin/kernel/bootstrap";

import type { ForeignKeyAction } from "./introspection.js";

/**
 * Tables that live in the meta schema but are not part of `META_TABLES`.
 *
 * `_meta_migrations` is the applier's own bookkeeping: it is created by `ensureMigrationLog`, not
 * declared in the catalog, so a diff that did not know about it would report the schema as drifted
 * on every correctly-migrated database.
 */
export const APPLIER_OWNED_TABLES: ReadonlySet<string> = new Set(["_meta_migrations"]);

/**
 * Declared type spellings and what `pg_catalog.format_type` calls them.
 *
 * Introspection reads types back through `format_type`, which prints the canonical name — so the
 * `TIMESTAMPTZ` a table declares comes back as `timestamp with time zone`. Comparing the two
 * spellings directly reported 425 columns as type-drifted on a schema that was exactly correct.
 */
export const PG_TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  char: "character",
  varchar: "character varying",
  bool: "boolean",
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  decimal: "numeric",
});

/** The alias targets whose precision is printed *inside* the name, not appended to it. */
const INFIX_PRECISION_TYPES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "timestamp with time zone": ["timestamp", " with time zone"],
  "timestamp without time zone": ["timestamp", " without time zone"],
  "time with time zone": ["time", " with time zone"],
  "time without time zone": ["time", " without time zone"],
});

const ARRAY_SUFFIX_RE = /((?:\s*\[\s*\])+)$/;

/**
 * Rewrites a declared SQL type into the spelling `format_type` would print, so a declared type and
 * an introspected one can be compared as strings.
 *
 * Three differences are mechanical and account for every mismatch observed against a correct
 * schema: an alias (`TIMESTAMPTZ` vs `timestamp with time zone`, `CHAR` vs `character`), whitespace
 * inside a precision list (`NUMERIC(12, 6)` vs `numeric(12,6)`), and case.
 */
export function canonicalPgType(declared: string): string {
  let text = declared.replace(/\s+/g, " ").trim().toLowerCase();
  if (text.length === 0) return text;

  let arraySuffix = "";
  const arrayMatch = ARRAY_SUFFIX_RE.exec(text);
  if (arrayMatch !== null) {
    const depth = (arrayMatch[1] ?? "").split("[").length - 1;
    arraySuffix = "[]".repeat(depth);
    text = text.slice(0, arrayMatch.index).trim();
  }

  let base = text;
  let params = "";
  const paren = text.indexOf("(");
  if (paren >= 0 && text.endsWith(")")) {
    base = text.slice(0, paren).trim();
    params = text.slice(paren).replace(/\s+/g, "");
  }

  const aliased = PG_TYPE_ALIASES[base] ?? base;
  if (params.length > 0) {
    // `timestamptz(3)` is printed `timestamp(3) with time zone`, not
    // `timestamp with time zone(3)` — the precision splits the name.
    const infix = INFIX_PRECISION_TYPES[aliased];
    if (infix !== undefined) return `${infix[0]}${params}${infix[1]}${arraySuffix}`;
  }
  return `${aliased}${params}${arraySuffix}`;
}

const TRAILING_CAST_RE = /::\s*[a-z_][a-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?((\s*\[\s*\])+)?$/;

function isWrappedInParens(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      // A closing paren that balances before the end means these are two groups, not one wrapper.
      if (depth === 0 && i !== text.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * Normalizes a default expression for comparison, dropping the explicit casts and wrapping parens
 * Postgres adds when it re-renders one. A column declaring `DEFAULT 'active'` reads back as
 * `'active'::text`, which is the same default written two ways.
 *
 * Stripping the cast means `0::numeric` and `0` compare equal. That is deliberate: the *column's*
 * type is compared separately, so a cast difference that actually matters shows up there, and
 * keeping the cast here would report drift on every string-literal default in the catalog.
 */
export function canonicalPgDefault(expr: string | null | undefined): string | null {
  if (expr === null || expr === undefined) return null;
  let text = expr.replace(/\s+/g, " ").trim().toLowerCase();
  for (;;) {
    const withoutCast = text.replace(TRAILING_CAST_RE, "").trim();
    const unwrapped = isWrappedInParens(withoutCast)
      ? withoutCast.slice(1, -1).trim()
      : withoutCast;
    if (unwrapped === text) break;
    text = unwrapped;
  }
  return text.length === 0 ? null : text;
}

export interface ExpectedIndexes {
  /** Names created by a `CREATE INDEX` statement. */
  readonly indexes: ReadonlySet<string>;
  /** Names backed by a UNIQUE constraint, which `CREATE INDEX` cannot produce. */
  readonly constraints: ReadonlySet<string>;
}

/**
 * Every non-primary index name a correctly-applied table carries, split by what created it.
 *
 * A UNIQUE constraint is backed by an index of the constraint's name, and those constraints are
 * declared in `uniqueConstraints` or on a column — not in `indexes`. Comparing introspected indexes
 * against `table.indexes` alone reported 117 constraint-backed indexes as removed on a schema that
 * had never been touched. The split matters for repair too: a missing constraint needs
 * `ADD CONSTRAINT`, and `CREATE INDEX` would leave the constraint itself absent.
 */
export function expectedIndexNames(table: TableDefinition): ExpectedIndexes {
  const indexes = new Set<string>();
  const constraints = new Set<string>();
  for (const idx of table.indexes ?? []) indexes.add(idx.name);
  for (const uc of table.uniqueConstraints ?? []) constraints.add(uc.name);
  for (const col of table.columns) {
    if (typeof col.unique === "object" && col.unique !== null) {
      constraints.add(col.unique.constraintName);
    } else if (col.unique === true) {
      // Postgres names an unnamed column UNIQUE `<table>_<column>_key`.
      constraints.add(`${table.name}_${col.name}_key`);
    }
  }
  return { indexes, constraints };
}

/**
 * The ON DELETE action a declared reference actually produces.
 *
 * `emitColumn` writes `ON DELETE RESTRICT` when `references.onDelete` is omitted, so a reference
 * that leaves it unset is not "unspecified" in the database — it is RESTRICT. Comparing the
 * declared `undefined` against the introspected `RESTRICT` would report drift on every such
 * column.
 */
export const DEFAULT_ON_DELETE: ForeignKeyAction = "RESTRICT";

export function declaredOnDelete(ref: ColumnReference): ForeignKeyAction {
  return (ref.onDelete ?? DEFAULT_ON_DELETE) as ForeignKeyAction;
}

export interface DeclaredForeignKey {
  /** The column carrying the reference; a declared FK is always single-column. */
  readonly column: string;
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumn: string;
  readonly onDelete: ForeignKeyAction;
  /** What Postgres names an inline column reference. */
  readonly expectedConstraintName: string;
}

/**
 * The foreign keys a table declares, one per column carrying `references`.
 *
 * `TableDefinition` has no table-level foreign key, so every declared FK is single-column and is
 * identified by its column rather than by a name — the emitter writes the reference inline and lets
 * Postgres name it.
 */
export function declaredForeignKeys(table: TableDefinition): readonly DeclaredForeignKey[] {
  const out: DeclaredForeignKey[] = [];
  for (const col of table.columns) {
    const ref = col.references;
    if (ref === undefined) continue;
    out.push({
      column: col.name,
      // An unqualified reference resolves through the search path, which for the meta-schema means
      // the table's own schema.
      targetSchema: ref.schema ?? table.schema,
      targetTable: ref.table,
      targetColumn: ref.column,
      onDelete: declaredOnDelete(ref),
      expectedConstraintName: `${table.name}_${col.name}_fkey`,
    });
  }
  return out;
}
