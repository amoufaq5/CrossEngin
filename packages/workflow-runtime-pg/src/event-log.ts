import {
  readRowsWithUnreadable,
  requireIsoInstant,
  type PgConnection,
  type RowRead,
  type UnreadableRow,
} from "@crossengin/kernel-pg";
import type { EventLog } from "@crossengin/workflow-runtime";
import { EVENT_KINDS, type WorkflowEvent } from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_events";

interface Row {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly sequence_number: number;
  readonly kind: string;
  /**
   * `unknown`, not `string`: node-postgres hands this `TIMESTAMPTZ` back as a `Date`, so typing it
   * `string` put a `Date` into `WorkflowEvent.occurredAt` — and from there into every timestamp the
   * projection derives from an event (`startedAt`, `completedAt`, `timeoutAt`, …), each of which the
   * contract declares as ISO text. Verified live. It only ever read as *correct* because the drift
   * comparison normalises both of its sides (ADR-0330); nothing was defending the contract here.
   */
  readonly occurred_at: unknown;
  readonly actor_principal_id: string | null;
  readonly actor_system_id: string | null;
  readonly previous_state: string | null;
  readonly new_state: string | null;
  readonly activity_id: string | null;
  readonly signal_id: string | null;
  readonly timer_id: string | null;
  readonly child_instance_id: string | null;
  readonly variable_name: string | null;
  readonly payload: unknown;
  readonly correlation_id: string | null;
  readonly causation_event_id: string | null;
  readonly instance_text_id: string;
}

/**
 * `readRowsWithUnreadable` for this store, which declares its row shape.
 *
 * The primitive types its mapper `(row: Record<string, unknown>) => T`, and an interface with no
 * index signature reaches neither that parameter nor `Record<string, unknown>` itself (measured both
 * ways; a function parameter is contravariant, so no widening gets there). Rewriting `rowToEvent` to
 * read 18 `unknown`s instead was built and **reverted**, because it cost more than it bought:
 * `pg-record-reads.ts` anchors on the declared `interface \w*Row` and on `<receiver>.<property>`
 * accesses, so coercing through `read(row, "event_id")` helpers made all 18 of this mapper's reads
 * invisible to the one rule that checks a field is read from the column it names — it said so, by
 * failing. Runtime type checks are not a substitute for that: they catch a wrong *type* and a
 * transposition between two columns of the same type is exactly what they cannot see.
 *
 * The loop **was** local for that reason, and is not any more: `readRows` is generic in its row
 * type now, which is what this comment's previous version said would retire it — so the only thing
 * here is the identity, which is the one part that has to know the row's own shape.
 */
function readEventRows(rows: readonly Row[]): RowRead<WorkflowEvent> {
  return readRowsWithUnreadable(rows, rowToEvent, (row) =>
    // Read **after** the mapper refused and off the raw row, so it still answers for a row the
    // mapper would not touch — and `null` says *this row does not name one* rather than inventing
    // a handle (ADR-0331).
    typeof row.event_id === "string" && row.event_id.length > 0 ? row.event_id : null,
  );
}

/**
 * `kind` is parsed against `EVENT_KINDS` where it used to be cast.
 *
 * The cast was the one thing in this mapper that could not fail, and an unknown kind is **not**
 * inert: `projectInstance` folds over the log and simply ignores a kind it does not recognise, so
 * such a row is a hole the fold cannot see — the same class as a row that throws, in the direction
 * that reports success. Refusing it costs nothing a conforming database can hold, which is a
 * measurement rather than a hope: `meta.workflow_events.kind` carries a 27-value CHECK naming
 * exactly `EVENT_KINDS`, so only a hand-edit or a future binary can produce one.
 */
