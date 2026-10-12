import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

import { anchorFromRow, auditEntryFromRow, type AnchoredAuditEntry } from "./audit-log-store.js";
import { withPlatformAudit } from "./integrity-verdict-store.js";

/**
 * The read side of `meta.audit_log` (the ADR-0279 follow-up).
 *
 * `PostgresAuditEmitter` writes the trail and verification walks it, but nothing could *read* it:
 * answering "who changed this invoice, and when" meant a psql session. This store answers it, and
 * does nothing else — there is no insert, update or delete here, and the class exposes none, so
 * no route built over it can append to or alter the chain.
 *
 * Two things differ from the emitter's own `listAnchoredForTenant`, both deliberately.
 *
 * **A row that no longer parses refuses the page.** The emitter drops one, so an old record cannot
 * hide every newer one — the right trade for a background verification pass. It is the wrong trade
 * for a reader: dropping a row is precisely how an entry would be made to disappear, and a reader
 * handed a shorter list has no way to notice. ADR-0289 found the same thing about incidents.
 *
 * **Cross-tenant reads go through an explicit grant.** A platform read elevates
 * `app.platform_audit` for the transaction, the same flag `meta.audit_integrity_verdicts` already
 * recognises, rather than relying on the API happening to connect as the table owner — which
 * bypasses RLS silently.
 *
 * The `all` scope needs a policy `meta.audit_log` did not have, and it did not merely come back
 * empty without it: measured against a real cluster as a non-owner role, a platform-
 * elevated read of a plain tenant-isolation policy raises `invalid input syntax for type uuid: ""`.
 * `current_setting('app.current_tenant_id', true)` returns NULL only until that setting has been
 * used once on the connection; afterwards its reset value is the empty string, and `''::UUID`
 * throws — so the failure appears on every pooled connection that has served a tenant, i.e. in
 * production and not in a fresh psql session. Two policies fix it, both verified live: tenant
 * isolation guarded as `tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID`
 * for ALL commands, plus a SELECT-only `current_setting('app.platform_audit', true) = 'on'`. The
 * SELECT-only half matters — with one combined policy the elevation would also pass the INSERT's
 * WITH CHECK, and a read grant must not become a write grant. Both are now declared
 * (`audit_log_tenant_isolation` + `audit_log_platform_audit_read`), so the `all` scope works; a
 * deployment migrating an older database needs the reconciler to have added the second policy before
 * configuring a platform role.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SELECT_COLUMNS =
  "id, tenant_id, occurred_at, actor, operation, entity, entity_id," +
  " before, after, diff, reason, e_signature, rego_decision_trace," +
  " chain_sequence_number, chain_entry_hash";

/**
 * Which rows a read may see. The caller's authorisation decides this; the store only executes it.
 *
 * There is still no `platform` scope, and since ADR-0331 that is a choice rather than a consequence.
 * `meta.audit_log.tenant_id` is nullable now, so platform rows exist — but they are reachable here
 * through `all`, which is what a human holding the cross-tenant grant should see: a platform-scope
 * row is part of the one trail, not a separate one. What a *tenant* scope must never do is return
 * one, and it cannot: `tenant_id = $1` never matches NULL and the isolation policy does not either.
 */
export type AuditReadScope =
  | { readonly kind: "tenant"; readonly tenantId: string }
  /** Every tenant, under the explicit cross-tenant grant. */
  | { readonly kind: "all" };

