import { META_TABLES } from "@crossengin/kernel/bootstrap";
import { CHECK_CONSTRAINT_QUERY, type PgConnection } from "@crossengin/kernel-pg";
import { LEGACY_PEPPER_VERSION } from "@crossengin/crypto";

import { sampleKeyedPasswordHash } from "./credential-auth-env.js";

/**
 * Whether a live database will store the password hashes this deployment writes (ADR-0479).
 *
 * A hash written under pepper version N > 1 carries a `k<N>$` segment, and the catalog's
 * `meta.users.credential_hash` CHECK admits it — but a database applied before that segment existed
 * carries the older pattern, and the reconciler does **not** plan the widening: a pattern CHECK is a
 * shape `predicate_implied_by` cannot see through, so it is reported `constraint_widening_unproven`
 * and left to an operator (ADR-0363). Rotating the pepper on such a database turns every password
 * set and every login re-hash into a `23514`. The catalog admission survey cannot see it either,
 * because a pattern CHECK has no declared candidate and reads `not_probeable` there — so this module
 * supplies the one candidate that matters and asks the **live** predicate, never a reading of it.
 *
 * It issues no write: the evaluation runs in a `READ ONLY` transaction with a savepoint per
 * constraint, `surveyCheckAdmission`'s fence, because a CHECK can call a volatile function.
 */
export const CREDENTIAL_HASH_ADMISSION_VERDICTS = [
  /** The legacy version writes no `k$` segment, so there is nothing new for the CHECK to admit. */
  "not_applicable",
  /** Every live CHECK on the column admits the sample. */
  "admits",
  /** At least one live CHECK refuses it: every write under this pepper version would be `23514`. */
  "refuses",
  /** The column carries no live CHECK — it refuses nothing, and the catalog declares one. */
  "unconstrained",
  /** Nothing could be asked: the table or column is absent, or the read itself failed. */
  "unreadable",
] as const;
export type CredentialHashAdmissionVerdict = (typeof CREDENTIAL_HASH_ADMISSION_VERDICTS)[number];

/**
 * Whether a boot may proceed on each verdict. A total map so a sixth verdict is a compile error at
 * the one place that decides. Only `refuses` stops the boot: it is the one verdict whose
 * consequence is certain (every write under this pepper fails) and whose remedy is known (the
 * `ALTER` pair below). `unreadable` warns rather than refusing, ADR-0334's
 * missing-versus-unreachable rule — at boot the database may simply not be up yet.
 */
export const CREDENTIAL_HASH_ADMISSION_MAY_SERVE: Readonly<
  Record<CredentialHashAdmissionVerdict, boolean>
> = Object.freeze({
  not_applicable: true,
  admits: true,
  refuses: false,
  unconstrained: true,
  unreadable: true,
});

export interface CredentialHashAdmission {
  readonly verdict: CredentialHashAdmissionVerdict;
  readonly pepperVersion: number;
  /** The live constraints that refused the sample, by name. */
  readonly refusing: readonly string[];
  readonly detail: string;
}

const COLUMN = "credential_hash";
const TABLE = "users";
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/** The catalog's own expression for the column, so the remedy restores what the catalog declares. */
export function declaredCredentialHashCheck(): string {
  const table = META_TABLES.find((t) => t.schema === "meta" && t.name === TABLE);
  const column = table?.columns.find((c) => c.name === COLUMN);
  if (column?.check === undefined) {
    throw new Error("the catalog declares no CHECK on meta.users.credential_hash");
  }
  return column.check;
}

interface LiveCheckRow {
  readonly table_name: unknown;
  readonly constraint_name: unknown;
  readonly expression: unknown;
  readonly columns: unknown;
}

