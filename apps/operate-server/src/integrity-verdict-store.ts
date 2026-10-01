import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

/**
 * The readable projection of an audit-integrity verdict (ADR-0287 follow-up).
 *
 * **The row is not the proof.** ADR-0287 recorded every verdict as a forensic-chain entry
 * precisely because a verdict in an ordinary table can be deleted by the same superuser who
 * edited the audit log, whereas editing a chain entry — or removing one that is not the
 * newest — breaks a link. The chain, however, stores only a *commitment*: the payload bytes
 * are hashed, not kept, so "show me last month's verifications" cannot be answered from it.
 *
 * This table answers that question and nothing more. A row here, on its own, proves nothing:
 * it could have been inserted or edited by anyone who can write to `meta`. What makes it
 * trustworthy is `chain_entry_hash` — the entry the verdict was committed to — so a reader can
 * go to the chain and confirm the two agree, and notice when a row names no entry at all. That
 * is why the hash is stored and why every route response carries it.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const VERDICT_ID_RE = /^aiv_[a-z0-9]{8,40}$/;

/** Mirrors `integrity-proof.ts`'s `INTEGRITY_VERDICTS` and the column's CHECK constraint. */
export const STORED_INTEGRITY_VERDICTS = ["verified", "unproven", "compromised"] as const;
export type StoredIntegrityVerdict = (typeof STORED_INTEGRITY_VERDICTS)[number];

