import type { PgConnection } from "@crossengin/kernel-pg";
import {
  TombstoneRecordSchema,
  tombstoneMatchesAttestations,
  verifyTombstoneHashes,
  type DeletionAttestation,
  type TombstoneKind,
  type TombstoneRecord,
} from "@crossengin/tenant-lifecycle";

/**
 * Persisting a tombstone, and anchoring it in the same transaction that writes it.
 *
 * ADR-0317 made a `TombstoneRecord` composed from attestations rather than written by hand, and left
 * it nowhere to live: a verified record existed only in the response that produced it, and its
 * `anchors` were supplied by the caller — a claim whose witness the claimant chose.
 *
 * `meta.tenant_tombstones` was declared in Phase 1 and never written, so it had drifted behind its
 * contract in the way ADR-0300 found for `meta.feature_flags`. ADR-0318 widened it; this is the first
 * writer.
 *
 * Three rules, and each is the reason this is a store rather than an `INSERT`.
 *
 * **The record and its anchor commit together.** `appendWithin(tx, …)` puts the chain entry in the
 * caller's transaction (ADR-0286), so there is no window in which a tombstone exists unanchored or an
 * anchor names a tombstone that was rolled back. The chain entry is written **first** and its hash
 * stored on the row — the same ordering `PostgresAuditEmitter` uses, and for the same reason: a row
 * inserted first would need an `UPDATE` to learn its coordinates, which would give an append-only
 * table a rewrite path.
 *
 * **The anchor is derived, not accepted.** `write` ignores any `anchors` on the record it is given and
 * replaces them with the chain entry it just appended. A tombstone's witness is the chain, and letting
 * a caller name one would make the anchor a claim about a claim.
 *
 * **It is verified before it is stored and re-parsed when it is read.** Before the insert: the
 * record's own hashes must check out, and — when attestations are supplied — the scope must still be
 * the one they compose to (ADR-0317's `tombstoneMatchesAttestations`). After: `read` parses every row
 * back through `TombstoneRecordSchema`, which is the only way to catch a row edited into a state the
 * contract forbids but the column CHECKs permit (ADR-0289).
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The chain's `deletion_event` kind, which is what a tombstone is. */
export const TOMBSTONE_LOG_KIND = "deletion_event";

/**
 * The most rows one `scanAll` page may hold.
 *
 * Exported because the cap has to be the caller's too: a sweep that asks for more than this gets a
 * short page, and a caller reading a short page as the end of the table would stop mid-sweep.
 */
export const TOMBSTONE_SCAN_MAX_LIMIT = 500;

export const TOMBSTONE_COLUMNS = [
  "tombstone_id",
  "kind",
  "tenant_id",
  "subject_identifier",
  "related_deletion_request_id",
  "deleted_at",
  "executed_by",
  "approved_by",
  "scope",
  "content_manifest_sha256",
  "proof_sha256",
  "anchors",
  "retained_reason",
  "retained_data_reference",
  "invalidation_of_prior_tombstone_id",
  "attestations",
  // ADR-0329. These two are load-bearing in a way the other columns are not: the proof version
  // selects which domain tag the content manifest was hashed under, so a v2 row written and read
  // back as v1 recomputes a *different* digest and `verifyStoredEvidence` reports `scope_tampered`
  // on a perfectly honest proof. The pre-insert `verifyTombstoneHashes` in `assertWritable` passes,
  // because the record is correct at that point — the forgery would be introduced by the read.
  "proof_version",
  "capability_declaration",
  // ADR-0331, and load-bearing for the same reason as the two above: a v3 row read back without its
  // obligations is a v3 label with nothing to hash, so `contentManifestSubjectOf` yields no subject,
  // `verifyTombstoneHashes` answers `contentManifestOk: false`, and `verifyStoredEvidence` reports
  // `scope_tampered` on an honest proof — then escalates it at `sev1` (ADR-0324). The forgery would be
  // introduced by the read; `assertWritable` passes, because the record is correct when it is written.
  "retained_obligations",
  // ADR-0351, and load-bearing for the same reason as the three above, with one difference worth
  // naming: there is no column default that could stand in for it. `proof_version` defaults to
  // `'v1'`, which is the honest reading of a row written before that column existed; a
  // record-storage declaration has no such reading, because every value of it is a claim. So a v4
  // row read back without this column is a v4 label with nothing to hash — `scope_tampered` on an
  // honest proof, escalated at `sev1` (ADR-0324) — and the only way to avoid that is to read it.
  "record_storage",
  "chain_entry_hash",
  "chain_sequence_number",
] as const;

