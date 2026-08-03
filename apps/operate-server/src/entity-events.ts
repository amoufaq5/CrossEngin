import type { JobDeclaration } from "@crossengin/jobs";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { EntityEvent, EntityEventSink } from "@crossengin/operate-runtime";
import { enqueueJobsForEvent } from "@crossengin/workflow-runtime-pg";

export interface PostgresEntityEventSinkOptions {
  readonly schema?: string;
  readonly now?: () => Date;
  /** Notified if an enqueue throws — emission is best-effort and must not fail the originating write. */
  readonly onError?: (err: unknown) => void;
  /** Notified after a successful enqueue (metrics / logging). */
  readonly onEnqueue?: (event: EntityEvent, enqueuedRunIds: readonly string[]) => void;
}

/**
 * An `EntityEventSink` that turns a served entity write into `pending` job runs: it maps the
 * `EntityEvent` to a `DomainEvent` and calls `enqueueJobsForEvent`, so every event-triggered (and
 * delayed) job whose `eventName` matches the write fires through the durable queue the worker fleet
 * drains. Idempotent by the producer's deterministic `run_id` + `ON CONFLICT DO NOTHING` (keyed on the
 * event's `idempotencyKey`). The connection is platform-scoped; the event's tenant rides on each row.
 * Failures are swallowed (routed to `onError`) — emitting jobs must never fail the user's write.
 */
export class PostgresEntityEventSink implements EntityEventSink {
  constructor(
    private readonly conn: PgConnection,
    private readonly jobs: readonly JobDeclaration[],
    private readonly options: PostgresEntityEventSinkOptions = {},
  ) {}

  async emit(event: EntityEvent): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const schemaOpt = this.options.schema !== undefined ? { schema: this.options.schema } : {};
    try {
      const enqueued = await enqueueJobsForEvent(this.conn, {
        event: {
          name: event.name,
          tenantId: event.tenantId,
          data: event.data,
          idempotencyKey: event.idempotencyKey,
          occurredAt: now,
        },
        jobs: this.jobs,
        now,
        ...schemaOpt,
      });
      this.options.onEnqueue?.(event, enqueued.map((e) => e.runId));
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}
