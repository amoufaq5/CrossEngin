import { quoteIdent } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";

import { plansRequirePgcrypto, type EntityTablePlan, type JoinTablePlan } from "./column-plan.js";
import { uniqueIndexFields } from "./entity-ddl.js";
import { SEARCH_FUNCTION_ADMITS_INDEX, probeSearchFunction } from "./search-function.js";

/**
 * Who may apply the column store's DDL, and what the store does when this session may not.
 *
 * Measured on PG 16 as the shipped serving role (`crossengin_app`, NOSUPERUSER NOBYPASSRLS, owning
 * nothing — ADR-0424): the first statement `ensureSchema` issued, `CREATE SCHEMA IF NOT EXISTS
 * "public"`, raised `42501 permission denied for database`, so `--store pg-columns` could not boot at
 * all. Skipping the statements that are already satisfied is not available either, and that is the
 * finding that decides the shape: with every table already present, `CREATE TABLE IF NOT EXISTS`
 * still raises `permission denied for schema public`, and `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * and `CREATE INDEX IF NOT EXISTS` raise `must be owner of table` — Postgres checks the privilege
 * before it checks existence. So the owner applies the DDL (the `column-schema` one-shot, ADR-0423's
 * `document-indexes` precedent) and a session that cannot apply it **verifies** instead.
 *
 * - `applies` — the schema is absent and this session may create it, or it exists and this session
 *   is a member of its owner. `ensureSchema` runs the DDL as it always has.
 * - `verifies` — anything else. `ensureSchema` reads the catalog and refuses, naming every
 *   shortfall and the remedy, when the schema the API will serve is not the one the manifest plans.
 *
 * A member of the owner, not the owner itself, because PG 15+ makes `public` owned by
 * `pg_database_owner`, of which the database owner is an implicit member.
 */
export const COLUMN_SCHEMA_AUTHORITIES = ["applies", "verifies"] as const;
export type ColumnSchemaAuthority = (typeof COLUMN_SCHEMA_AUTHORITIES)[number];

export interface ColumnSchemaAuthorityProbe {
  readonly authority: ColumnSchemaAuthority;
  readonly role: string;
  readonly schemaExists: boolean;
  /** The schema's owning role, or `null` when the schema does not exist. */
  readonly schemaOwner: string | null;
}

/**
 * A fragment only the authority probe names, and the row an owner session answers it with. Exported
 * for the fakes that reach `ensureSchema`, so none of them has to hand-write a row the probe reads
 * differently (`SEARCH_FUNCTION_PROBE_MATCH`'s reason).
 */
export const COLUMN_SCHEMA_AUTHORITY_PROBE_MATCH = "AS may_apply";
export const COLUMN_SCHEMA_OWNER_AUTHORITY_ROW = {
  role: "owner",
  schema_exists: true,
  schema_owner: "owner",
  may_apply: true,
} as const;

const AUTHORITY_SQL = `
  SELECT current_user::text AS role,
         n.oid IS NOT NULL AS schema_exists,
         n.nspowner::regrole::text AS schema_owner,
         CASE WHEN n.oid IS NULL THEN has_database_privilege(current_database(), 'CREATE')
              ELSE pg_has_role(current_user, n.nspowner, 'USAGE') END AS may_apply
    FROM (SELECT $1::text AS nspname) want
    LEFT JOIN pg_namespace n ON n.nspname = want.nspname`;

export async function probeColumnSchemaAuthority(
  conn: PgConnection,
  schema: string,
): Promise<ColumnSchemaAuthorityProbe> {
  const result = await conn.query<{
    role: unknown;
    schema_exists: unknown;
    schema_owner: unknown;
    may_apply: unknown;
  }>(AUTHORITY_SQL, [schema]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`could not read the authority over schema '${schema}'`);
  const exists = row.schema_exists === true;
  return {
    authority: row.may_apply === true ? "applies" : "verifies",
    role: String(row.role),
    schemaExists: exists,
    schemaOwner: exists && typeof row.schema_owner === "string" ? row.schema_owner : null,
  };
}

/** What the serving schema lacks, relative to the manifest's plan. */
export const COLUMN_SCHEMA_SHORTFALL_KINDS = [
  "schema_absent",
  "table_absent",
  "column_absent",
  "row_security_off",
  "privilege_absent",
  "search_function_absent",
  "extension_absent",
] as const;
export type ColumnSchemaShortfallKind = (typeof COLUMN_SCHEMA_SHORTFALL_KINDS)[number];

export interface ColumnSchemaShortfall {
  readonly kind: ColumnSchemaShortfallKind;
  /** `schema.table`, `schema.table.column`, or the function's signature. */
  readonly object: string;
}

