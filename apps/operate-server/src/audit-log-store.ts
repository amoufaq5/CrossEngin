import type {
  AuditActor,
  AuditESignature,
  AuditEmitter,
  AuditLogEntry,
  PrincipalKind,
} from "@crossengin/auth";
import { canonicalAuditEntryPayload } from "@crossengin/auth";
import type { ChainAppendInput, ChainedLogEntry } from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

export interface AuditLogStoreOptions {
  readonly schema?: string;
  /**
   * When present, every `emit` also appends an `audit_event` chain entry committing to the
   * row's canonical content — in the **same transaction**, so the row and its anchor share a
   * fate. Omit it and rows are written unanchored, which is what a deployment with no signing
   * key can do (ADR-0286).
   */
  readonly chain?: AuditAnchorChain;
}

/** The slice of `PostgresChainLogStore` the emitter needs — an append into its own transaction. */
export interface AuditAnchorChain {
  appendWithin(tx: PgConnection, input: ChainAppendInput): Promise<ChainedLogEntry>;
}

/** One audit row's stored anchor coordinates, as verification reads them back. */
export interface AuditAnchorRef {
  readonly sequenceNumber: number;
  readonly entryHash: string;
}

/** An audit row paired with the anchor it was written with, if any. */
export interface AnchoredAuditEntry {
  readonly entry: AuditLogEntry;
  readonly anchor: AuditAnchorRef | null;
}

export interface AuditLogQuery {
  readonly operation?: string;
  readonly entity?: string;
  readonly since?: Date;
  readonly limit?: number;
}

/**
 * The elevation that satisfies `audit_log_platform_audit_write`'s `WITH CHECK`.
 *
 * Separate from `app.platform_audit` (ADR-0313's cross-tenant **read** grant) on purpose: a read
 * grant that also authorised a write would let a reader of the trail forge an entry, which is the
 * precise failure ADR-0313 split one policy into two to prevent. Transaction-local
 * (`set_config(..., true)`), never a session-wide `SET`, so no pooled connection carries it out of
 * the statement that needed it.
 *
 * It lives beside the only writer and is deliberately **not exported**: a second caller able to set
 * it is the thing this is trying not to have.
 */
const SET_PLATFORM_AUDIT_WRITE_SQL = "SELECT set_config('app.platform_audit_write', 'on', true)";

/** ADR-0313's cross-tenant read elevation, used here only to read back a platform-scope row. */
const SET_PLATFORM_AUDIT_SQL = "SELECT set_config('app.platform_audit', 'on', true)";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const ACTOR_KINDS = ["user", "ai_architect", "system"] as const satisfies readonly PrincipalKind[];

const DEFAULT_ACTOR_KIND: PrincipalKind = "user";

/**
 * `id` and `tenant_id` are UUID columns while `AuditLogEntry` types both as
 * plain strings, so a non-UUID would only fail at the driver — after the
 * transaction is open and the caller believes the record was written.
 */
const INSERT_COLUMNS =
  "tenant_id, id, occurred_at, actor, operation, entity, entity_id," +
  " before, after, diff, reason, e_signature, rego_decision_trace," +
  " chain_sequence_number, chain_entry_hash";

const INSERT_VALUES =
  "$1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13," +
  " $14, $15";

const SELECT_COLUMNS =
  "id, tenant_id, occurred_at, actor, operation, entity, entity_id," +
  " before, after, diff, reason, e_signature, rego_decision_trace," +
  " chain_sequence_number, chain_entry_hash";

const ActorSchema = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    userId: z.string().nullable(),
    sessionId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .strict();

