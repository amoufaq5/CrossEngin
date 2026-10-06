import { isoInstant, type PgConnection } from "@crossengin/kernel-pg";
import {
  INSTANCE_CANCELLATION_DISPOSITIONS,
  type InstanceCancellationDisposition,
} from "@crossengin/workflow-engine";
import type { ProjectedInstance } from "@crossengin/workflow-runtime";

import type {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_instances";

export interface CreateInstanceInput {
  readonly projection: ProjectedInstance;
  readonly definitionId: string;
  readonly relatedEntity?: Record<string, unknown> | null;
}

/**
 * The cancellation columns as a row carries them, so the one definition serves the writer here and
 * the drift comparison in `replayer.ts`.
 *
 * `cancellation_requested_by` is TEXT and not a `meta.users` reference: the projection sets it to
 * `actorPrincipalId ?? actorSystemId`, so the value is a user's uuid *or* a system slug, and a
 * scheduled timeout cancellation has no human in it at all. ADR-0318's lesson on
 * `meta.tenant_tombstones.executed_by`, in a second table.
 */
export interface StoredCancellationColumns {
  /** `unknown`, not `string | null`: node-postgres hands a `TIMESTAMPTZ` back as a `Date`. */
  readonly cancellation_requested_at: unknown;
  readonly cancellation_requested_by: string | null;
  readonly cancellation_disposition: string | null;
  readonly cancellation_signalled_activity_ids: unknown;
}

/**
 * A stored timestamp as the ISO text a `ProjectedInstance` holds.
 *
 * Re-exported, not defined: the same normaliser is wanted in this package, `api-gateway-pg` and
 * `operate-runtime-pg`, so it lives beside `PgQueryResult` in `@crossengin/kernel-pg` — the row
 * interface whose behaviour it describes, and the one dependency all three already have. A second
 * copy here is the shape this codebase keeps finding defects in.
 */
export { isoInstant };

/** The four `ProjectedInstance` cancellation fields, as read back off a row. */
export interface CancellationProjectionFields {
  readonly cancellationRequestedAt: string | null;
  readonly cancellationRequestedBy: string | null;
  readonly cancellationDisposition: InstanceCancellationDisposition | null;
  /** `null` when the stored column is not a JSON array of strings, which is drift and not emptiness. */
  readonly cancellationSignalledActivityIds: readonly string[] | null;
}

function asDisposition(value: unknown): InstanceCancellationDisposition | null {
  return typeof value === "string" &&
    (INSTANCE_CANCELLATION_DISPOSITIONS as readonly string[]).includes(value)
    ? (value as InstanceCancellationDisposition)
    : null;
}

/**
 * A stored JSONB array of strings, or `null` when it is anything else.
 *
 * `null` rather than `[]` on purpose: an unreadable column and an empty list are different facts,
 * and collapsing them would make a tampered `cancellation_signalled_activity_ids` compare equal to
 * the healthy empty case on every instance that signalled nothing.
 */
export function parseStringArray(value: unknown): readonly string[] | null {
  const raw: unknown =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return null;
  return raw.every((v): v is string => typeof v === "string") ? (raw as readonly string[]) : null;
}

export function cancellationProjectionFromRow(
  row: StoredCancellationColumns,
): CancellationProjectionFields {
  return {
    cancellationRequestedAt: isoInstant(row.cancellation_requested_at),
    cancellationRequestedBy: row.cancellation_requested_by,
    // Never silently one of the two: an unreadable stored disposition reads as unknown, which is the
    // projection's own rule for an unreadable event payload.
    cancellationDisposition: asDisposition(row.cancellation_disposition),
    cancellationSignalledActivityIds: parseStringArray(row.cancellation_signalled_activity_ids),
  };
}

export class PostgresInstanceStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;
  private readonly definitionResolver: WorkflowDefinitionIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
    readonly definitionResolver: WorkflowDefinitionIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
    this.definitionResolver = opts.definitionResolver;
  }

  async create(input: CreateInstanceInput): Promise<string> {
    const p = input.projection;
    const definitionUuid = await this.definitionResolver.requireResolve(input.definitionId);
    const result = await this.conn.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         instance_id, tenant_id, definition_id, definition_key, definition_version,
         status, current_state, variables, related_entity, correlation_key,
         parent_instance_id, started_at, started_by_user_id, started_by_system,
         last_transition_at, timeout_at, sequence_cursor,
         awaiting_activity_ids, awaiting_signal_names, awaiting_timer_names
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
         NULL, $11, $12, $13, $14, $15, $16,
         $17::jsonb, $18::jsonb, $19::jsonb
       )
       RETURNING id`,
      [
        p.instanceId,
        p.tenantId,
        definitionUuid,
        p.definitionKey,
        p.definitionVersion,
        p.status,
        p.currentState,
        JSON.stringify(p.variables),
        input.relatedEntity === null || input.relatedEntity === undefined ? null : JSON.stringify(input.relatedEntity),
        p.correlationKey,
        p.startedAt,
        p.startedByUserId,
        p.startedBySystem,
        p.lastTransitionAt,
        p.timeoutAt,
        p.sequenceCursor,
        JSON.stringify([...p.awaitingActivityIds]),
        JSON.stringify([...p.awaitingSignalNames]),
        JSON.stringify([...p.awaitingTimerNames]),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`failed to insert instance ${p.instanceId}`);
    }
    this.instanceResolver.register(p.instanceId, row.id);
    return row.id;
  }

  /**
   * Writes the projection over the instance's existing row, and **answers whether a row was there**.
   *
   * It is an `UPDATE`, not an upsert: the row is created once by `create()` from the
   * `instance_started` append, and re-deriving one here would have to invent the create-time columns
   * (`definition_id`, `started_at`, `timeout_at`) that the projection does not carry. So an absent
   * row is `false` rather than an exception — but it has to be *said*, because `UPDATE … WHERE
   * instance_id = $n` matching nothing is byte-identical to matching one row from the caller's side,
   * which is ADR-0333's `INSERT 0 0` in a second place. Two callers want opposite things with the
   * answer: the projecting log is downstream of an append that has already committed and may only
   * report it, while the replayer is a repair and must not claim one it did not make.
   */
  async upsertProjection(projection: ProjectedInstance): Promise<boolean> {
    const p = projection;
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE}
          SET status = $1,
              current_state = $2,
              variables = $3::jsonb,
              correlation_key = $4,
              last_transition_at = $5,
              completed_at = $6,
              cancelled_at = $7,
              cancelled_by_user_id = $8,
              cancelled_reason = $9,
              failed_at = $10,
              failure_code = $11,
              failure_message = $12,
              suspended_at = $13,
              suspended_reason = $14,
              compensation_started_at = $15,
              compensation_completed_at = $16,
              sequence_cursor = $17,
              awaiting_activity_ids = $18::jsonb,
              awaiting_signal_names = $19::jsonb,
              awaiting_timer_names = $20::jsonb,
              cancellation_requested_at = $21,
              cancellation_requested_by = $22,
              cancellation_disposition = $23,
              cancellation_signalled_activity_ids = $24::jsonb
        WHERE instance_id = $25`,
      [
        p.status,
        p.currentState,
        JSON.stringify(p.variables),
        p.correlationKey,
        p.lastTransitionAt,
        p.completedAt,
        p.cancelledAt,
        p.cancelledByUserId,
        p.cancelledReason,
        p.failedAt,
        p.failureCode,
        p.failureMessage,
        p.suspendedAt,
        p.suspendedReason,
        p.compensationStartedAt,
        p.compensationCompletedAt,
        p.sequenceCursor,
        JSON.stringify([...p.awaitingActivityIds]),
        JSON.stringify([...p.awaitingSignalNames]),
        JSON.stringify([...p.awaitingTimerNames]),
        // The fence, persisted. ADR-0329 put it only in the projection, so a restart re-read the row
        // and found a `running` instance with no `cancellation_requested_at` — and the driver reads
        // the fence, not the status, so every dropped timer and refused activity came back live.
        p.cancellationRequestedAt,
        p.cancellationRequestedBy,
        p.cancellationDisposition,
        JSON.stringify([...p.cancellationSignalledActivityIds]),
        p.instanceId,
      ],
    );
    return result.rowCount > 0;
  }
}
