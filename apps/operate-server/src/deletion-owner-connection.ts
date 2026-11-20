import type { PgConfig, PgConnection } from "@crossengin/kernel-pg";
import {
  DEFAULT_TENANT_SCHEMA_PREFIX,
  isTenantSchemaName,
  tenantSchemaName,
} from "@crossengin/operate-runtime-pg";
import {
  probeErasureConfinement,
  RETAINED_SHARED_TABLES,
  type BootSchemaErasureTarget,
} from "@crossengin/tenant-lifecycle-pg";

/**
 * The connection an Article 17 deletion runs on (ADR-0453).
 *
 * The shipped API connects as `crossengin_app`, `NOSUPERUSER NOBYPASSRLS` and owning nothing
 * (ADR-0424), and on that role the erasure's own probe answers `rls_would_confine_this_session` for
 * every table it must empty — so every deletion was refused, correctly, and could never complete.
 * A per-table platform `DELETE` arm would grant the serving role the one power the confinement exists
 * to withhold. Instead the deletion pipeline gets a **separate** connection as a role RLS does not
 * confine, used for nothing but the pipeline, so the serving role stays confined for every request.
 * In the compose stack that role is `crossengin_eraser` (ADR-0458): `NOSUPERUSER BYPASSRLS`, owning
 * nothing, granted exactly what the erasure reads, deletes and appends — where ADR-0453 recommended
 * the database owner, which in the official image is a superuser.
 *
 * The credentials come from the environment and never from argv (ADR-0301): `ps` shows argv to
 * anyone on the host, and this is the most privileged credential the process holds. Only the role
 * and its password differ from the serving connection; host, port, database and the TLS mode are
 * the serving connection's own, so the two cannot point at different databases.
 */
export const DELETION_PGUSER_VAR = "DELETION_PGUSER";
export const DELETION_PGPASSWORD_VAR = "DELETION_PGPASSWORD";

/** Named so `pg_stat_activity` tells the deletion connection from the serving pool at a glance. */
export const DELETION_APPLICATION_NAME = "crossengin-deletion";

export type DeletionOwnerSource =
  | { readonly kind: "absent" }
  | { readonly kind: "configured"; readonly config: PgConfig };

/**
 * Reads the two variables. A password with no role is refused by throwing: it is a half-made
 * configuration whose intent cannot be guessed, and the cheapest place to say so is boot. A role
 * with no password is accepted, because `trust`, `peer` and `cert` authentication need none.
 */
export function resolveDeletionOwnerConfig(
  serving: PgConfig,
  env: NodeJS.ProcessEnv = process.env,
): DeletionOwnerSource {
  const user = env[DELETION_PGUSER_VAR] ?? "";
  const password = env[DELETION_PGPASSWORD_VAR] ?? "";
  if (user.length === 0) {
    if (password.length > 0) {
      throw new Error(
        `${DELETION_PGPASSWORD_VAR} is set and ${DELETION_PGUSER_VAR} is not: name the role the ` +
          "deletion pipeline connects as, or unset both",
      );
    }
    return { kind: "absent" };
  }
  return {
    kind: "configured",
    config: { ...serving, user, password, applicationName: DELETION_APPLICATION_NAME },
  };
}

/**
 * What a compromise of the process holding this credential yields, as Postgres answers it.
 *
 * - `dedicated`: no superuser attribute, no route to one, no role membership of any kind, owns no
 *   catalog table, and holds no `UPDATE` in `meta` and no `DELETE` on a retained table — the narrow
 *   role ADR-0458 provisions. Every one of those is asked, because `BYPASSRLS` makes the absence of a
 *   grant the only thing standing between this role and the retained audit trail.
 * - `superuser`: the role is a superuser (the official image's `POSTGRES_USER` is).
 * - `superuser_by_membership`: not a superuser, and a member of one. Attributes are never inherited,
 *   but a member may `SET ROLE` to the superuser and hold the attribute from then on, so this is the
 *   same blast radius with one more statement in front of it — named, because it reads as narrow.
 * - `broader`: no superuser route, and more than the erasure needs — a membership (`pg_write_all_data`,
 *   `pg_execute_server_program`, the app role…), ownership of catalog tables (a managed provider's
 *   NOSUPERUSER admin), `UPDATE` in `meta`, or `DELETE` on a table the erasure retains. Each is named.
 */
