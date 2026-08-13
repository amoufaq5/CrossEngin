import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  buildChainEntry,
  verifyChainIntegrity,
  type ChainedLogEntry,
} from "@crossengin/forensics";

import { assertTenantId, SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import {
  ChainAppendInputSchema,
  rowToChainEntry,
  type ChainAppendInput,
} from "./records.js";
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
 * The chain producer: appends signed, hash-linked `ChainedLogEntry` rows to `meta.forensic_chain_entries`.
 *
 * Every append runs in ONE transaction that first takes a per-tenant `pg_advisory_xact_lock` (auto-released
 * at commit, bound to the transaction's own connection — so concurrent appends for a tenant serialize and
 * the `priorEntryHash` chain never races), then sets the tenant's RLS context, reads the current tail,
 * builds + signs the next entry from the genesis-anchored `priorEntryHash`, and inserts it. A platform
 * chain (`tenantId = null`) skips the RLS context (RLS then exposes only `tenant_id IS NULL` rows).
 */
export class PostgresChainLogStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    private readonly signer: ChainSigner,
    options: PostgresChainLogStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async append(input: ChainAppendInput): Promise<ChainedLogEntry> {
    const valid = ChainAppendInputSchema.parse(input);
    return this.serialized(valid.tenantId, async (tx) => {
      const tail = await this.tailWithin(tx);
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
    });
  }

  async loadChain(tenantId: string | null): Promise<readonly ChainedLogEntry[]> {
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${READ_COLUMNS} FROM ${this.schema}.${TABLE} ORDER BY sequence_number ASC`,
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
    return this.scoped(tenantId, (tx) => this.tailWithin(tx));
  }

  private async tailWithin(tx: PgConnection): Promise<ChainTail | null> {
    const result = await tx.query<Record<string, unknown>>(
      `SELECT sequence_number, entry_hash FROM ${this.schema}.${TABLE}
       ORDER BY sequence_number DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      sequenceNumber: Number(row["sequence_number"]),
      entryHash: String(row["entry_hash"]).trim(),
    };
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

  /** One transaction: per-tenant xact advisory lock → RLS context → fn. Serializes appends per scope. */
  private serialized<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [advisoryKeyFor(tenantId)]);
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }

  /** A read-only transaction with the tenant's RLS context set (platform reads skip it). */
  private scoped<T>(
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

/** A stable per-scope bigint for `pg_advisory_xact_lock` (63-bit signed), derived from the tenant id. */
export function advisoryKeyFor(tenantId: string | null): bigint {
  const hex = sha256(`crossengin.forensic-chain.${tenantId ?? "platform"}`).slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`));
}
