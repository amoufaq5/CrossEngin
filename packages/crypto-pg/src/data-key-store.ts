import { assertScopeTenantId, type PgConnection } from "@crossengin/kernel-pg";
import {
  DEFAULT_KEY_GENERATION,
  dataKeyWrapAad,
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
} from "@crossengin/crypto";

import { scopeFilter, SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "tenant_data_keys";

/** The row's own first envelope key. A rekey mints the next; `ensure` never does. */
const FIRST_GENERATION = 1;

const READ_COLUMNS = "tenant_id, generation, wrapped_key, kek_generation, provenance";

/**
 * Serializes two first-provisionings of the same tenant's data key.
 *
 * Copied verbatim in shape from `operate-runtime-pg`'s `TENANT_SCHEMA_LOCK_SQL` — the repo's other
 * per-tenant lock — down to the two-argument `hashtext` form and the namespace literal in the first
 * slot, so two unrelated per-tenant locks cannot collide on one key space. `kernel-pg`'s applier
 * lock is the wrong model here: it is a *session* lock taken through `PgConnection.withAdvisoryLock`,
 * which `node-pg` refuses inside a transaction, and this lock has to be held by the transaction that
 * reads and inserts.
 *
 * **Xact-scoped**, so it is released by the commit that ends the provisioning and there is nothing
 * to unwind on a failure path.
 */
export const DATA_KEY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('crypto_tenant_data_key'), hashtext($1))";

export const DATA_KEY_PROVENANCES = ["random", "seeded_from_derived"] as const;
export type DataKeyProvenance = (typeof DATA_KEY_PROVENANCES)[number];

export interface StoredDataKey {
  readonly tenantId: string;
  readonly generation: number;
  readonly kekGeneration: number;
  readonly provenance: DataKeyProvenance;
  /** Unwrapped. Nothing in this module logs or stringifies it. */
  readonly dek: Uint8Array;
}

export interface DataKeySeed {
  /** The DEK to store when none exists. Absent ⇒ generate a random one. */
  readonly seed?: Uint8Array;
}

export interface PostgresDataKeyStoreOptions {
  readonly schema?: string;
  /**
   * Which KEK generation `kekFor` returns. Recorded on every row this store writes, and defaulted to
   * `DEFAULT_KEY_GENERATION` because that is `deriveTenantKek`'s own default — a store defaulting to
   * anything else would record a KEK generation that did not wrap the row, which is the one fact a
   * mid-flight KEK rotation reads to decide what still needs re-wrapping.
   */
  readonly kekGeneration?: number;
}

/**
 * A stored wrapped key that will not open.
 *
 * Carries the tenant and the generation — the two things an operator needs to find the row — and
 * **never** the wrapped bytes, the plaintext or the KEK.
 */
export class DataKeyUnwrapFailed extends Error {
  constructor(
    readonly tenantId: string,
    readonly generation: number,
  ) {
    super(
      `the stored data key for tenant ${tenantId} generation ${generation.toString()} did not ` +
        "unwrap: the key-encryption key is wrong for this row, or the row is corrupt",
    );
    this.name = "DataKeyUnwrapFailed";
  }
}

/**
 * The envelope over `meta.tenant_data_keys`: one wrapped data key per tenant per generation.
 *
 * ADR-0338 derives a tenant's at-rest column key from the deployment secret and stores nothing,
 * which means it cannot be destroyed — so an Article 17 erasure gains nothing from it and
 * crypto-shredding is not expressible. This store is the other half: a key that exists only as
 * ciphertext in a row, so deleting the row destroys it.
 *
 * `tenant_id` is `NOT NULL` on this table, so there is no platform scope and no platform policy arm
 * to claim. Every statement here is tenant-scoped in both of the two ways that are needed: the
 * transaction sets `app.current_tenant_id` for the single isolation policy, and the statement itself
 * carries the **strict** `scopeFilter` predicate for the deployment that connects as the table's
 * owner and so bypasses that policy. Strict and never the inclusive arm: there is no platform data
 * key, so a row from another scope is never evidence about this tenant — it is the row whose AAD
 * would refuse to open under this tenant's KEK.
 */
export class PostgresDataKeyStore {
  private readonly schema: string;
  private readonly kekGeneration: number;

  constructor(
    private readonly conn: PgConnection,
    private readonly kekFor: (tenantId: string) => Uint8Array,
    options: PostgresDataKeyStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
    this.kekGeneration = options.kekGeneration ?? DEFAULT_KEY_GENERATION;
    // The column carries `CHECK (kek_generation >= 1)`. Refused at construction rather than left to
    // raise on the first provisioning, so a misconfiguration is a boot failure and not a 500 on the
    // first PHI write for a tenant that has no key yet.
    if (!Number.isInteger(this.kekGeneration) || this.kekGeneration < 1) {
      throw new Error(
        `kekGeneration must be an integer >= 1, got ${String(options.kekGeneration)}`,
      );
    }
  }

