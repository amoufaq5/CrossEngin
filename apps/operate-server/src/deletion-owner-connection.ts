import type { PgConfig, PgConnection } from "@crossengin/kernel-pg";
import {
  probeErasureConfinement,
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
 * confine — in the compose stack, the database owner its one-shot steps already run as — used for
 * nothing but the pipeline, so the serving role stays confined for every request.
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

/** What boot found when it asked the erasure's own questions on the connection deletions will use. */
export type DeletionConnectionProbe =
  | {
      readonly kind: "can_complete";
      readonly role: string;
      /** Whether the session is a database superuser — a fact about its blast radius, not its reach. */
      readonly superuser: boolean;
      readonly probed: number;
    }
  | {
      readonly kind: "will_refuse";
      readonly role: string;
      readonly superuser: boolean;
      readonly probed: number;
      /** Tables RLS confines on this session: `rls_would_confine_this_session`. */
      readonly confined: readonly string[];
      /** Target tables the database does not have: `table_missing`. */
      readonly missing: readonly string[];
      /** Target tables with no `tenant_id` column: `target_lacks_tenant_scope`. */
      readonly unscoped: readonly string[];
    }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * Asks Postgres — never the role's name — whether an erasure on this connection would be refused.
 *
 * It runs `probeErasureConfinement`, which is the erasure's own read-only `row_security_active`
 * statement over the erasure's own targets, so the boot answer and the deletion-time answer cannot
 * disagree (ADR-0362: a second spelling of a confinement rule was measured wrong on 2 of 8
 * sessions). That statement answers three of the erasure's refusals at once — confined, missing and
 * unscoped — and all three are carried, because "can complete" is true only when none applies: an
 * unmigrated database is refused `table_missing` on every deletion however unconfined its role.
 *
 * `opts` must be what the pipeline itself is handed. Neither `deleteTenantAtomically` call site
 * passes a `schema`, so the erasure reads `meta`, and so must this — a `--schema` threaded here and
 * not there would probe one schema and delete from another.
 *
 * `current_user` and `is_superuser` are asked too: the role a connection *runs as* is a fact about
 * the session, and the line should report it rather than the variable an operator typed — and
 * whether that role is a superuser is what a compromise of this process would yield.
 */
export async function probeDeletionConnection(
  conn: PgConnection,
  opts: { readonly bootTargets?: readonly BootSchemaErasureTarget[] } = {},
): Promise<DeletionConnectionProbe> {
  try {
    const who = await conn.query<{ role: unknown; superuser: unknown }>(
      "SELECT current_user AS role, current_setting('is_superuser') AS superuser",
    );
    const role = String(who.rows[0]?.role ?? "?");
    const superuser = who.rows[0]?.superuser === "on";
    const probe = await probeErasureConfinement(
      conn,
      opts.bootTargets !== undefined ? { bootTargets: opts.bootTargets } : {},
    );
    if (probe.confined.length === 0 && probe.missing.length === 0 && probe.unscoped.length === 0) {
      return { kind: "can_complete", role, superuser, probed: probe.probed };
    }
    return {
      kind: "will_refuse",
      role,
      superuser,
      probed: probe.probed,
      confined: probe.confined,
      missing: probe.missing,
      unscoped: probe.unscoped,
    };
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

function sampleOf(tables: readonly string[]): string {
  const more = tables.length > 3 ? ` and ${(tables.length - 3).toString()} more` : "";
  return `${tables.slice(0, 3).join(", ")}${more}`;
}

/**
 * The `[deletion]` boot line: which role the erasure runs as and whether it can complete there.
 *
 * Said either way, including when everything is fine, because the failure it guards against is a
 * deployment that discovers its deletions cannot run only when a data subject's Article 12(3) clock
 * is already running. A superuser role is named as such on the success line too: it is the value the
 * compose documentation recommends, and the operator should read what that costs where they read
 * that it works.
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
  const as = `${probe.role}${probe.superuser ? " (a SUPERUSER)" : ""}`;
  if (probe.kind === "can_complete") {
    const blast =
      probe.superuser && source === "configured"
        ? "; this process holds a superuser credential, so a compromise of it yields the whole " +
          "database server, not only the ability to bypass row-level security (deploy/README.md)"
        : "";
    return {
      level: "info",
      line:
        `Article 17 erasure runs as ${as} ${on}: every one of its ${probe.probed.toString()} ` +
        `target tables is present, scoped and unconfined, so a deletion can complete${blast}`,
    };
  }
  // Every reason the erasure itself will give — it reports all three together from this one probe —
  // each with its own remedy, since setting the deletion role fixes only the last.
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
      "released back to verified with its reason recorded, and retried once the cause is fixed",
  };
}
