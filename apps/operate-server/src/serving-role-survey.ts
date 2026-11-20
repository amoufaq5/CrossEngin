import {
  parseSessionPolicyVisibility,
  SESSION_POLICY_VISIBILITY_COLUMNS,
  sessionPolicyVisibilityReason,
  type PgConnection,
  type SessionPolicyVisibilityRow,
} from "@crossengin/kernel-pg";

/**
 * Whether the role the serving process connected as is confined by the catalog's row-level security.
 *
 * Every isolation policy in `META_TABLES` is inert for a session that is a superuser, holds
 * `BYPASSRLS`, or owns the table — and the shipped compose stack connected the API as the image's
 * `POSTGRES_USER`, which is all three. Tenant isolation then rested on the stores' own `tenant_id`
 * predicates alone (which hold, measured), and the 115 isolation arms, the eighteen `DELETE` fences
 * and every platform grant were declarations no statement consulted. Nothing said so at boot.
 *
 * The verdict is Postgres's own, `row_security_active`, read per table through the one select list
 * the confinement fences share (`SESSION_POLICY_VISIBILITY_COLUMNS`), so this cannot come to compose
 * the rule differently from them (ADR-0362). It **reports and never refuses**: every deployment that
 * predates the role split runs this way and its answers are correct, so a refusal would break a
 * working deployment to protect a second belt (ADR-0338's rule read the other way).
 */
export const SERVING_ROLE_VERDICTS = [
  /** Every row-level-security table in the surveyed schemas applies its policies to this session. */
  "confined",
  /** At least one does not. */
  "bypasses_rls",
  /** The surveyed schemas hold no row-level-security table, so there was nothing to ask. */
  "no_policied_tables",
  /** The probe itself failed; nothing was established. */
  "unreadable",
] as const;
export type ServingRoleVerdict = (typeof SERVING_ROLE_VERDICTS)[number];

/** Why a table's policies do not apply to this session, as the remedy differs per cause. */
export const SERVING_ROLE_BYPASS_CAUSES = ["superuser", "bypassrls", "owner", "exempt"] as const;
export type ServingRoleBypassCause = (typeof SERVING_ROLE_BYPASS_CAUSES)[number];

export interface ServingRoleSurvey {
  readonly verdict: ServingRoleVerdict;
  /**
   * Every schema whose tables hold tenant rows for this deployment: `meta` always, and on
   * `--store pg-columns` the entity schema too. The entity tables are the ones that schema's store
   * creates at boot, so the serving role owns them by construction; surveying `meta` alone would
   * answer "confined" for a process whose every record read bypasses its policies.
   */
  readonly schemas: readonly string[];
  /** `null` when the probe returned no row to read it from. */
  readonly role: string | null;
  readonly policiedTables: number;
  readonly bypassedTables: number;
  /** Per cause, counted over the bypassed tables only. */
  readonly causes: Readonly<Record<ServingRoleBypassCause, number>>;
  /** The probe's error, for `unreadable` alone. */
  readonly detail: string | null;
}

interface ServingRoleRow extends SessionPolicyVisibilityRow {
  readonly is_superuser: unknown;
}

const SERVING_ROLE_QUERY = `
  SELECT ${SESSION_POLICY_VISIBILITY_COLUMNS},
         COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND c.relrowsecurity
`;

function noCauses(): Record<ServingRoleBypassCause, number> {
  return { superuser: 0, bypassrls: 0, owner: 0, exempt: 0 };
}

