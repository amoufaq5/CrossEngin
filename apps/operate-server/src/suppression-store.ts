import type { PgConnection } from "@crossengin/kernel-pg";
import {
  SuppressionRecordSchema,
  type NotificationChannel,
  type SuppressionRecord,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

/**
 * The write half of ADR-0274's open loop: `meta.notification_suppressions` was modelled in Phase 1
 * and read by `PostgresRecipientResolver.activeSuppressions`, but nothing ever wrote a row, so the
 * table that exists to stop mail to a dead address was permanently empty.
 *
 * The load-bearing property here is that a write is **idempotent, and never an update**. A bounce
 * webhook's record id is `sha256(tenant|channel|address|reason)`, so a provider's retry — or a replay
 * inside the HMAC tolerance window the envelope deliberately permits — presents the identical row.
 * `ON CONFLICT … DO UPDATE` would move `applied_at` and could extend an expiry on every replay,
 * which hands an attacker holding one captured signed body a way to keep an address suppressed
 * indefinitely by re-posting it. So the only conflict action in this module is DO NOTHING, and there
 * are no UPDATE assignments to derive from the column list because nothing here updates.
 */

export interface SuppressionStoreOptions {
  readonly schema?: string;
}

export const SUPPRESSION_WRITE_OUTCOMES = [
  "inserted",
  /** The identical suppression is already recorded — a replay, which is the normal duplicate path. */
  "already_present",
  /**
   * A *different* suppression already holds this (tenant, channel, address). The table is unique on
   * that tuple while the record id also hashes the reason, so a hard bounce followed by a complaint
   * for one address cannot both be stored. The first one recorded wins and the second is reported
   * rather than overwriting it: the address is suppressed either way, and overwriting would be the
   * `DO UPDATE` this module exists to avoid.
   */
  "address_already_suppressed",
] as const;
export type SuppressionWriteOutcome = (typeof SUPPRESSION_WRITE_OUTCOMES)[number];

export interface SuppressionWriteResult {
  /** The id of the row that now holds this address — not necessarily the id that was offered. */
  readonly suppressionId: string;
  readonly outcome: SuppressionWriteOutcome;
}

export interface SuppressionWriteBatch {
  readonly results: readonly SuppressionWriteResult[];
  readonly inserted: number;
  readonly alreadyPresent: number;
  readonly addressAlreadySuppressed: number;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The table's columns, in the order every statement in this module binds them. Declared once:
 * the select list, the insert column list, the `$n` placeholders and the dedup predicate's
 * placeholder numbers are all derived from this array, so adding a column cannot leave one
 * statement naming nine columns and another binding ten.
 */
const SUPPRESSION_COLUMNS: readonly string[] = Object.freeze([
  "suppression_id",
  "tenant_id",
  "channel",
  "recipient_address",
  "reason",
  "applied_at",
  "applied_by",
  "expires_at",
  "source_delivery_id",
  "notes",
]);

/**
 * `INSERT … SELECT` resolves its select list's types on its own rather than from the target columns,
 * and an unknown-typed parameter there lands as `text`. Casting the non-text columns is what stops a
 * NULL `applied_by` from arriving as `text` and failing against a UUID column.
 */
const COLUMN_CASTS: Readonly<Record<string, string>> = Object.freeze({
  tenant_id: "::uuid",
  applied_at: "::timestamptz",
  applied_by: "::uuid",
  expires_at: "::timestamptz",
  source_delivery_id: "::uuid",
});

const COLUMN_LIST = SUPPRESSION_COLUMNS.join(", ");

const INSERT_VALUES = SUPPRESSION_COLUMNS.map(
  (column, index) => `$${(index + 1).toString()}${COLUMN_CASTS[column] ?? ""}`,
).join(", ");

function placeholderFor(column: string): string {
  const index = SUPPRESSION_COLUMNS.indexOf(column);
  if (index < 0) throw new Error(`unknown suppression column: ${column}`);
  return `$${(index + 1).toString()}${COLUMN_CASTS[column] ?? ""}`;
}

const TENANT_PARAM = placeholderFor("tenant_id");
const CHANNEL_PARAM = placeholderFor("channel");
const ADDRESS_PARAM = placeholderFor("recipient_address");
const EXPIRES_PARAM = placeholderFor("expires_at");

/** Postgres' SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = "23505";

export const SUPPRESSION_ID_CONSTRAINT = "notification_suppressions_suppression_id_key";
export const SUPPRESSION_ADDRESS_CONSTRAINT =
  "notification_suppressions_tenant_channel_address_active";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return isoOf(value);
}

/**
 * Re-validates a stored row through `SuppressionRecordSchema` on the way out, and **throws** on a
 * row that no longer parses rather than dropping it from the result.
 *
 * Dropping is the tempting choice and it is the wrong one here: a suppression that silently vanishes
 * from a read fails *open* — the next drain sends to the address the row was recorded to protect. A
 * row hand-edited into a shape the contract forbids but the table's CHECK constraints permit (an
 * `expires_at` set on a `hard_bounce`, say) is exactly the case ADR-0289 re-parses for, and the only
 * honest report is a refusal.
 */
export function suppressionFromRow(row: Record<string, unknown>): SuppressionRecord {
  const parsed = SuppressionRecordSchema.safeParse({
    id: row["suppression_id"],
    tenantId: row["tenant_id"],
    channel: row["channel"],
    recipientAddress: row["recipient_address"],
    reason: row["reason"],
    appliedAt: isoOrNull(row["applied_at"]) ?? EPOCH_ISO,
    appliedBy: row["applied_by"] == null ? null : String(row["applied_by"]),
    expiresAt: isoOrNull(row["expires_at"]),
    sourceDeliveryId:
      row["source_delivery_id"] == null ? null : String(row["source_delivery_id"]),
    notes: row["notes"] == null ? undefined : String(row["notes"]),
  });
  if (!parsed.success) {
    // The id is safe to name; the address is not — a suppression row's address is a recipient
    // identity, which is pii under the repo's classification rules.
    throw new Error(
      `stored suppression row is invalid: ${String(row["suppression_id"])}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function paramsFor(record: SuppressionRecord): readonly unknown[] {
  return [
    record.id,
    record.tenantId,
    record.channel,
    record.recipientAddress,
    record.reason,
    record.appliedAt,
    record.appliedBy,
    record.expiresAt,
    record.sourceDeliveryId,
    record.notes ?? null,
  ];
}

/** The constraint a unique violation names, or null when the error is something else. */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { readonly code?: unknown; readonly constraint?: unknown };
  if (candidate.code !== UNIQUE_VIOLATION) return null;
  return typeof candidate.constraint === "string" ? candidate.constraint : "";
}

/**
 * A unique violation that got past both conflict guards, which can only be a concurrent writer
 * taking the address between this statement's `NOT EXISTS` and its insert.
 *
 * It exists to stop a node-postgres error from being the thing that propagates: a unique-violation
 * error carries `detail` of the form `Key (tenant_id, channel, recipient_address)=(…, email,
 * someone@example.com) already exists`, so logging or returning that message publishes a recipient
 * address. This one names the constraint and the suppression id and nothing else.
 */
export class SuppressionWriteConflictError extends Error {
  readonly constraintName: string;
  readonly suppressionId: string;

  constructor(constraintName: string, suppressionId: string) {
    super(`suppression ${suppressionId} lost a race on ${constraintName}`);
    this.name = "SuppressionWriteConflictError";
    this.constraintName = constraintName;
    this.suppressionId = suppressionId;
  }
}

/**
 * Postgres-backed writer for `meta.notification_suppressions`.
 *
 * The table carries tenant RLS, so every method runs inside `withTenantContext` (which binds
 * `app.current_tenant_id` for the transaction) AND binds `tenant_id` as an explicit parameter —
 * defense in depth, and not merely decorative on the write path: the table's **owner bypasses RLS**,
 * so a connection that happens to own the schema would otherwise be free to insert a row under
 * another tenant's id. `write` refuses a record whose `tenantId` is not the context's before any SQL
 * runs, which is the only check that holds for owner and non-owner alike.
 *
 * `activeSuppressions` carries the same signature as `PostgresRecipientResolver`'s — it is the
 * interface the delivery drain reads suppressions through — so this store can serve that read path
 * rather than defining a second shape for the same question. It differs in one deliberate way: an
 * unparseable row refuses the read here instead of being skipped. See `suppressionFromRow`.
 */
export class PostgresSuppressionStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: SuppressionStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.notification_suppressions`;
  }

  /**
   * The insert, and the only statement in this module that writes.
   *
   * Two conflict guards, because the table has two unique indexes and `ON CONFLICT` may name only
   * one. `WHERE NOT EXISTS` covers the (tenant, channel, address) one — which a *replay* also trips,
   * since a replay has the same tuple — so the normal duplicate path inserts nothing without raising.
   * `ON CONFLICT (suppression_id) DO NOTHING` then covers the race the predicate cannot: two
   * identical POSTs whose `NOT EXISTS` both read empty before either commits.
   *
   * The guard mirrors the index's predicate rather than the whole tuple. The index is unique only
   * over permanent rows (`expires_at IS NULL`), so a guard without that filter would refuse a new
   * suppression whenever *any* row existed for the address, lapsed or not — re-imposing in the
   * application the defect the predicated index removed from the schema, where an address that once
   * soft-bounced could never afterwards be hard-bounce-suppressed. A temporary row cannot trip the
   * index at all, so it is not guarded.
   */
  private get insertSql(): string {
    return (
      `INSERT INTO ${this.table} (${COLUMN_LIST})` +
      ` SELECT ${INSERT_VALUES}` +
      ` WHERE (${EXPIRES_PARAM} IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ${this.table}` +
      ` WHERE tenant_id = ${TENANT_PARAM} AND channel = ${CHANNEL_PARAM}` +
      ` AND recipient_address = ${ADDRESS_PARAM} AND expires_at IS NULL))` +
      ` ON CONFLICT (suppression_id) DO NOTHING`
    );
  }

  /** Which row holds the address, for disambiguating a zero-row insert. Permanent rows only: a
   * lapsed one does not hold anything, and naming it would report the wrong reason. */
  private get holderSql(): string {
    return (
      `SELECT suppression_id FROM ${this.table}` +
      ` WHERE tenant_id = $1::uuid AND channel = $2 AND recipient_address = $3` +
      ` AND expires_at IS NULL`
    );
  }

  private async runInsert(tx: PgConnection, record: SuppressionRecord): Promise<number> {
    try {
      const result = await tx.query(this.insertSql, paramsFor(record));
      return result.rowCount;
    } catch (err) {
      const constraint = uniqueViolationConstraint(err);
      if (constraint === null) throw err;
      throw new SuppressionWriteConflictError(constraint, record.id);
    }
  }

  private async insertOne(
    tx: PgConnection,
    record: SuppressionRecord,
  ): Promise<SuppressionWriteResult> {
    const inserted = await this.runInsert(tx, record);
    if (inserted > 0) return { suppressionId: record.id, outcome: "inserted" };
    // Nothing was written, which means some row already holds this address. Which one decides
    // whether this was a harmless replay or a second, different verdict about the same address —
    // and the route reports the difference, so it is resolved rather than collapsed into "no-op".
    const holder = await tx.query(this.holderSql, [
      record.tenantId,
      record.channel,
      record.recipientAddress,
    ]);
    const existing = holder.rows[0]?.["suppression_id"];
    if (existing == null) {
      // No row holds the address, yet the insert wrote nothing: the only way there is a concurrent
      // transaction that has inserted and not committed. Reporting it as present would claim a
      // suppression that may yet roll back.
      throw new Error(`suppression insert wrote no row and no row holds the address: ${record.id}`);
    }
    const suppressionId = String(existing);
    return {
      suppressionId,
      outcome: suppressionId === record.id ? "already_present" : "address_already_suppressed",
    };
  }

  /**
   * Writes one planned suppression. Returns which of the three things happened, because a caller
   * reporting "recorded" for a row it did not write would make a replay indistinguishable from a
   * first delivery.
   */
  async write(tenantId: string, record: SuppressionRecord): Promise<SuppressionWriteResult> {
    const batch = await this.writeAll(tenantId, [record]);
    const result = batch.results[0];
    if (result === undefined) throw new Error("suppression write returned no result");
    return result;
  }

  /**
   * Writes a webhook's whole plan in ONE transaction, so a two-recipient bounce either records both
   * suppressions or neither. A partial write is the worst outcome available: the caller reports a
   * refusal, the provider retries, and meanwhile one of the two addresses is quietly suppressed.
   *
   * A record is re-validated through its own schema first. It usually arrives already parsed, but
   * this is the boundary where a hand-built object reaches the table, and the store's invariant —
   * every row in this table parses as a `SuppressionRecord` — only holds if it is checked here too.
   */
  async writeAll(
    tenantId: string,
    records: readonly SuppressionRecord[],
  ): Promise<SuppressionWriteBatch> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`invalid tenantId for suppression write: ${JSON.stringify(tenantId)}`);
    }
    const validated = records.map((record) => {
      const parsed = SuppressionRecordSchema.parse(record);
      if (parsed.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
        throw new Error(
          `suppression ${parsed.id} is scoped to another tenant than the write context`,
        );
      }
      return parsed;
    });
    if (validated.length === 0) {
      return { results: [], inserted: 0, alreadyPresent: 0, addressAlreadySuppressed: 0 };
    }
    const results = await withTenantContext(this.conn, tenantId, async (tx) => {
      const out: SuppressionWriteResult[] = [];
      for (const record of validated) {
        out.push(await this.insertOne(tx, record));
      }
      return out;
    });
    return {
      results,
      inserted: results.filter((r) => r.outcome === "inserted").length,
      alreadyPresent: results.filter((r) => r.outcome === "already_present").length,
      addressAlreadySuppressed: results.filter(
        (r) => r.outcome === "address_already_suppressed",
      ).length,
    };
  }

  /** One suppression by its id, scoped to the tenant so an id alone cannot reach another's row. */
  async get(tenantId: string, suppressionId: string): Promise<SuppressionRecord | null> {
    const sql =
      `SELECT ${COLUMN_LIST} FROM ${this.table}` +
      ` WHERE tenant_id = $1::uuid AND suppression_id = $2`;
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, [tenantId, suppressionId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      return suppressionFromRow(row);
    });
  }

  /**
   * The drain's read, served from the writer's side of the table.
   *
   * "Active" is a property of this predicate, not of the table: the unique constraint named
   * `…_tenant_channel_address_active` carries no predicate, so an expired row still occupies its
   * tuple. Only `expires_at` decides whether a suppression suppresses, and the comparison is bound
   * from the caller's `now` so a test can pin it.
   */
  async activeSuppressions(
    tenantId: string,
    channel: NotificationChannel,
    now: Date,
  ): Promise<readonly SuppressionRecord[]> {
    const sql =
      `SELECT ${COLUMN_LIST} FROM ${this.table}` +
      ` WHERE tenant_id = $1::uuid AND channel = $2` +
      ` AND (expires_at IS NULL OR expires_at > $3::timestamptz)` +
      ` ORDER BY applied_at DESC, suppression_id`;
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, [tenantId, channel, now.toISOString()]);
      return result.rows.map((row) => suppressionFromRow(row));
    });
  }
}
