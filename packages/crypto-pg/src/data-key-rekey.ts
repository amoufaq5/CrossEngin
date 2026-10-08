/**
 * The per-tenant data-key rekey: rewrite this tenant's ciphertext from the key its envelope row
 * holds to a freshly generated one, and write the new row **in the same transaction**.
 *
 * ADR-0347 shipped the envelope and said in its own open ends that for an existing deployment it
 * bought the mechanism and not the horizon, because every tenant that already held ciphertext was
 * given a key *seeded* from ADR-0338's derived one — and a seeded key stays recomputable from
 * `COLUMN_ENCRYPTION_SECRET`, so destroying its row destroys nothing. This is the operation that
 * moves such a tenant to a `random` key, which is the only thing that makes
 * `shreddabilityOf` answer `shreddable` and therefore the only thing that bounds an Article 17
 * deletion's recovery horizon at all.
 *
 * **Why it lives in `crypto-pg` and could not live anywhere else.** It needs the re-encryption
 * emitter and the rotation migrator from `@crossengin/kernel-pg`, the key generator and the wrap
 * from `@crossengin/crypto`, and the envelope row's store from this package. This is the only
 * package that depends on both of the first two, and `kernel-pg` does not depend on `crypto-pg`, so
 * the dependency edge exists in this direction only. Putting the orchestration in `kernel-pg` would
 * mean that package knowing what a data key is; putting it in an app would mean the key *values*
 * passing through a module that parses argv.
 *
 * **What a returned result means.** Everything `rekeyTenant` does happens inside one
 * `conn.transaction`, nothing is caught, and the confirm-readability pass runs before the commit —
 * so a returned result means the ciphertext and the new key row agree, and a thrown error means
 * neither moved. Each way of splitting that is broken separately and neither is recoverable, since
 * nothing on any row records which key wrote it: the key row first and the rewrite failing leaves
 * `load` answering the new key over ciphertext under the old one, so every read for that tenant
 * raises; the rewrite first and the row write failing is the mirror image, where every read raises
 * under a key the database still names as current.
 */

import {
  COLUMN_ENCRYPTION_KEY_GUC,
  COLUMN_ENCRYPTION_KEY_OLD_GUC,
  DEFAULT_COLUMN_KEY_REF,
  KeyRotationMigrator,
  OLD_COLUMN_KEY_REF,
  introspectEncryptedColumns,
  type EncryptedColumn,
  type KeyRotationOutcome,
  type KeyRotationPlan,
  type KeyRotationRefusalReason,
  type PgConnection,
} from "@crossengin/kernel-pg";
import { dataKeyToColumnKey, generateDataKey } from "@crossengin/crypto";

