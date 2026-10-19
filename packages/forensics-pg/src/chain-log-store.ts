import { sha256 } from "@crossengin/crypto";
import {
  numericIdentity,
  readRowsWithUnreadable,
  type PgConnection,
  type UnreadableRow,
} from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  buildChainEntry,
  checkpointAnchorsBoundedProof,
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
  checkpointFromTail,
  verifyChainSuffix,
  type ChainSuffixVerdict,
  type ChainTail,
  type CheckpointMeta,
} from "./checkpoint.js";
import type { ChainSigner } from "./signer.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "forensic_chain_entries";

const READ_COLUMNS = `sequence_number, kind, recorded_at, actor_reference, payload_sha256,
  payload_size_bytes, prior_entry_hash, entry_hash, signing_key_fingerprint, signature`;

export interface PostgresChainLogStoreOptions {
  readonly schema?: string;
}

/**
 * A chain as it reads: the entries the contract can represent, and every row it refuses.
 *
 * The pair rather than `readonly ChainedLogEntry[]` because **every caller of this read is a
 * verifier** — the signature check, the integrity fold, the hourly proof, the `verify-chain`
 * subcommand and the certification audit control — so a row this reader drops or throws on is not a
 * detail of the read, it is the thing those callers exist to find. `.map(rowToChainEntry)` threw out
 * of the whole array, and ADR-0373 measured what that costs: blanking `actor_reference` is a
 * signature-breaking tamper **inside the signed bytes** which no CHECK refused, and the one check
 * that could catch it (`verifyStoredChainSignatures`, the only check in this stack binding an
 * entry's stored columns to its content — ADR-0371) reaches that content through this mapper. So the
 * tamper prevented its own detector from running, and an hourly `sev1` became one `console.error`
 * per hour, for ever.
 *
 * An unreadable row here is **conclusive** rather than inferred (ADR-0322's axis): both append paths
 * parse `ChainAppendInputSchema` before any statement, so a stored row this reader refuses cannot
 * have been written by this code.
 */
export interface ChainRead {
  readonly entries: readonly ChainedLogEntry[];
  readonly unreadable: readonly UnreadableRow[];
}

/**
 * The verdict an unreadable row forces, or `null` when every row read.
 *
 * Unreadable rows take precedence over the fold's own answer, unconditionally, and that is the
 * decision rather than an ordering preference: **a fold over a chain with a row missing is not a
 * fold over that chain.** `verifyChainIntegrity` walks the entries it was given, so a refused row
 * reads to it as a `sequence gap` — which is a true statement about the array and a false one about
 * the table, and it sends an operator to look for a deleted entry when the entry is present and
 * malformed. Naming the row that is there is ADR-0334's rule: a remedy that cannot work is worse
 * than none.
 *
 * `brokenAt` is the first unreadable row's sequence, which reads because the column is
 * `INTEGER NOT NULL CHECK (sequence_number >= 0)` — the one field that always answers is the one
 * that says which row to go and look at. `null` where even that did not read, rather than a
 * fabricated position.
 */
export function unreadableEntryVerdict(
  unreadable: readonly UnreadableRow[],
): ChainSuffixVerdict | null {
  const first = unreadable[0];
  if (first === undefined) return null;
  const at = first.identity === null ? Number.NaN : Number(first.identity);
  return {
    valid: false,
    brokenAt: Number.isInteger(at) ? at : null,
    reason: `${String(unreadable.length)} entr${unreadable.length === 1 ? "y" : "ies"} the contract refuses (first: ${first.detail})`,
  };
}

/**
 * One spelling of the read, so `loadChain` and `loadFrom` cannot come to disagree about what a
 * refused row is. `detail` carries no value from the row by construction (`unreadableDetail`), which
 * is what makes it safe to interpolate into a verdict a log line and a stored record both carry.
 */
function readChain(rows: readonly Record<string, unknown>[]): ChainRead {
  const { records, unreadable } = readRowsWithUnreadable(rows, rowToChainEntry, (row) =>
    numericIdentity(row, "sequence_number"),
  );
  return { entries: records, unreadable };
}

/**
 * A bounded verification was asked for against an anchor nothing vouched for.
 *
 * An `Error` and not a `ChainSuffixVerdict`, for the reason stated at `verifyFromCheckpoint`: a
 * verdict says something about the **chain**, and this says the verification could not be performed.
 * The message names the provenance it got — including the word `absent`, which is the state every
 * checkpoint written before ADR-0371 is in and is a different fact from a row that states
 * `unverified`.
 */
export class ChainAnchorNotVerified extends Error {
  constructor(
    readonly sequenceNumber: number,
    readonly provenance: ChainCheckpoint["provenance"],
  ) {
    super(
      `cannot bound a verification on the checkpoint at sequence ${sequenceNumber.toString()}: ` +
        `its provenance is ${provenance ?? "absent"}, so nothing vouched for the prefix it anchors. ` +
        `Fold from genesis instead, or verify and re-anchor that scope first.`,
    );
    this.name = "ChainAnchorNotVerified";
  }
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

