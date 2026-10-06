import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Whether the principal ids this deployment's credentials name have a `meta.users` row — asked at
 * boot, because the alternative is finding out at the first write.
 *
 * ## The failure this exists to make legible
 *
 * **50 of the catalog's columns carry a `NOT NULL` foreign key into `meta.users`**, every one of
 * them `ON DELETE RESTRICT`, and nine sit on tables with a live writer. Nothing writes `meta.users`
 * (verified: every reference to it in the workspace is a comment or a read), so those nine stores
 * cannot insert a row at all. Measured live as a non-owner role against a fresh cluster: eight of
 * the nine refuse with `23503 … Key is not present in table "users"`, and the ninth cannot be
 * attempted because its own parent is refused by the same constraint.
 *
 * The symptom is not an error at boot. It is a 23503 the first time somebody opens a notification
 * (`meta.notification_read_states.user_id`), publishes a workflow definition
 * (`workflow_definitions.created_by`) or runs an access-review campaign
 * (`access_review_campaigns.created_by`) — reported, in ADR-0331's words for the read-state case,
 * "as a 503 for something permanent".
 *
 * ## Why the catalog and not a count
 *
 * ADR-0333's `probeJobQueueVisibility` and ADR-0334's `surveyTenantStatusCoverage` both turn on the
 * same observation, and it holds here with a twist. `SELECT count(*) FROM meta.users WHERE id = $1`
 * answering 0 has **two** meanings: the row is absent, or this role cannot read the table. The
 * second is not hypothetical — `meta.users` has no RLS, so the confinement is privileges rather than
 * policies, and a deployment that granted `INSERT` on the `meta` tables and forgot `SELECT` gets a
 * confidently wrong "not provisioned" for every principal it holds. So the probe asks
 * `pg_class` whether the table exists and `has_table_privilege` what this role may do to it, and
 * only *then* reads the ids — and when it may not read, it says `unknown` rather than `absent`.
 *
 * That is the same asymmetry `surveyTenantStatusCoverage` draws between `missing` and `unreachable`:
 * one names a thing an operator must create, the other names a thing this probe could not see.
 * Printing the first when the second is true prints a list of principals that are fine.
 *
 * ## What it cannot see
 *
 * The JWT path. `principalFromJwtClaims` hashes an arbitrary IdP `sub` into a UUID via
 * `subjectToUuid` and always reports `principalKind: "user"`, so a JWT-authenticated principal's id
 * is not known until the request arrives and is overwhelmingly unlikely to exist in `meta.users`.
 * There is no set to survey at boot, which is a limitation of the deployment's shape and not of this
 * function: see the note on `surveyUserFkReadiness`'s return.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const USER_REGISTRY_STATES = [
  /** The table exists and this role may read it, so the per-principal answers mean something. */
  "readable",
  /** The table exists and this role may not `SELECT` it: every principal answers `unknown`. */
  "unreadable",
  /** No `meta.users` in this schema. Nothing can satisfy any of the 50 references. */
  "absent",
  /** The catalog query itself failed — at boot the database may simply not be up yet. */
  "unreachable",
] as const;
export type UserRegistryState = (typeof USER_REGISTRY_STATES)[number];

export const PRINCIPAL_READINESS = [
  /** A `meta.users` row holds this id: every `NOT NULL` reference to it is satisfiable. */
  "provisioned",
  /** No row holds it. Any store writing a `NOT NULL` user reference for it will raise 23503. */
  "absent",
  /** Could not be established — the registry was unreadable, unreachable or absent. */
  "unknown",
] as const;
export type PrincipalReadiness = (typeof PRINCIPAL_READINESS)[number];

/**
 * The tables with a **live writer** and a `NOT NULL` foreign key into `meta.users`, as verified by
 * running `scanWorkspaceSql` over the workspace and intersecting with the catalog.
 *
 * A **floor, not a census**, and asserted as a subset rather than as an equality: a store added
 * tomorrow for any of the other 37 such tables joins this class the moment it lands, and a test that
 * demanded equality would fail on somebody else's correct increment. The both-directions comparison
 * that ADR-0334 says a declaration needs lives where it belongs — in
 * `packages/testing/src/strategy/pg-storeless-tables.ts`, over writers and not over this list.
 *
 * This was **nine** before the catalog change in this increment, and the six that left are the point
 * of that change rather than an erosion of this list: `pack_installations.requested_by`,
 * `notification_templates.created_by`, `access_review_campaigns.created_by`,
 * `access_review_decisions.decided_by_user_id`, `workflow_definitions.created_by` and
 * `gateway_routes.created_by` are TEXT now, so those stores insert whatever principal acted without
 * demanding a registry row first. What remains is the set where the reference is **right**: three
 * `CASCADE` tables holding a user's own per-viewer state, which must go when the user does, and two
 * that are *about* the user — their tenant membership and their notification preferences.
 */
