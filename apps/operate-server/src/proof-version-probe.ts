import type { PgConnection } from "@crossengin/kernel-pg";
import { TOMBSTONE_PROOF_VERSIONS } from "@crossengin/tenant-lifecycle";

/**
 * Whether this database's `meta.tenant_tombstones` will accept the proof version this binary emits.
 *
 * ## The failure this exists to convert
 *
 * `proof_version` carries a column CHECK naming the versions the catalog knows, and ADR-0351 widened
 * it from `('v1','v2','v3')` to `('v1','v2','v3','v4')`. On a **fresh** database that arrives with
 * the bootstrap and costs nothing. On an existing one it does not, and the asymmetry is measured
 * rather than assumed — `crossengin apply --plan` against a cluster holding one stored tombstone
 * reports:
 *
 * ```
 *   1 statement(s) to apply:
 *       add_column tenant_tombstones.record_storage
 *   1 difference(s) left alone:
 *       [constraint_needs_validation] tenant_tombstones.proof_version
 * ```
 *
 * So the **column lands automatically and the CHECK does not**. ADR-0330 is why: a widening CHECK
 * cannot be told from a narrowing one, so validating it against existing rows is the one thing a
 * plan may not assume, and the SQL is handed over instead. The consequence is the part that needed
 * answering: between the upgrade and that `ALTER`, this binary emits `proofVersion: "v4"` and the
 * `INSERT` is refused `23514` — **inside the deletion pipeline's transaction**, after the tenant's
 * schema has been dropped and their rows deleted. The transaction rolls back, so nothing is
 * destroyed; ADR-0321's runner sees a throw that is not a `DeletionPipelineAborted`, files it
 * `aborted`, and leaves the request `in_progress` for a human. An operator meets that under an
 * Article 12(3) deadline.
 *
 * Converting it into a boot refusal naming the remedy is ADR-0334's move, and this is the fourth
 * place it has been the right one. `api-gateway-pg`'s `decision-schema-probe.ts` is the direct
 * precedent and says why the probe belongs at boot rather than at the statement: *the remedy for an
 * unpatched catalog is standing manual SQL an operator runs once, which a boot line can carry and a
 * per-request error cannot.*
 *
 * ## Why it refuses where the rate-limit probe mounts
 *
 * That probe mounts either way, loudly (ADR-0322), because the limit is enforced whether or not its
 * decision row can be written — the projection degrades and the behaviour does not. Here there is no
 * degraded behaviour to protect: a deletion that cannot store its proof is a deletion that does not
 * happen, and the only question is whether the operator learns it now or from a stranded request.
 *
 * ## What it asks, and what it refuses to guess
 *
 * `pg_get_constraintdef` — Postgres's own deparse of its own constraint — and then a membership
 * question about each version literal in it. Not a parser: the catalog writes `IN (…)`, Postgres
 * renders it `= ANY (ARRAY['v1'::text, …])`, and the only thing asked of that text is whether each
 * version appears as a quoted literal. A constraint whose rendering does not match that shape at all
 * is reported `unreadable` with the text rather than `refuses`, because "this expression is not one
 * I can read" and "this expression rejects v4" are different facts and only the second has a remedy.
 */

const PROOF_VERSION_COLUMN = "proof_version";
const TOMBSTONE_TABLE = "tenant_tombstones";

/**
 * The shape the catalog's `IN (…)` is deparsed into, and the only shape this probe reads.
 *
 * The optional inner paren is not defensive padding — it is the second spelling Postgres actually
 * produces, measured on 16.13 over the same `CHECK (proof_version IN ('v1', …))` against two column
 * types:
 *
 * ```
 *   TEXT     CHECK ((proof_version = ANY (ARRAY['v1'::text, …])))
 *   VARCHAR  CHECK (((proof_version)::text = ANY ((ARRAY['v1'::character varying, …])::text[])))
 * ```
 *
 * The catalog declares TEXT, so the first is what every correctly-applied database holds. Accepting
 * the second matters because of which way this probe fails on a shape it cannot read: `unreadable`
 * **mounts** (ADR-0334's asymmetry), so a column that has drifted to `VARCHAR` would leave the
 * `23514` this module exists to convert exactly where it was, behind a warning. One spelling it can
 * read and does not is worth more than a narrower regex.
 */
