import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  buildChainEntry,
  verifyChainIntegrity,
  type ChainCheckpoint,
  type ChainedLogEntry,
} from "@crossengin/forensics";

import {
  assertTenantId,
  scopeFilter,
  SET_PLATFORM_AUDIT_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./tenant-context.js";
import {
  ChainAppendInputSchema,
  rowToChainEntry,
  type ChainAppendInput,
} from "./records.js";
import {
  checkpointFromChain,
  verifyChainSuffix,
  type ChainSuffixVerdict,
  type CheckpointMeta,
} from "./checkpoint.js";
import type { ChainSigner } from "./signer.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "forensic_chain_entries";

const READ_COLUMNS = `sequence_number, kind, recorded_at, actor_reference, payload_sha256,
  payload_size_bytes, prior_entry_hash, entry_hash, signing_key_fingerprint, signature`;

export interface ChainTail {
  readonly sequenceNumber: number;
  readonly entryHash: string;
}

export interface PostgresChainLogStoreOptions {
  readonly schema?: string;
}

/**
 * Read-only view over `meta.forensic_chain_entries` — load, integrity-verify, and checkpoint a scope's
 * chain WITHOUT a signing key. Verification only needs public keys (resolved elsewhere), so a `verify-chain`
 * tool / auditor can read a chain it has no authority to write; the signing key stays with the producer
 * (`PostgresChainLogStore`, which extends this reader with the append path).
 *
 * **Every read binds its scope as a predicate.** RLS is the isolation boundary, but a table's owner
 * bypasses it and connecting as the owner is ordinary — so relying on RLS alone made an
 * owner-connected reader return every scope's entries to every scope, which is both a disclosure and
 * a correctness failure: `verify` reported a sequence gap on healthy data, and `tailWithin` handed the
 * next append another scope's `priorEntryHash`. See `scopeFilter` for why the predicate branches
 * rather than using `IS NOT DISTINCT FROM`.
 */
export class PostgresChainLogReader {
  protected readonly schema: string;

  constructor(
    protected readonly conn: PgConnection,
    options: PostgresChainLogStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async loadChain(tenantId: string | null): Promise<readonly ChainedLogEntry[]> {
    const scope = scopeFilter(tenantId);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number ASC`,
        scope.params,
      );
      return result.rows.map((row) => rowToChainEntry(row));
    });
  }

  async verify(
    tenantId: string | null,
  ): Promise<{ readonly valid: boolean; readonly brokenAt: number | null; readonly reason?: string }> {
    return verifyChainIntegrity(await this.loadChain(tenantId));
  }

  async tail(tenantId: string | null): Promise<ChainTail | null> {
    return this.scoped(tenantId, (tx) => this.tailWithin(tx, tenantId));
  }

  /** The chain suffix at or after `fromSequence`, ordered — the input to a checkpoint-anchored verify. */
  async loadFrom(
    tenantId: string | null,
    fromSequence: number,
  ): Promise<readonly ChainedLogEntry[]> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number >= $1 AND ${scope.sql} ORDER BY sequence_number ASC`,
        [fromSequence, ...scope.params],
      );
      return result.rows.map((row) => rowToChainEntry(row));
    });
  }

  /**
   * O(suffix) integrity check: loads only the entries strictly after the checkpoint (the checkpoint's own
   * entry is the anchor, at `checkpoint.rootHash`) and folds them forward via `verifyChainSuffix`.
   */
  async verifyFromCheckpoint(
    tenantId: string | null,
    checkpoint: ChainCheckpoint,
  ): Promise<ChainSuffixVerdict> {
    const fromSequence = checkpoint.sequenceNumber + 1;
    const entries = await this.loadFrom(tenantId, fromSequence);
    return verifyChainSuffix(entries, { fromSequence, priorRootHash: checkpoint.rootHash });
  }

  /**
   * Builds a `ChainCheckpoint` at the current chain tail. It does NOT persist — hand the result to a
   * `PostgresChainCheckpointStore.record` to durably anchor it. Throws on an empty chain (nothing to anchor).
   */
  async createCheckpoint(
    tenantId: string | null,
    meta: { checkpointedBy: string } & Partial<CheckpointMeta>,
  ): Promise<ChainCheckpoint> {
    const entries = await this.loadChain(tenantId);
    return checkpointFromChain(entries, {
      checkpointedBy: meta.checkpointedBy,
      checkpointedAt: meta.checkpointedAt ?? new Date().toISOString(),
      externalAnchorReference: meta.externalAnchorReference,
      algorithm: meta.algorithm,
    });
  }

  /**
   * The scope's own tail. `tenantId` is a parameter and not inferred from the transaction, because
   * an append in a **caller's** transaction (`appendWithin`) has no context this class set.
   */
  protected async tailWithin(
    tx: PgConnection,
    tenantId: string | null,
  ): Promise<ChainTail | null> {
    const scope = scopeFilter(tenantId);
    const result = await tx.query<Record<string, unknown>>(
      `SELECT sequence_number, entry_hash FROM ${this.schema}.${TABLE}
       WHERE ${scope.sql} ORDER BY sequence_number DESC LIMIT 1`,
      scope.params,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      sequenceNumber: Number(row["sequence_number"]),
      entryHash: String(row["entry_hash"]).trim(),
    };
  }

  /** A read-only transaction with the tenant's RLS context set (platform reads skip it). */
  protected scoped<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}

