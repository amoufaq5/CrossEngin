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
  readonly indexes?: readonly IndexSpec[];
  readonly rls?: TableRls;
}