/** The slice of `PostgresChainLogStore` this store needs. Structural, so a fake needs no chain. */
export interface TombstoneAnchorer {
  appendWithin(
    tx: PgConnection,
    input: {
      readonly tenantId: string | null;
      readonly kind: typeof TOMBSTONE_LOG_KIND;
      readonly actorReference: string;
      readonly recordedAt: string;
      readonly payload: string;
    },
  ): Promise<{ readonly sequenceNumber: number; readonly entryHash: string }>;
}

export interface PostgresTombstoneStoreOptions {
  readonly schema?: string;
}

export const TOMBSTONE_WRITE_REFUSALS = [
  "proof_unverifiable",
  "attestations_mismatch",
  "four_eyes_violated",
  "invalid_tenant_id",
] as const;
export type TombstoneWriteRefusal = (typeof TOMBSTONE_WRITE_REFUSALS)[number];

export class TombstoneWriteRefused extends Error {
  readonly refusal: TombstoneWriteRefusal;

  constructor(refusal: TombstoneWriteRefusal, detail: string) {
    super(`refusing to store tombstone: ${detail}`);
    this.name = "TombstoneWriteRefused";
    this.refusal = refusal;
  }
}

export interface StoredTombstone {
  readonly record: TombstoneRecord;
  readonly attestations: readonly DeletionAttestation[];
  /** Null only for a row written before anchoring existed; this store always sets it. */
  readonly chainEntryHash: string | null;
  readonly chainSequenceNumber: number | null;
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function textOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The bytes the chain commits to for one tombstone.
 *
 * Deliberately **not** the whole record: it is the two digests plus the identity the proof already
 * covers. A tombstone's scope can be arbitrarily large (every table a tenant held), and the chain is
 * append-only storage that every verification pass reads — committing the payload twice would make
 * chain verification scale with deleted data. The digests are what make the record tamper-evident, so
 * committing to them is committing to it.
 */
export function tombstoneChainPayload(record: TombstoneRecord): string {
  return jsonOf({
    tombstoneId: record.id,
    kind: record.kind,
    tenantId: record.tenantId,
    deletedAt: record.deletedAt,
    contentManifestSha256: record.contentManifestSha256,
    proofSha256: record.proofSha256,
  });
}

export class PostgresTombstoneStore {
  private readonly conn: PgConnection;
  private readonly schema: string;
  private readonly anchorer: TombstoneAnchorer;

  constructor(
    conn: PgConnection,
    anchorer: TombstoneAnchorer,
    opts: PostgresTombstoneStoreOptions = {},
  ) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
    this.anchorer = anchorer;
  }

  private get table(): string {
    return `${this.schema}.tenant_tombstones`;
  }

  /**
   * Stores a tombstone and anchors it, in one transaction.
   *
   * Returns the record as stored — with `anchors` replaced by the chain entry that witnessed it, not
   * the ones the caller passed. Refuses, before any write, a record whose own hashes do not verify,
   * one whose scope no longer matches its attestations, and one whose executor approved it.
   *
   * **No tenant context.** The connection is platform-scoped and the insert deliberately does not run
   * under `withTenantContext`: a tombstone is written at the moment a tenant's data is gone, and
   * setting that tenant's context to write the record of its deletion is a dependency on the thing
   * being deleted. The row carries `tenant_id` and the table's isolation policy still confines any
   * tenant-scoped *reader*.
   */
  async write(
    record: TombstoneRecord,
    attestations: readonly DeletionAttestation[] = [],
  ): Promise<StoredTombstone> {
    this.assertWritable(record, attestations);
    return this.conn.transaction(async (tx) => this.insertWithin(tx, record, attestations));
  }

  /**
   * The same write, inside a transaction the caller owns.
   *
   * This is what lets a tenant deletion commit the `DROP SCHEMA` and the tombstone that records it
   * **together** (ADR-0319). Postgres DDL is transactional, so the alternative is a window in which
   * the data is gone and the proof of its deletion is not — for a cryptographically attested deletion
   * that is the worst state available: irreversible and unaccounted for.
   *
   * Refusals are raised before the caller's transaction is touched, so a refused write leaves whatever
   * else the caller had done intact and rollback-able on its own terms.
   */
  async writeWithin(
    tx: PgConnection,
    record: TombstoneRecord,
    attestations: readonly DeletionAttestation[] = [],
  ): Promise<StoredTombstone> {
    this.assertWritable(record, attestations);
    return this.insertWithin(tx, record, attestations);
  }