export const LIVE_USER_FK_WRITERS: readonly string[] = Object.freeze([
  "notification_digests",
  "notification_preferences",
  "notification_read_states",
  "notification_read_watermarks",
  "user_tenant_membership",
]);

/** One `NOT NULL` reference into `meta.users`, as the live catalog reports it. */
export interface UserReference {
  readonly table: string;
  readonly column: string;
  readonly onDelete: string;
  /** Whether a store in this workspace is known to write the table (see `LIVE_USER_FK_WRITERS`). */
  readonly hasLiveWriter: boolean;
}

export interface UserFkReadiness {
  readonly registry: UserRegistryState;
  /** Why the registry is in that state, in words an operator can act on. */
  readonly detail: string;
  readonly role: string;
  readonly canSelect: boolean;
  readonly canInsert: boolean;
  /** Every `NOT NULL` reference into `meta.users` the catalog declares, sorted. */
  readonly references: readonly UserReference[];
  readonly checked: readonly string[];
  readonly provisioned: readonly string[];
  readonly absent: readonly string[];
  readonly unknown: readonly string[];
  /**
   * The references that a write for an `absent` principal would refuse, i.e. the subset of
   * `references` with a live writer, non-empty only when `absent` is.
   *
   * Reported as the pairing rather than as two lists because that is the sentence an operator needs:
   * *this id, in this column, will raise.*
   */
  readonly blocked: readonly { readonly table: string; readonly column: string }[];
}

export function readinessOf(report: UserFkReadiness, principalId: string): PrincipalReadiness {
  if (report.provisioned.includes(principalId)) return "provisioned";
  if (report.absent.includes(principalId)) return "absent";
  return "unknown";
}

