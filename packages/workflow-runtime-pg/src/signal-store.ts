import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  SignalDeliveryGuarantee,
  SignalStatus,
} from "@crossengin/workflow-engine";
import type {
  SignalDeduplicator,
  SignalDelivery,
  SignalIdempotency,
} from "@crossengin/workflow-runtime";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_signals";

/** The unique key `(tenant_id, signal_name, idempotency_key, instance_id)` is declared under. */
export const SIGNAL_IDEMPOTENCY_CONSTRAINT =
  "workflow_signals_tenant_name_idempotency_key";

const UNIQUE_VIOLATION = "23505";

export interface SignalProjection {
  readonly id: string;
  readonly instanceId: string | null;
  readonly tenantId: string;
  readonly signalName: string;
  readonly correlationKey: string;
  /**
   * Not projected from the log — declared by the workflow's `SignalDefinition` and resolved by
   * `projectPersistableSignals`. Required rather than optional because the column is NOT NULL with
   * no default: an optional field can be forgotten with the type still satisfied, which is exactly
   * how every `upsert` came to omit it.
   */
  readonly deliveryGuarantee: SignalDeliveryGuarantee;
  /**
   * The submitter's key, as the `signal_received` event recorded it. Required for the same reason
   * as the guarantee and nullable for a different one: the column is nullable, two of the three
   * guarantees permit no key, and `exactly_once_idempotent` without one is refused upstream rather
   * than stored — so a `null` here is a fact, never a gap left by a caller who forgot the field.
   */
  readonly idempotencyKey: string | null;
  readonly sourceSystem: string;
  readonly sourcePrincipalId: string | null;
  readonly status: SignalStatus;
  readonly receivedAt: string;
  readonly matchedAt: string | null;
  readonly consumedAt: string | null;
}

/**
 * Two signal ids claim one delivery: the same `(tenant, signal name, idempotency key, instance)`
 * under a second `wfs_…`.
 *
 * Re-projecting an instance cannot cause this — the row's own `signal_id` wins the `ON CONFLICT`
 * and collides with nothing — so it means two submits of one key raced past the deduplicator's
 * read. Raised rather than swallowed: the second submit has already appended its receipt events,
 * and converting the collision into a skip would leave a log claiming a delivery the table does
 * not hold, which is the shape of the defect this column was added to close.
 */
export class SignalIdempotencyConflict extends Error {
  readonly signalId: string;
  readonly idempotencyKey: string;

  constructor(input: {
    readonly signalId: string;
    readonly signalName: string;
    readonly idempotencyKey: string;
  }) {
    super(
      `signal ${input.signalId} (${input.signalName}) cannot be stored: idempotency key ` +
        `${input.idempotencyKey} is already recorded under another signal id ` +
        `(${SIGNAL_IDEMPOTENCY_CONSTRAINT})`,
    );
    this.name = "SignalIdempotencyConflict";
    this.signalId = input.signalId;
    this.idempotencyKey = input.idempotencyKey;
  }
}

function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint;
}

export class PostgresSignalStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
  }

  async upsert(projection: SignalProjection): Promise<void> {
    const instanceUuid =
      projection.instanceId === null
        ? null
        : await this.instanceResolver.requireResolve(projection.instanceId);
    try {
      await this.conn.query(
        // The DO UPDATE set is the signal's *progress* and nothing else. Provenance — the guarantee
        // it arrived under, the key it was submitted with, the system that sent it, the principal
        // behind it — is a fact of receipt; a later definition version declaring a different
        // guarantee must not rewrite what the signal was actually accepted under.
        `INSERT INTO ${SCHEMA}.${TABLE} (
           signal_id, instance_id, tenant_id, signal_name, correlation_key,
           delivery_guarantee, idempotency_key, source_system, source_principal_id,
           status, received_at, matched_at, consumed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (signal_id) DO UPDATE
           SET status = EXCLUDED.status,
               matched_at = EXCLUDED.matched_at,
               consumed_at = EXCLUDED.consumed_at,
               instance_id = COALESCE(EXCLUDED.instance_id, ${SCHEMA}.${TABLE}.instance_id)`,
        [
          projection.id,
          instanceUuid,
          projection.tenantId,
          projection.signalName,
          projection.correlationKey,
          projection.deliveryGuarantee,
          projection.idempotencyKey,
          projection.sourceSystem,
          projection.sourcePrincipalId,
          projection.status,
          projection.receivedAt,
          projection.matchedAt,
          projection.consumedAt,
        ],
      );
    } catch (err) {
      if (
        projection.idempotencyKey !== null &&
        isUniqueViolationOn(err, SIGNAL_IDEMPOTENCY_CONSTRAINT)
      ) {
        throw new SignalIdempotencyConflict({
          signalId: projection.id,
          signalName: projection.signalName,
          idempotencyKey: projection.idempotencyKey,
        });
      }
      throw err;
    }
  }

  async upsertMany(projections: readonly SignalProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}

/**
 * The deduplicator that answers from the table rather than from process memory, which is the half a
 * `Set` could never do: it survives a restart and it is the same answer for every replica.
 *
 * `remember` is deliberately a no-op. The ledger is `meta.workflow_signals` itself, written by
 * `ProjectingEventLog.persistProjections` as each event lands, so a second ledger would be a second
 * thing to keep true — and the one the unique key enforces is the one that counts.
 *
 * It reads the **textual** `wfi_…` id back through the join, not the surrogate uuid, because that
 * is what a `SignalDelivery` names and what a caller retrying a webhook can act on.
 */
export class PostgresSignalDeduplicator implements SignalDeduplicator {
  constructor(private readonly conn: PgConnection) {}

  async lookup(key: SignalIdempotency): Promise<readonly SignalDelivery[] | null> {
    const result = await this.conn.query<{
      signal_id: string;
      instance_id: string | null;
    }>(
      `SELECT s.signal_id, i.instance_id
         FROM ${SCHEMA}.${TABLE} s
         LEFT JOIN ${SCHEMA}.workflow_instances i ON i.id = s.instance_id
        WHERE s.tenant_id = $1 AND s.signal_name = $2 AND s.idempotency_key = $3
        ORDER BY s.received_at, s.signal_id`,
      [key.tenantId, key.signalName, key.idempotencyKey],
    );
    if (result.rows.length === 0) return null;
    const deliveries: SignalDelivery[] = [];
    for (const row of result.rows) {
      // A stored signal with no instance is `received` and unmatched, which this engine never
      // writes; it is still proof the key was accepted, so it suppresses the retry without
      // claiming a delivery that cannot be named.
      if (row.instance_id === null) continue;
      deliveries.push({ instanceId: row.instance_id, signalId: row.signal_id });
    }
    return deliveries;
  }

  async remember(): Promise<void> {
    return;
  }
}