export async function probeCredentialHashAdmission(
  conn: PgConnection,
  input: { readonly schema: string; readonly pepperVersion: number },
): Promise<CredentialHashAdmission> {
  const { schema, pepperVersion } = input;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const base = { pepperVersion, refusing: [] as string[] };
  if (pepperVersion === LEGACY_PEPPER_VERSION) {
    return {
      ...base,
      verdict: "not_applicable",
      detail: "the legacy pepper version writes no k$ segment, so the stored-hash CHECK has nothing new to admit",
    };
  }
  const sample = sampleKeyedPasswordHash(pepperVersion);
  try {
    return await conn.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      const live = (await tx.query<LiveCheckRow>(CHECK_CONSTRAINT_QUERY, [schema])).rows.filter(
        (r) =>
          String(r.table_name) === TABLE &&
          Array.isArray(r.columns) &&
          r.columns.length === 1 &&
          r.columns[0] === COLUMN,
      );
      if (live.length === 0) {
        return {
          ...base,
          verdict: "unconstrained" as const,
          detail: `${schema}.${TABLE}.${COLUMN} carries no live CHECK, so it refuses nothing; the catalog declares one`,
        };
      }
      const refusing: string[] = [];
      for (const row of live) {
        const expression = typeof row.expression === "string" ? row.expression : null;
        if (expression === null) continue;
        await tx.query("SAVEPOINT credential_hash_probe");
        try {
          const answer = await tx.query<{ readonly admits: unknown }>(
            `SELECT coalesce((${expression}), true) AS admits FROM (VALUES ($1::text)) AS probe(${COLUMN})`,
            [sample],
          );
          await tx.query("RELEASE SAVEPOINT credential_hash_probe");
          if (answer.rows[0]?.admits !== true) refusing.push(String(row.constraint_name));
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT credential_hash_probe");
          throw err;
        }
      }
      if (refusing.length > 0) {
        return {
          ...base,
          verdict: "refuses" as const,
          refusing,
          detail:
            `${schema}.${TABLE}.${COLUMN}'s live CHECK (${refusing.join(", ")}) refuses a hash written` +
            ` under pepper version ${pepperVersion.toString()}, so every password set and every login` +
            " re-hash would be refused 23514",
        };
      }
      return {
        ...base,
        verdict: "admits" as const,
        detail: `${schema}.${TABLE}.${COLUMN} admits a hash written under pepper version ${pepperVersion.toString()}`,
      };
    });
  } catch (err) {
    return {
      ...base,
      verdict: "unreadable",
      detail: `the stored-hash CHECK could not be asked: ${err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err)}`,
    };
  }
}

/**
 * The `ALTER` pair that restores the catalog's CHECK, in **one** transaction for
 * `admissionRemedy`'s measured reason: pasted unwrapped, a failing `ADD` after a succeeding `DROP`
 * leaves the column under no rule at all. It names the live constraint in the `DROP` and reuses
 * the name in the `ADD`.
 */
export function credentialHashAdmissionRemedy(schema: string, admission: CredentialHashAdmission): string {
  const relation = `"${schema}"."${TABLE}"`;
  const declared = declaredCredentialHashCheck();
  const lines = ["BEGIN;"];
  for (const name of admission.refusing) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    lines.push(`ALTER TABLE ${relation} DROP CONSTRAINT ${quoted};`);
    lines.push(`ALTER TABLE ${relation} ADD CONSTRAINT ${quoted} CHECK (${declared});`);
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}

/** The boot line, said either way. No hash, no pepper and no password is ever in it. */
export function formatCredentialHashAdmission(admission: CredentialHashAdmission): string {
  const prefix = "[auth] credential hash admission:";
  switch (admission.verdict) {
    case "not_applicable":
      return `${prefix} not applicable (legacy pepper version)`;
    case "admits":
      return `${prefix} admits pepper version ${admission.pepperVersion.toString()}`;
    case "refuses":
      return `${prefix} REFUSES pepper version ${admission.pepperVersion.toString()} — ${admission.detail}`;
    case "unconstrained":
      return `${prefix} unconstrained — ${admission.detail}`;
    case "unreadable":
      return `${prefix} unreadable — ${admission.detail}`;
  }
}