const CHAIN_MODES = ["full", "from_checkpoint"] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** How many hex characters of the content hash make up a `aiv_…` id (within the CHECK's 8–40). */
const VERDICT_ID_HEX_LENGTH = 32;

/**
 * Elevates the transaction to the cross-tenant audit-read scope the RLS policy on
 * `meta.audit_integrity_verdicts` recognizes
 * (`... OR current_setting('app.platform_audit', true) = 'on'`).
 *
 * A **different** flag from `app.platform_review`: reading every tenant's integrity verdicts is
 * not the same privilege as reviewing design proposals, and one grant must not carry the other.
 * The `true` third argument makes the setting transaction-local, so the elevation is released
 * with the transaction and can never leak onto a pooled connection.
 */
const SET_PLATFORM_AUDIT_SQL = "SELECT set_config('app.platform_audit', 'on', true)";

/**
 * The chain's committed projection of one verdict, stored verbatim in `report`.
 *
 * Deliberately the *same* shape `integrityVerdictPayload` commits to — not the whole
 * `IntegrityProofReport`. Two reasons. It is bounded: the full report carries a per-entry
 * signature result and a per-row anchor result, up to 500 of each, which would make an hourly
 * verdict per tenant an expensive way to store a summary. And it is comparable: the row holds
 * exactly the content the chain entry attests to, so the two can be checked against each other
 * rather than merely cross-referenced.
 */
const StoredIntegrityReportSchema = z
  .object({
    kind: z.literal("audit_integrity_proof"),
    /** Tenant id, or null for the platform chain, which has no tenant. */
    scope: z.string().min(1).nullable(),
    verdict: z.enum(STORED_INTEGRITY_VERDICTS),
    verifiedAt: z.string().datetime({ offset: true }),
    chain: z
      .object({
        ok: z.boolean(),
        mode: z.enum(CHAIN_MODES),
        checkpointSequence: z.number().int().nonnegative().nullable(),
        integrityValid: z.boolean(),
        brokenAt: z.number().int().nullable(),
        signaturesValid: z.boolean(),
      })
      .strict(),
    truncation: z
      .object({
        checkpointSequence: z.number().int().nonnegative().nullable(),
        tailSequence: z.number().int().nonnegative().nullable(),
        truncated: z.boolean(),
      })
      .strict(),
    anchors: z
      .object({
        checked: z.number().int().nonnegative(),
        verified: z.number().int().nonnegative(),
        unanchored: z.number().int().nonnegative(),
        tampered: z.array(
          z
            .object({
              auditId: z.string().min(1),
              verdict: z.string().min(1),
              sequenceNumber: z.number().int().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type StoredIntegrityReport = z.infer<typeof StoredIntegrityReportSchema>;

const SHA256_RE = /^[0-9a-f]{64}$/;

const IntegrityVerdictRecordSchema = z
  .object({
    id: z.string().regex(UUID_RE),
    verdictId: z.string().regex(VERDICT_ID_RE),
    /** Null for the platform chain. */
    scope: z.string().regex(UUID_RE).nullable(),
    verdict: z.enum(STORED_INTEGRITY_VERDICTS),
    verifiedAt: z.string().datetime({ offset: true }),
    anchorsChecked: z.number().int().nonnegative(),
    anchorsVerified: z.number().int().nonnegative(),
    anchorsTampered: z.number().int().nonnegative(),
    anchorsUnanchored: z.number().int().nonnegative(),
    chainOk: z.boolean().nullable(),
    truncated: z.boolean(),
    report: StoredIntegrityReportSchema,
    chainEntryHash: z.string().min(1).nullable(),
    chainSequenceNumber: z.number().int().nonnegative().nullable(),
    payloadSha256: z.string().regex(SHA256_RE).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type IntegrityVerdictRecord = z.infer<typeof IntegrityVerdictRecordSchema>;

/**
 * Structural mirror of `integrity-proof.ts`'s `IntegrityProofReport`.
 *
 * Declared here rather than imported so this module never depends on the scheduler — which will
 * import *this* one to persist a verdict. Same reason ADR-0288 gave `IntegrityEscalationOutcome`
 * a structural mirror instead of a cycle.
 */
export interface IntegrityProofReportLike {
  readonly scope: string | null;
  readonly verdict: StoredIntegrityVerdict;
  readonly verifiedAt: string;
  readonly chain: {
    readonly ok: boolean;
    readonly mode: string;
    readonly checkpointSequence: number | null;
    readonly integrity: { readonly valid: boolean; readonly brokenAt: number | null };
    readonly signatures: { readonly valid: boolean };
  };
  readonly anchors: {
    readonly checked: number;
    readonly verified: number;
    readonly unanchored: number;
    readonly tampered: readonly {
      readonly auditId: string;
      readonly verdict: string;
      readonly sequenceNumber: number | null;
    }[];
  } | null;
  readonly truncation: {
    readonly checkpointSequence: number | null;
    readonly tailSequence: number | null;
    readonly truncated: boolean;
  };
}

/**
 * The chain entry a verdict was committed to. Both halves or neither: the hash is the pointer a
 * reader verifies against, the sequence is what lets them seek to it instead of scanning the chain
 * — `meta.audit_log` stores both for the same reason (ADR-0286). A pass configured with
 * `recordVerdict: false` appended nothing, and leaves both null.
 */
export interface IntegrityVerdictAnchor {
  readonly chainEntryHash: string | null;
  /** `IntegrityProofPassResult.recordedAt` — the sequence the verdict entry was appended at. */
  readonly chainSequenceNumber: number | null;
}

const NO_ANCHOR: IntegrityVerdictAnchor = { chainEntryHash: null, chainSequenceNumber: null };

export interface IntegrityVerdictInput {
  readonly verdictId: string;
  readonly report: StoredIntegrityReport;
  readonly anchor: IntegrityVerdictAnchor;
}

/** Which rows a read may see. The caller's authorisation decides this; the store only executes it. */
export type IntegrityVerdictReadScope =
  | { readonly kind: "tenant"; readonly tenantId: string }
  /** The platform chain's own verdicts (`tenant_id IS NULL`), reachable only under elevation. */
  | { readonly kind: "platform" }
  /** Every tenant and the platform chain. */
  | { readonly kind: "all" };

export interface IntegrityVerdictListQuery {
  readonly scope: IntegrityVerdictReadScope;
  readonly verdict?: StoredIntegrityVerdict;
  /** Inclusive lower bound on `verified_at`. */
  readonly from?: string;
  /** Exclusive upper bound on `verified_at`. */
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IntegrityVerdictListPage {
  readonly data: readonly IntegrityVerdictRecord[];
  readonly nextCursor: string | null;
}

export interface IntegrityVerdictCounts {
  readonly verified: number;
  readonly unproven: number;
  readonly compromised: number;
  readonly total: number;
}

export interface IntegrityVerdictWriteResult {
  readonly record: IntegrityVerdictRecord;
  /** False when this exact verdict was already stored, so a replayed pass is a no-op. */
  readonly inserted: boolean;
}

const SELECT_COLUMNS =
  "id, verdict_id, tenant_id, verdict, verified_at, anchors_checked, anchors_verified," +
  " anchors_tampered, anchors_unanchored, chain_ok, truncated, report, chain_entry_hash," +
  " chain_sequence_number, payload_sha256, created_at";

/**
 * The bytes a verdict's id is derived from. Key order is fixed by construction here, so the same
 * verdict always hashes to the same id and re-recording a pass is idempotent against the
 * `verdict_id` unique constraint rather than duplicating the row.
 */
export function canonicalStoredReport(report: StoredIntegrityReport): string {
  return JSON.stringify({
    kind: report.kind,
    scope: report.scope,
    verdict: report.verdict,
    verifiedAt: report.verifiedAt,
    chain: {
      ok: report.chain.ok,
      mode: report.chain.mode,
      checkpointSequence: report.chain.checkpointSequence,
      integrityValid: report.chain.integrityValid,
      brokenAt: report.chain.brokenAt,
      signaturesValid: report.chain.signaturesValid,
    },
    truncation: {
      checkpointSequence: report.truncation.checkpointSequence,
      tailSequence: report.truncation.tailSequence,
      truncated: report.truncation.truncated,
    },
    anchors:
      report.anchors === null
        ? null
        : {
            checked: report.anchors.checked,
            verified: report.anchors.verified,
            unanchored: report.anchors.unanchored,
            tampered: report.anchors.tampered.map((t) => ({
              auditId: t.auditId,
              verdict: t.verdict,
              sequenceNumber: t.sequenceNumber,
            })),
          },
  });
}

/**
 * The digest the chain entry commits to for this verdict, stored in `payload_sha256`.
 *
 * `canonicalStoredReport` emits the same keys in the same order as `integrity-proof.ts`'s
 * `integrityVerdictPayload`, so this is the chain entry's own `payloadSha256` — the row can be
 * checked against the entry by *content*, not just by pointer. The parity is deliberate and
 * pinned by a test that hashes both; it cannot be enforced by importing that function, because
 * that module imports this one to persist a verdict.
 */
export function integrityVerdictPayloadSha256(report: StoredIntegrityReport): string {
  return sha256(canonicalStoredReport(report));
}

/**
 * Content-addressed id, so the same verdict cannot be stored twice. A prefix of the payload digest
 * above, which is why the two can never disagree about which verdict they identify.
 */
export function integrityVerdictIdFor(report: StoredIntegrityReport): string {
  return `aiv_${integrityVerdictPayloadSha256(report).slice(0, VERDICT_ID_HEX_LENGTH)}`;
}

/** Projects a proof report onto the shape the chain commits to and this table stores. */
export function storedIntegrityReportFor(report: IntegrityProofReportLike): StoredIntegrityReport {
  return StoredIntegrityReportSchema.parse({
    kind: "audit_integrity_proof",
    scope: report.scope,
    verdict: report.verdict,
    verifiedAt: report.verifiedAt,
    chain: {
      ok: report.chain.ok,
      mode: report.chain.mode,
      checkpointSequence: report.chain.checkpointSequence,
      integrityValid: report.chain.integrity.valid,
      brokenAt: report.chain.integrity.brokenAt,
      signaturesValid: report.chain.signatures.valid,
    },
    truncation: {
      checkpointSequence: report.truncation.checkpointSequence,
      tailSequence: report.truncation.tailSequence,
      truncated: report.truncation.truncated,
    },
    anchors:
      report.anchors === null
        ? null
        : {
            checked: report.anchors.checked,
            verified: report.anchors.verified,
            unanchored: report.anchors.unanchored,
            tampered: report.anchors.tampered.map((t) => ({
              auditId: t.auditId,
              verdict: t.verdict,
              sequenceNumber: t.sequenceNumber,
            })),
          },
  });
}

/** The insert a scheduler pass makes: the projection, its content-addressed id, and the anchor. */
export function integrityVerdictInputFor(
  report: IntegrityProofReportLike,
  anchor: IntegrityVerdictAnchor = NO_ANCHOR,
): IntegrityVerdictInput {
  const stored = storedIntegrityReportFor(report);
  return { verdictId: integrityVerdictIdFor(stored), report: stored, anchor };
}

export interface IntegrityVerdictCursor {
  readonly verifiedAt: string;
  readonly verdictId: string;
}

export function encodeIntegrityVerdictCursor(cursor: IntegrityVerdictCursor): string {
  return Buffer.from(`v1:${cursor.verifiedAt}:${cursor.verdictId}`, "utf8").toString("base64url");
}

/**
 * Null for anything that is not a cursor this store issued.
 *
 * Deliberately not "fall back to the first page": a cursor that silently rewinds makes a caller
 * paging through a month of verdicts re-read rows they have already seen and believe the page
 * after it does not exist. A refusal is the only honest answer.
 */
export function decodeIntegrityVerdictCursor(
  cursor: string | undefined,
): IntegrityVerdictCursor | null {
  if (cursor === undefined || cursor.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^v1:(.+):(aiv_[a-z0-9]{8,40})$/.exec(decoded);
  if (match === null) return null;
  const verifiedAt = match[1] ?? "";
  const verdictId = match[2] ?? "";
  if (Number.isNaN(Date.parse(verifiedAt))) return null;
  return { verifiedAt, verdictId };
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function intOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function boolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  return String(value) === "true" || String(value) === "t";
}

/** node-postgres yields JSONB parsed, but a scripted or raw driver may hand back the text form. */
function jsonOf(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function sameInstant(a: string, b: unknown): boolean {
  const left = Date.parse(a);
  const right = b instanceof Date ? b.getTime() : Date.parse(String(b));
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Runs `fn` inside a transaction carrying the cross-tenant audit-read elevation — the explicit,
 * auditable opt-in the RLS policy requires, rather than relying on the API happening to connect
 * as the table owner (which bypasses RLS silently and invisibly).
 *
 * Modelled on `withTenantContext`: `SELECT set_config(..., true)`, never a session-wide `SET`.
 */
export async function withPlatformAudit<T>(
  conn: PgConnection,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  return conn.transaction(async (tx) => {
    await tx.query(SET_PLATFORM_AUDIT_SQL);
    return fn(tx);
  });
}

export interface PostgresIntegrityVerdictStoreOptions {
  readonly schema?: string;
}

/**
 * `meta.audit_integrity_verdicts` as the readable index of audit-integrity proof passes.
 *
 * Scope decides the RLS path, and the distinction is the security property: a tenant-scoped read
 * runs under `withTenantContext` only, so a platform-chain verdict (`tenant_id IS NULL`) fails the
 * policy's `tenant_id = current_setting(...)` and is **invisible** — a platform tamper finding is
 * not broadcast to every tenant. Cross-tenant and platform reads run under `withPlatformAudit`.
 * A tenant-scoped read must never set that flag, and the tenant id is bound as a WHERE predicate
 * too, so the row filter does not rest on RLS alone.
 */
export class PostgresIntegrityVerdictStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresIntegrityVerdictStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.audit_integrity_verdicts`;
  }

  /**
   * Re-validates a row rather than trusting it — the same discipline every store here follows,
   * and the reason this projection is safe to serve at all. The stored report is parsed back
   * through its schema, and then the scalar columns are checked **against it**: a row whose
   * `verdict` column was edited to 'verified' while the JSONB still reads 'compromised' is the
   * precise shape a tamper would take, and nothing in the database would refuse it — the CHECK
   * constraints see one column at a time. A mismatch throws, so the row is not served.
   */
  private rowToRecord(row: Record<string, unknown>): IntegrityVerdictRecord {
    const record = IntegrityVerdictRecordSchema.parse({
      id: String(row["id"]),
      verdictId: String(row["verdict_id"]),
      scope: row["tenant_id"] == null ? null : String(row["tenant_id"]),
      verdict: String(row["verdict"]),
      verifiedAt: isoOf(row["verified_at"]),
      anchorsChecked: intOf(row["anchors_checked"], -1),
      anchorsVerified: intOf(row["anchors_verified"], -1),
      anchorsTampered: intOf(row["anchors_tampered"], -1),
      anchorsUnanchored: intOf(row["anchors_unanchored"], -1),
      chainOk: boolOrNull(row["chain_ok"]),
      truncated: boolOrNull(row["truncated"]) ?? false,
      report: jsonOf(row["report"]),
      chainEntryHash: row["chain_entry_hash"] == null ? null : String(row["chain_entry_hash"]),
      chainSequenceNumber:
        row["chain_sequence_number"] == null ? null : intOf(row["chain_sequence_number"], -1),
      payloadSha256: row["payload_sha256"] == null ? null : String(row["payload_sha256"]),
      createdAt: isoOf(row["created_at"]),
    });
    const mismatches = storedReportMismatches(record);
    if (mismatches.length > 0) {
      throw new Error(
        `stored integrity verdict ${record.verdictId} disagrees with its report: ${mismatches.join(", ")}`,
      );
    }
    return record;
  }

  /**
   * Stores one verdict. Idempotent on `verdict_id`, which is content-addressed, so a pass replayed
   * after a crash between the chain append and this insert cannot produce a second row.
   *
   * A platform-scope verdict (`tenant_id IS NULL`) can only be written under the elevation: the
   * policy's `tenant_id = current_setting(...)` is never true for NULL, so the insert's WITH CHECK
   * would refuse it inside a tenant context.
   */
  async record(input: IntegrityVerdictInput): Promise<IntegrityVerdictWriteResult> {
    if (!VERDICT_ID_RE.test(input.verdictId)) {
      throw new Error(`invalid verdict id: ${JSON.stringify(input.verdictId)}`);
    }
    const report = StoredIntegrityReportSchema.parse(input.report);
    const anchor = input.anchor;
    if ((anchor.chainEntryHash === null) !== (anchor.chainSequenceNumber === null)) {
      // Half an anchor is worse than none: a reader would believe the verdict was committed and
      // have no way to find, or no way to check, the entry it names.
      throw new Error("integrity verdict anchor needs both a chain entry hash and a sequence");
    }
    const scope = report.scope;
    const params: unknown[] = [
      input.verdictId,
      scope,
      report.verdict,
      report.verifiedAt,
      report.anchors?.checked ?? 0,
      report.anchors?.verified ?? 0,
      report.anchors?.tampered.length ?? 0,
      report.anchors?.unanchored ?? 0,
      report.chain.ok,
      report.truncation.truncated,
      JSON.stringify(report),
      anchor.chainEntryHash,
      anchor.chainSequenceNumber,
      // Derived, never taken from the caller: a digest the writer could choose would not be
      // evidence of anything, and deriving it makes the row agree with its own report by
      // construction. A later disagreement is therefore an edit, which is what the read check looks for.
      integrityVerdictPayloadSha256(report),
    ];
    const insertSql =
      `INSERT INTO ${this.table} (verdict_id, tenant_id, verdict, verified_at,` +
      " anchors_checked, anchors_verified, anchors_tampered, anchors_unanchored, chain_ok," +
      " truncated, report, chain_entry_hash, chain_sequence_number, payload_sha256)" +
      " VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)" +
      ` ON CONFLICT (verdict_id) DO NOTHING RETURNING ${SELECT_COLUMNS}`;
    const selectSql = `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE verdict_id = $1`;

    const run = async (tx: PgConnection): Promise<IntegrityVerdictWriteResult> => {
      const inserted = await tx.query(insertSql, params);
      const row = inserted.rows[0];
      if (row !== undefined) return { record: this.rowToRecord(row), inserted: true };
      const existing = await tx.query(selectSql, [input.verdictId]);
      const prior = existing.rows[0];
      if (prior === undefined) {
        // Nothing inserted and nothing there: the row exists but is invisible under this scope,
        // which means the caller wrote it into a tenant it cannot read. Fail loudly.
        throw new Error(`integrity verdict ${input.verdictId} was neither inserted nor readable`);
      }
      return { record: this.rowToRecord(prior), inserted: false };
    };

    return scope === null
      ? withPlatformAudit(this.conn, run)
      : withTenantContext(this.conn, scope, run);
  }

  async getByVerdictId(
    verdictId: string,
    scope: IntegrityVerdictReadScope,
  ): Promise<IntegrityVerdictRecord | null> {
    if (!VERDICT_ID_RE.test(verdictId)) return null;
    return this.read(scope, async (tx, base) => {
      const params = [...base.params, verdictId];
      const where = [...base.conditions, `verdict_id = $${params.length.toString()}`];
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${where.join(" AND ")}`,
        params,
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  /**
   * "Show me last month's verifications": a scope, a time window, an optional verdict filter, and
   * a bounded page. Pagination is **keyset** on `(verified_at DESC, verdict_id DESC)`, not offset:
   * verdicts arrive continuously, and an offset page would skip or repeat rows as the table grows
   * underneath a caller walking a month of history.
   */
  async list(query: IntegrityVerdictListQuery): Promise<IntegrityVerdictListPage> {
    const limit = clampLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodeIntegrityVerdictCursor(query.cursor);
    if (query.cursor !== undefined && query.cursor.length > 0 && cursor === null) {
      throw new Error(`invalid integrity verdict cursor: ${JSON.stringify(query.cursor)}`);
    }
    return this.read(query.scope, async (tx, base) => {
      const params = [...base.params];
      const conditions = [...base.conditions, ...this.filters(query, params)];
      if (cursor !== null) {
        params.push(cursor.verifiedAt);
        const atParam = params.length;
        params.push(cursor.verdictId);
        const idParam = params.length;
        conditions.push(
          `(verified_at < $${atParam.toString()}::timestamptz OR (verified_at = $${atParam.toString()}::timestamptz` +
            ` AND verdict_id < $${idParam.toString()}))`,
        );
      }
      params.push(limit + 1);
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY verified_at DESC, verdict_id DESC LIMIT $${params.length.toString()}`;
      const result = await tx.query(sql, params);
      const rows = result.rows.map((r) => this.rowToRecord(r));
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const last = data[data.length - 1];
      return {
        data,
        nextCursor:
          hasMore && last !== undefined
            ? encodeIntegrityVerdictCursor({
                verifiedAt: last.verifiedAt,
                verdictId: last.verdictId,
              })
            : null,
      };
    });
  }

  /** The verdict tally over the same scope and window the listing uses. */
  async counts(
    query: Omit<IntegrityVerdictListQuery, "limit" | "cursor">,
  ): Promise<IntegrityVerdictCounts> {
    return this.read(query.scope, async (tx, base) => {
      const params = [...base.params];
      const conditions = [...base.conditions, ...this.filters(query, params)];
      const result = await tx.query(
        `SELECT verdict, count(*)::int AS n FROM ${this.table}` +
          ` WHERE ${conditions.join(" AND ")} GROUP BY verdict`,
        params,
      );
      const buckets: Record<StoredIntegrityVerdict, number> = {
        verified: 0,
        unproven: 0,
        compromised: 0,
      };
      for (const row of result.rows) {
        const parsed = z.enum(STORED_INTEGRITY_VERDICTS).safeParse(String(row["verdict"]));
        if (!parsed.success) continue;
        buckets[parsed.data] += intOf(row["n"], 0);
      }
      return {
        verified: buckets.verified,
        unproven: buckets.unproven,
        compromised: buckets.compromised,
        total: buckets.verified + buckets.unproven + buckets.compromised,
      };
    });
  }

  /** The newest verdict in scope, which is what a status panel asks for. */
  async latest(scope: IntegrityVerdictReadScope): Promise<IntegrityVerdictRecord | null> {
    return this.read(scope, async (tx, base) => {
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${base.conditions.join(" AND ")}` +
          " ORDER BY verified_at DESC, verdict_id DESC LIMIT 1",
        base.params,
      );
      const row = result.rows[0];
      return row === undefined ? null : this.rowToRecord(row);
    });
  }

  private filters(
    query: Pick<IntegrityVerdictListQuery, "verdict" | "from" | "to">,
    params: unknown[],
  ): string[] {
    const conditions: string[] = [];
    if (query.verdict !== undefined) {
      params.push(query.verdict);
      conditions.push(`verdict = $${params.length.toString()}`);
    }
    if (query.from !== undefined) {
      params.push(query.from);
      conditions.push(`verified_at >= $${params.length.toString()}::timestamptz`);
    }
    if (query.to !== undefined) {
      params.push(query.to);
      conditions.push(`verified_at < $${params.length.toString()}::timestamptz`);
    }
    return conditions;
  }

  /**
   * Opens the transaction a read runs in and builds its base predicate.
   *
   * The two paths are not interchangeable. A tenant scope sets `app.current_tenant_id` and
   * **never** the platform flag, so RLS confines it to that tenant's rows and hides the
   * platform chain's. `platform` and `all` set `app.platform_audit`, the explicit cross-tenant
   * grant, and `platform` narrows to `tenant_id IS NULL` on top of it.
   */
  private async read<T>(
    scope: IntegrityVerdictReadScope,
    fn: (
      tx: PgConnection,
      base: { readonly conditions: readonly string[]; readonly params: readonly unknown[] },
    ) => Promise<T>,
  ): Promise<T> {
    if (scope.kind === "tenant") {
      return withTenantContext(this.conn, scope.tenantId, (tx) =>
        fn(tx, { conditions: ["tenant_id = $1"], params: [scope.tenantId] }),
      );
    }
    const conditions = scope.kind === "platform" ? ["tenant_id IS NULL"] : ["TRUE"];
    return withPlatformAudit(this.conn, (tx) => fn(tx, { conditions, params: [] }));
  }
}

/**
 * Where a row's scalar columns disagree with the report they are supposed to summarise.
 *
 * Exported because this is the check that makes the projection trustworthy, and it is worth
 * pinning on its own: a `TableDefinition` has no table-level CHECK, so no constraint in the
 * database can compare two columns, let alone a column against a JSONB field.
 */
export function storedReportMismatches(record: IntegrityVerdictRecord): readonly string[] {
  const r = record.report;
  const issues: string[] = [];
  if (r.verdict !== record.verdict) issues.push(`verdict ${record.verdict} vs ${r.verdict}`);
  if (!sameInstant(r.verifiedAt, record.verifiedAt)) {
    issues.push(`verifiedAt ${record.verifiedAt} vs ${r.verifiedAt}`);
  }
  if ((r.scope ?? null) !== record.scope) issues.push(`scope ${String(record.scope)} vs ${String(r.scope)}`);
  if (r.truncation.truncated !== record.truncated) {
    issues.push(`truncated ${String(record.truncated)} vs ${String(r.truncation.truncated)}`);
  }
  // `chain_ok` is nullable, so an absent column means "not recorded" and is not a disagreement.
  if (record.chainOk !== null && r.chain.ok !== record.chainOk) {
    issues.push(`chainOk ${String(record.chainOk)} vs ${String(r.chain.ok)}`);
  }
  const checked = r.anchors?.checked ?? 0;
  const verified = r.anchors?.verified ?? 0;
  const tampered = r.anchors?.tampered.length ?? 0;
  const unanchored = r.anchors?.unanchored ?? 0;
  if (checked !== record.anchorsChecked) issues.push(`anchorsChecked ${record.anchorsChecked.toString()} vs ${checked.toString()}`);
  if (verified !== record.anchorsVerified) issues.push(`anchorsVerified ${record.anchorsVerified.toString()} vs ${verified.toString()}`);
  if (tampered !== record.anchorsTampered) issues.push(`anchorsTampered ${record.anchorsTampered.toString()} vs ${tampered.toString()}`);
  if (unanchored !== record.anchorsUnanchored) {
    issues.push(`anchorsUnanchored ${record.anchorsUnanchored.toString()} vs ${unanchored.toString()}`);
  }
  // The strongest of these checks: `payload_sha256` is the digest the chain entry committed to, and
  // it is derived from `report` at write time, so the two agree unless one of them was edited
  // afterwards. Editing the report to hide a finding and leaving the digest is caught here; editing
  // both still leaves a digest that no longer matches the chain entry, which is the point of
  // keeping the proof outside this table.
  if (record.payloadSha256 !== null) {
    const expected = integrityVerdictPayloadSha256(r);
    if (expected !== record.payloadSha256) {
      issues.push(`payloadSha256 ${record.payloadSha256} vs ${expected}`);
    }
  }
  // The verdict id is a prefix of that same digest, so a row whose id does not match its report is
  // claiming to be a different verdict than the one it carries.
  const expectedId = integrityVerdictIdFor(r);
  if (expectedId !== record.verdictId) issues.push(`verdictId ${record.verdictId} vs ${expectedId}`);
  // A two-column rule with nowhere else to live: `TableDefinition` has no table-level CHECK, so
  // nothing in the database refuses a hash with no sequence or a sequence with no hash.
  if ((record.chainEntryHash === null) !== (record.chainSequenceNumber === null)) {
    issues.push("chain anchor is half-present");
  }
  return issues;
}
