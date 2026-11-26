import {
  UsageRecordSchema,
  type MeterId,
  type UsageRecord,
} from "@crossengin/billing";
import {
  readRows,
  readRowsWithUnreadable,
  textIdentity,
  type PgConnection,
  type RowRead,
  type UnreadableRowReporter,
} from "@crossengin/kernel-pg";

import { setTenantContextWithin, withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "billing_usage_records";

/**
 * `id` is selected **only so a refused row can be named**, and that is the whole reason this
 * interface has two fields.
 *
 * Both multi-row reads below took `SELECT record` alone, so for a row `UsageRecordSchema` refuses
 * there was no column in hand to identify it with: the blob is the thing that failed to parse, so
 * reading the id out of it is reading the value whose unreadability is the finding.
 * `meta.billing_usage_records.id` is `UUID NOT NULL` and the primary key, and the widening costs one
 * column on two statements.
 */
interface UsageRow {
  readonly record: unknown;
  readonly id: string;
}

function rowToRecord(row: UsageRow): UsageRecord {
  const raw = typeof row.record === "string" ? (JSON.parse(row.record) as unknown) : row.record;
  return UsageRecordSchema.parse(raw);
}

/**
 * One spelling, because both reads below must name a refused row the same way: a detail that
 * differs between two sweeps of the same table cannot be compared across them.
 */
function usageIdentity(row: UsageRow): string | null {
  return textIdentity(row, "id");
}

/**
 * A usage record was already reported to Stripe and a later write for the same key carries a
 * different quantity. Overwriting it would leave the difference reported nowhere, so the write is
 * refused by name instead.
 */
export class UsageAlreadyReported extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`usage record ${idempotencyKey} was already reported to Stripe with a different quantity`);
    this.name = "UsageAlreadyReported";
  }
}

const WINDOW_SAVEPOINT = "usage_window_record";

/**
 * A record the database refused **on its own account** — never a transport or session failure.
 * `detail` names the SQLSTATE and the constraint, and never a value from the row (ADR-0373's rule:
 * the record carries tenant and quantity, and a refusal line is read by more people than the row).
 */
export interface RefusedUsageRecord {
  readonly record: UsageRecord;
  readonly sqlstate: string;
  readonly constraint: string | null;
  readonly detail: string;
}

export interface UsageWindowWrite {
  /** Rows the window added; a record already stored under its key adds none. */
  readonly inserted: number;
  /** Records the database refused; re-sending cannot succeed until somebody changes the database. */
  readonly refused: readonly RefusedUsageRecord[];
}

/** SQLSTATE classes that are a statement about the record rather than the session. */
const RECORD_REFUSAL_CLASSES: ReadonlySet<string> = new Set(["22", "23"]);

function recordRefusalOf(err: unknown): Omit<RefusedUsageRecord, "record"> | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !RECORD_REFUSAL_CLASSES.has(code.slice(0, 2))) return null;
  const raw = (err as { constraint?: unknown }).constraint;
  const constraint = typeof raw === "string" && raw.length > 0 ? raw : null;
  return {
    sqlstate: code,
    constraint,
    detail: constraint === null ? `SQLSTATE ${code}` : `SQLSTATE ${code} on ${constraint}`,
  };
}

/** `markSynced` named a key no row carries. */
export class UsageRecordAbsent extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`no usage record carries idempotency key ${idempotencyKey}`);
    this.name = "UsageRecordAbsent";
  }
}

/**
 * Persists rolled-up `UsageRecord`s into `meta.billing_usage_records`, keyed by the record's
 * idempotency key. Every op runs in the tenant RLS context.
 */
export class PostgresUsageRecordStore {
  constructor(private readonly conn: PgConnection) {}

