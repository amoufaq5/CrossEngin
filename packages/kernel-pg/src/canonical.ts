import {
  PUBLIC_ROLE,
  type ColumnReference,
  type RlsPolicy,
  type RlsPolicyCommand,
  type TableCheckConstraint,
  type TableDefinition,
  type TableForeignKeyConstraint,
  type TableUniqueConstraint,
} from "@crossengin/kernel/bootstrap";

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
  // `uniqueConstraints` and a `kind: "unique"` table constraint are the same thing spelled two ways,
  // so both land here and both are repaired by `ADD CONSTRAINT`.
  for (const uc of declaredUniqueConstraints(table)) constraints.add(uc.name);
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

/**
 * `pg_policy.polcmd` and the command it stands for.
 *
 * The letters are the same ones `pg_trigger` uses for its event mask, which is why `SELECT` is `r`
 * (read) and `INSERT` is `a` (append) rather than the initials anyone would guess. `*` is a policy
 * that was created without `FOR`, so an unscoped policy and one written `FOR ALL` are the same row.
 */
export const POLCMD_TO_COMMAND: Readonly<Record<string, RlsPolicyCommand>> = Object.freeze({
  "*": "ALL",
  r: "SELECT",
  a: "INSERT",
  w: "UPDATE",
  d: "DELETE",
});

export const COMMAND_TO_POLCMD: Readonly<Record<RlsPolicyCommand, string>> = Object.freeze({
  ALL: "*",
  SELECT: "r",
  INSERT: "a",
  UPDATE: "w",
  DELETE: "d",
});

/** What `CREATE POLICY` means when `FOR` is omitted, and so what an omitted `command` means. */
export const DEFAULT_POLICY_COMMAND: RlsPolicyCommand = "ALL";

/** What `CREATE POLICY` means when `TO` is omitted, and so what omitted `roles` means. */
export const DEFAULT_POLICY_ROLES: readonly string[] = Object.freeze([PUBLIC_ROLE]);

/**
 * `polcmd` → the declared spelling, or null for a character this version does not recognize.
 *
 * Null is *undetermined*, not `ALL`. A Postgres release adding a command would otherwise make every
 * policy using it read as drifted back to `FOR ALL` — inventing drift on a schema nobody touched,
 * which is the failure ADR-0290 exists to prevent.
 */
export function canonicalPolicyCommand(polcmd: string): RlsPolicyCommand | null {
  return POLCMD_TO_COMMAND[polcmd.trim()] ?? null;
}

/** The declared spelling → the `polcmd` character Postgres would store for it. */
export function policyCommandToPolcmd(command: RlsPolicyCommand): string {
  return COMMAND_TO_POLCMD[command];
}

/**
 * The command a declared policy actually produces. An omitted `command` is not "unspecified" in the
 * database — it is `ALL`, by the same reasoning as `declaredOnDelete`.
 */
export function declaredPolicyCommand(policy: RlsPolicy): RlsPolicyCommand {
  return policy.command ?? DEFAULT_POLICY_COMMAND;
}

/**
 * The roles a declared policy actually applies to, in a form comparable with an introspected list.
 *
 * `PUBLIC` is folded to its canonical spelling because it is a keyword rather than a role name and
 * introspects from oid 0; everything else is a role name and is compared verbatim, since Postgres
 * stores a quoted identifier exactly as written. The list is **sorted**: `polroles` comes back in
 * oid order, which has nothing to do with the order anyone wrote, so order cannot be a difference.
 */
export function declaredPolicyRoles(policy: RlsPolicy): readonly string[] {
  const roles = policy.roles;
  if (roles === undefined || roles.length === 0) return DEFAULT_POLICY_ROLES;
  return canonicalPolicyRoles(roles);
}