/** The four DML privileges the store issues against every table it serves. */
const SERVED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

const TABLES_SQL = `
  SELECT c.relname::text AS table_name, c.relrowsecurity AS rls,
         has_table_privilege(c.oid, 'SELECT') AS can_select,
         has_table_privilege(c.oid, 'INSERT') AS can_insert,
         has_table_privilege(c.oid, 'UPDATE') AS can_update,
         has_table_privilege(c.oid, 'DELETE') AS can_delete
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[])`;

const COLUMNS_SQL = `
  SELECT c.relname::text AS table_name, a.attname::text AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped`;

/**
 * The columns every entity table carries beside its planned ones (`emitEntityTableDdl`). The two
 * system timestamps are not listed, because a planned column of either name replaces them.
 */
const IMPLICIT_ENTITY_COLUMNS = ["id", "tenant_id"] as const;

/**
 * Reads the serving schema against the plan: every table present, carrying every planned column,
 * with row-level security on and the four DML privileges held by this session, and the search
 * wrapper the predicate names. Read-only, and every read is a catalog read, so it answers for a
 * session that owns nothing.
 *
 * Deliberately not a full drift check — foreign keys, indexes and policy *bodies* are the owner's
 * DDL to converge, and `kernel-pg`'s reconciler is the instrument for comparing them. What this
 * asks is the narrower question that decides whether the API can serve at all; a schema an owner
 * provisioned from the same manifest passes it, and one provisioned from another manifest or not at
 * all is refused by name before the first request.
 */
export async function verifyColumnSchema(
  conn: PgConnection,
  plans: ReadonlyMap<string, EntityTablePlan>,
  joinPlans: readonly JoinTablePlan[],
): Promise<readonly ColumnSchemaShortfall[]> {
  const planList = [...plans.values()];
  const schema = planList[0]?.schema ?? joinPlans[0]?.schema;
  if (schema === undefined) return [];
  const expected = new Map<string, readonly string[]>();
  for (const plan of planList) {
    expected.set(plan.table, [...IMPLICIT_ENTITY_COLUMNS, ...plan.columns.map((c) => c.column)]);
  }
  for (const join of joinPlans) {
    expected.set(join.table, ["tenant_id", join.leftColumn, join.rightColumn]);
  }
  const names = [...expected.keys()];
  const shortfalls: ColumnSchemaShortfall[] = [];

  const ns = await conn.query<{ present: unknown }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
    [schema],
  );
  if (ns.rows[0]?.present !== true) return [{ kind: "schema_absent", object: schema }];

  const tables = await conn.query<{
    table_name: unknown;
    rls: unknown;
    can_select: unknown;
    can_insert: unknown;
    can_update: unknown;
    can_delete: unknown;
  }>(TABLES_SQL, [schema, names]);
  const found = new Map(tables.rows.map((r) => [String(r.table_name), r]));
  const columns = await conn.query<{ table_name: unknown; column_name: unknown }>(COLUMNS_SQL, [
    schema,
    names,
  ]);
  const columnsOf = new Map<string, Set<string>>();
  for (const r of columns.rows) {
    const t = String(r.table_name);
    const set = columnsOf.get(t) ?? new Set<string>();
    set.add(String(r.column_name));
    columnsOf.set(t, set);
  }

  for (const [table, cols] of expected) {
    const qualified = `${schema}.${table}`;
    const row = found.get(table);
    if (row === undefined) {
      shortfalls.push({ kind: "table_absent", object: qualified });
      continue;
    }
    const have = columnsOf.get(table) ?? new Set<string>();
    for (const col of cols) {
      if (!have.has(col)) shortfalls.push({ kind: "column_absent", object: `${qualified}.${col}` });
    }
    if (row.rls !== true) shortfalls.push({ kind: "row_security_off", object: qualified });
    const held = [row.can_select, row.can_insert, row.can_update, row.can_delete];
    const missing = SERVED_PRIVILEGES.filter((_, i) => held[i] !== true);
    if (missing.length > 0) {
      shortfalls.push({ kind: "privilege_absent", object: `${qualified} (${missing.join(", ")})` });
    }
  }

  if (planList.length > 0) {
    const search = await probeSearchFunction(conn);
    if (SEARCH_FUNCTION_ADMITS_INDEX[search.state] === false) {
      shortfalls.push({
        kind: "search_function_absent",
        object: `public.ce_unaccent(text) (${search.state})`,
      });
    }
  }
  if (plansRequirePgcrypto(plans)) {
    const ext = await conn.query<{ present: unknown }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS present",
    );
    if (ext.rows[0]?.present !== true) shortfalls.push({ kind: "extension_absent", object: "pgcrypto" });
  }
  return shortfalls;
}

