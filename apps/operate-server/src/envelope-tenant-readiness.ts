import type { PgConnection } from "@crossengin/kernel-pg";

import { COLUMN_KEY_MODE_FLAG } from "./data-key-envelope.js";

/**
 * Whether the tenant ids this deployment's credentials name have a `meta.tenants` row — asked at
 * boot, because under `--column-key-mode envelope` the alternative is finding out at the first PHI
 * request.
 *
 * ## The failure this exists to make legible
 *
 * `meta.tenant_data_keys.tenant_id` carries `FOREIGN KEY (tenant_id) REFERENCES meta.tenants(id)
 * ON DELETE CASCADE`, added deliberately by ADR-0347 on the stated rule that this is "the one table
 * whose *survival* defeats its own purpose", since a wrapped key outliving its tenant is a key
 * nobody destroyed. The consequence nobody checked is the contrapositive: **a tenant with no
 * `meta.tenants` row cannot have a data key at all**, so envelope mode is unusable for it.
 *
 * Measured live as a non-owner role on PG 16: a deployment booted with `--column-key-mode envelope`
 * and `--api-key 'ka:clinician:<uuid>'` accepted the boot, logged `column key mode: envelope`, and
 * then answered **every** PHI read and write with
 *
 * ```
 * insert or update on table "tenant_data_keys" violates foreign key constraint
 * "tenant_data_keys_tenant_id_fkey"
 * ```
 *
 * surfaced to the client as an HTTP **504** — a retryable status for a permanent configuration
 * fault, so a client's own retry can never succeed and the deployment reads as a slow database
 * rather than a misconfigured one. `--api-key 'key:role:tenant'` names an arbitrary UUID that
 * nothing requires to exist, and ADR-0334's own boot survey established that such tenants have no
 * `meta.tenants` row in any dev deployment. So the unusability is silent until the first PHI
 * request, which is the shape `surveyUserFkReadiness` exists to end one table across.
 *
 * ## Why three states and not two
 *
 * `SELECT count(*) FROM meta.tenants WHERE id = $1` answering 0 has **two** meanings: the row is
 * absent, or this role cannot read the table. So the probe asks `pg_class` whether the table exists
 * and `has_table_privilege` whether this role may `SELECT` it, and only *then* reads the ids — and
 * when it may not read, every tenant answers `unknown` rather than `missing`.
 *
 * That is the asymmetry `surveyUserFkReadiness` draws between `absent` and `unknown`, and
 * `surveyTenantStatusCoverage` between `missing` and `unreachable`: one names a thing an operator
 * must create, the other names a thing this probe could not see. Printing the first when the second
 * is true prints a list of tenants that are fine — and here the cost of that mistake is an operator
 * talked out of envelope mode by a list of tenants that would have worked.
 *
 * `INSERT` privilege is deliberately **not** probed, where the `meta.users` sibling does probe it.
 * There, provisioning was the only remedy, so a role that could read and not write had nothing to
 * do with the finding. Here the second remedy — `--column-key-mode derived`, which stores no row
 * and so has no foreign key to satisfy — is available whatever this role may do to `meta.tenants`,
 * so an INSERT probe would qualify neither verdict nor remedy.
 *
 * ## What it cannot see
 *
 * The JWT path. A JWT deployment presents whatever tenant the request's `x-tenant-id` header names
 * and `principalFromJwtClaims` takes it as given, so the api-key specs are **not** the population of
 * tenants this deployment will serve — they are the subset known at boot. A tenant arriving over a
 * JWT is surveyed by nothing and meets the same foreign key. That is why this reports and does not
 * refuse: a boot refusal built on an incomplete population would refuse deployments that work and
 * still admit the ones that do not.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The constraint the operator will have in their log, spelled here so the boot line and the
 * database agree on one string.
 *
 * Derived by Postgres rather than chosen by the catalog: the emitter writes column-level foreign
 * keys inline and unnamed, so Postgres names this one `<table>_<column>_fkey`. A test pins the
 * three parts against `META_TABLES`, so a catalog edit that moves the reference fails there rather
 * than leaving this line naming a constraint that no longer exists.
 */
export const DATA_KEY_TENANT_FK = "tenant_data_keys_tenant_id_fkey";