  /**
   * Re-closing a period refreshes the row's quantity **while it is unreported**. Two things this did
   * wrong before: the conflict arm rewrote `record` with the *new* caller's id while the row kept the
   * old one, so the id `listUnsynced` handed back named no row and `markSynced` matched nothing —
   * every sync re-sent the record to Stripe as a fresh increment; and it overwrote a row Stripe had
   * already been told about, leaving the difference reported nowhere. The document's id is pinned to
   * the row's now, and a reported row is refused unless the quantity is unchanged.
   */
  async record(usage: UsageRecord): Promise<void> {
    const valid = UsageRecordSchema.parse(usage);
    await withTenantContext(this.conn, valid.tenantId, async (tx) => {
      const written = await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           id, tenant_id, subscription_id, meter, period_start, period_end,
           quantity, source, recorded_at, idempotency_key, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           period_end = EXCLUDED.period_end,
           recorded_at = EXCLUDED.recorded_at,
           record = jsonb_set(EXCLUDED.record, '{id}', to_jsonb(${TABLE}.id::text))
         WHERE ${TABLE}.synced_to_stripe_at IS NULL
         RETURNING id`,
        [
          valid.id,
          valid.tenantId,
          valid.subscriptionId,
          valid.meter,
          valid.period.start,
          valid.period.end,
          valid.quantity,
          valid.source,
          valid.recordedAt,
          valid.idempotencyKey,
          JSON.stringify(valid),
        ],
      );
      if (written.rowCount > 0) return;
      // Compared in SQL, at the column's own scale (ADR-0483). It read `quantity::TEXT` and compared
      // `Number.parseFloat(stored) !== valid.quantity`, a JS double against a `NUMERIC(20, 4)` the
      // row was rounded into on write — so a re-close of `0.1 + 0.2` (stored `0.3000`) was refused as
      // a changed quantity Stripe had already been told. Casting the candidate to the column's type
      // applies the same rounding the original write did, so "unchanged" means unchanged as stored.
      const existing = await tx.query<{ same: boolean }>(
        `SELECT quantity = $2::NUMERIC(20, 4) AS same FROM ${SCHEMA}.${TABLE} WHERE idempotency_key = $1`,
        [valid.idempotencyKey, valid.quantity],
      );
      if (existing.rows[0]?.same !== true) {
        throw new UsageAlreadyReported(valid.idempotencyKey);
      }
    });
  }

  /**
   * Writes one flush window's records in one transaction, each under its own tenant's context and
   * **each behind its own savepoint**, and never updates: a record is immutable once written, so a
   * retry of the same window — the same records, the same keys — is a no-op rather than an
   * overwrite.
   *
   * It was all-or-nothing, on the argument that a flush writing some subscriptions and failing on
   * the next would leave the caller unable to tell which half to retry. That argument is false here
   * (ADR-0451 Q1, closed by ADR-0483): every insert is `ON CONFLICT (idempotency_key) DO NOTHING`, so
   * re-running a window that half-landed is already exact. What all-or-nothing actually bought was
   * that **one record's refusal rolled back every tenant's** — one unprovisioned tenant's foreign-key
   * refusal (`23503`) kept the whole window pending, and since that refusal stands until an operator
   * provisions the tenant, every later tick failed the same way and no tenant was billed meanwhile —
   * every later window queued behind the first.
   *
   * A refusal **of the record** — SQLSTATE class 22 (data exception) or 23 (integrity constraint) —
   * rolls back to that record's savepoint and is returned in `refused`; the caller drops it, because
   * re-sending it cannot succeed until somebody changes the database (a tenant provisioned, a CHECK
   * widened). Any other error is not about the record (a lost connection, a serialization failure,
   * a privilege) and propagates, failing the whole window so it is retried unchanged. `RELEASE`
   * follows `ROLLBACK TO`, because the savepoint survives the rollback and a window of many
   * refusals would otherwise nest a subtransaction per record (ADR-0360's rule).
   */
  async recordWindow(records: readonly UsageRecord[]): Promise<UsageWindowWrite> {
    if (records.length === 0) return { inserted: 0, refused: [] };
    const valid = records.map((r) => UsageRecordSchema.parse(r));
    return this.conn.transaction(async (tx) => {
      let inserted = 0;
      const refused: RefusedUsageRecord[] = [];
      for (const record of valid) {
        await tx.query(`SAVEPOINT ${WINDOW_SAVEPOINT}`);
        try {
          await setTenantContextWithin(tx, record.tenantId);
          const result = await tx.query(
            `INSERT INTO ${SCHEMA}.${TABLE} (
               id, tenant_id, subscription_id, meter, period_start, period_end,
               quantity, source, recorded_at, idempotency_key, record
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [
              record.id,
              record.tenantId,
              record.subscriptionId,
              record.meter,
              record.period.start,
              record.period.end,
              record.quantity,
              record.source,
              record.recordedAt,
              record.idempotencyKey,
              JSON.stringify(record),
            ],
          );
          await tx.query(`RELEASE SAVEPOINT ${WINDOW_SAVEPOINT}`);
          inserted += result.rowCount;
        } catch (err) {
          const refusal = recordRefusalOf(err);
          if (refusal === null) throw err;
          await tx.query(`ROLLBACK TO SAVEPOINT ${WINDOW_SAVEPOINT}`);
          await tx.query(`RELEASE SAVEPOINT ${WINDOW_SAVEPOINT}`);
          refused.push({ record, ...refusal });
        }
      }
      return { inserted, refused };
    });
  }

  async recordMany(records: readonly UsageRecord[]): Promise<void> {
    for (const record of records) await this.record(record);
  }

  /**
   * One subscription's metered usage, **with a report for every row the contract refuses**.
   *
   * Returns the pair rather than forwarding a reporter because this method has **no caller
   * anywhere, test included** — one repo-wide hit, its own definition — so there is no consumer
   * kind to pick the reporter form and nobody to forward to (ADR-0336's shape: a required
   * parameter whose only supplier is a test).
   */
  async listBySubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<RowRead<UsageRecord>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<UsageRow>(
        `SELECT id, record FROM ${SCHEMA}.${TABLE}
         WHERE subscription_id = $1 ORDER BY period_start ASC, meter ASC`,
        [subscriptionId],
      );
      return readRowsWithUnreadable(result.rows, rowToRecord, usageIdentity);
    });
  }

  /**
   * Usage records not yet reported to Stripe, oldest first.
   *
   * **Forwards** the reporter rather than returning the pair, because this is the one read in this
   * package whose consumer chain is a scheduler end to end — `UsageStripeSync.syncTenant` <-
   * `StripeUsageSyncScheduler.syncOnce` <- a `setInterval` — and ADR-0373's split puts the
   * decision at the caller for exactly that shape. What it closes: `.map(rowToRecord)` threw one
   * unrepresentable row out of the page, the throw propagated through `syncTenant` into the
   * scheduler's `onError`, and **that tenant's whole unsynced backlog stopped reaching Stripe** —
   * so a tenant was under-billed for as long as the row sat there, and every later tick failed
   * the same way.
   *
   * `onUnreadable` precedes `limit`, which keeps its default: a required parameter may follow a
   * *defaulted* one (TS1016 is about `?`-optional parameters), so this position is chosen rather
   * than forced. It matches `PostgresDrDrillStore.listRecent`, the house spelling, and it keeps the
   * page size last where every other read in the package has it.
   */
  async listUnsynced(
    tenantId: string,
    onUnreadable: UnreadableRowReporter,
    limit = 500,
  ): Promise<readonly UsageRecord[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<UsageRow>(
        `SELECT id, record FROM ${SCHEMA}.${TABLE}
         WHERE synced_to_stripe_at IS NULL ORDER BY recorded_at ASC LIMIT $1`,
        [limit],
      );
      return readRows(result.rows, rowToRecord, usageIdentity, onUnreadable);
    });
  }

  /**
   * Marks a usage record as reported to Stripe, by its **idempotency key** — the natural key the row
   * and the document always agree on, where the document's `id` was not guaranteed to name the row.
   * A re-mark keeps the first report; a key no row carries throws, because a sync that silently
   * marked nothing would re-send the record on the next pass.
   */
  async markSynced(
    tenantId: string,
    idempotencyKey: string,
    stripeUsageRecordId: string,
    syncedAt: string,
  ): Promise<void> {
    await withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${SCHEMA}.${TABLE}
         SET synced_to_stripe_at = COALESCE(synced_to_stripe_at, $2),
             stripe_usage_record_id = COALESCE(stripe_usage_record_id, $3)
         WHERE idempotency_key = $1
         RETURNING id`,
        [idempotencyKey, syncedAt, stripeUsageRecordId],
      );
      if (result.rowCount === 0) throw new UsageRecordAbsent(idempotencyKey);
    });
  }

  async sumForMeter(
    tenantId: string,
    subscriptionId: string,
    meter: MeterId,
    since: Date,
  ): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(quantity), 0)::TEXT AS total FROM ${SCHEMA}.${TABLE}
         WHERE subscription_id = $1 AND meter = $2 AND period_start >= $3`,
        [subscriptionId, meter, since.toISOString()],
      );
      const total = result.rows[0]?.total;
      return total === null || total === undefined ? 0 : Number.parseFloat(total);
    });
  }
}