export function canonicalPolicyRoles(roles: readonly string[]): readonly string[] {
  return [...roles]
    .map((r) => (r.toUpperCase() === PUBLIC_ROLE ? PUBLIC_ROLE : r))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether two canonicalized role lists name the same grantees. */
export function samePolicyRoles(a: readonly string[], b: readonly string[]): boolean {
  const left = canonicalPolicyRoles(a);
  const right = canonicalPolicyRoles(b);
  if (left.length !== right.length) return false;
  return left.every((role, i) => role === right[i]);
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

/* ------------------------------------------------------------------------------------------------
 * Table-level constraints
 * ---------------------------------------------------------------------------------------------- */

/** What `ON UPDATE` means when the clause is omitted, and so what an omitted `onUpdate` means. */
export const DEFAULT_ON_UPDATE: ForeignKeyAction = "NO ACTION";

export function declaredConstraintOnDelete(fk: TableForeignKeyConstraint): ForeignKeyAction {
  return (fk.onDelete ?? DEFAULT_ON_DELETE) as ForeignKeyAction;
}

export function declaredConstraintOnUpdate(fk: TableForeignKeyConstraint): ForeignKeyAction {
  return (fk.onUpdate ?? DEFAULT_ON_UPDATE) as ForeignKeyAction;
}

/** `schema.table` of a table constraint's referenced side; an omitted schema is the table's own. */
export function declaredConstraintTarget(
  table: TableDefinition,
  fk: TableForeignKeyConstraint,
): string {
  return `${fk.references.schema ?? table.schema}.${fk.references.table}`;
}

export function declaredCheckConstraints(
  table: TableDefinition,
): readonly TableCheckConstraint[] {
  return (table.constraints ?? []).filter(
    (c): c is TableCheckConstraint => c.kind === "check",
  );
}

export function declaredForeignKeyConstraints(
  table: TableDefinition,
): readonly TableForeignKeyConstraint[] {
  return (table.constraints ?? []).filter(
    (c): c is TableForeignKeyConstraint => c.kind === "foreign_key",
  );
}

/**
 * Every named UNIQUE constraint the table declares over an explicit column list, from either
 * spelling. The column-level forms are deliberately left out: `expectedIndexNames` already derives
 * their names, and one of them lets Postgres do the naming.
 */
export function declaredUniqueConstraints(
  table: TableDefinition,
): readonly { readonly name: string; readonly columns: readonly string[] }[] {
  return [
    ...(table.uniqueConstraints ?? []),
    ...(table.constraints ?? []).filter(
      (c): c is TableUniqueConstraint => c.kind === "unique",
    ),
  ];
}

/** Postgres's identifier length limit, `NAMEDATALEN - 1`. */
export const PG_NAME_MAX_LENGTH = 63;

/**
 * Postgres's `makeObjectName`, which is how every constraint it names for itself is spelled.
 *
 * This is not `${name1}_${name2}_${label}` truncated at 63 characters. When the whole thing is too
 * long Postgres shortens the *longer of the two names* one character at a time until it fits,
 * keeping the label intact — so `access_review_templates` + `default_remediation_days_from_completion`
 * + `check` becomes `access_review_templates_default_remediation_days_from_com_check`, not the first
 * 63 characters of the full name, which would have dropped `_check` altogether. Two of the catalog's
 * 741 column-level checks are long enough for the difference to matter, and getting it wrong would
 * report both as undeclared on a database that is exactly correct.
 *
 * Truncation is by bytes in Postgres; every identifier here is ASCII, so characters and bytes agree.
 */
export function makeObjectName(
  name1: string,
  name2: string | null,
  label: string,
): string {
  let name1Chars = name1.length;
  let name2Chars = 0;
  let overhead = label.length + 1;
  if (name2 !== null) {
    name2Chars = name2.length;
    overhead += 1;
  }
  const available = PG_NAME_MAX_LENGTH - overhead;
  while (name1Chars + name2Chars > available) {
    if (name1Chars > name2Chars) name1Chars--;
    else name2Chars--;
  }
  const head = name1.slice(0, name1Chars);
  const middle = name2 === null ? "" : `_${name2.slice(0, name2Chars)}`;
  return `${head}${middle}_${label}`;
}

/**
 * Every CHECK constraint name a correctly-applied table carries.
 *
 * A declared table-level check is matched by the name it declares. A column-level `check` is named by
 * Postgres, and which name it picks depends on how many columns the *expression* references: one
 * column gives `<table>_<column>_check`, while none or several give `<table>_check`, because
 * `AddRelationNewConstraints` only passes a column name along when the parsed expression resolves to
 * exactly one. Knowing which applies means parsing the expression, which is the problem ADR-0292
 * refused to solve — `tenant_credits.remaining_cents` already declares
 * `remaining_cents <= amount_cents` on a column and so carries the second spelling.
 *
 * So both are expected whenever the table has any column-level check. That over-approximates by one
 * name: an unnamed table-level CHECK someone added by hand to such a table would be read as
 * accounted for instead of reported. It never invents drift, which is the direction that matters —
 * the alternative reports every correct cross-column column check as undeclared. A table-level
 * constraint declared here always carries a name, so it is never the ambiguous case.
 */
export function expectedCheckConstraintNames(table: TableDefinition): ReadonlySet<string> {
  const names = new Set<string>();
  for (const check of declaredCheckConstraints(table)) names.add(check.name);
  let hasColumnCheck = false;
  for (const col of table.columns) {
    if (col.check === undefined) continue;
    hasColumnCheck = true;
    names.add(makeObjectName(table.name, col.name, "check"));
  }
  if (hasColumnCheck) names.add(makeObjectName(table.name, null, "check"));
  return names;
}

/** What `CREATE POLICY` means when `AS` is omitted, and so what an omitted `permissive` means. */
export const DEFAULT_POLICY_PERMISSIVE = true;

/**
 * Whether a declared policy is permissive. A boolean needs no canonicalisation, but its *absence*
 * does: omitting `AS` means `AS PERMISSIVE`, so an omitted field is `true` rather than unknown — the
 * same reasoning as `declaredOnDelete` and `declaredPolicyCommand`.
 */
export function declaredPolicyPermissive(policy: RlsPolicy): boolean {
  return policy.permissive ?? DEFAULT_POLICY_PERMISSIVE;
}