export const ENVELOPE_TENANT_STATES = [
  /** A `meta.tenants` row holds this id, so a data key row for it can be inserted. */
  "provisioned",
  /** No row holds it: every PHI read and write for this tenant is refused by the foreign key. */
  "missing",
  /** Could not be established — the table was absent, unreadable or unreachable. */
  "unknown",
] as const;
export type EnvelopeTenantState = (typeof ENVELOPE_TENANT_STATES)[number];

export interface EnvelopeTenantVerdict {
  readonly tenantId: string;
  readonly state: EnvelopeTenantState;
}

export interface EnvelopeTenantReadiness {
  /** Every id asked about, sorted, each with its verdict. */
  readonly tenants: readonly EnvelopeTenantVerdict[];
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  /** Why the probe could not read, when it could not. `null` when the verdicts mean something. */
  readonly unreadableReason: string | null;
}

/**
 * One tenant's verdict, answering `unknown` for an id the survey never asked about.
 *
 * `unknown` and not `missing` for the same reason the enum has three members: an id outside
 * `tenants` was not found absent, it was not looked for.
 */
export function envelopeTenantStateOf(
  report: EnvelopeTenantReadiness,
  tenantId: string,
): EnvelopeTenantState {
  return report.tenants.find((t) => t.tenantId === tenantId)?.state ?? "unknown";
}

