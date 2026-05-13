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
}

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface RlsPolicy {
  readonly name: string;
  readonly using: string;
  readonly check?: string;
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
