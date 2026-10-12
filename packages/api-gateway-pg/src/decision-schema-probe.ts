import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * **Does `meta.rate_limit_decisions` accept the row this package writes?**
 *
 * This asks `information_schema` rather than attempting a write, for `probeJobQueueVisibility`'s
 * reason (ADR-0334): a failure observed at the first request is indistinguishable from a transient
 * database fault, and the remedy — standing manual SQL an operator must run once — is not something
 * a per-request error can carry legibly.
 *
 * Two columns are asked about and both are catalog *changes* this increment depends on:
 *
 * - **`policy_id`** is `UUID REFERENCES meta.rate_limit_policies(id)` in the shipped catalog, and
 *   the policy a request is governed by is an `rlp_` identifier (see `rate-limit-policy.ts`). A
 *   `UUID` column cannot hold one, so against an unpatched database the write fails with
 *   `22P02 invalid input syntax for type uuid`.
 * - **`principal_id`** is `UUID REFERENCES meta.users(id) ON DELETE RESTRICT`, and **nothing in the
 *   workspace writes `meta.users`** — verified against a live cluster: a decision naming any
 *   resolvable principal fails with
 *   `insert or update on table "rate_limit_decisions" violates foreign key constraint
 *   "rate_limit_decisions_principal_id_fkey"`. Which is to say the column recording *who* was rate
 *   limited is unusable for every value except NULL. ADR-0318 and ADR-0321 both concluded a
 *   `RESTRICT` reference into `meta.users` is wrong for a column recording who did a thing and made
 *   those columns TEXT; this is the same column one table over.
 *
 * `pg-column-coverage.ts` cannot see either of these, which is worth saying plainly: it asserts that
 * a column a statement names **exists**, not that its type can hold what the statement binds, nor
 * that a referenced row does. Both defects here are inside that fence.
 */

export type DecisionColumnShape = "text" | "uuid" | "absent";

export interface DecisionSchemaProbe {
  readonly policyColumn: DecisionColumnShape;
  readonly principalColumn: DecisionColumnShape;
  /** True while the dropped `quota_definition_id` column is still present; harmless, since nothing names it. */
  readonly quotaColumnPresent: boolean;
  readonly ready: boolean;
  readonly defects: readonly string[];
  readonly remediationSql: readonly string[];
}

const SHAPE_BY_UDT: Readonly<Record<string, DecisionColumnShape>> = {
  text: "text",
  varchar: "text",
  uuid: "uuid",
};

interface ColumnRow {
  readonly column_name: string;
  readonly udt_name: string;
}

function shapeOf(rows: readonly ColumnRow[], column: string): DecisionColumnShape {
  const row = rows.find((r) => r.column_name === column);
  if (row === undefined) return "absent";
  return SHAPE_BY_UDT[row.udt_name] ?? "uuid";
}

export const DECISION_POLICY_COLUMN_SQL = [
  "ALTER TABLE meta.rate_limit_decisions DROP CONSTRAINT IF EXISTS rate_limit_decisions_policy_id_fkey;",
  "ALTER TABLE meta.rate_limit_decisions DROP COLUMN IF EXISTS quota_definition_id;",
  "ALTER TABLE meta.rate_limit_decisions ALTER COLUMN policy_id TYPE TEXT USING policy_id::TEXT;",
  "ALTER TABLE meta.rate_limit_decisions ADD CONSTRAINT rate_limit_decisions_policy_id_check CHECK (policy_id IS NULL OR policy_id ~ '^rlp_[a-z0-9]{8,40}$');",
] as const;

export const DECISION_PRINCIPAL_COLUMN_SQL = [
  "ALTER TABLE meta.rate_limit_decisions DROP CONSTRAINT IF EXISTS rate_limit_decisions_principal_id_fkey;",
  "ALTER TABLE meta.rate_limit_decisions ALTER COLUMN principal_id TYPE TEXT USING principal_id::TEXT;",
] as const;

/**
 * Reads the two column shapes and says what is standing between this store and a successful write.
 *
 * It never throws on a *finding*; a connection that cannot answer at all does throw, because an
 * unreachable catalog is not evidence that the schema is wrong in either direction (ADR-0334's
 * first-lookup rule for the tenant-status directory).
 */
export async function probeDecisionSchema(conn: PgConnection): Promise<DecisionSchemaProbe> {
  const result = await conn.query<ColumnRow>(
    `SELECT column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'meta' AND table_name = 'rate_limit_decisions'
        AND column_name IN ('policy_id', 'quota_definition_id', 'principal_id')`,
  );
  const rows = result.rows;
  const policyColumn = shapeOf(rows, "policy_id");
  const principalColumn = shapeOf(rows, "principal_id");
  const quotaColumnPresent = rows.some((r) => r.column_name === "quota_definition_id");

  const defects: string[] = [];
  const remediationSql: string[] = [];
  if (policyColumn !== "text") {
    defects.push(
      `meta.rate_limit_decisions.policy_id is ${policyColumn}, and a declared policy id is an rlp_ string; decisions will not be persisted`,
    );
    remediationSql.push(...DECISION_POLICY_COLUMN_SQL);
  } else if (quotaColumnPresent) {
    remediationSql.push(DECISION_POLICY_COLUMN_SQL[1]);
  }
  if (principalColumn !== "text") {
    defects.push(
      `meta.rate_limit_decisions.principal_id is ${principalColumn} referencing meta.users, which has no writer; a decision naming a principal violates its foreign key`,
    );
    remediationSql.push(...DECISION_PRINCIPAL_COLUMN_SQL);
  }
  return {
    policyColumn,
    principalColumn,
    quotaColumnPresent,
    // `policy_id` alone gates readiness: a `uuid` `principal_id` is survivable (the decision is
    // written with a NULL principal and the loss is the attribution), while a `uuid` `policy_id`
    // means no row can be written at all.
    ready: policyColumn === "text",
    defects,
    remediationSql,
  };
}