  /**
   * Returns this tenant's current data key, provisioning the first generation if it has none.
   *
   * **One transaction, holding a per-tenant advisory lock across the read and the insert**, rather
   * than `INSERT … ON CONFLICT DO NOTHING` followed by a re-read. With `ON CONFLICT` the loser of a
   * race discards the DEK it brought and reads back the winner's. For a *generated* DEK that is
   * harmless — the two are interchangeable and neither has written a byte yet. For a **seeded** one
   * it is not: the loser discards ADR-0338's derived key, reads back a random one, and the caller
   * goes on serving a tenant whose existing ciphertext was written under the key that was thrown
   * away. That splits one tenant's data across two keys with nothing on any row saying which is
   * which, and it is unrecoverable. The lock makes the decision once, so no caller's seed is ever
   * silently replaced.
   *
   * A `23505` on the unique `(tenant_id, generation)` is therefore **not caught**. It is the
   * backstop, and reaching it means the lock was not held — catching it and re-reading would
   * reintroduce exactly the `ON CONFLICT` behaviour above, in the one place where the wrong answer
   * is permanent.
   *
   * **Who seeds.** A caller seeds exactly when the tenant may already hold ciphertext written under
   * ADR-0338's derived column key, so that the switch to the envelope keeps that ciphertext
   * readable. Both ways of getting it wrong are consequential and they are not symmetric: seeding a
   * tenant that holds no ciphertext merely records a key that is still recomputable from the
   * deployment secret, so the row is not shreddable and `provenance` says so; **omitting** the seed
   * for a tenant that does hold ciphertext makes that ciphertext permanently unreadable, because
   * nothing afterwards knows which key wrote it.
   *
   * `ensure` takes the lock on every call, including the overwhelmingly common one that finds a row.
   * A caller on the request path wants `load`.
   */
  async ensure(tenantId: string, seed?: DataKeySeed): Promise<StoredDataKey> {
    assertScopeTenantId(tenantId);
    // A seed of the wrong length is `wrapDataKey`'s refusal and deliberately **not** re-checked
    // here. One definition of what a data key is: `pgp_sym_encrypt` accepts a key of any length, so
    // a short DEK rendered to base64 would encrypt PHI under a weak key and report success, and a
    // second copy of that check is a second thing to keep in agreement with it. The cost is that it
    // raises after the lock and the read rather than before them — harmless, since the rollback
    // releases an xact lock — and that a malformed seed handed to a tenant who already has a row is
    // not reported at all, because that seed is ignored either way.
    const seeded = seed?.seed;
    const kek = this.kekFor(tenantId);
    return this.scoped(tenantId, async (tx) => {
      await tx.query(DATA_KEY_LOCK_SQL, [tenantId]);

      const existing = await this.selectLatest(tx, tenantId);
      if (existing !== null) return this.open(kek, existing);

      const dek = seeded ?? generateDataKey();
      // Recorded, never inferred from the bytes: the shreddability claim is read off this column,
      // and a random key and a derived one are indistinguishable as bytes. A `random` row is the
      // only copy of its key, so destroying it destroys the key; a `seeded_from_derived` row is
      // still recomputable from the deployment secret, so destroying it destroys nothing.
      const provenance: DataKeyProvenance =
        seeded === undefined ? "random" : "seeded_from_derived";
      const wrapped = wrapDataKey(
        kek,
        dek,
        dataKeyWrapAad(tenantId, FIRST_GENERATION),
      );
      await tx.query(
        `INSERT INTO ${this.schema}.${TABLE}
          (tenant_id, generation, wrapped_key, kek_generation, provenance)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          FIRST_GENERATION,
          // `Buffer.from`, not the `Uint8Array` as it stands: node-postgres serialises a value by
          // asking `Buffer.isBuffer`, and a plain `Uint8Array` falls past that to a text rendering.
          // A fake that records `{sql, params}` cannot see the difference (ADR-0333's boundary).
          Buffer.from(wrapped),
          this.kekGeneration,
          provenance,
        ],
      );
      return {
        tenantId,
        generation: FIRST_GENERATION,
        kekGeneration: this.kekGeneration,
        provenance,
        // The DEK we just wrapped, not a re-read and re-unwrap of it.
        dek,
      };
    });
  }

  /**
   * Reads one stored data key, **the highest generation** unless one is named.
   *
   * Highest by default so a rekey that added generation 2 is picked up without every caller having
   * to track which generation is current; named explicitly so a rotation can read a specific one
   * while both exist.
   */
  async load(tenantId: string, generation?: number): Promise<StoredDataKey | null> {
    assertScopeTenantId(tenantId);
    const kek = this.kekFor(tenantId);
    return this.scoped(tenantId, async (tx) => {
      const row = await this.selectLatest(tx, tenantId, generation);
      return row === null ? null : this.open(kek, row);
    });
  }

  /**
   * Destroys every generation of this tenant's data key and returns how many rows went.
   *
   * A **hard delete**, not a `destroyed_at` flag. A soft delete leaves the wrapped key in the row
   * and the KEK wherever it was, so the deployment would report a shred while the material it
   * claimed to destroy was still there and still openable — a signed proof over live data, which is
   * the failure the erasure's confirm-absence pass exists to catch. The row *is* the key, so the
   * only honest destruction is the row's.
   */
  async destroy(tenantId: string): Promise<number> {
    assertScopeTenantId(tenantId);
    const scope = scopeFilter(tenantId, 1);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query(
        `DELETE FROM ${this.schema}.${TABLE} WHERE ${scope.sql}`,
        [...scope.params],
      );
      return result.rowCount;
    });
  }

  private async selectLatest(
    tx: PgConnection,
    tenantId: string,
    generation?: number,
  ): Promise<Record<string, unknown> | null> {
    const scope = scopeFilter(tenantId, 1);
    const params: unknown[] = [...scope.params];
    let where = scope.sql;
    if (generation !== undefined) {
      params.push(generation);
      where = `${where} AND generation = $${String(params.length)}`;
    }
    const result = await tx.query<Record<string, unknown>>(
      `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
       WHERE ${where}
       ORDER BY generation DESC
       LIMIT 1`,
      params,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Unwraps a stored row, or **throws**.
   *
   * Never `null` and never a fall-back to minting a new key. `unwrapDataKey` answering `null` is a
   * wrong KEK or a corrupt row — the deployment's own state, wrong for every request for this tenant
   * until someone fixes it — and the two recoveries a caller might reach for are both worse than
   * refusing: serving under a freshly generated key writes new ciphertext this tenant's old rows
   * cannot be read beside, and answering "no key yet" invites the caller to do the same thing one
   * level up. A wrong answer is worse than a refusal, and here the wrong answer cannot be undone.
   */
  private open(kek: Uint8Array, row: Record<string, unknown>): StoredDataKey {
    const tenantId = String(row["tenant_id"]);
    const generation = asInt(row["generation"]);
    const dek = unwrapDataKey(
      kek,
      asBytes(row["wrapped_key"]),
      dataKeyWrapAad(tenantId, generation),
    );
    if (dek === null) throw new DataKeyUnwrapFailed(tenantId, generation);
    return {
      tenantId,
      generation,
      kekGeneration: asInt(row["kek_generation"]),
      provenance: asProvenance(row["provenance"]),
      dek,
    };
  }

  /**
   * Every statement's scope, in both of the ways this table needs one.
   *
   * The context is set **inside the transaction** because `set_config(…, true)` is
   * transaction-local: issued through a bare `conn.query` it is discarded with the implicit
   * single-statement transaction that carried it, before the statement it was set for. The isolation
   * policy is this table's only arm and therefore the only thing carrying a `WITH CHECK`, so for a
   * non-owner a write with no context raises `42501` rather than matching nothing.
   */
  private scoped<T>(tenantId: string, fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    return this.conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}

function asInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`expected an integer column, got ${JSON.stringify(value)}`);
  }
  return n;
}

function asProvenance(value: unknown): DataKeyProvenance {
  const raw = String(value);
  if (!(DATA_KEY_PROVENANCES as readonly string[]).includes(raw)) {
    // The column's CHECK permits exactly these two, so a third means the row was written by
    // something that is not this store against a catalog that is not the one this was built from.
    throw new Error(`unknown data key provenance: ${JSON.stringify(raw)}`);
  }
  return raw as DataKeyProvenance;
}

/**
 * A `BYTEA` as node-postgres hands it back: a `Buffer`, which is a `Uint8Array`.
 *
 * A string is deliberately **not** accepted. Postgres can render `BYTEA` as `\x…` hex text under a
 * driver or a `bytea_output` this store did not expect, and decoding it here would be guessing at an
 * encoding on the path where guessing wrong yields bytes that are not the stored ciphertext — which
 * surfaces as a failed unwrap, i.e. as the alarm for a corrupt row, on a row that is fine.
 */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(
    `expected wrapped_key to be a BYTEA buffer, got ${typeof value}`,
  );
}