function requireEventKind(kind: string): WorkflowEvent["kind"] {
  const found = EVENT_KINDS.find((candidate) => candidate === kind);
  if (found === undefined) {
    // The value is deliberately not named: a report scoped by it sends an operator to act on the
    // very thing that made the row unreadable.
    throw new Error("row column kind is not a declared workflow event kind");
  }
  return found;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

function rowToEvent(row: Row): WorkflowEvent {
  return {
    id: row.event_id,
    instanceId: row.instance_text_id,
    tenantId: row.tenant_id,
    sequenceNumber: row.sequence_number,
    kind: requireEventKind(row.kind),
    occurredAt: requireIsoInstant(row.occurred_at, "occurred_at"),
    actorPrincipalId: row.actor_principal_id,
    actorSystemId: row.actor_system_id,
    previousState: row.previous_state,
    newState: row.new_state,
    activityId: row.activity_id,
    signalId: row.signal_id,
    timerId: row.timer_id,
    childInstanceId: row.child_instance_id,
    variableName: row.variable_name,
    payload: parsePayload(row.payload),
    correlationId: row.correlation_id,
    causationEventId: row.causation_event_id,
  };
}

/**
 * The refusal `listByInstance` takes when any row of a log cannot be represented.
 *
 * `listByInstance` is an `EventLog` method, and its nine other callers are folds:
 * `WorkflowEngine` projects an instance from it, and `ProjectingEventLog.persistProjections`
 * re-projects on **every append**. A projection rebuilt from a log with a hole in it is not a
 * projection of that log — it is a projection of a shorter, different log that reports success — so
 * this read may not hand a fold a short list, and dropping a row silently is the one answer that is
 * never right here. It therefore keeps its signature and refuses.
 *
 * What changed is that the refusal names **every** unreadable row rather than the first the mapper
 * happened to reach, so an operator repairing them does not need one pass per row; and
 * `listByInstanceWithUnreadable` gives `WorkflowReplayer` — whose whole job is to find such rows —
 * the pair instead.
 */
export class UnreadableEventRowsError extends Error {
  readonly instanceId: string;
  readonly unreadable: readonly UnreadableRow[];

  constructor(instanceId: string, unreadable: readonly UnreadableRow[]) {
    super(
      `workflow instance ${instanceId}: ${String(unreadable.length)} event row(s) could not be ` +
        "represented, so the log cannot be folded — " +
        unreadable.map((u) => `${u.identity ?? "<unidentified>"} (${u.detail})`).join("; "),
    );
    this.name = "UnreadableEventRowsError";
    this.instanceId = instanceId;
    this.unreadable = unreadable;
  }
}

export interface PostgresEventLogOptions {
  readonly conn: PgConnection;
  readonly instanceResolver: WorkflowInstanceIdResolver;
}

export class PostgresEventLog implements EventLog {
  private readonly conn: PgConnection;
  private readonly resolver: WorkflowInstanceIdResolver;

  constructor(opts: PostgresEventLogOptions) {
    this.conn = opts.conn;
    this.resolver = opts.instanceResolver;
  }

  async append(event: WorkflowEvent): Promise<void> {
    const instanceUuid = await this.resolver.requireResolve(event.instanceId);
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         event_id, instance_id, tenant_id, sequence_number, kind, occurred_at,
         actor_principal_id, actor_system_id, previous_state, new_state,
         activity_id, signal_id, timer_id, child_instance_id, variable_name,
         payload, correlation_id, causation_event_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
      [
        event.id,
        instanceUuid,
        event.tenantId,
        event.sequenceNumber,
        event.kind,
        event.occurredAt,
        event.actorPrincipalId,
        event.actorSystemId,
        event.previousState,
        event.newState,
        event.activityId,
        event.signalId,
        event.timerId,
        event.childInstanceId,
        event.variableName,
        JSON.stringify(event.payload),
        event.correlationId,
        event.causationEventId,
      ],
    );
  }

  async appendBatch(events: readonly WorkflowEvent[]): Promise<void> {
    for (const event of events) {
      await this.append(event);
    }
  }

  /**
   * One instance's log, oldest first — refusing if any row cannot be represented.
   *
   * See `UnreadableEventRowsError` for why a fold must not be handed a short log, and
   * `listByInstanceWithUnreadable` for the sibling a verifier calls instead.
   */
  async listByInstance(instanceId: string): Promise<readonly WorkflowEvent[]> {
    const read = readEventRows(await this.selectByInstance(instanceId));
    if (read.unreadable.length > 0) {
      throw new UnreadableEventRowsError(instanceId, read.unreadable);
    }
    return read.records;
  }

  /**
   * The same log, with the rows the contract refused beside the ones it accepted.
   *
   * `WorkflowReplayer` is the one caller, and the distinction is the primitive's: this read's other
   * consumers are folds, which must refuse, while a verification's job *is* the refused row — and a
   * verdict computed over the readable rows alone is a verdict about a different log than the one on
   * disk.
   */
  async listByInstanceWithUnreadable(instanceId: string): Promise<{
    readonly records: readonly WorkflowEvent[];
    readonly unreadable: readonly UnreadableRow[];
  }> {
    return readEventRows(await this.selectByInstance(instanceId));
  }

  /** One statement, so the pair and the refusing form cannot ask the database different questions. */
  private async selectByInstance(instanceId: string): Promise<readonly Row[]> {
    const instanceUuid = await this.resolver.resolve(instanceId);
    if (instanceUuid === null) return [];
    const result = await this.conn.query<Row>(
      `SELECT e.event_id, e.tenant_id, e.sequence_number, e.kind, e.occurred_at,
              e.actor_principal_id, e.actor_system_id, e.previous_state, e.new_state,
              e.activity_id, e.signal_id, e.timer_id, e.child_instance_id, e.variable_name,
              e.payload, e.correlation_id, e.causation_event_id,
              $1::TEXT AS instance_text_id
         FROM ${SCHEMA}.${TABLE} e
        WHERE e.instance_id = $2
        ORDER BY e.sequence_number ASC`,
      [instanceId, instanceUuid],
    );
    return result.rows;
  }

  async latestSequence(instanceId: string): Promise<number | null> {
    const instanceUuid = await this.resolver.resolve(instanceId);
    if (instanceUuid === null) return null;
    const result = await this.conn.query<{ max: number | null }>(
      `SELECT MAX(sequence_number) AS max FROM ${SCHEMA}.${TABLE} WHERE instance_id = $1`,
      [instanceUuid],
    );
    const row = result.rows[0];
    if (row === undefined || row.max === null) return null;
    return row.max;
  }

  async count(): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}`,
    );
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }
}