  /** Everything refusable about a write, checked before any statement is sent. */
  private assertWritable(
    record: TombstoneRecord,
    attestations: readonly DeletionAttestation[],
  ): void {
    if (!UUID_RE.test(record.tenantId)) {
      // The column is UUID; a contract that accepts free text would otherwise fail at the bind with a
      // message about syntax rather than about the tenant.
      throw new TombstoneWriteRefused(
        "invalid_tenant_id",
        `tenantId must be a uuid, got ${JSON.stringify(record.tenantId)}`,
      );
    }
    if (record.executedBy === record.approvedBy) {
      throw new TombstoneWriteRefused(
        "four_eyes_violated",
        "executedBy and approvedBy must differ (four-eyes principle)",
      );
    }
    const verified = verifyTombstoneHashes(record);
    if (!verified.contentManifestOk || !verified.proofOk) {
      throw new TombstoneWriteRefused(
        "proof_unverifiable",
        `the record's own hashes do not verify (contentManifest ${
          verified.contentManifestOk ? "ok" : "bad"
        }, proof ${verified.proofOk ? "ok" : "bad"})`,
      );
    }
    if (attestations.length > 0 && !tombstoneMatchesAttestations(record, attestations)) {
      // A record and evidence that disagree is the one thing an auditor would be misled by, and it
      // is cheap to check here and impossible to check later from the row alone.
      throw new TombstoneWriteRefused(
        "attestations_mismatch",
        "the record's scope is not the one its attestations compose to",
      );
    }
  }

  private async insertWithin(
    tx: PgConnection,
    record: TombstoneRecord,
    attestations: readonly DeletionAttestation[],
  ): Promise<StoredTombstone> {
    return (async () => {
      // Appended first so the row can carry its coordinates without an UPDATE, which would give an
      // append-only table a rewrite path (ADR-0286).
      const entry = await this.anchorer.appendWithin(tx, {
        tenantId: record.tenantId,
        kind: TOMBSTONE_LOG_KIND,
        actorReference: record.executedBy,
        recordedAt: record.deletedAt,
        payload: tombstoneChainPayload(record),
      });
      const anchors = [
        {
          kind: "internal_audit_log" as const,
          reference: entry.entryHash,
          anchoredAt: record.deletedAt,
        },
      ];
      const stored: TombstoneRecord = TombstoneRecordSchema.parse({ ...record, anchors });

      const columns = TOMBSTONE_COLUMNS.join(", ");
      const placeholders = TOMBSTONE_COLUMNS.map((c, i) => {
        const n = `$${(i + 1).toString()}`;
        // `INSERT … VALUES` with an unknown-typed parameter infers `text`, so the non-text columns
        // are cast. The same reasoning as the suppression store's cast map.
        if (c === "tenant_id") return `${n}::uuid`;
        if (c === "deleted_at") return `${n}::timestamptz`;
        if (
          c === "scope" ||
          c === "anchors" ||
          c === "attestations" ||
          c === "capability_declaration" ||
          c === "retained_obligations" ||
          c === "record_storage"
        )
          return `${n}::jsonb`;
        if (c === "chain_sequence_number") return `${n}::integer`;
        return n;
      }).join(", ");

      await tx.query(
        `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders})`,
        [
          stored.id,
          stored.kind,
          stored.tenantId,
          stored.subjectIdentifier ?? null,
          stored.relatedDeletionRequestId ?? null,
          stored.deletedAt,
          stored.executedBy,
          stored.approvedBy,
          jsonOf(stored.scope),
          stored.contentManifestSha256,
          stored.proofSha256,
          jsonOf(stored.anchors),
          stored.retainedReason ?? null,
          stored.retainedDataReference ?? null,
          stored.invalidationOfPriorTombstoneId,
          jsonOf(attestations),
          stored.proofVersion,
          stored.capabilityDeclaration === undefined
            ? null
            : jsonOf(stored.capabilityDeclaration),
          // `null` and `'[]'` are different facts, so the empty array is written as an array. NULL
          // means this record's bytes do not cover a retention claim; `[]` is the v3 claim that
          // nothing was lawfully kept.
          stored.retainedObligations === undefined ? null : jsonOf(stored.retainedObligations),
          stored.recordStorage === undefined ? null : jsonOf(stored.recordStorage),
          entry.entryHash,
          entry.sequenceNumber,
        ],
      );

      return {
        record: stored,
        attestations,
        chainEntryHash: entry.entryHash,
        chainSequenceNumber: entry.sequenceNumber,
      };
    })();
  }