import {
  DATA_KEY_LOCK_SQL,
  type DataKeyProvenance,
  type PostgresDataKeyStore,
} from "./data-key-store.js";
import { assertTenantId, SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

/**
 * The three ways a rekey is wrong *as a rekey*, beside the five ways a key rotation is wrong as a
 * rotation (`KEY_ROTATION_REFUSAL_REASONS`, raised by the migrator and reported next to these).
 */
export const REKEY_REFUSAL_REASONS = [
  "no_data_key_row",
  "no_encrypted_columns",
  /**
   * The two resolved key VALUES are identical, so the rotation would rewrite every row to the same
   * ciphertext and report a successful rekey having bounded nothing. `kernel-pg` compares key
   * *references* and cannot see this — two different GUC names holding identical bytes pass its
   * `keys_are_the_same`, which is exactly the shape a rekey has — and this module holds both values
   * and is therefore the only place that can.
   */
  "new_key_equals_old",
] as const;
export type RekeyRefusalReason = (typeof REKEY_REFUSAL_REASONS)[number];

export interface RekeyRefusal {
  /** Either this module's own reason or one the key-rotation survey raised. */
  readonly reason: RekeyRefusalReason | KeyRotationRefusalReason;
  readonly detail: string;
}

/**
 * A rekey this module refused. The migrator's own `KeyRotationRefused` is deliberately **not**
 * converted into one — see `rekeyTenant`.
 *
 * Carries the tenant and the reasons, and never a key, a wrapped key, a row or a ciphertext: every
 * detail it transports comes either from the catalog (schema, table and column names) or from this
 * module's own sentences.
 */
export class TenantRekeyRefused extends Error {
  readonly tenantId: string;
  readonly refusals: readonly RekeyRefusal[];

  constructor(tenantId: string, refusals: readonly RekeyRefusal[]) {
    super(
      `data key rekey refused for tenant ${tenantId}: ` +
        refusals.map((r) => `${r.reason} (${r.detail})`).join("; "),
    );
    this.name = "TenantRekeyRefused";
    this.tenantId = tenantId;
    this.refusals = refusals;
  }
}

export interface TenantRekeyInput {
  readonly conn: PgConnection;
  readonly store: PostgresDataKeyStore;
  readonly tenantId: string;
  /**
   * Where the encrypted **entity** tables live — `public` for a boot manifest, `t_…` for a
   * per-tenant one. Deliberately separate from the store's own meta schema, because one `--schema`
   * flag drives both with two different defaults (`meta` for the key row, `public` for the
   * ciphertext), so a tool taking one schema argument would read the key from the wrong place for
   * at least one configuration.
   */
  readonly dataSchema: string;
  /**
   * Other schemas to name in a `no_encrypted_columns` refusal if they hold encrypted columns — the
   * tenant's own schema, typically. This module computes no naming convention of its own.
   */
  readonly alternativeSchemas?: readonly string[];
}

export interface TenantRekeySurvey {
  readonly tenantId: string;
  readonly dataSchema: string;
  /**
   * What the tenant's envelope row says, and deliberately **not** the key it holds: a survey is
   * read by a formatter and printed, and the dek is the one field of `StoredDataKey` that must
   * never reach a line of output.
   */
  readonly current: {
    readonly generation: number;
    readonly provenance: DataKeyProvenance;
    readonly kekGeneration: number;
  } | null;
  readonly plans: readonly KeyRotationPlan[];
  readonly plaintextAtRest: readonly EncryptedColumn[];
  /**
   * The rows the whole rekey would rewrite — the lock window an operator is approving.
   *
   * Summed from the per-plan counts, which `surveyTenant` fills only when nothing refuses. So a
   * refused survey reports 0 here, and that is **not** a claim that the tenant holds no ciphertext:
   * it is `KeyRotationPlan.rowsToRewrite`'s null-is-not-0 distinction collapsing at the aggregate,
   * survivable only because `refusals` is non-empty in exactly that case and is what the reader
   * must act on first.
   */
  readonly rowsToRewrite: number;
  /** Schemas from `alternativeSchemas` that DO hold encrypted columns, when `dataSchema` holds none. */
  readonly alternativesWithCiphertext: readonly string[];
  readonly refusals: readonly RekeyRefusal[];
}

export interface TenantRekeyResult {
  readonly tenantId: string;
  readonly fromGeneration: number;
  readonly fromProvenance: DataKeyProvenance;
  readonly toGeneration: number;
  readonly columns: readonly KeyRotationOutcome[];
  readonly rowsReencrypted: number;
  readonly rowsConfirmed: number;
  readonly priorGenerationsDestroyed: number;
}

/**
 * The two key GUCs the rotation reads, mapped to the two key values, for one transaction.
 *
 * The **only** place either value appears, and it appears as a `set_config` bind parameter: the
 * migrator issues `SELECT set_config($1, $2, true)` for each pair, so neither key reaches SQL text,
 * a `pg_stat_statements` entry, a query plan or a server log line (ADR-0301's rule, and the reason
 * `KeyRotationMigratorOptions.sessionSettings` exists at all).
 *
 * The old key goes to `COLUMN_ENCRYPTION_KEY_OLD_GUC` and the new one to the GUC the serving stack
 * reads, which is what makes the rekey leave the deployment in a state its own key source agrees
 * with rather than one step out of phase.
 */
function rekeySessionSettings(
  oldColumnKey: string,
  newColumnKey: string,
): ReadonlyMap<string, string> {
  return new Map([
    [COLUMN_ENCRYPTION_KEY_OLD_GUC, oldColumnKey],
    [COLUMN_ENCRYPTION_KEY_GUC, newColumnKey],
  ]);
}

/**
 * What this rekey would do: the current envelope row, the per-column plans with their row counts,
 * and every refusal — this module's own first, then the rotation survey's.
 *
 * **Read-only.** It mints no key, writes nothing, and opens no transaction of its own; the one
 * transaction in its trace is `store.load`'s, which exists solely to set the tenant context that
 * table's isolation policy needs. It also sets **no key GUC**, and that is sound rather than an
 * omission: every statement the rotation survey issues is a catalog read, a visibility probe or a
 * `count(*)` over the scope predicate, and none of them decrypts — so a survey is safe to run on a
 * deployment whose keys an operator has not arranged yet, which is the deployment most likely to be
 * asking.
 *
 * Own refusals before the migrator's, because their remedies differ in kind: `no_data_key_row`
 * means this tenant is not in envelope mode at all and `no_encrypted_columns` almost always means
 * the wrong `--data-schema`, while the migrator's are properties of a schema that *is* the right
 * one.
 */
export async function surveyTenantRekey(input: TenantRekeyInput): Promise<TenantRekeySurvey> {
  // Before any statement, so a malformed id costs no round trip — `ensure`'s rule.
  assertTenantId(input.tenantId);
  const refusals: RekeyRefusal[] = [];

  // `load` and never `ensure`: a survey must not provision. Worth recording that before this module
  // `load` had **no caller anywhere in the workspace**, against its own doc saying that a caller on
  // the request path wants `load` rather than `ensure` — the serving path reaches `ensure` because
  // it has to provision a cold tenant, and this is the first operation that wants to know what a
  // tenant holds without changing it.
  const stored = await input.store.load(input.tenantId);
  if (stored === null) {
    refusals.push({
      reason: "no_data_key_row",
      detail:
        `tenant ${input.tenantId} has no row in the data key table, so there is no key to rotate ` +
        "from: either this deployment runs --column-key-mode derived, or this tenant has never " +
        "written an encrypted column",
    });
  }

  const rotation = await new KeyRotationMigrator(input.conn).surveyTenant(
    input.conn,
    input.dataSchema,
    input.tenantId,
    OLD_COLUMN_KEY_REF,
    DEFAULT_COLUMN_KEY_REF,
  );

  const alternativesWithCiphertext: string[] = [];
  if (rotation.plans.length === 0) {
    // One extra catalog query per named schema is what turns a puzzling empty survey into "pass
    // --data-schema t_…". A wrong data schema is the likeliest operator error here and an empty
    // plan is the only way it shows up — identical output to a tenant that genuinely holds no
    // ciphertext, where the right answer is to do nothing.
    for (const schema of input.alternativeSchemas ?? []) {
      if (schema === input.dataSchema) continue;
      const columns = await introspectEncryptedColumns(input.conn, schema);
      if (columns.some((c) => c.encryptedStorage)) alternativesWithCiphertext.push(schema);
    }
    refusals.push({
      reason: "no_encrypted_columns",
      detail:
        `schema ${input.dataSchema} holds no ciphertext (bytea) column hinted ` +
        "crossengin.encrypt=at_rest, so a rekey would rewrite nothing" +
        (alternativesWithCiphertext.length === 0
          ? ""
          : `; these schemas do hold one: ${alternativesWithCiphertext.join(", ")}`),
    });
  }

  refusals.push(...rotation.refusals.map((r) => ({ reason: r.reason, detail: r.detail })));

  return {
    tenantId: input.tenantId,
    dataSchema: input.dataSchema,
    current:
      stored === null
        ? null
        : {
            generation: stored.generation,
            provenance: stored.provenance,
            kekGeneration: stored.kekGeneration,
          },
    plans: rotation.plans,
    plaintextAtRest: rotation.plaintextAtRest,
    rowsToRewrite: rotation.plans.reduce((sum, p) => sum + (p.rowsToRewrite ?? 0), 0),
    alternativesWithCiphertext,
    refusals,
  };
}

/**
 * Performs the rekey. **One transaction: either the ciphertext and the new key row both land, or
 * neither does.**
 *
 * The order is forced rather than chosen:
 * 1. the tenant context, because every statement in here is confined by it for a non-owner, and
 *    `set_config(…, true)` is transaction-local so it has to be claimed inside this transaction;
 * 2. `DATA_KEY_LOCK_SQL`, so a concurrent `ensure` for a cold tenant cannot interleave with a rekey
 *    and two replicas cannot race one — taken **before** the read, so the generation this rotates
 *    from cannot change under it;
 * 3. the read, through `loadWithin` rather than `load`, which would open a nested transaction that
 *    the real binding refuses and both of this package's fakes permit;
 * 4. a fresh **random** key — never a seed, because the ciphertext this key will protect is the
 *    ciphertext step 6 is about to rewrite, and a key that cannot be recomputed is the entire
 *    product of the operation;
 * 5. the key-*value* refusal `kernel-pg` structurally cannot make;
 * 6. the rotation: survey inside this transaction, refuse, rewrite every column, confirm each one
 *    reads back under the new key;
 * 7. the new key row, and the destruction of every earlier generation with it;
 * 8. one last check that the destruction reached a row, because step 3 proved there was one.
 *
 * **Nothing is caught, and there is deliberately no `try` in this function at all.** A refusal, a
 * confirm disagreement, a wrong-length key and an ordinary database error all roll the transaction
 * back, which is what makes the guarantee above a property of the code rather than of a code path.
 * It is also why the migrator's `KeyRotationRefused` is allowed out unchanged instead of being
 * caught and re-thrown as a `TenantRekeyRefused`: re-wrapping would need the only `catch` in a
 * function whose guarantee is that it has none, and it would erase which of the two vocabularies
 * the refusal came from. `surveyTenantRekey` merges them because it *reports*; this function does
 * not, because it *acts*.
 */
export async function rekeyTenant(input: TenantRekeyInput): Promise<TenantRekeyResult> {
  assertTenantId(input.tenantId);
  const tenantId = input.tenantId;

  return input.conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    await tx.query(DATA_KEY_LOCK_SQL, [tenantId]);

    const current = await input.store.loadWithin(tx, tenantId);
    if (current === null) {
      throw new TenantRekeyRefused(tenantId, [
        {
          reason: "no_data_key_row",
          detail:
            `tenant ${tenantId} has no row in the data key table, so there is no key to rotate ` +
            "from; a rekey never provisions one, because choosing between a random key and a " +
            "seeded one needs evidence this operation does not gather",
        },
      ]);
    }

    const next = generateDataKey();
    const oldColumnKey = dataKeyToColumnKey(current.dek);
    const newColumnKey = dataKeyToColumnKey(next);
    // A plain `===` and not a constant-time comparison: both values are ours, neither is an
    // attacker-supplied candidate being checked against a secret, and there is nothing here a
    // timing signal could reveal that the caller does not already hold.
    if (oldColumnKey === newColumnKey) {
      throw new TenantRekeyRefused(tenantId, [
        {
          reason: "new_key_equals_old",
          detail:
            "the generated data key is byte-identical to the stored one, so the rotation would " +
            "rewrite every row to the same ciphertext and report a rekey that bounded nothing",
        },
      ]);
    }

    // Constructed over `tx` and not over `input.conn`. `rotateTenantWithin` never reads the
    // migrator's own connection, so the choice decides only what a *mistake* costs: handed
    // `input.conn`, an accidental `rotateSchema` would run its unscoped whole-schema rewrite in its
    // own transaction, outside this one and outside this tenant's scope. Handed `tx` it is a nested
    // transaction the real binding refuses.
    const migrator = new KeyRotationMigrator(tx, {
      sessionSettings: rekeySessionSettings(oldColumnKey, newColumnKey),
    });
    const rotation = await migrator.rotateTenantWithin(
      tx,
      input.dataSchema,
      tenantId,
      OLD_COLUMN_KEY_REF,
      DEFAULT_COLUMN_KEY_REF,
    );

    // Last, and in the same transaction as the rewrite that just ran. The confirm pass has already
    // proved every rewritten row reads back under `next`, so this row is written over ciphertext
    // already known to be under the key it names.
    const row = await input.store.rekeyWithin(tx, tenantId, next, current.generation);

    // `loadWithin` found a row at `current.generation` under this transaction's lock, so the
    // `DELETE` whose predicate is `generation <= current.generation` had at least that row to
    // reach. Zero therefore cannot mean "nothing to retire"; it means the statement reached no row
    // it should have — a confined session or a scope that does not match the read — and the
    // consequence is the one this operation exists to prevent: the previous generation surviving
    // the rekey, so a `seeded_from_derived` row goes on claiming a key that is still recomputable
    // while the deployment believes the tenant is shreddable. A throw and not a refusal, because
    // rows have already been rewritten and the only exit after the first destructive statement is
    // the one that rolls them back.
    if (row.priorGenerationsDestroyed === 0) {
      throw new Error(
        `data key rekey for tenant ${tenantId} wrote generation ${row.generation.toString()} but ` +
          `retired none of the ${current.generation.toString()} earlier generation(s) it read, so ` +
          "the delete reached no row and the rekey must not commit",
      );
    }

    return {
      tenantId,
      fromGeneration: current.generation,
      fromProvenance: current.provenance,
      toGeneration: row.generation,
      columns: rotation.columns,
      rowsReencrypted: rotation.rowsReencrypted,
      rowsConfirmed: rotation.rowsConfirmed,
      priorGenerationsDestroyed: row.priorGenerationsDestroyed,
    };
  });
}