/**
 * The chain producer: appends signed, hash-linked `ChainedLogEntry` rows to `meta.forensic_chain_entries`,
 * on top of the read-only {@link PostgresChainLogReader}.
 *
 * Every append runs in ONE transaction that first takes a per-scope `pg_advisory_xact_lock` (auto-released
 * at commit, bound to the transaction's own connection — so concurrent appends for a scope serialize and
 * the `priorEntryHash` chain never races), then sets the scope's RLS elevation, reads the scope's current
 * tail, builds + signs the next entry from the genesis-anchored `priorEntryHash`, and inserts it.
 *
 * A platform chain (`tenantId = null`) sets `app.platform_audit_write` rather than a tenant context.
 * That elevation exists because the platform arm used to ride inside the tenant isolation policy as
 * `tenant_id IS NULL OR …`, and on an `ALL`-scope policy the `USING` expression also serves as the
 * `WITH CHECK` — so any tenant session could insert, update and delete platform chain entries, which
 * is a tenant's switch for making the platform's own tamper-evident log read compromised. Verified
 * live as a non-owner role before and after.
 */
export class PostgresChainLogStore extends PostgresChainLogReader {
  constructor(
    conn: PgConnection,
    private readonly signer: ChainSigner,
    options: PostgresChainLogStoreOptions = {},
  ) {
    super(conn, options);
  }

  async append(input: ChainAppendInput): Promise<ChainedLogEntry> {
    const valid = ChainAppendInputSchema.parse(input);
    return this.serialized(valid.tenantId, async (tx) => this.appendSealed(tx, valid));
  }

  /**
   * Appends into a transaction the **caller** owns, so the chain entry and whatever the caller
   * is writing commit or roll back together. That atomicity is the point: an audit record
   * anchored by a chain entry that did not survive the same commit is an unanchored record,
   * and one the chain attests to but which was rolled back is a phantom.
   *
   * The per-scope advisory lock is still taken here — chain linearity depends on it — but the
   * **RLS context is the caller's responsibility**, since the caller's transaction has already
   * established whatever scope it is writing under. Passing a `tenantId` that differs from the
   * context the caller set would be caught by RLS on insert, not silently accepted.
   *
   * For a **platform** entry (`tenantId = null`) that means the caller's transaction must carry
   * `SET_PLATFORM_AUDIT_WRITE_SQL`. `PostgresAuditEmitter` already does, for the same GUC and in the
   * same transaction, which is why an anchored platform audit row keeps working — and why the chain
   * reuses that GUC rather than minting its own.
   */
  async appendWithin(tx: PgConnection, input: ChainAppendInput): Promise<ChainedLogEntry> {
    const valid = ChainAppendInputSchema.parse(input);
    if (valid.tenantId !== null) assertTenantId(valid.tenantId);
    await tx.query("SELECT pg_advisory_xact_lock($1)", [advisoryKeyFor(valid.tenantId)]);
    return this.appendSealed(tx, valid);
  }

  /** Reads the tail, builds + signs the next entry from it, inserts it. Assumes lock + context. */
  private async appendSealed(tx: PgConnection, valid: ChainAppendInput): Promise<ChainedLogEntry> {
    const tail = await this.tailWithin(tx, valid.tenantId);
    const sequenceNumber = tail === null ? 0 : tail.sequenceNumber + 1;
    const priorEntryHash = tail === null ? GENESIS_HASH : tail.entryHash;
    const sealed = await buildChainEntry({
      sequenceNumber,
      priorEntryHash,
      entry: {
        kind: valid.kind,
        recordedAt: valid.recordedAt,
        actorReference: valid.actorReference,
        payloadBytes: valid.payload,
      },
      signingKeyFingerprint: this.signer.fingerprint,
      sign: (bytes) => this.signer.sign(bytes),
    });
    await this.insertWithin(tx, valid.tenantId, sealed.entry);
    return sealed.entry;
  }

  private async insertWithin(
    tx: PgConnection,
    tenantId: string | null,
    entry: ChainedLogEntry,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.schema}.${TABLE}
        (tenant_id, sequence_number, kind, recorded_at, actor_reference, payload_sha256,
         payload_size_bytes, prior_entry_hash, entry_hash, signing_key_fingerprint, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        entry.sequenceNumber,
        entry.kind,
        entry.recordedAt,
        entry.actorReference,
        entry.payloadSha256,
        entry.payloadSizeBytes,
        entry.priorEntryHash,
        entry.entryHash,
        entry.signingKeyFingerprint,
        entry.signature,
      ],
    );
  }

  /**
   * One transaction: per-scope xact advisory lock → the scope's RLS elevation → fn. Serializes
   * appends per scope.
   *
   * The two elevations are different grants, and that is the security property. A **tenant** append
   * sets `app.current_tenant_id`, which the isolation policy confines to that tenant's own rows — it
   * can no longer reach the platform chain, because the platform arm was split out of that policy. A
   * **platform** append sets `app.platform_audit_write`, which satisfies an `INSERT`-scoped policy
   * whose `WITH CHECK` also demands `tenant_id IS NULL`, so holding it buys no route into any
   * tenant's chain. Neither elevation carries the other.
   */
  private serialized<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [advisoryKeyFor(tenantId)]);
      await tx.query(
        tenantId === null ? SET_PLATFORM_AUDIT_WRITE_SQL : SET_TENANT_CONTEXT_SQL,
        tenantId === null ? [] : [tenantId],
      );
      return fn(tx);
    });
  }
}

/** A stable per-scope bigint for `pg_advisory_xact_lock` (63-bit signed), derived from the tenant id. */
export function advisoryKeyFor(tenantId: string | null): bigint {
  const hex = sha256(`crossengin.forensic-chain.${tenantId ?? "platform"}`).slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`));
}