interface CatalogRow {
  readonly table_exists: unknown;
  readonly can_select: unknown;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Every id `unknown`, **including a malformed one**, although a non-UUID is unsatisfiable by the
 * column's type alone and so could be called `missing` without any read. It is not, because this
 * report's verdicts are what the probe *established*, and a report mixing one established verdict
 * into a set of unestablished ones is the conflation the three states exist to prevent — read by an
 * operator as "we checked, and this is the one that is wrong".
 */
function allUnknown(
  ids: readonly string[],
  unreadableReason: string,
): EnvelopeTenantReadiness {
  return {
    tenants: ids.map((tenantId) => ({ tenantId, state: "unknown" as const })),
    missing: [],
    unknown: [...ids],
    unreadableReason,
  };
}

/**
 * Surveys `<schema>.tenants` against the tenant ids this deployment's credentials name — in
 * practice `options.apiKeys.map(parseApiKeySpec).map((s) => s.tenantId)`.
 *
 * Every id is reported, including a **non-UUID** one, which is the one place this departs from
 * `surveyUserFkReadiness`'s input handling. That function drops a non-UUID principal id silently;
 * here dropping would hide a tenant that is *certainly* broken, because `meta.tenants.id` is `UUID`
 * so no row can ever hold a non-UUID value. It is also why such an id must not reach the read: a
 * single malformed element makes `$1::uuid[]` raise `22P02`, which would turn one broken spec into
 * `unknown` for every other tenant — the answer this probe exists to avoid. So it is classified
 * `missing` without being asked about, and the formatter gives it its own remedy, since correcting
 * a spec and provisioning a tenant are different acts.
 */
export async function surveyEnvelopeTenantReadiness(
  conn: PgConnection,
  tenantIds: readonly string[],
  opts: { readonly schema?: string } = {},
): Promise<EnvelopeTenantReadiness> {
  const schema = opts.schema ?? "meta";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const checked = [...new Set(tenantIds.filter((id) => id.length > 0))].sort();
  const askable = checked.filter((id) => UUID_RE.test(id));
  const malformed = new Set(checked.filter((id) => !UUID_RE.test(id)));

  let catalog: CatalogRow | undefined;
  try {
    const result = await conn.query<CatalogRow>(
      // One row, always, and no branch that can raise. `has_table_privilege`'s *name* overload
      // errors on a table that does not exist, which would make an absent table indistinguishable
      // from an unreachable database; the **oid** overload takes `to_regclass`'s NULL and answers
      // NULL, so the absence is a value rather than an exception.
      `SELECT to_regclass($1) IS NOT NULL AS table_exists,
              COALESCE(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) AS can_select`,
      [`${schema}.tenants`],
    );
    catalog = result.rows[0];
  } catch (err) {
    return allUnknown(
      checked,
      `the catalog could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (catalog === undefined || catalog.table_exists !== true) {
    return allUnknown(
      checked,
      `${schema}.tenants does not exist, so no tenant can satisfy ${DATA_KEY_TENANT_FK} and ` +
        `whether any particular tenant is provisioned cannot be established; run the migration applier`,
    );
  }
  if (catalog.can_select !== true) {
    return allUnknown(
      checked,
      `this role has no SELECT privilege on ${schema}.tenants, so whether a tenant is provisioned ` +
        `cannot be established — a zero-row answer here would be indistinguishable from an ` +
        `unprovisioned tenant`,
    );
  }

  let present: Set<string>;
  try {
    present = await loadPresent(conn, schema, askable);
  } catch (err) {
    return allUnknown(
      checked,
      `${schema}.tenants could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tenants = checked.map((tenantId) => ({
    tenantId,
    state:
      !malformed.has(tenantId) && present.has(tenantId.toLowerCase())
        ? ("provisioned" as const)
        : ("missing" as const),
  }));
  return {
    tenants,
    missing: tenants.filter((t) => t.state === "missing").map((t) => t.tenantId),
    unknown: [],
    unreadableReason: null,
  };
}

async function loadPresent(
  conn: PgConnection,
  schema: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // The ids are **bound**, never interpolated: they come from argv and the only identifier in this
  // statement is the schema, which `SCHEMA_RE` has already admitted.
  const result = await conn.query<Record<string, unknown>>(
    `SELECT id FROM ${schema}.tenants WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  return new Set(result.rows.map((r) => str(r["id"]).toLowerCase()));
}

/**
 * The boot line, under `--column-key-mode envelope`.
 *
 * `null` when every named tenant is provisioned, so a caller logs only a finding. The message names
 * the **consequence** and the **remedy** rather than the condition: a line reading "tenant X has no
 * meta.tenants row" is true and tells an operator neither what will break nor what to do, and this
 * failure's symptom — a 504 — actively points away from configuration.
 */
export function formatEnvelopeTenantReadiness(report: EnvelopeTenantReadiness): string | null {
  if (report.unreadableReason === null && report.missing.length === 0) return null;
  const lines: string[] = [];
  if (report.unreadableReason !== null) {
    lines.push(`envelope tenant readiness: unknown — ${report.unreadableReason}`);
  } else {
    lines.push(
      `envelope tenant readiness: ${String(report.missing.length)} of ` +
        `${String(report.tenants.length)} named tenants have no meta.tenants row`,
    );
  }
  for (const tenantId of report.missing) {
    lines.push(
      UUID_RE.test(tenantId)
        ? `  unprovisioned tenant: ${tenantId}`
        : `  malformed tenant id (meta.tenants.id is UUID, so no row can hold it): ${tenantId}`,
    );
  }
  for (const tenantId of report.unknown) lines.push(`  undetermined tenant: ${tenantId}`);
  // The consequence, stated once and in full, because every part of it is counter-intuitive: the
  // failure is on a key-management table the request never names, it reaches reads as well as
  // writes, and the status invites the one response that cannot work.
  lines.push(
    `  consequence: under ${COLUMN_KEY_MODE_FLAG} envelope every PHI read and write for such a ` +
      `tenant is refused by ${DATA_KEY_TENANT_FK}, because the wrapped data key is a row whose ` +
      `tenant_id references meta.tenants(id) — the client sees an HTTP 504, a retryable status for ` +
      `a permanent fault, so retrying can never succeed`,
  );
  lines.push(
    `  remedy: point the credential at a tenant provisioned through POST /v1/platform/tenants ` +
      `(--platform-admin-role, or the console's tenant provisioning, which mints the id), or run ` +
      `${COLUMN_KEY_MODE_FLAG} derived, which stores no row and so has no foreign key to satisfy`,
  );
  if (report.unreadableReason !== null) {
    // Said only on this arm: an operator who reads "tenants are missing" acts, and an operator who
    // reads "we could not look" must not be sent after a list this probe did not produce.
    lines.push(
      `  note: no tenant was found missing — this probe could not establish any verdict, so the ` +
        `remedy above applies only to whatever a direct read of meta.tenants reports`,
    );
  }
  lines.push(
    `  not surveyed: tenants arriving over JWT, whose id comes from the request rather than from ` +
      `--api-key, so this list is a lower bound`,
  );
  return lines.join("\n");
}