interface CatalogRow {
  readonly role: unknown;
  readonly table_exists: unknown;
  readonly can_select: unknown;
  readonly can_insert: unknown;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Surveys the registry against a set of principal ids.
 *
 * `principalIds` is what the deployment's own credentials name — in practice
 * `options.apiKeys.map(parseApiKeySpec).filter((s) => s.namesPrincipal).map((s) => s.principalId)`.
 * A spec that names **no** principal is deliberately excluded: since ADR-0331 it resolves as a
 * `service_account` sharing one placeholder UUID, and every per-person surface already refuses it,
 * so listing it here would name a row that must *not* be created. The per-person surfaces it is
 * refused by are the same nine writers this probe reports on, which is why the two decisions have to
 * agree.
 */
export async function surveyUserFkReadiness(
  conn: PgConnection,
  principalIds: readonly string[],
  options: { readonly schema?: string } = {},
): Promise<UserFkReadiness> {
  const schema = options.schema ?? "meta";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const checked = [...new Set(principalIds.filter((id) => UUID_RE.test(id)))].sort();

  let catalog: CatalogRow | undefined;
  let references: UserReference[] = [];
  try {
    const result = await conn.query<CatalogRow>(
      // One row, always, and no branch that can raise. `has_table_privilege`'s *name* overload
      // errors on a table that does not exist, which would make an absent registry indistinguishable
      // from an unreachable database; the **oid** overload takes `to_regclass`'s NULL and answers
      // NULL, so the absence is a value rather than an exception. A `CASE` guarding the name form
      // would read as equivalent and is not: Postgres does not promise lazy evaluation of a
      // function's arguments inside one (ADR-0334 hit exactly this with a flat `AND`).
      `SELECT current_user AS role,
              to_regclass($1) IS NOT NULL AS table_exists,
              COALESCE(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) AS can_select,
              COALESCE(has_table_privilege(current_user, to_regclass($1), 'INSERT'), false) AS can_insert`,
      [`${schema}.users`],
    );
    catalog = result.rows[0];
    if (catalog !== undefined && catalog.table_exists === true) {
      references = await loadReferences(conn, schema);
    }
  } catch (err) {
    return {
      registry: "unreachable",
      detail: `the catalog could not be read: ${err instanceof Error ? err.message : String(err)}`,
      role: "",
      canSelect: false,
      canInsert: false,
      references: [],
      checked,
      provisioned: [],
      absent: [],
      unknown: checked,
      blocked: [],
    };
  }

  const role = str(catalog?.role);
  if (catalog === undefined || catalog.table_exists !== true) {
    return {
      registry: "absent",
      detail:
        `${schema}.users does not exist, so none of the ${String(references.length)} NOT NULL ` +
        "references to it can ever be satisfied; run the migration applier",
      role,
      canSelect: false,
      canInsert: false,
      references,
      checked,
      provisioned: [],
      absent: [],
      unknown: checked,
      blocked: [],
    };
  }

  const canSelect = catalog.can_select === true;
  const canInsert = catalog.can_insert === true;
  const withWriters = references.filter((r) => r.hasLiveWriter);

  if (!canSelect) {
    return {
      registry: "unreadable",
      detail:
        `'${role}' has no SELECT privilege on ${schema}.users, so whether a principal is ` +
        "provisioned cannot be established — a zero-row answer here would be indistinguishable " +
        "from an unprovisioned id",
      role,
      canSelect,
      canInsert,
      references,
      checked,
      provisioned: [],
      absent: [],
      unknown: checked,
      blocked: [],
    };
  }

  let present: Set<string>;
  try {
    present = await loadPresent(conn, schema, checked);
  } catch (err) {
    return {
      registry: "unreachable",
      detail: `the registry could not be read: ${err instanceof Error ? err.message : String(err)}`,
      role,
      canSelect,
      canInsert,
      references,
      checked,
      provisioned: [],
      absent: [],
      unknown: checked,
      blocked: [],
    };
  }

  const provisioned = checked.filter((id) => present.has(id.toLowerCase()));
  const absent = checked.filter((id) => !present.has(id.toLowerCase()));
  return {
    registry: "readable",
    detail:
      absent.length === 0
        ? `every principal this deployment names has a ${schema}.users row`
        : `${String(absent.length)} of ${String(checked.length)} principals have no ${schema}.users ` +
          `row; ${String(withWriters.length)} written columns reference it NOT NULL and will raise 23503`,
    role,
    canSelect,
    canInsert,
    references,
    checked,
    provisioned,
    absent,
    unknown: [],
    blocked:
      absent.length === 0
        ? []
        : withWriters.map((r) => ({ table: r.table, column: r.column })),
  };
}

/**
 * Every `NOT NULL` column with a foreign key into `<schema>.users`, read from `pg_constraint`.
 *
 * Asked of the catalog rather than imported from `META_TABLES` on purpose. The question is about the
 * database this process is connected to, and a catalog that has drifted from the declaration — a
 * half-applied migration, a constraint dropped by hand — is exactly the state where a list compiled
 * into the binary would describe the wrong database. It also means a 51st reference appears here the
 * moment it is applied, with nobody updating anything.
 */
async function loadReferences(conn: PgConnection, schema: string): Promise<UserReference[]> {
  const result = await conn.query<Record<string, unknown>>(
    `SELECT c.relname AS tbl, a.attname AS col, k.confdeltype AS on_delete
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest(k.conkey) AS ck ON true
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck
      WHERE k.contype = 'f'
        AND k.confrelid = to_regclass($1)
        AND n.nspname = $2
        AND a.attnotnull
      ORDER BY c.relname, a.attname`,
    [`${schema}.users`, schema],
  );
  const writers = new Set(LIVE_USER_FK_WRITERS);
  return result.rows.map((row) => ({
    table: str(row["tbl"]),
    column: str(row["col"]),
    onDelete: ON_DELETE_CODES[str(row["on_delete"])] ?? str(row["on_delete"]),
    hasLiveWriter: writers.has(str(row["tbl"])),
  }));
}

/** `pg_constraint.confdeltype`'s single-character codes, spelled out for a log line. */
const ON_DELETE_CODES: Readonly<Record<string, string>> = Object.freeze({
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
});

async function loadPresent(
  conn: PgConnection,
  schema: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await conn.query<Record<string, unknown>>(
    `SELECT id FROM ${schema}.users WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  return new Set(result.rows.map((r) => str(r["id"]).toLowerCase()));
}

/**
 * The boot line.
 *
 * Says the absence out loud, which is the half ADR-0334 kept finding missing: a fleet that can never
 * execute anything reads exactly like an idle one, and a registry that can never be written reads
 * exactly like one nobody has needed yet. `null` when there is nothing to report, so a caller logs
 * only a finding.
 */
export function formatUserFkReadiness(report: UserFkReadiness): string | null {
  if (report.registry === "readable" && report.absent.length === 0) return null;
  const lines: string[] = [`meta.users readiness: ${report.registry} — ${report.detail}`];
  if (report.registry === "readable" && !report.canInsert) {
    lines.push(
      `  '${report.role}' has no INSERT privilege on the registry, so the provisioning routes ` +
        "cannot fix this either",
    );
  }
  for (const id of report.absent) lines.push(`  unprovisioned principal: ${id}`);
  for (const id of report.unknown) lines.push(`  undetermined principal: ${id}`);
  for (const b of report.blocked) {
    lines.push(`  will raise 23503: ${b.table}.${b.column}`);
  }
  return lines.join("\n");
}