  /**
   * One tombstone by its id, re-parsed through the contract.
   *
   * Reads under the platform grant, because the isolation policy cannot serve this: a tombstone
   * outlives its tenant, so by the time anybody asks for it there is no tenant session left to
   * satisfy. `app.platform_audit` is transaction-scoped and `SELECT`-only at the policy, so the
   * elevation cannot write (ADR-0318).
   */
  async read(tombstoneId: string): Promise<StoredTombstone | null> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TOMBSTONE_COLUMNS.join(", ")} FROM ${this.table} WHERE tombstone_id = $1`,
        [tombstoneId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToStoredTombstone(row);
    });
  }

  /** Every tombstone for one tenant, newest first. Re-parsed, so a corrupted row throws. */
  async listForTenant(tenantId: string): Promise<readonly StoredTombstone[]> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    }
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TOMBSTONE_COLUMNS.join(", ")} FROM ${this.table}` +
          " WHERE tenant_id = $1::uuid ORDER BY deleted_at DESC, tombstone_id",
        [tenantId],
      );
      return result.rows.map((row) => rowToStoredTombstone(row));
    });
  }

  /**
   * Every tombstone naming one deletion request.
   *
   * This is the evidence a stranded request is reconciled from (ADR-0322). The pipeline writes the
   * tombstone in the **same transaction** as the `DROP SCHEMA` (ADR-0319) and ADR-0321 put the
   * request's id on it, so a tombstone naming a request exists if and only if that request's
   * deletion committed. Returning every match rather than the first is the point: two would mean the
   * premise is broken, and a `LIMIT 1` would hide that instead of reporting it.
   */
  async findForRequest(requestId: string): Promise<readonly StoredTombstone[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TOMBSTONE_COLUMNS.join(", ")} FROM ${this.table}` +
          " WHERE related_deletion_request_id = $1 ORDER BY deleted_at, tombstone_id",
        [requestId],
      );
      return result.rows.map((row) => rowToStoredTombstone(row));
    });
  }

  /**
   * Every tombstone in the table, a page at a time — the one reader that does **not** start from
   * something already naming a tombstone.
   *
   * That is the whole reason it exists (ADR-0327). `read` takes an id, `findForRequest` takes a
   * request id, and `listForTenant` takes a tenant; a tombstone written by the synchronous deletion
   * route names no request, so no audit that walks requests ever reaches it — and
   * `verifyStoredEvidence` is the only detector for a tampered `scope`, because neither
   * `proofSha256` nor the chain entry commits to it (ADR-0323).
   *
   * **Keyset-paged on a key that cannot tie.** `tombstone_id` is `NOT NULL` and uniquely
   * constrained, so the ordering is total and the cursor is exact. `deleted_at` was the natural
   * choice and is wrong: two tombstones can share it, and a sweep ordered on a key with ties either
   * re-reads a row or steps over one at every page boundary. Stepping over one is the failure that
   * matters here — the row skipped is a row nothing else will ever verify, so a tie is the
   * difference between an audit and an audit with holes in it. `OFFSET` has the same defect for a
   * different reason: a row inserted mid-sweep shifts every later page.
   *
   * Reads under the platform grant, like `read` and `listForTenant` and for a stronger version of
   * their reason: this is a cross-tenant sweep, so under the isolation policy it would see only
   * whichever tenant's context the connection happened to hold — which for a tombstone is usually
   * none at all. `tenant_tombstones_platform_audit_read` is `SELECT`-only at the policy, so the
   * elevation cannot write (ADR-0318).
   */
  async scanAll(input: {
    readonly limit: number;
    readonly afterTombstoneId?: string | null;
  }): Promise<readonly StoredTombstone[]> {
    const limit = Math.max(1, Math.min(TOMBSTONE_SCAN_MAX_LIMIT, Math.trunc(input.limit)));
    const after = input.afterTombstoneId ?? null;
    // The cursor predicate is omitted rather than written `($1 IS NULL OR tombstone_id > $1)`: that
    // form makes the planner pick one path for both shapes and gives up the unique index.
    const where = after === null ? "" : " WHERE tombstone_id > $1";
    const limitPlaceholder = after === null ? "$1" : "$2";
    const params: readonly unknown[] = after === null ? [limit] : [after, limit];
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TOMBSTONE_COLUMNS.join(", ")} FROM ${this.table}${where}` +
          ` ORDER BY tombstone_id LIMIT ${limitPlaceholder}`,
        params,
      );
      return result.rows.map((row) => rowToStoredTombstone(row));
    });
  }

  /**
   * Whether a stored tombstone still stands up: its own hashes, and its scope against the
   * attestations stored beside it.
   *
   * These are two different questions and the row answers both only because ADR-0318 gave it an
   * `attestations` column. Without the evidence, `proofOk` is all anyone could ask, and a record is
   * internally consistent with whatever it was given — including a scope nobody attested to.
   */
  async verify(tombstoneId: string): Promise<{
    readonly found: boolean;
    readonly contentManifestOk: boolean;
    readonly proofOk: boolean;
    readonly anchored: boolean;
    readonly matchesAttestations: boolean | null;
  }> {
    const stored = await this.read(tombstoneId);
    if (stored === null) {
      return {
        found: false,
        contentManifestOk: false,
        proofOk: false,
        anchored: false,
        matchesAttestations: null,
      };
    }
    const hashes = verifyTombstoneHashes(stored.record);
    return {
      found: true,
      contentManifestOk: hashes.contentManifestOk,
      proofOk: hashes.proofOk,
      anchored: stored.chainEntryHash !== null,
      // Null, not false, when there is no evidence: "cannot say" and "disagrees" are different
      // answers and an auditor must not read one as the other.
      matchesAttestations:
        stored.attestations.length === 0
          ? null
          : tombstoneMatchesAttestations(stored.record, stored.attestations),
    };
  }
}