/** A declared unique field whose index the verified schema does not hold, or holds invalid. */
export interface UniqueIndexShortfall {
  readonly entity: string;
  readonly field: string;
  readonly index: string;
  readonly state: "absent" | "invalid";
}

const UNIQUE_INDEXES_SQL = `
  SELECT i.relname::text AS index_name, x.indisvalid AS valid
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = $1 AND i.relname = ANY($2::text[])`;

/**
 * Which of the plan's unique indexes the schema lacks. Not a shortfall that refuses the boot — an
 * absent unique index is permissive rather than a wrong answer (ADR-0360), and the owner's one-shot
 * may have been refused it over existing duplicates — but the boot's unique-enforcement line has to
 * hear it: on the applying arm the store ran the `CREATE UNIQUE INDEX` and saw its refusal, and on
 * the verifying arm nothing did, so without this the line counted an index nobody built as enforced.
 */
export async function verifyUniqueIndexes(
  conn: PgConnection,
  plans: ReadonlyMap<string, EntityTablePlan>,
): Promise<readonly UniqueIndexShortfall[]> {
  const wanted: { entity: string; field: string; index: string }[] = [];
  let schema: string | undefined;
  for (const plan of plans.values()) {
    schema ??= plan.schema;
    for (const [index, field] of uniqueIndexFields(plan)) wanted.push({ entity: plan.entity, field, index });
  }
  if (schema === undefined || wanted.length === 0) return [];
  const result = await conn.query<{ index_name: unknown; valid: unknown }>(UNIQUE_INDEXES_SQL, [
    schema,
    wanted.map((w) => w.index),
  ]);
  const found = new Map(result.rows.map((r) => [String(r.index_name), r.valid === true]));
  const out: UniqueIndexShortfall[] = [];
  for (const w of wanted) {
    const valid = found.get(w.index);
    if (valid === undefined) out.push({ ...w, state: "absent" });
    else if (!valid) out.push({ ...w, state: "invalid" });
  }
  return out;
}

/**
 * The serving schema is not the one the manifest plans, and this session cannot make it so.
 *
 * Raised at boot rather than met as a 500 on the first request, and its message is the remedy: the
 * owner's one-shot applies the DDL and grants the serving role its DML, after which the API needs
 * nothing but the verification it now passes.
 */
export class ColumnSchemaNotProvisioned extends Error {
  override readonly name = "ColumnSchemaNotProvisioned";
  constructor(
    readonly probe: ColumnSchemaAuthorityProbe,
    readonly schema: string,
    readonly shortfalls: readonly ColumnSchemaShortfall[],
  ) {
    const shown = shortfalls.slice(0, 8).map((s) => `${s.kind} ${s.object}`);
    const more = shortfalls.length > shown.length ? `, and ${(shortfalls.length - shown.length).toString()} more` : "";
    super(
      `--store pg-columns: role '${probe.role}' cannot apply the column store's DDL to schema ` +
        `'${schema}' (${probe.schemaExists ? `owned by '${probe.schemaOwner ?? "?"}'` : "the schema does not exist and this role may not create it"}), ` +
        `and the schema is not provisioned for this manifest: ${shown.join("; ")}${more}. ` +
        "Run `operate-server column-schema --pack <name> --grant-to " +
        `${probe.role}\` (or --manifest <file>) as the role that owns the schema — the one that runs ` +
        "migrate — before the API boots, then restart. The API never applies this DDL as a role that " +
        "owns nothing, because Postgres refuses CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT " +
        "EXISTS to a non-owner even when the object already exists.",
    );
  }
}

/**
 * The grants a serving role needs over the tables the owner just created: USAGE on the schema and
 * the four DML privileges on each table. Nothing else — the serving role must own nothing, or every
 * policy on these tables is inert for it (ADR-0424).
 */
export function columnSchemaGrantSql(
  plans: ReadonlyMap<string, EntityTablePlan>,
  joinPlans: readonly JoinTablePlan[],
  role: string,
): readonly string[] {
  const schema = [...plans.values()][0]?.schema ?? joinPlans[0]?.schema;
  if (schema === undefined) return [];
  const tables = [...[...plans.values()].map((p) => p.table), ...joinPlans.map((j) => j.table)];
  const unique = [...new Set(tables)];
  return [
    `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
    ...unique.map(
      (t) =>
        `GRANT ${SERVED_PRIVILEGES.join(", ")} ON ${quoteIdent(schema)}.${quoteIdent(t)} TO ${quoteIdent(role)};`,
    ),
  ];
}