export interface AuditReadQuery {
  readonly scope: AuditReadScope;
  /** Inclusive lower bound on `occurred_at`. */
  readonly from?: string;
  /** Exclusive upper bound on `occurred_at`. */
  readonly to?: string;
  readonly entity?: string;
  readonly operation?: string;
  readonly entityId?: string;
  /** The acting user, matched against the actor JSONB's `userId`. */
  readonly actorUserId?: string;
  /** When true, only rows committed to a forensic chain entry. */
  readonly anchoredOnly?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AuditReadPage {
  readonly data: readonly AnchoredAuditEntry[];
  readonly nextCursor: string | null;
}

export interface AuditReadCursor {
  readonly occurredAt: string;
  readonly id: string;
}

export function encodeAuditReadCursor(cursor: AuditReadCursor): string {
  return Buffer.from(`v1:${cursor.occurredAt}:${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Null for anything this store did not issue — never a fall back to the first page, which would
 * make a reader walking a month of history re-read rows and conclude the page after them is empty.
 */
export function decodeAuditReadCursor(cursor: string | undefined): AuditReadCursor | null {
  if (cursor === undefined || cursor.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^v1:(.+):([0-9a-fA-F-]{36})$/.exec(decoded);
  if (match === null) return null;
  const occurredAt = match[1] ?? "";
  const id = match[2] ?? "";
  if (!UUID_RE.test(id)) return null;
  if (Number.isNaN(Date.parse(occurredAt))) return null;
  return { occurredAt, id };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

export interface AuditReadStoreOptions {
  readonly schema?: string;
}

function rowToEntry(row: Record<string, unknown>): AnchoredAuditEntry {
  // `auditEntryFromRow` parses through `AuditLogEntrySchema` and throws on a row the contract
  // cannot represent (ADR-0289). Throwing is the behaviour this store wants: the caller turns it
  // into a refused page, not a shorter one.
  return { entry: auditEntryFromRow(row), anchor: anchorFromRow(row) };
}

export class PostgresAuditReadStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: AuditReadStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.audit_log`;
  }

  /**
   * A window of the trail, newest first, keyset-paginated on `(occurred_at DESC, id DESC)`.
   *
   * Keyset rather than offset because the log is append-only and busy: an offset page shifts under
   * a reader as rows arrive, which in an audit trail means a record that was never shown to
   * anybody who paged past it.
   */
  async list(query: AuditReadQuery): Promise<AuditReadPage> {
    const limit = clampLimit(query.limit);
    const cursor = decodeAuditReadCursor(query.cursor);
    if (query.cursor !== undefined && query.cursor.length > 0 && cursor === null) {
      throw new Error("invalid audit cursor");
    }
    return this.read(query.scope, async (tx, base) => {
      const params = [...base.params];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length.toString()}`;
      };
      const conditions = [...base.conditions, ...filterConditions(query, bind)];
      if (cursor !== null) {
        const at = bind(cursor.occurredAt);
        const id = bind(cursor.id);
        conditions.push(
          `(occurred_at < ${at}::timestamptz OR (occurred_at = ${at}::timestamptz AND id < ${id}::uuid))`,
        );
      }
      const limitParam = bind(limit + 1);
      const sql =
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${conditions.join(" AND ")}` +
        ` ORDER BY occurred_at DESC, id DESC LIMIT ${limitParam}`;
      const result = await tx.query(sql, params);
      const rows = result.rows.map((r) => rowToEntry(r));
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const last = data[data.length - 1];
      return {
        data,
        nextCursor:
          hasMore && last !== undefined
            ? encodeAuditReadCursor({ occurredAt: last.entry.occurredAt, id: last.entry.id })
            : null,
      };
    });
  }

  /**
   * One entry, within a scope. Never by id alone: a bare `WHERE id = $1` would let a tenant read
   * another tenant's record by naming it, and an audit id travels in links and logs.
   */
  async getById(id: string, scope: AuditReadScope): Promise<AnchoredAuditEntry | null> {
    if (!UUID_RE.test(id)) return null;
    return this.read(scope, async (tx, base) => {
      const params = [...base.params, id];
      const where = [...base.conditions, `id = $${params.length.toString()}::uuid`];
      const result = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE ${where.join(" AND ")}`,
        params,
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToEntry(row);
    });
  }

  /**
   * Opens the transaction a read runs in and builds its base predicate.
   *
   * The two paths are not interchangeable. A tenant scope sets `app.current_tenant_id` and never
   * the platform flag, so RLS confines it even if the predicate were wrong; `all` sets
   * `app.platform_audit`, the explicit cross-tenant grant, and adds no tenant predicate at all.
   */
  private async read<T>(
    scope: AuditReadScope,
    fn: (
      tx: PgConnection,
      base: { readonly conditions: readonly string[]; readonly params: readonly unknown[] },
    ) => Promise<T>,
  ): Promise<T> {
    if (scope.kind === "tenant") {
      if (!UUID_RE.test(scope.tenantId)) {
        throw new Error(`invalid tenant id: ${JSON.stringify(scope.tenantId)}`);
      }
      return withTenantContext(this.conn, scope.tenantId, (tx) =>
        fn(tx, { conditions: ["tenant_id = $1"], params: [scope.tenantId] }),
      );
    }
    return withPlatformAudit(this.conn, (tx) => fn(tx, { conditions: ["TRUE"], params: [] }));
  }
}

/** The filters, bound as parameters; only the validated schema name is ever interpolated. */
function filterConditions(
  query: AuditReadQuery,
  bind: (value: unknown) => string,
): readonly string[] {
  const conditions: string[] = [];
  if (query.from !== undefined) conditions.push(`occurred_at >= ${bind(query.from)}::timestamptz`);
  if (query.to !== undefined) conditions.push(`occurred_at < ${bind(query.to)}::timestamptz`);
  if (query.entity !== undefined) conditions.push(`entity = ${bind(query.entity)}`);
  if (query.operation !== undefined) conditions.push(`operation = ${bind(query.operation)}`);
  if (query.entityId !== undefined) conditions.push(`entity_id = ${bind(query.entityId)}`);
  if (query.actorUserId !== undefined) {
    conditions.push(`actor->>'userId' = ${bind(query.actorUserId)}`);
  }
  if (query.anchoredOnly === true) {
    conditions.push("chain_entry_hash IS NOT NULL", "chain_sequence_number IS NOT NULL");
  }
  return conditions;
}