const ANY_ARRAY_SHAPE = /=\s*ANY\s*\(\s*\(?\s*ARRAY\s*\[/i;

export const PROOF_VERSION_CHECK_STATES = [
  /** The CHECK names every version this binary can emit. */
  "admits",
  /** The CHECK exists and omits at least one. The one actionable state, and the only refusal. */
  "refuses",
  /** No CHECK on the column, so it constrains nothing and admits every version. */
  "unconstrained",
  /** The table or the column is not there: the catalog has not been applied to this database. */
  "absent",
  /** The catalog could not be read, or the constraint is in a shape this probe does not read. */
  "unreadable",
] as const;
export type ProofVersionCheckState = (typeof PROOF_VERSION_CHECK_STATES)[number];

export interface ProofVersionCheckProbe {
  readonly state: ProofVersionCheckState;
  /** The versions this binary emits that the stored CHECK does not name. Empty unless `refuses`. */
  readonly missing: readonly string[];
  /** Postgres's own rendering, when there was one to read. */
  readonly definition: string | null;
  readonly detail: string;
}

/**
 * Whether the stored CHECK admits `version`, by looking for it as a quoted literal.
 *
 * `'v1'` and not `v1`, so a version string that happened to be a substring of a column or function
 * name in the expression cannot be read as a member of the list.
 */
function definitionNames(definition: string, version: string): boolean {
  return definition.includes(`'${version}'`);
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export async function probeProofVersionCheck(
  conn: PgConnection,
  schema: string,
): Promise<ProofVersionCheckProbe> {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  let rows: readonly { readonly definition: unknown; readonly column_exists: unknown }[];
  try {
    const result = await conn.query<{
      readonly definition: unknown;
      readonly column_exists: unknown;
    }>(
      // One statement for both questions, because the answers are only meaningful together: a
      // definition with no column behind it cannot happen, and a column with no definition is the
      // `unconstrained` state rather than an absent table. `conkey` restricts the join to a CHECK
      // over exactly this one column, which is the form `ChooseConstraintName` writes.
      `SELECT pg_get_constraintdef(con.oid) AS definition,
              att.attname IS NOT NULL AS column_exists
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute att
           ON att.attrelid = c.oid AND att.attname = $2
          AND att.attnum > 0 AND NOT att.attisdropped
         LEFT JOIN pg_constraint con
           ON con.conrelid = c.oid AND con.contype = 'c'
          AND con.conkey = ARRAY[att.attnum]
        WHERE n.nspname = $1 AND c.relname = $3 AND c.relkind IN ('r', 'p')`,
      [schema, PROOF_VERSION_COLUMN, TOMBSTONE_TABLE],
    );
    rows = result.rows;
  } catch (err) {
    return {
      state: "unreadable",
      missing: [],
      definition: null,
      detail:
        `the catalog could not be read: ${err instanceof Error ? err.message : String(err)}; ` +
        `whether ${schema}.${TOMBSTONE_TABLE} will accept this binary's proof version is unknown`,
    };
  }

  const first = rows[0];
  if (first === undefined || first.column_exists !== true) {
    return {
      state: "absent",
      missing: [],
      definition: null,
      detail:
        `${schema}.${TOMBSTONE_TABLE}.${PROOF_VERSION_COLUMN} does not exist, so the catalog has` +
        " not been applied to this database; run the migration applier",
    };
  }
  const definition =
    first.definition === null || first.definition === undefined ? null : String(first.definition);
  if (definition === null || definition.length === 0) {
    return {
      state: "unconstrained",
      missing: [],
      definition: null,
      detail:
        `${schema}.${TOMBSTONE_TABLE}.${PROOF_VERSION_COLUMN} carries no CHECK, so it admits every` +
        " proof version; the catalog declares one, so this database has drifted from it",
    };
  }
  if (!ANY_ARRAY_SHAPE.test(definition)) {
    return {
      state: "unreadable",
      missing: [],
      definition,
      detail:
        `${schema}.${TOMBSTONE_TABLE}.${PROOF_VERSION_COLUMN} carries a CHECK in a shape this probe` +
        ` does not read (${definition}); whether it admits this binary's proof version is unknown` +
        " — a rejected expression and an unreadable one are different facts and only the first has" +
        " a remedy",
    };
  }
  const missing = TOMBSTONE_PROOF_VERSIONS.filter((v) => !definitionNames(definition, v));
  if (missing.length === 0) {
    return {
      state: "admits",
      missing: [],
      definition,
      detail: `${schema}.${TOMBSTONE_TABLE} accepts every proof version this binary emits`,
    };
  }
  return {
    state: "refuses",
    missing,
    definition,
    detail:
      `${schema}.${TOMBSTONE_TABLE}.${PROOF_VERSION_COLUMN} does not name ` +
      `${missing.map((v) => `'${v}'`).join(", ")}, so storing a tombstone at that version is` +
      " refused 23514 — inside the deletion pipeline's transaction, after the tenant's data has been" +
      " deleted. The transaction rolls back, so nothing is destroyed, and the request is left" +
      " in_progress for a human",
  };
}

/**
 * Whether this state must stop the deletion surfaces mounting.
 *
 * Only `refuses`, and the asymmetry is ADR-0334's `missing`-versus-`unreachable`: a CHECK observed to
 * omit a version is a fact with one `ALTER` as its remedy, while `absent` and `unreadable` are
 * states the probe could not establish anything from. Refusing on an unestablished fact would refuse
 * a deployment that works — at boot the database may simply not be up yet — so those warn and mount.
 */
export function proofVersionCheckBlocksDeletion(state: ProofVersionCheckState): boolean {
  return state === "refuses";
}

/**
 * The `ALTER` pair an operator runs once, which is what `constraint_needs_validation` hands over.
 *
 * It takes no probe, which is deliberate rather than an omission: the statement restates the
 * **declared** list and not the stored one, because the stored one is what is being replaced. A
 * remedy derived from what the database currently holds would reproduce whatever is wrong with it.
 */
export function proofVersionCheckRemedy(schema: string): string {
  const relation = `"${schema}"."${TOMBSTONE_TABLE}"`;
  const list = TOMBSTONE_PROOF_VERSIONS.map((v) => `'${v}'`).join(", ");
  const name = `${TOMBSTONE_TABLE}_${PROOF_VERSION_COLUMN}_check`;
  return (
    `-- rows that would refuse it:\n` +
    `-- SELECT * FROM ${relation} WHERE NOT (${PROOF_VERSION_COLUMN} IN (${list}));\n` +
    `ALTER TABLE ${relation} DROP CONSTRAINT "${name}";\n` +
    `ALTER TABLE ${relation} ADD CONSTRAINT "${name}" ` +
    `CHECK (${PROOF_VERSION_COLUMN} IN (${list}));`
  );
}

/** The boot line. Carries the state first, because that is what an operator greps for. */
export function formatProofVersionCheck(probe: ProofVersionCheckProbe, schema: string): string {
  const head = `tombstone proof version: ${probe.state} — ${probe.detail}`;
  if (!proofVersionCheckBlocksDeletion(probe.state)) return head;
  return `${head}\n${proofVersionCheckRemedy(schema)}`;
}