export type DeletionRolePosture = "dedicated" | "superuser" | "superuser_by_membership" | "broader";

/**
 * Whether this role can drop a per-tenant schema created **after** boot (ADR-0314): the structural
 * answer the boot snapshot of existing schemas cannot give. `not_applicable` when this deployment
 * creates none (no per-tenant manifests and no schema-erasure route).
 */
export type FutureTenantSchemas =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "droppable"; readonly owner: string }
  | { readonly kind: "undroppable"; readonly owner: string };

interface ProbedRole {
  readonly role: string;
  readonly posture: DeletionRolePosture;
  /** Whether the session can act as a database superuser, by attribute or by `SET ROLE`. */
  readonly superuser: boolean;
  /** For `broader`: what makes it so, as short phrases. Empty for every other posture. */
  readonly breadth: readonly string[];
  readonly probed: number;
  /**
   * Per-tenant schemas (`t_<hex>`, ADR-0314) owned by a role this one does not inherit, so it cannot
   * `DROP SCHEMA` them. Ownership is the only route to that privilege short of a superuser, and a
   * deletion reaching the schema eraser for such a tenant raises mid-transaction and is rolled back.
   */
  readonly undroppableSchemas: readonly string[];
  readonly futureSchemas: FutureTenantSchemas;
}

/** What boot found when it asked the erasure's own questions on the connection deletions will use. */
export type DeletionConnectionProbe =
  | ({ readonly kind: "can_complete" } & ProbedRole)
  | ({
      readonly kind: "will_refuse";
      /** Tables RLS confines on this session: `rls_would_confine_this_session`. */
      readonly confined: readonly string[];
      /** Target tables the database does not have: `table_missing`. */
      readonly missing: readonly string[];
      /** Target tables with no `tenant_id` column: `target_lacks_tenant_scope`. */
      readonly unscoped: readonly string[];
      /** Grants the pipeline needs and this role lacks: `table_privilege_missing` (ADR-0458). */
      readonly unprivileged: readonly string[];
    } & ProbedRole)
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * One statement for the role's whole breadth. `memberships` is every role this one is granted
 * directly (`pg_auth_members`, which a superuser attribute does not answer for, unlike
 * `pg_has_role`); the counts are `meta` tables it owns or inherits ownership of, may `UPDATE`, and
 * may `DELETE` from although the erasure retains them (`$1`, `RETAINED_SHARED_TABLES`).
 *
 * Retained, not merely fenced: the restrictive `FOR DELETE USING (false)` fence also covers six tables
 * a tenant must not delete and the erasure does empty (`tenantUndeletableRecord`), so the eraser must
 * hold `DELETE` there. Counting every fenced table read the provisioned role as `broader` the moment
 * it was granted what the erasure needs (measured live, ADR-0458).
 */
const ROLE_QUESTION = `SELECT current_user AS role, current_setting('is_superuser') AS superuser,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolsuper AND r.rolname <> current_user
           AND pg_has_role(current_user, r.oid, 'MEMBER')) AS superuser_member,
  (SELECT coalesce(string_agg(g.rolname, ',' ORDER BY g.rolname), '')
     FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS memberships,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND pg_has_role(c.relowner, 'USAGE')) AS owns_meta,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(c.oid, 'UPDATE')) AS updatable_meta,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND has_table_privilege(c.oid, 'DELETE')
      AND c.relname = ANY ($1::text[])) AS deletable_retained`;

const SCHEMA_QUESTION =
  "SELECT n.nspname AS schema_name, pg_has_role(n.nspowner, 'USAGE') AS droppable" +
  " FROM pg_namespace n WHERE starts_with(n.nspname, $1) ORDER BY n.nspname";

/** Whether this role inherits the privileges of the role that will create later per-tenant schemas. */
const FUTURE_SCHEMA_QUESTION =
  "SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = $1 AND pg_has_role(r.oid, 'USAGE')) AS droppable";

