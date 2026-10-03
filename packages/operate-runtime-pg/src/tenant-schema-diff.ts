import { qualifyTable, quoteIdent } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { ColumnMapping, EntityTablePlan, JoinTablePlan } from "./column-plan.js";

/**
 * One column as Postgres currently has it. `formattedType` is `format_type`'s
 * own spelling — asking the server rather than reading
 * `information_schema.columns` is deliberate: `format_type` is the canonical
 * rendering (`character varying(320)`, `timestamp with time zone`, `text[]`),
 * where `information_schema` reports an array as the bare word `ARRAY` and the
 * element type separately.
 */
export interface LiveColumn {
  readonly table: string;
  readonly column: string;
  readonly formattedType: string;
  readonly notNull: boolean;
}

/** `table name → column name → column`, for the tables of one schema. */
export type LiveSchema = ReadonlyMap<string, ReadonlyMap<string, LiveColumn>>;

const INTROSPECT_COLUMNS_SQL = `SELECT c.relname AS table_name,
       a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
       a.attnotnull AS not_null
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1
   AND c.relkind = 'r'
   AND a.attnum > 0
   AND NOT a.attisdropped
 ORDER BY c.relname, a.attnum`;

/**
 * Reads every ordinary table's columns in one schema. A schema that does not
 * exist yet simply yields no rows — the caller treats that as "everything is new",
 * which is exactly right on a first activation.
 */
export async function introspectTenantSchema(conn: PgConnection, schema: string): Promise<LiveSchema> {
  const res = await conn.query<{
    table_name: unknown;
    column_name: unknown;
    formatted_type: unknown;
    not_null: unknown;
  }>(INTROSPECT_COLUMNS_SQL, [schema]);
  const out = new Map<string, Map<string, LiveColumn>>();
  for (const row of res.rows) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    let columns = out.get(table);
    if (columns === undefined) {
      columns = new Map<string, LiveColumn>();
      out.set(table, columns);
    }
    columns.set(column, {
      table,
      column,
      formattedType: String(row.formatted_type),
      // node-postgres yields a bool; a scripted driver may hand back "t"/"true".
      notNull: row.not_null === true || row.not_null === "t" || row.not_null === "true",
    });
  }
  return out;
}

/**
 * The emitter's own columns on an entity table (`entity-ddl.ts`). They are not in
 * the column plan, so they must be excluded from the "this column is not
 * declared" check or every table would report them.
 */
const ENTITY_SYSTEM_COLUMNS: ReadonlySet<string> = new Set([
  "tenant_id",
  "id",
  "created_at",
  "updated_at",
]);

const DECLARED_TYPE_BASES: ReadonlyMap<string, string> = new Map([
  ["TEXT", "text"],
  ["VARCHAR", "character varying"],
  ["CHAR", "character"],
  ["INTEGER", "integer"],
  ["BIGINT", "bigint"],
  ["NUMERIC", "numeric"],
  ["BOOLEAN", "boolean"],
  ["DATE", "date"],
  ["TIME", "time without time zone"],
  ["TIMESTAMPTZ", "timestamp with time zone"],
  ["INTERVAL", "interval"],
  ["UUID", "uuid"],
  ["JSONB", "jsonb"],
  ["BYTEA", "bytea"],
]);

/**
 * Rewrites a type the plan declares into `format_type`'s spelling, so a declared
 * `VARCHAR(320)` and a live `character varying(320)` compare equal.
 *
 * The set of types this store can emit is **closed** — whatever
 * `fieldTypeToPostgresType` produces, plus `TEXT` for a reference column and
 * `BYTEA` for an encrypted one — so an explicit table is complete rather than
 * fragile, and `tenant-schema-diff.test.ts` enumerates it against the kernel's
 * own mapping to keep it that way.
 *
 * Anything outside it (today: PostGIS `geography(POINT)`, whose `format_type`
 * spelling carries an SRID this function has no way to predict) returns **null**
 * — undetermined. A caller must read that as "not compared", never as drift,
 * the same rule ADR-0292 applies to an index predicate it cannot render.
 */
export function canonicalDeclaredType(sqlType: string): string | null {
  const trimmed = sqlType.trim();
  const isArray = trimmed.endsWith("[]");
  const scalar = isArray ? trimmed.slice(0, -2).trim() : trimmed;
  const open = scalar.indexOf("(");
  const base = (open === -1 ? scalar : scalar.slice(0, open)).trim().toUpperCase();
  const canonicalBase = DECLARED_TYPE_BASES.get(base);
  if (canonicalBase === undefined) return null;
  const modifier = open === -1 ? "" : scalar.slice(open).replace(/\s+/g, "");
  return `${canonicalBase}${modifier}${isArray ? "[]" : ""}`;
}

/** The type a planned column is actually stored as: ciphertext is `BYTEA`, not the plaintext type. */
export function storedTypeOf(mapping: ColumnMapping): string {
  return mapping.encryptAtRest ? "BYTEA" : mapping.sqlType;
}

export const TENANT_SCHEMA_CHANGE_KINDS = [
  "column_type_change",
  "column_encryption_change",
  "not_null_tightening",
  "not_null_relaxation",
  "undeclared_column",
  "undeclared_table",
] as const;

export type TenantSchemaChangeKind = (typeof TENANT_SCHEMA_CHANGE_KINDS)[number];

/**
 * Something the manifest asks for (or no longer asks for) that the additive
 * migration will not do. Every one carries the exact SQL that *would* do it, so
 * an operator can decide about the existing rows and run it by hand — the same
 * shape `kernel-pg`'s reconciler reports an `unreconciled` step in (ADR-0290).
 *
 * `blocking` separates "this would serve a lie" from "this is untidy". A changed
 * type or a changed classification is blocking: the store reads and writes
 * through the plan's type, so a column that disagrees makes every read of it
 * wrong, and a classification change silently moves a field between ciphertext
 * and plaintext. The rest are reported and the migration proceeds.
 */