export async function surveyServingRole(
  conn: PgConnection,
  schemas: readonly string[],
): Promise<ServingRoleSurvey> {
  const causes = noCauses();
  let policied = 0;
  let bypassed = 0;
  let role: string | null = null;
  try {
    const rows = (await conn.query<ServingRoleRow>(SERVING_ROLE_QUERY, [[...schemas]])).rows;
    for (const row of rows) {
      // Inside the `try`: an unreadable verdict is a report of `unreadable`, never a boot failure
      // and never a default — the kernel's parse refuses to read it as "not confined".
      const v = parseSessionPolicyVisibility(row);
      role = v.role;
      policied += 1;
      if (v.policiesActive) continue;
      bypassed += 1;
      // Superuser first: the official image's `POSTGRES_USER` is superuser *and* `BYPASSRLS`, and
      // dropping only the second leaves it unconfined (ADR-0401), so naming the second would send
      // an operator to a remedy that changes nothing.
      if (row.is_superuser === true) causes.superuser += 1;
      else {
        const reason = sessionPolicyVisibilityReason(v);
        if (reason === "role_bypasses_rls") causes.bypassrls += 1;
        else if (reason === "owner_exempt") causes.owner += 1;
        else causes.exempt += 1;
      }
    }
  } catch (err) {
    return {
      verdict: "unreadable",
      schemas,
      role,
      policiedTables: 0,
      bypassedTables: 0,
      causes: noCauses(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    verdict: policied === 0 ? "no_policied_tables" : bypassed > 0 ? "bypasses_rls" : "confined",
    schemas,
    role,
    policiedTables: policied,
    bypassedTables: bypassed,
    causes,
    detail: null,
  };
}

/** `confined` alone is healthy; the other three each want an operator's eye. */
export const SERVING_ROLE_VERDICT_IS_HEALTHY: Readonly<Record<ServingRoleVerdict, boolean>> = {
  confined: true,
  bypasses_rls: false,
  no_policied_tables: false,
  unreadable: false,
};

const CAUSE_PHRASE: Readonly<Record<ServingRoleBypassCause, string>> = {
  superuser: "it is a superuser",
  bypassrls: "it holds BYPASSRLS",
  owner: "it owns them",
  exempt: "Postgres exempts it and no catalog fact read here says why",
};

const REMEDY =
  "connect the API as a role that is NOSUPERUSER, NOBYPASSRLS and owns no table here — on the" +
  " compose stack that is POSTGRES_APP_USER, created by the app-role step (deploy/README.md," +
  ' "The database roles")';

export interface ServingRoleLine {
  readonly level: "info" | "warn";
  readonly text: string;
}

/**
 * The `[pg]` boot line. `erasureDeclared` adds the one consequence of a **confined** session an
 * operator will otherwise meet later: the Article 17 shared-table erasure refuses
 * `rls_would_confine_this_session` by design, because a confined `DELETE` reports zero rows while the
 * rows remain, so a deployment declaring deletion capabilities on a confined role has a deletion
 * surface that refuses every deletion.
 */
export function formatServingRoleSurvey(
  survey: ServingRoleSurvey,
  erasureDeclared: boolean,
): readonly ServingRoleLine[] {
  const who = survey.role === null ? "the serving role" : `role ${survey.role}`;
  const where = `${survey.schemas.length === 1 ? "schema" : "schemas"} ${survey.schemas.join(", ")}`;
  const level = SERVING_ROLE_VERDICT_IS_HEALTHY[survey.verdict] ? "info" : "warn";
  const lines: ServingRoleLine[] = [];
  const say = (lvl: "info" | "warn", text: string): void => {
    lines.push({ level: lvl, text });
  };
  switch (survey.verdict) {
    case "confined":
      say(
        level,
        `[pg] row-level security: ${who} is confined on all ${survey.policiedTables.toString()}` +
          ` policied table(s) in ${where} — the isolation policies apply beside the` +
          " stores' tenant_id predicates",
      );
      if (erasureDeclared) {
        say(
          "warn",
          "[pg] deletion capabilities are declared and this session is confined, so the Article 17" +
            " shared-table erasure will refuse every deletion with rls_would_confine_this_session" +
            " (a confined DELETE reports 0 rows while they remain); set DELETION_PGUSER and" +
            " DELETION_PGPASSWORD to the database owner so the deletion pipeline alone runs" +
            " unconfined (ADR-0453) — deploy/README.md, \"The database roles\"",
        );
      }
      break;
    case "bypasses_rls": {
      const why = SERVING_ROLE_BYPASS_CAUSES.filter((c) => survey.causes[c] > 0)
        .map((c) => `${CAUSE_PHRASE[c]} (${survey.causes[c].toString()})`)
        .join("; ");
      say(
        level,
        `[pg] row-level security: ${who} BYPASSES the policies on` +
          ` ${survey.bypassedTables.toString()} of ${survey.policiedTables.toString()} policied` +
          ` table(s) in ${where} — ${why}. Tenant isolation rests on the stores'` +
          ` tenant_id predicates alone, and no isolation policy, DELETE fence or platform grant is` +
          ` consulted. Remedy: ${REMEDY}`,
      );
      break;
    }
    case "no_policied_tables":
      say(
        level,
        `[pg] row-level security: no row-level-security table in ${where}, so` +
          " whether this session is confined was not asked — has the catalog been applied to it?",
      );
      break;
    case "unreadable":
      say(
        level,
        `[pg] row-level security: could not be surveyed (${survey.detail ?? "no detail"}); nothing` +
          " was established about whether this session is confined",
      );
      break;
  }
  return lines;
}
