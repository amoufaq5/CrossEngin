export interface ColumnReference {
  readonly schema?: string;
  readonly table: string;
  readonly column: string;
  readonly onDelete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT" | "NO ACTION";
}

export interface ColumnDefinition {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
  readonly default?: string;
  readonly unique?: boolean | { readonly constraintName: string };
  readonly references?: ColumnReference;
  readonly check?: string;
  /**
   * The name this column used to be declared under, so a rename reconciles as a rename.
   *
   * Without it, renaming a column added one under the new name and reported the old one as
   * undeclared — and a `NOT NULL` old column that nothing dropped then failed every insert.
   *
   * It says nothing about emission: a fresh `CREATE TABLE` has no history to honour, so this field
   * is invisible to the emitter and only the reconciler reads it. It is also *not* an instruction —
   * a rename is planned only when the old name is live and the new one is not. Both live is
   * ambiguous and is reported; neither live is an ordinary addition.
   */
  readonly renamedFrom?: string;
}

export interface IndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly kind?: "btree" | "gin" | "gist" | "hash";
  readonly where?: string;
}

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
}

/** The referential actions `ON DELETE` / `ON UPDATE` can take, spelled the way DDL spells them. */
export const REFERENTIAL_ACTIONS = [
  "NO ACTION",
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
] as const;
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/** The kinds of constraint that can only be stated at the table level. */
export const TABLE_CONSTRAINT_KINDS = ["check", "foreign_key", "unique"] as const;
export type TableConstraintKind = (typeof TABLE_CONSTRAINT_KINDS)[number];

/**
 * A CHECK over the whole row, which is the only place a *cross-column* rule can live:
 * `bounces_count <= recipient_count` is a comparison between two columns and belongs to neither.
 *
 * A single-column rule still belongs on the column (`ColumnDefinition.check`) — Postgres stores both
 * as `contype = 'c'` and the difference is only in who names it. That matters on the way back: a
 * column check is named by Postgres and has to be guessed at, while this one is matched by the name
 * declared here.
 */
export interface TableCheckConstraint {
  readonly kind: "check";
  readonly name: string;
  /** A boolean SQL expression over this table's columns. */
  readonly expression: string;
}

/**
 * A foreign key over one or more columns.
 *
 * `ColumnDefinition.references` covers the single-column case and is emitted inline, which leaves
 * Postgres to name it — so a *composite* key had no way to be declared at all, and one the database
 * held always read as undeclared. Declaring the name here is what makes a multi-column key matchable
 * on the way back, since the column-matching trick a single-column reference relies on cannot
 * distinguish two keys over overlapping column sets.
 */
export interface TableForeignKeyConstraint {
  readonly kind: "foreign_key";
  readonly name: string;
  /** The referencing columns, in key order. Order is part of the constraint's identity. */
  readonly columns: readonly string[];
  readonly references: {
    readonly schema?: string;
    readonly table: string;
    /** The referenced columns, positionally paired with `columns`. */
    readonly columns: readonly string[];
  };
  /** Omitted means `RESTRICT`, which is what the emitter writes when it is left out. */
  readonly onDelete?: ReferentialAction;
  /** Omitted means `NO ACTION`, which is what Postgres defaults to when no clause is written. */
  readonly onUpdate?: ReferentialAction;
}

/**
 * A UNIQUE constraint over one or more columns.
 *
 * This is the general spelling of something the vocabulary already had two narrower forms of:
 * `TableDefinition.uniqueConstraints` is the same named, multi-column constraint, and
 * `ColumnDefinition.unique` is sugar for the single-column case (`true` lets Postgres name it,
 * `{ constraintName }` names it). All three produce the same `CONSTRAINT … UNIQUE (…)` table-level
 * line and are reconciled by the same machinery; the older fields are left exactly as they are
 * because 139 tables use them and changing their emission would rewrite the bootstrap SQL.
 */
export interface TableUniqueConstraint {
  readonly kind: "unique";
  readonly name: string;
  readonly columns: readonly string[];
}

export type TableConstraint =
  | TableCheckConstraint
  | TableForeignKeyConstraint
  | TableUniqueConstraint;

/** The commands a policy can be scoped to, spelled the way `CREATE POLICY … FOR …` spells them. */
export const RLS_POLICY_COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export type RlsPolicyCommand = (typeof RLS_POLICY_COMMANDS)[number];

/**
 * The grantee `CREATE POLICY` applies a policy to when `TO` is omitted. It is a keyword, not a role
 * name, so it is never quoted and it has no row in `pg_authid` — Postgres records it as oid 0.
 */
export const PUBLIC_ROLE = "PUBLIC";

export interface RlsPolicy {
  readonly name: string;
  readonly using: string;
  readonly check?: string;
  /**
   * Which command the policy governs. Omitted means `ALL` — exactly what `CREATE POLICY` defaults
   * to — so a policy that does not declare it emits and compares the same as one that never could.
   */
  readonly command?: RlsPolicyCommand;
  /**
   * The roles the policy applies to. Omitted means `PUBLIC`, which is again the `CREATE POLICY`
   * default; an empty list is not a narrower grant but a meaningless one, so it is not allowed to
   * mean anything and is treated as absent.
   */
  readonly roles?: readonly string[];
  /**
   * Whether the policy is permissive — ORed with the other permissive policies — or restrictive,
   * ANDed with every policy that matched. Omitted means permissive, which is the `CREATE POLICY`
   * default, so a policy that does not declare it emits and compares exactly as one that never
   * could.
   *
   * It is a boolean rather than the two keywords because `pg_policy.polpermissive` is a boolean;
   * there is no third state in the database to represent.
   */
  readonly permissive?: boolean;
}

export interface TableRls {
  readonly enabled: boolean;
  readonly policies?: readonly RlsPolicy[];
}

export interface TableDefinition {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnDefinition[];
  readonly primaryKey?: readonly string[];
  readonly uniqueConstraints?: readonly UniqueConstraint[];
  /**
   * Constraints that can only be stated at the table level: a cross-column CHECK and a composite
   * foreign key, plus `unique` as the general spelling of `uniqueConstraints`.
   *
   * Optional and emitted *after* the existing table-level lines, so a table that declares none emits
   * byte-identical SQL to what it emitted before this field existed.
   */
  readonly constraints?: readonly TableConstraint[];
  readonly indexes?: readonly IndexSpec[];
  readonly rls?: TableRls;
}