const ESignatureSchema = z
  .object({
    method: z.string().min(1),
    challengeId: z.string().min(1),
    signedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const AuditLogEntrySchema = z
  .object({
    id: z.string().regex(UUID_RE),
    // Nullable, never optional: a platform-scope row is `tenant_id IS NULL`, and an *omitted*
    // key would be a third state the canonical payload renders the same as null while the
    // re-parse-on-read discipline (ADR-0289) could not tell apart from a column that is gone.
    tenantId: z.string().regex(UUID_RE).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    actor: ActorSchema,
    operation: z.string().min(1),
    entity: z.string().min(1),
    entityId: z.string().nullable(),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()).nullable(),
    diff: z.record(z.unknown()).nullable(),
    reason: z.string().optional(),
    eSignature: ESignatureSchema.optional(),
    regoDecisionTrace: z.string().optional(),
  })
  .strict();

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSONB comes back as a parsed object from most drivers and as text from some. */
function jsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

export function auditActor(input: {
  readonly kind?: PrincipalKind;
  readonly userId?: string | null;
  readonly sessionId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}): AuditActor {
  return {
    kind: input.kind ?? DEFAULT_ACTOR_KIND,
    userId: (input.userId ?? null) as AuditActor["userId"],
    sessionId: input.sessionId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
}

export function auditEntry(input: {
  readonly id: string;
  /** `null` is platform scope — a fact about the deployment, not about one tenant (ADR-0331). */
  readonly tenantId: string | null;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly operation: string;
  readonly entity: string;
  readonly entityId?: string | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly reason?: string;
}): AuditLogEntry {
  const base: AuditLogEntry = {
    id: input.id,
    tenantId: input.tenantId as AuditLogEntry["tenantId"],
    occurredAt: input.occurredAt,
    actor: input.actor,
    operation: input.operation,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: null,
    after: input.after ?? null,
    diff: null,
  };
  // The key is omitted, not set to undefined: an entry with `reason: undefined`
  // round-trips through JSON as a different shape than one without it.
  return input.reason === undefined ? base : { ...base, reason: input.reason };
}

function assertEmittable(entry: AuditLogEntry): void {
  if (!UUID_RE.test(entry.id)) {
    throw new Error(`audit entry id must be a UUID: ${JSON.stringify(entry.id)}`);
  }
  // A platform-scope entry carries no tenant; anything else must be a real UUID, because
  // `tenant_id` is a foreign key to `meta.tenants` and a non-UUID would only fail at the driver,
  // after the transaction is open and the caller believes the record was written.
  if (entry.tenantId !== null && !UUID_RE.test(entry.tenantId)) {
    throw new Error(`audit entry tenantId must be a UUID or null: ${JSON.stringify(entry.tenantId)}`);
  }
  if (entry.operation.trim().length === 0) {
    throw new Error("audit entry operation must be a non-empty string");
  }
  if (entry.entity.trim().length === 0) {
    throw new Error("audit entry entity must be a non-empty string");
  }
}

export function auditEntryFromRow(row: Record<string, unknown>): AuditLogEntry {
  const candidate: Record<string, unknown> = {
    id: String(row["id"]),
    // `String(null)` is `"null"`, which the schema would reject as a malformed UUID and the
    // re-parse-on-read path would then drop — so a platform row would read as an unparseable one.
    tenantId: row["tenant_id"] == null ? null : String(row["tenant_id"]),
    occurredAt: isoOf(row["occurred_at"]),
    actor: jsonObjectOrNull(row["actor"]),
    operation: String(row["operation"]),
    entity: String(row["entity"]),
    entityId: textOrNull(row["entity_id"]),
    before: jsonObjectOrNull(row["before"]),
    after: jsonObjectOrNull(row["after"]),
    diff: jsonObjectOrNull(row["diff"]),
  };
  const reason = textOrNull(row["reason"]);
  if (reason !== null) candidate["reason"] = reason;
  const signature = jsonObjectOrNull(row["e_signature"]);
  if (signature !== null) candidate["eSignature"] = signature;
  const trace = textOrNull(row["rego_decision_trace"]);
  if (trace !== null) candidate["regoDecisionTrace"] = trace;
  const parsed = AuditLogEntrySchema.parse(candidate);
  return {
    ...parsed,
    tenantId: parsed.tenantId as AuditLogEntry["tenantId"],
    actor: parsed.actor as AuditActor,
    ...(parsed.eSignature === undefined
      ? {}
      : { eSignature: parsed.eSignature as AuditESignature }),
  };
}

/**
 * Reads a row's chain coordinates. Both columns must be present for an anchor to exist — half
 * an anchor is no anchor, and reporting it as missing is the safe reading.
 */
export function anchorFromRow(row: Record<string, unknown>): AuditAnchorRef | null {
  const seq = row["chain_sequence_number"];
  const hash = row["chain_entry_hash"];
  if (seq == null || hash == null) return null;
  const sequenceNumber = Number(seq);
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) return null;
  return { sequenceNumber, entryHash: String(hash) };
}

export function tryAuditEntryFromRow(row: Record<string, unknown>): AuditLogEntry | null {
  try {
    return auditEntryFromRow(row);
  } catch {
    return null;
  }
}

/**
 * The platform's audit writer over `meta.audit_log` — the table
 * `@crossengin/auth` has modelled since Phase 1. General on purpose: any
 * privileged action that must leave a record emits through this seam.
 *
 * INVARIANT: the log is APPEND-ONLY. `emit` is a plain INSERT with no
 * `ON CONFLICT`, there is no update path, and the class exposes no delete —
 * an audit record that can be rewritten is not an audit record. Retention is a
 * database-level concern, never an application one.
 *
 * The table carries tenant RLS, so every method runs inside `withTenantContext`
 * (which binds `app.current_tenant_id` for the transaction) AND binds
 * `tenant_id = $1` as an explicit predicate — defense in depth. The validated
 * schema name is the only interpolated identifier; every value is bound.
 */
export class PostgresAuditEmitter implements AuditEmitter {
  private readonly conn: PgConnection;
  private readonly schema: string;
  private readonly chain: AuditAnchorChain | null;

  constructor(conn: PgConnection, opts: AuditLogStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
    this.chain = opts.chain ?? null;
  }

  private get table(): string {
    return `${this.schema}.audit_log`;
  }

  /** Whether this emitter anchors what it writes into a tamper-evident chain. */
  anchors(): boolean {
    return this.chain !== null;
  }

  async emit(entry: AuditLogEntry): Promise<void> {
    assertEmittable(entry);
    await this.inScope(entry.tenantId, "write", async (tx) => {
      // The anchor is appended BEFORE the row, so the row can be inserted with its chain
      // coordinates already known — no UPDATE, which would give this append-only table a
      // rewrite path. Both statements are in the caller's transaction: a failed anchor rolls
      // the row back, so `emit` throwing means nothing was written, and ADR-0279's fail-closed
      // caller (503 `audit_unavailable`) covers an unanchorable record too.
      const anchor =
        this.chain === null
          ? null
          : await this.chain.appendWithin(tx, {
              tenantId: entry.tenantId,
              kind: "audit_event",
              actorReference: entry.actor.userId ?? "system",
              recordedAt: entry.occurredAt,
              payload: canonicalAuditEntryPayload(entry),
            });
      const sql = `INSERT INTO ${this.table} (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`;
      await tx.query(sql, [
        entry.tenantId,
        entry.id,
        // The caller's clock is the event time. Defaulting to the database's
        // `now()` would misdate a record queued or retried after the fact.
        entry.occurredAt,
        JSON.stringify(entry.actor),
        entry.operation,
        entry.entity,
        entry.entityId,
        entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === null ? null : JSON.stringify(entry.after),
        entry.diff === null ? null : JSON.stringify(entry.diff),
        entry.reason ?? null,
        entry.eSignature === undefined ? null : JSON.stringify(entry.eSignature),
        entry.regoDecisionTrace ?? null,
        anchor === null ? null : anchor.sequenceNumber,
        anchor === null ? null : anchor.entryHash,
      ]);
    });
  }

  /**
   * Opens the transaction one write or read runs in, under the RLS context its scope requires.
   *
   * The two paths are not interchangeable, and the asymmetry is the security property.
   *
   * A **tenant** scope sets `app.current_tenant_id` and never the platform flag, so the isolation
   * policy confines the statement even if the predicate were wrong.
   *
   * A **platform** scope (`null`) sets `app.platform_audit_write`, which satisfies the
   * `INSERT`-scoped policy whose `WITH CHECK` is `tenant_id IS NULL AND …`. Three things about that
   * are deliberate. It is a *different* GUC from `app.platform_audit`: that one is the cross-tenant
   * **read** elevation (ADR-0313), and letting a read grant also authorise a write is the shape of
   * forgery ADR-0313 split its policies to prevent — here it would let a reader of the trail forge a
   * platform-scope entry claiming a page was delivered. It is `INSERT`-scoped, so it carries no
   * `USING` and therefore cannot serve an `UPDATE` or `DELETE`: the table stays append-only at the
   * policy as well as in this class. And because the elevation's check also demands
   * `tenant_id IS NULL`, holding it buys no ability to write into any *tenant's* chain — the
   * isolation policy is still the only route to a tenant row, and it still demands that tenant's
   * context.
   *
   * `access` picks which platform elevation is set, and the narrower one is never widened: an
   * `emit` transaction cannot read other scopes' rows and a verification read cannot insert.
   */
  private async inScope<T>(
    scope: string | null,
    access: "read" | "write",
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (scope !== null) return withTenantContext(this.conn, scope, fn);
    return this.conn.transaction(async (tx) => {
      await tx.query(access === "write" ? SET_PLATFORM_AUDIT_WRITE_SQL : SET_PLATFORM_AUDIT_SQL);
      return fn(tx);
    });
  }

  /** Shared filter construction for both list paths, so they can never drift apart. */
  private whereFor(scope: string | null, query: AuditLogQuery): {
    readonly conditions: readonly string[];
    readonly params: unknown[];
  } {
    // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`
    // and cannot ride along as a bound parameter. The predicate is still the scope's, beside RLS.
    const params: unknown[] = scope === null ? [] : [scope];
    const conditions: string[] = scope === null ? ["tenant_id IS NULL"] : ["tenant_id = $1"];
    if (query.operation !== undefined) {
      params.push(query.operation);
      conditions.push(`operation = $${params.length}`);
    }
    if (query.entity !== undefined) {
      params.push(query.entity);
      conditions.push(`entity = $${params.length}`);
    }
    if (query.since !== undefined) {
      params.push(query.since);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    return { conditions, params };
  }

  async listForTenant(
    tenantId: string,
    query: AuditLogQuery = {},
  ): Promise<readonly AuditLogEntry[]> {
    const anchored = await this.listAnchoredForTenant(tenantId, query);
    return anchored.map((a) => a.entry);
  }

  /**
   * The same read as `listForTenant`, but keeping each row's chain coordinates — what
   * verification needs to find the entry that commits to a given row. Ordered oldest-first,
   * the order a chain is verified in, rather than the newest-first a human reads in.
   */
  async listAnchoredForTenant(
    tenantId: string,
    query: AuditLogQuery = {},
  ): Promise<readonly AnchoredAuditEntry[]> {
    return this.listAnchoredForScope(tenantId, query);
  }

  /**
   * The same read for either scope, which is what makes a platform-scope row *verifiable* rather
   * than merely writable.
   *
   * The anchor check is the only detector there is for an edited audit row (ADR-0286), and until
   * this existed `proveScopeIntegrity` skipped it for the platform chain on the grounds that there
   * were no platform audit rows. Writing them without this would have reproduced ADR-0327's shape
   * exactly — a proof nobody reads — in the table the whole forensics stack exists to protect.
   */
  async listAnchoredForScope(
    scope: string | null,
    query: AuditLogQuery = {},
  ): Promise<readonly AnchoredAuditEntry[]> {
    const limit = clampLimit(query.limit);
    return this.inScope(scope, "read", async (tx) => {
      const { conditions, params } = this.whereFor(scope, query);
      params.push(limit);
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`;
      const result = await tx.query(sql, params);
      const out: AnchoredAuditEntry[] = [];
      for (const row of result.rows) {
        // A row the current contract cannot represent is dropped rather than
        // failing the whole read: an old record must not hide every newer one.
        const entry = tryAuditEntryFromRow(row);
        if (entry !== null) out.push({ entry, anchor: anchorFromRow(row) });
      }
      return out;
    });
  }

  /**
   * `scope` is nullable because this is the "how often does our paging path fail" query
   * `page-record.ts` names (`countSince(scope, since, PAGE_UNDELIVERED_OPERATION)`), and the SLO
   * loop's pages are exactly the ones that land platform-scope — so a tenant-only counter would
   * answer zero for the surface most likely to be failing.
   */
  async countSince(scope: string | null, since: Date, operation?: string): Promise<number> {
    return this.inScope(scope, "read", async (tx) => {
      const params: unknown[] = scope === null ? [since] : [scope, since];
      const conditions: string[] =
        scope === null
          ? ["tenant_id IS NULL", "occurred_at >= $1"]
          : ["tenant_id = $1", "occurred_at >= $2"];
      if (operation !== undefined) {
        params.push(operation);
        conditions.push(`operation = $${params.length}`);
      }
      const sql =
        `SELECT count(*) AS audit_rows FROM ${this.table}` +
        ` WHERE ${conditions.join(" AND ")}`;
      const result = await tx.query(sql, params);
      const row = result.rows[0];
      if (row === undefined) return 0;
      return Number(row["audit_rows"]);
    });
  }
}