  async loadChain(tenantId: string | null): Promise<ChainRead> {
    const scope = scopeFilter(tenantId);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql} ORDER BY sequence_number ASC`,
        scope.params,
      );
      return readChain(result.rows);
    });
  }

  async verify(tenantId: string | null): Promise<ChainSuffixVerdict> {
    const read = await this.loadChain(tenantId);
    return unreadableEntryVerdict(read.unreadable) ?? verifyChainIntegrity(read.entries);
  }

  async tail(tenantId: string | null): Promise<ChainTail | null> {
    return this.scoped(tenantId, (tx) => this.tailWithin(tx, tenantId));
  }

  /** The chain suffix at or after `fromSequence`, ordered — the input to a checkpoint-anchored verify. */
  async loadFrom(tenantId: string | null, fromSequence: number): Promise<ChainRead> {
    const scope = scopeFilter(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE sequence_number >= $1 AND ${scope.sql} ORDER BY sequence_number ASC`,
        [fromSequence, ...scope.params],
      );
      return readChain(result.rows);
    });
  }

  /**
   * O(suffix) integrity check: loads only the entries strictly after the checkpoint (the checkpoint's own
   * entry is the anchor, at `checkpoint.rootHash`) and folds them forward via `verifyChainSuffix`.
   *
   * **Refuses an anchor whose provenance does not admit a bounded proof**, which is ADR-0371's
   * defect through a second door. That increment made the bounded arm of
   * `verifyChainFromCheckpoint` reachable only behind `checkpointAnchorsBoundedProof`, and this
   * method was the other bounded-verify entry point: it took a caller-supplied `ChainCheckpoint` of
   * **any** provenance, handed the suffix to `verifyChainSuffix` and consulted `provenance`
   * nowhere — and `verifyChainSuffix` answers `{valid: true}` over an empty suffix, so a stale
   * anchor over a forged prefix read as verified having examined nothing. Found by auditing
   * ADR-0371 rather than by using it.
   *
   * It **throws** rather than answering `{valid: false}`, and the distinction is ADR-0371's own
   * refused-versus-error split one layer down: a `false` verdict says *this chain did not verify*
   * and names where it broke, while the truth here is that the verification could not be performed
   * — which asserts nothing about the chain. Returning `valid: false` would report a tamper for a
   * configuration problem, and `reason` is the field a reader would then have to disambiguate from
   * a real `sequence gap`.
   *
   * A **backstop** rather than the gate: `verifyChainFromCheckpoint` adjudicates before it reaches
   * any reader, so nothing in the serving binary can meet this refusal — `dischargeAbac`'s shape,
   * and ADR-0369's `sessionScope` throw kept as a backstop the live path can no longer reach. What
   * makes it worth having is that this class is the auditor-facing reader `runVerifyChain` and
   * `chain-verify.ts` both construct, so the method sits in the serving process one call away from
   * reintroducing exactly the unsoundness ADR-0371 closed — and **no workspace rule covers it**,
   * because `pg-unreachable-stores.ts` asks which exported *class* has no caller and not which
   * *method* (the gap CLAUDE.md already records for `PostgresDataKeyStore.destroy`).
   *
   * Not deleted, though it is callerless outside its own tests: the fold is the primitive and the
   * fold is sound. What was wrong is that the name claimed an adjudication the body did not
   * perform, so deleting it would send the next auditor to re-implement it — ungated.
   */
  async verifyFromCheckpoint(
    tenantId: string | null,
    checkpoint: ChainCheckpoint,
  ): Promise<ChainSuffixVerdict> {
    if (!checkpointAnchorsBoundedProof(checkpoint.provenance)) {
      throw new ChainAnchorNotVerified(checkpoint.sequenceNumber, checkpoint.provenance);
    }
    const fromSequence = checkpoint.sequenceNumber + 1;
    const read = await this.loadFrom(tenantId, fromSequence);
    return (
      unreadableEntryVerdict(read.unreadable) ??
      verifyChainSuffix(read.entries, { fromSequence, priorRootHash: checkpoint.rootHash })
    );
  }

  /**
   * Builds a `ChainCheckpoint` at the current chain tail, for a caller that holds no tail of its own.
   * It does NOT persist — hand the result to a `PostgresChainCheckpointStore.record` to durably
   * anchor it. Throws on an empty chain (nothing to anchor).
   *
   * It reads the **tail** (one row) and not the chain. That is not only cheaper: a caller that has
   * just verified a chain must anchor at the tail its verification covered, so it should build from
   * that tail through `checkpointFromTail` rather than call this and have a second read choose the
   * sequence — which is what stamped entries appended during a verification as verified (ADR-0371).
   * This method is for the caller with nothing verified and nothing in hand, and `provenance` is
   * required precisely so that caller has to say so.
   *
   * `provenance` is carried from the caller and deliberately **not** derived here: this class holds
   * no keys — by design, so that an auditor can read a chain it cannot write — and the hash links
   * alone cannot earn one, since `verifyChainIntegrity` compares a stored `priorEntryHash` against a
   * stored `entryHash` and recomputes neither. Only the signature binds an entry to its content.
   */
  async createCheckpoint(
    tenantId: string | null,
    meta: Pick<CheckpointMeta, "checkpointedBy" | "provenance"> & Partial<CheckpointMeta>,
  ): Promise<ChainCheckpoint> {
    const tail = await this.tail(tenantId);
    if (tail === null) {
      throw new Error("cannot checkpoint an empty chain");
    }
    return checkpointFromTail(tail, {
      checkpointedBy: meta.checkpointedBy,
      checkpointedAt: meta.checkpointedAt ?? new Date().toISOString(),
      externalAnchorReference: meta.externalAnchorReference,
      algorithm: meta.algorithm,
      provenance: meta.provenance,
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