/**
 * One row back into a record, parsed through `TombstoneRecordSchema`.
 *
 * Throws on a row the contract cannot represent, which is the behaviour the callers want: a
 * tombstone that no longer satisfies its own contract is not a shorter answer, it is a finding
 * (ADR-0289).
 */
export function rowToStoredTombstone(row: Record<string, unknown>): StoredTombstone {
  const candidate: Record<string, unknown> = {
    id: String(row["tombstone_id"]),
    kind: String(row["kind"]) as TombstoneKind,
    tenantId: String(row["tenant_id"]),
    deletedAt: isoOf(row["deleted_at"]),
    executedBy: String(row["executed_by"]),
    approvedBy: String(row["approved_by"]),
    scope: parseJson(row["scope"]),
    contentManifestSha256: String(row["content_manifest_sha256"]).trim(),
    proofSha256: String(row["proof_sha256"]).trim(),
    anchors: parseJson(row["anchors"]) ?? [],
    invalidationOfPriorTombstoneId: textOrUndefined(row["invalidation_of_prior_tombstone_id"]) ?? null,
  };
  const subject = textOrUndefined(row["subject_identifier"]);
  if (subject !== undefined) candidate["subjectIdentifier"] = subject;
  const request = textOrUndefined(row["related_deletion_request_id"]);
  if (request !== undefined) candidate["relatedDeletionRequestId"] = request;
  const reason = textOrUndefined(row["retained_reason"]);
  if (reason !== undefined) candidate["retainedReason"] = reason;
  const reference = textOrUndefined(row["retained_data_reference"]);
  if (reference !== undefined) candidate["retainedDataReference"] = reference;
  // The version is read back **explicitly** rather than inferred from whether a declaration came
  // with the row (ADR-0329): inference would read a *deleted* declaration as an older record, which
  // is a tamper that covers its own tracks. A row written before this column existed reads `v1`
  // from its column default, so the two agree.
  const proofVersion = textOrUndefined(row["proof_version"]);
  if (proofVersion !== undefined) candidate["proofVersion"] = proofVersion;
  const declaration = parseJson(row["capability_declaration"]);
  if (declaration !== null && declaration !== undefined) {
    candidate["capabilityDeclaration"] = declaration;
  }
  // `Array.isArray` and not a truthiness test (ADR-0331): `[]` is a v3 record's signed claim that
  // nothing was retained, and dropping it would relabel the record as carrying no claim — which the
  // schema then refuses, and which a verifier that tolerated it would hash under the wrong tag.
  const obligations = parseJson(row["retained_obligations"]);
  if (Array.isArray(obligations)) candidate["retainedObligations"] = obligations;
  // Handed to the schema unexamined, which is deliberate: `TombstoneRecordStorageDeclarationSchema`
  // is the one place that decides whether a stored declaration is coherent, and a second opinion
  // here — "does it look like a model?" — would be a shape check that can disagree with the one the
  // digest was computed over. A row whose column holds something else fails the parse by name.
  const storage = parseJson(row["record_storage"]);
  if (storage !== null && storage !== undefined) candidate["recordStorage"] = storage;

  const record = TombstoneRecordSchema.parse(candidate);
  const attestations = parseJson(row["attestations"]);
  const hash = row["chain_entry_hash"];
  const sequence = row["chain_sequence_number"];
  return {
    record,
    attestations: Array.isArray(attestations) ? (attestations as DeletionAttestation[]) : [],
    chainEntryHash: hash === null || hash === undefined ? null : String(hash).trim(),
    chainSequenceNumber:
      sequence === null || sequence === undefined ? null : Number(sequence),
  };
}
