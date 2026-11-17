import { randomUUID } from "node:crypto";

import type { PipelineExecution } from "@crossengin/api-gateway";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  EntityAuditUnrecorded,
  type EntityWriteAuditEvent,
  type EntityWriteAuditor,
} from "@crossengin/operate-runtime";

import { auditActor, auditEntry } from "./audit-log-store.js";
import type { AuditLogEntry } from "@crossengin/auth";

/** The slice of `PostgresAuditEmitter` the recorder writes through. */
export interface EntityAuditSink {
  emitWithin(tx: PgConnection, entry: AuditLogEntry): Promise<void>;
  emit(entry: AuditLogEntry): Promise<void>;
  anchors(): boolean;
}

export interface EntityAuditRecorderOptions {
  readonly sink: EntityAuditSink;
  /** Which transaction the caller is in — `AmbientTransactions.current`. */
  readonly currentTransaction: () => PgConnection | undefined;
  /**
   * Told every refusal, with the cause. Required: the handler's 503 says an operator has been told,
   * and this is the telling — an optional reporter defaulting to silence would make that sentence
   * false (ADR-0364's rule).
   */
  readonly onRefused: (event: EntityWriteAuditEvent, reason: string, cause: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Bound on the set of request ids awaiting the observer; see {@link EntityAuditRecorder.supersedes}. */
  readonly maxPendingSupersedes?: number;
}

const DEFAULT_MAX_PENDING_SUPERSEDES = 4096;

/**
 * Where an entity write's record goes: one `meta.audit_log` row per write, in the write's own
 * transaction, anchored into the tenant's chain when the deployment has one.
 *
 * **Same transaction or refused.** An event carrying `inTransaction: true` is written through
 * `emitWithin` on the transaction the entity store opened, found through the ambient context — so
 * the row commits with the write or neither does. If the recorder is called from inside a
 * transactional write and finds no transaction (a store this process did not build from the wrapped
 * connection), it refuses rather than writing the row on a second connection: that row would commit
 * even when the write rolls back, and would take a second pooled connection while the first is held
 * (ADR-0422's measured deadlock). An event with `inTransaction: false` — a link or unlink, whose store
 * call has already committed — is written in its own transaction, and a failure is reported to the
 * handler, which answers 503 saying the write stands and its record does not.
 *
 * **One anchor per write, not two.** The request-level observer appends an `audit_event` chain entry
 * for every completed request it samples, carrying the request id, the operation and the status. For
 * a request whose entity write was recorded here *and anchored*, that entry restates a subset of an
 * entry already in the chain — and the row here carries the record id, the actor and the redacted
 * before/after the request-level entry cannot. So the observer is told to skip it
 * ({@link supersedes}), and only when the response was a 2xx: a write recorded and then rolled back
 * (a failed commit) still gets its request-level entry, since the row that would have superseded it
 * does not exist.
 */
export class EntityAuditRecorder implements EntityWriteAuditor {
  private readonly pending = new Map<string, true>();
  private readonly maxPending: number;

  constructor(private readonly opts: EntityAuditRecorderOptions) {
    this.maxPending = opts.maxPendingSupersedes ?? DEFAULT_MAX_PENDING_SUPERSEDES;
  }

  async record(event: EntityWriteAuditEvent): Promise<void> {
    const entry = entityAuditEntry(event, {
      id: (this.opts.newId ?? randomUUID)(),
      occurredAt: (this.opts.now ?? (() => new Date()))().toISOString(),
    });
    try {
      if (event.inTransaction) {
        const tx = this.opts.currentTransaction();
        if (tx === undefined) throw new NoAmbientTransaction();
        await this.opts.sink.emitWithin(tx, entry);
      } else {
        await this.opts.sink.emit(entry);
      }
    } catch (err) {
      const reason = describe(err);
      this.opts.onRefused(event, reason, err);
      throw new EntityAuditUnrecorded(reason, { cause: err });
    }
    // A write background work made has no request the observer will ever see complete, so a mark for
    // it would sit in the set until evicted, crowding out the marks that are consumed.
    if (this.opts.sink.anchors() && event.origin === undefined) this.remember(event.requestId);
  }

  /**
   * Whether the request-level chain entry for this execution is redundant, consuming the mark.
   * Wired as `AuditChainObserverOptions.supersedes`.
   */
  supersedes(execution: PipelineExecution): boolean {
    if (!this.pending.delete(execution.requestId)) return false;
    const status = execution.finalResponseStatus;
    return status !== null && status >= 200 && status < 300;
  }

  /** How many marks are waiting for their request to complete — for tests and a leak check. */
  pendingSupersedes(): number {
    return this.pending.size;
  }

  private remember(requestId: string): void {
    this.pending.set(requestId, true);
    // Eviction drops a mark, which costs one redundant request-level entry — the safe direction.
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}

export function buildEntityAuditRecorder(opts: EntityAuditRecorderOptions): EntityAuditRecorder {
  return new EntityAuditRecorder(opts);
}

/**
 * The row an entity write becomes. `operation` is the route's operationId (`invoice.send`), which is
 * the vocabulary `--audit-read-routes`' `?operation=` filter and the request-level chain already use,
 * so a reader can find an entity write and the request that made it under one name. The transition's
 * name, and for a link the related entity, ride in `reason`.
 */
export function entityAuditEntry(
  event: EntityWriteAuditEvent,
  at: { readonly id: string; readonly occurredAt: string },
): AuditLogEntry {
  return auditEntry({
    id: at.id,
    tenantId: event.tenantId,
    occurredAt: at.occurredAt,
    actor: auditActor({ kind: event.actorUserId === null ? "system" : "user", userId: event.actorUserId }),
    operation: event.operationId,
    entity: event.entity,
    entityId: event.recordId,
    before: event.before,
    after: event.after,
    diff: event.diff,
    ...(reasonOf(event) === null ? {} : { reason: reasonOf(event) as string }),
  });
}

/**
 * The row's `reason`: the transition or link detail, and — for a write background work made — which
 * job run made it. The actor's kind is `system` either way and the actor shape has no field for a
 * job, so without this a job's write and a bare api-key's would be one row shape with nothing to
 * tell them apart (ADR-0331's shared placeholder, at the audit trail).
 */
function reasonOf(event: EntityWriteAuditEvent): string | null {
  const act = event.detail === null ? null : `${event.action}:${event.detail}`;
  if (event.origin === undefined) return act;
  const by = `job:${event.origin.jobId} run:${event.origin.runId}`;
  return act === null ? by : `${by} ${act}`;
}

class NoAmbientTransaction extends Error {
  constructor() {
    super(
      "the write runs in a transaction this recorder cannot join, and a record written outside it would not share its fate",
    );
    this.name = "NoAmbientTransaction";
  }
}

/**
 * The cause, as a name and a SQLSTATE and never a message: the reason travels into a log line and
 * the exception's message, and a driver message can quote a value from the row being written.
 */
function describe(err: unknown): string {
  if (err instanceof NoAmbientTransaction) return err.message;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${err.name} ${code}` : err.name;
  }
  return "unknown error";
}