export interface TenantSchemaChange {
  readonly kind: TenantSchemaChangeKind;
  readonly table: string;
  readonly column: string | null;
  readonly detail: string;
  readonly blocking: boolean;
  /** The statement that would reconcile it, or null when the only remedy is a human decision. */
  readonly sql: string | null;
}

function entityChangesFor(plan: EntityTablePlan, live: ReadonlyMap<string, LiveColumn>): TenantSchemaChange[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const out: TenantSchemaChange[] = [];
  const planned = new Set<string>();

  for (const mapping of plan.columns) {
    planned.add(mapping.column);
    const existing = live.get(mapping.column);
    if (existing === undefined) continue; // additive: ADD COLUMN IF NOT EXISTS handles it
    const wantRaw = storedTypeOf(mapping);
    const want = canonicalDeclaredType(wantRaw);
    const liveIsBytea = existing.formattedType === "bytea";

    // Classification first: it is a type change, but calling it one buries the
    // part that matters — whether the field is stored as ciphertext at all.
    if (mapping.encryptAtRest !== liveIsBytea) {
      out.push({
        kind: "column_encryption_change",
        table: plan.table,
        column: mapping.column,
        detail: mapping.encryptAtRest
          ? `classified ${mapping.classification ?? "sensitive"}, so it must be stored encrypted (BYTEA), but the column is ${existing.formattedType} plaintext; the existing rows would have to be encrypted first`
          : `the column is encrypted (bytea) but the manifest no longer classifies it for encryption; the existing rows would have to be decrypted first`,
        blocking: true,
        sql: null,
      });
      continue;
    }

    if (want !== null && want !== existing.formattedType) {
      out.push({
        kind: "column_type_change",
        table: plan.table,
        column: mapping.column,
        detail: `declared ${wantRaw} (${want}), live ${existing.formattedType}`,
        blocking: true,
        // ADD COLUMN IF NOT EXISTS matches on name only, so it would report
        // success and change nothing; this is the statement that would not.
        sql: `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(mapping.column)} TYPE ${wantRaw};`,
      });
      continue;
    }

    const wantNotNull = mapping.notNull;
    if (wantNotNull && !existing.notNull) {
      out.push({
        kind: "not_null_tightening",
        table: plan.table,
        column: mapping.column,
        detail:
          mapping.defaultSql === null
            ? "the field is now required but the column is nullable and has no default to backfill existing rows with"
            : "the field is now required; existing NULL rows would need backfilling",
        blocking: false,
        sql: `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(mapping.column)} SET NOT NULL;`,
      });
    } else if (!wantNotNull && existing.notNull) {
      out.push({
        kind: "not_null_relaxation",
        table: plan.table,
        column: mapping.column,
        detail:
          "the field is no longer required but the column is still NOT NULL, so a write that omits it will be rejected",
        blocking: false,
        sql: `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(mapping.column)} DROP NOT NULL;`,
      });
    }
  }

  for (const existing of live.values()) {
    if (planned.has(existing.column) || ENTITY_SYSTEM_COLUMNS.has(existing.column)) continue;
    out.push({
      kind: "undeclared_column",
      table: plan.table,
      column: existing.column,
      detail: "the column exists but no field in the manifest resolves to it; it is left in place",
      blocking: false,
      sql: `ALTER TABLE ${qualified} DROP COLUMN ${quoteIdent(existing.column)};`,
    });
  }

  return out;
}

/**
 * Compares a tenant's declared tables against the ones their schema already has,
 * and reports everything the additive migration will not do.
 *
 * It reports; it never rewrites the plan. The additive statements
 * (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) stand on their own
 * and need no diff to be safe — the diff exists for what they *cannot* do, which
 * `ADD COLUMN IF NOT EXISTS` would otherwise hide by reporting success on a
 * column whose type does not match (it matches on name alone).
 *
 * A table in the schema that no plan claims — a removed entity, or a renamed
 * `many_to_many` relation's old join table — is reported and left alone, for the
 * same reason a removed field's column is: dropping it is a decision about
 * existing data.
 */
export function diffTenantSchema(
  plans: ReadonlyMap<string, EntityTablePlan>,
  joinPlans: readonly JoinTablePlan[],
  live: LiveSchema,
): readonly TenantSchemaChange[] {
  const out: TenantSchemaChange[] = [];
  const declaredTables = new Set<string>();
  for (const plan of plans.values()) {
    declaredTables.add(plan.table);
    out.push(...entityChangesFor(plan, live.get(plan.table) ?? new Map<string, LiveColumn>()));
  }
  for (const joinPlan of joinPlans) declaredTables.add(joinPlan.table);
  for (const table of live.keys()) {
    if (declaredTables.has(table)) continue;
    out.push({
      kind: "undeclared_table",
      table,
      column: null,
      detail: "the table exists but the manifest declares no entity or relation for it; it is left in place",
      blocking: false,
      sql: null,
    });
  }
  return out;
}

/** The blocking subset — what makes an application refuse rather than proceed. */
export function blockingChanges(changes: readonly TenantSchemaChange[]): readonly TenantSchemaChange[] {
  return changes.filter((c) => c.blocking);
}

/** A one-line-per-change rendering for a log line or an API response. */
export function formatTenantSchemaChange(change: TenantSchemaChange): string {
  const where = change.column === null ? change.table : `${change.table}.${change.column}`;
  const sql = change.sql === null ? "" : ` — manual: ${change.sql}`;
  return `${change.kind} ${where}: ${change.detail}${sql}`;
}