function yes(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === "on";
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Asks Postgres — never the role's name — whether an erasure on this connection would be refused,
 * and what holding its credential is worth.
 *
 * It runs `probeErasureConfinement`, which is the erasure's own read-only statement over the
 * erasure's own targets, so the boot answer and the deletion-time answer cannot disagree (ADR-0362).
 * That statement answers four of the erasure's refusals at once — confined, missing, unscoped and,
 * since ADR-0458, a grant the erasure needs and this role lacks — and all four are carried, because
 * "can complete" is true only when none applies.
 *
 * `opts` must be what the pipeline itself is handed. Neither `deleteTenantAtomically` call site
 * passes a `schema`, so the erasure reads `meta`, and so must this.
 *
 * The role, its superuser posture and the per-tenant schemas it cannot drop are asked too: the role a
 * connection *runs as* is a fact about the session, and the line reports that rather than the variable
 * an operator typed.
 */
export async function probeDeletionConnection(
  conn: PgConnection,
  opts: {
    readonly bootTargets?: readonly BootSchemaErasureTarget[];
    readonly tenantSchemaPrefix?: string;
    /**
     * The connection that will create per-tenant schemas after boot — the serving one — when this
     * deployment can create or erase one (`--per-tenant-manifests`, `--tenant-erasure-routes`). Its
     * role is asked inside this probe, so an unreachable database is the `unreachable` answer rather
     * than a throw at boot. Absent means none is created, and the structural question is not asked.
     */
    readonly futureSchemaCreator?: PgConnection;
  } = {},
): Promise<DeletionConnectionProbe> {
  try {
    const who = await conn.query<Record<string, unknown>>(ROLE_QUESTION, [[...RETAINED_SHARED_TABLES]]);
    const row = who.rows[0];
    const role = String(row?.["role"] ?? "?");
    const breadth: string[] = [];
    const memberships = String(row?.["memberships"] ?? "")
      .split(",")
      .filter((m) => m.length > 0);
    if (memberships.length > 0) breadth.push(`a member of ${memberships.join(", ")}`);
    const owns = count(row?.["owns_meta"]);
    if (owns > 0) breadth.push(`owns ${owns.toString()} meta table(s)`);
    const updatable = count(row?.["updatable_meta"]);
    if (updatable > 0) breadth.push(`may UPDATE ${updatable.toString()} meta table(s)`);
    const retained = count(row?.["deletable_retained"]);
    if (retained > 0) breadth.push(`may DELETE from ${retained.toString()} retained table(s)`);
    const posture: DeletionRolePosture = yes(row?.["superuser"])
      ? "superuser"
      : yes(row?.["superuser_member"])
        ? "superuser_by_membership"
        : breadth.length > 0
          ? "broader"
          : "dedicated";
    const prefix = opts.tenantSchemaPrefix ?? DEFAULT_TENANT_SCHEMA_PREFIX;
    const schemas = await conn.query<{ schema_name: unknown; droppable: unknown }>(SCHEMA_QUESTION, [
      prefix,
    ]);
    const undroppableSchemas = schemas.rows
      .map((r) => ({ schemaName: String(r.schema_name ?? ""), droppable: yes(r.droppable) }))
      .filter((r) => isTenantSchemaName(r.schemaName, prefix) && !r.droppable)
      .map((r) => r.schemaName);
    let futureSchemas: FutureTenantSchemas = { kind: "not_applicable" };
    if (opts.futureSchemaCreator !== undefined) {
      const creator = await opts.futureSchemaCreator.query<{ role: unknown }>(
        "SELECT current_user AS role",
      );
      const owner = String(creator.rows[0]?.role ?? "");
      const future = await conn.query<{ droppable: unknown }>(FUTURE_SCHEMA_QUESTION, [owner]);
      futureSchemas = {
        kind: yes(future.rows[0]?.droppable) ? "droppable" : "undroppable",
        owner,
      };
    }
    const probe = await probeErasureConfinement(
      conn,
      opts.bootTargets !== undefined ? { bootTargets: opts.bootTargets } : {},
    );
    const base: ProbedRole = {
      role,
      posture,
      superuser: posture === "superuser" || posture === "superuser_by_membership",
      breadth: posture === "broader" ? breadth : [],
      probed: probe.probed,
      undroppableSchemas,
      futureSchemas,
    };
    if (
      probe.confined.length === 0 &&
      probe.missing.length === 0 &&
      probe.unscoped.length === 0 &&
      probe.unprivileged.length === 0
    ) {
      return { kind: "can_complete", ...base };
    }
    return {
      kind: "will_refuse",
      ...base,
      confined: probe.confined,
      missing: probe.missing,
      unscoped: probe.unscoped,
      unprivileged: probe.unprivileged,
    };
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether the connection's role can `DROP SCHEMA` this tenant's per-tenant schema: true when it owns
 * or inherits the schema's owner (a superuser answers true for every role), and true when there is no
 * such schema, since an absent one is the erasure's `alreadyAbsent` answer rather than a refusal.
 * Asked per request by the schema-erasure route so a role that cannot drop it is refused by name
 * instead of a 42501 surfacing as a generic failure (ADR-0458).
 */
export async function tenantSchemaDroppable(
  conn: PgConnection,
  tenantId: string,
  prefix: string = DEFAULT_TENANT_SCHEMA_PREFIX,
): Promise<boolean> {
  const result = await conn.query<{ droppable: unknown }>(
    "SELECT pg_has_role(n.nspowner, 'USAGE') AS droppable FROM pg_namespace n WHERE n.nspname = $1",
    [tenantSchemaName(tenantId, prefix)],
  );
  const row = result.rows[0];
  return row === undefined || yes(row.droppable);
}

/** The deletion role deploy/ provisions (deploy/postgres/roles/eraser-role.sql, ADR-0458). */
export const SHIPPED_ERASER_ROLE = "crossengin_eraser";

function sampleOf(tables: readonly string[]): string {
  const more = tables.length > 3 ? ` and ${(tables.length - 3).toString()} more` : "";
  return `${tables.slice(0, 3).join(", ")}${more}`;
}

function postureSaid(probe: ProbedRole): string {
  switch (probe.posture) {
    case "dedicated":
      return "";
    case "superuser":
      return " (a SUPERUSER)";
    case "superuser_by_membership":
      return " (a member of a SUPERUSER role, which it can SET ROLE to)";
    case "broader":
      return ` (broader than the erasure needs: ${probe.breadth.join("; ")})`;
  }
}

/**
 * What the per-tenant schemas cost, said structurally where the deployment can create one after boot
 * and as a snapshot of the existing ones where it cannot. The two surfaces fail differently and are
 * named apart: the schema-erasure route answers `schema_not_droppable`, while a deletion reaching the
 * schema eraser rolls back after the shared erasure and stays `in_progress` for reconciliation.
 */
function schemaClause(probe: ProbedRole): string {
  const consequence =
    "so --tenant-erasure-routes answers schema_not_droppable for such a tenant, and a deletion " +
    "reaching the schema eraser for one rolls back and stays in_progress for reconciliation; a role " +
    "that can drop them is their owner or a superuser, and making this role a member of their owner " +
    "would give it that owner's every other object too";
  if (probe.futureSchemas.kind === "undroppable") {
    return (
      `; it can drop no per-tenant schema: they are created by ${probe.futureSchemas.owner}, which it ` +
      `neither is nor inherits${
        probe.undroppableSchemas.length > 0
          ? ` (${probe.undroppableSchemas.length.toString()} exist now: ${sampleOf(probe.undroppableSchemas)})`
          : ""
      }, ${consequence}`
    );
  }
  if (probe.undroppableSchemas.length === 0) return "";
  return (
    `; it cannot DROP ${probe.undroppableSchemas.length.toString()} per-tenant schema(s) another role ` +
    `owns (${sampleOf(probe.undroppableSchemas)}), ${consequence}`
  );
}

/**
 * The `[deletion]` boot line: which role the erasure runs as, what holding it is worth, and whether a
 * deletion can complete there (ADR-0453, ADR-0458).
 *
 * Said either way, including when everything is fine, because the failure it guards against is a
 * deployment that discovers its deletions cannot run only when a data subject's Article 12(3) clock
 * is already running. Four outcomes: a **dedicated** role that can complete is info; a **superuser**
 * one that can complete is a warn naming the cost, since the compose documentation no longer
 * recommends it; a role that **will refuse** is a warn naming each cause and its remedy; and an
 * **unreachable** probe is a warn that asserts nothing.
 */
export function formatDeletionConnectionLine(
  source: DeletionOwnerSource["kind"],
  probe: DeletionConnectionProbe,
): { readonly level: "info" | "warn"; readonly line: string } {
  const on =
    source === "configured"
      ? `on its own connection (${DELETION_PGUSER_VAR})`
      : `on the serving connection (${DELETION_PGUSER_VAR} unset)`;
  if (probe.kind === "unreachable") {
    return {
      level: "warn",
      line:
        `Article 17 erasure runs ${on}; whether it can complete could not be checked at boot ` +
        `(${probe.detail}) — a deletion that cannot connect stays in_progress for reconciliation`,
    };
  }
  const as = `${probe.role}${postureSaid(probe)}`;
  const undroppable = schemaClause(probe);
  if (probe.kind === "can_complete") {
    // The cost is named only for a credential this process holds for the pipeline alone: on the
    // serving connection the whole process already runs as it, which `[pg]` says on its own line.
    const costly = probe.posture !== "dedicated" && source === "configured";
    // Naming the dedicated role as the remedy is wrong when the role already is that one and has
    // drifted (a membership granted by hand): the remedy then is the step that refuses and names it.
    const remedy =
      probe.role === SHIPPED_ERASER_ROLE
        ? `re-run the eraser-role step, which refuses ${SHIPPED_ERASER_ROLE} while it holds that ` +
          "and names what to REVOKE"
        : probe.superuser
          ? `the dedicated ${SHIPPED_ERASER_ROLE} role (NOSUPERUSER BYPASSRLS, deploy/README.md) runs the same erasure`
          : `the dedicated ${SHIPPED_ERASER_ROLE} role (deploy/README.md) holds none of it`;
    const blast = !costly
      ? ""
      : probe.superuser
        ? "; this process holds a superuser credential, so a compromise of it yields the whole " +
          `database server, not only the ability to bypass row-level security — ${remedy}`
        : "; this process holds a BYPASSRLS credential with more than the erasure uses, and with " +
          "row-level security bypassed the absence of a grant is the only protection the retained " +
          `audit trail has — ${remedy}`;
    const kind = probe.posture === "dedicated" && source === "configured" ? "a dedicated role, " : "";
    return {
      level: costly || undroppable.length > 0 ? "warn" : "info",
      line:
        `Article 17 erasure runs as ${as} ${on}: ${kind}every one of its ${probe.probed.toString()} ` +
        `target tables is present, scoped, granted and unconfined, so a deletion can complete` +
        `${blast}${undroppable}`,
    };
  }
  // Every reason the erasure itself will give — it reports them together from this one probe — each
  // with its own remedy, since setting the deletion role fixes only the confinement.
  const parts: string[] = [];
  if (probe.missing.length > 0) {
    parts.push(
      `${probe.missing.length.toString()} target table(s) are missing (${sampleOf(probe.missing)}), ` +
        "refused table_missing — reconcile the schema (crossengin apply)",
    );
  }
  if (probe.unscoped.length > 0) {
    parts.push(
      `${probe.unscoped.length.toString()} have no tenant_id column (${sampleOf(probe.unscoped)}), ` +
        "refused target_lacks_tenant_scope — reconcile the schema",
    );
  }
  if (probe.unprivileged.length > 0) {
    parts.push(
      `${probe.unprivileged.length.toString()} grant(s) are missing (${sampleOf(probe.unprivileged)}), ` +
        "refused table_privilege_missing — re-run docker compose up -d, whose eraser-role step " +
        "re-grants every table migrate created, or grant them by hand",
    );
  }
  if (probe.confined.length > 0) {
    parts.push(
      `row-level security confines ${probe.confined.length.toString()} (${sampleOf(probe.confined)}), ` +
        `refused rls_would_confine_this_session — set ${DELETION_PGUSER_VAR} and ` +
        `${DELETION_PGPASSWORD_VAR} to a role row-level security does not confine, which the ` +
        "deletion pipeline alone connects as",
    );
  }
  return {
    level: "warn",
    line:
      `Article 17 erasure runs as ${as} ${on} and every deletion will be refused, of ` +
      `${probe.probed.toString()} target tables: ${parts.join("; ")}. Each refused request is ` +
      `released back to verified with its reason recorded, and retried once the cause is fixed` +
      undroppable,
  };
}
