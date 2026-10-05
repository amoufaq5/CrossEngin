import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import {
  type ProjectedInstance,
  projectActivities,
  projectInstance,
  projectSignals,
  projectTimers,
} from "@crossengin/workflow-runtime";

import { type ActivityProjection, PostgresActivityStore } from "./activity-store.js";
import { PostgresEventLog } from "./event-log.js";
import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import {
  PostgresInstanceStore,
  type StoredCancellationColumns,
  cancellationProjectionFromRow,
  isoInstant,
} from "./instance-store.js";
import { projectPersistableSignals } from "./signal-provenance.js";
import { PostgresSignalStore } from "./signal-store.js";
import { PostgresTimerStore, type TimerProjection } from "./timer-store.js";

const SCHEMA = "meta";

export interface DriftField {
  readonly field: string;
  readonly stored: unknown;
  readonly expected: unknown;
}

export interface InstanceDrift {
  readonly instanceMissing: boolean;
  readonly fields: readonly DriftField[];
}

export interface ChildEntityDrift {
  readonly missingIds: readonly string[];
  readonly extraIds: readonly string[];
  readonly mismatchedIds: readonly string[];
}

export interface VerifyReport {
  readonly instanceId: string;
  readonly hasEvents: boolean;
  readonly definitionId: string | null;
  readonly instance: InstanceDrift;
  readonly activities: ChildEntityDrift;
  readonly signals: ChildEntityDrift;
  readonly timers: ChildEntityDrift;
  readonly drifted: boolean;
}

export interface ResyncReport {
  readonly instanceId: string;
  readonly hadEvents: boolean;
  readonly upserts: {
    readonly instance: boolean;
    readonly activities: number;
    readonly signals: number;
    readonly timers: number;
  };
}

export interface WorkflowReplayerOptions {
  readonly conn: PgConnection;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly instanceResolver?: WorkflowInstanceIdResolver;
  readonly definitionResolver?: WorkflowDefinitionIdResolver;
}

/** The timestamps are `unknown` because node-postgres hands a `TIMESTAMPTZ` back as a `Date`. */
interface StoredInstanceRow extends StoredCancellationColumns {
  readonly instance_id: string;
  readonly status: string;
  readonly current_state: string;
  readonly variables: unknown;
  readonly sequence_cursor: number;
  readonly completed_at: unknown;
  readonly failed_at: unknown;
  readonly cancelled_at: unknown;
  readonly suspended_at: unknown;
  readonly compensation_started_at: unknown;
  readonly compensation_completed_at: unknown;
}

interface StoredActivityRow {
  readonly activity_id: string;
  readonly status: string;
  readonly definition_activity_key: string;
}

interface StoredSignalRow {
  readonly signal_id: string;
  readonly status: string;
}

interface StoredTimerRow {
  readonly timer_id: string;
  readonly status: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
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
      return {};
    }
  }
  return {};
}

export class WorkflowReplayer {
  private readonly conn: PgConnection;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly instanceResolver: WorkflowInstanceIdResolver;
  private readonly definitionResolver: WorkflowDefinitionIdResolver;
  private readonly eventLog: PostgresEventLog;
  private readonly instanceStore: PostgresInstanceStore;
  private readonly activityStore: PostgresActivityStore;
  private readonly signalStore: PostgresSignalStore;
  private readonly timerStore: PostgresTimerStore;

  constructor(opts: WorkflowReplayerOptions) {
    this.conn = opts.conn;
    this.definitions = opts.definitions;
    this.instanceResolver = opts.instanceResolver ?? new WorkflowInstanceIdResolver(opts.conn);
    this.definitionResolver =
      opts.definitionResolver ?? new WorkflowDefinitionIdResolver(opts.conn);
    this.eventLog = new PostgresEventLog({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.instanceStore = new PostgresInstanceStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
      definitionResolver: this.definitionResolver,
    });
    this.activityStore = new PostgresActivityStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.signalStore = new PostgresSignalStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.timerStore = new PostgresTimerStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
  }

  async resyncInstance(instanceId: string): Promise<ResyncReport> {
    const events = await this.eventLog.listByInstance(instanceId);
    if (events.length === 0) {
      return {
        instanceId,
        hadEvents: false,
        upserts: { instance: false, activities: 0, signals: 0, timers: 0 },
      };
    }
    const definition = this.resolveDefinitionFor(events);
    const projection = projectInstance(events, definition);
    // Resolved before the first write: this is the one projection that can refuse, and a refusal
    // that has already upserted the instance and its activities leaves a half-resynced instance
    // for a tool whose whole job is to make the projections agree with the log.
    const signals = projectPersistableSignals(events, definition);
    let instanceUpserted = false;
    if (projection !== null) {
      await this.instanceStore.upsertProjection(projection);
      instanceUpserted = true;
    }
    const activities = projectActivities(events) as readonly ActivityProjection[];
    await this.activityStore.upsertMany(activities);
    await this.signalStore.upsertMany(signals);
    const timers = projectTimers(events).map((t): TimerProjection => ({
      id: t.id,
      instanceId: t.instanceId,
      tenantId: t.tenantId,
      timerName: t.timerName,
      status: t.status,
      scheduledAt: t.scheduledAt,
      fireAt: t.fireAt,
      firedAt: t.firedAt,
      cancelledAt: t.cancelledAt,
    }));
    await this.timerStore.upsertMany(timers);
    return {
      instanceId,
      hadEvents: true,
      upserts: {
        instance: instanceUpserted,
        activities: activities.length,
        signals: signals.length,
        timers: timers.length,
      },
    };
  }

  async verifyInstance(instanceId: string): Promise<VerifyReport> {
    const events = await this.eventLog.listByInstance(instanceId);
    if (events.length === 0) {
      return {
        instanceId,
        hasEvents: false,
        definitionId: null,
        instance: { instanceMissing: false, fields: [] },
        activities: { missingIds: [], extraIds: [], mismatchedIds: [] },
        signals: { missingIds: [], extraIds: [], mismatchedIds: [] },
        timers: { missingIds: [], extraIds: [], mismatchedIds: [] },
        drifted: false,
      };
    }
    const definition = this.resolveDefinitionFor(events);
    const expected = projectInstance(events, definition);
    const storedInstance = await this.fetchInstanceRow(instanceId);
    const instanceDrift = expected === null
      ? { instanceMissing: storedInstance !== null, fields: [] as DriftField[] }
      : compareInstanceProjection(expected, storedInstance);

    const expectedActivities = projectActivities(events);
    const storedActivities = await this.fetchActivityRows(instanceId);
    const activityDrift = compareActivityProjections(
      expectedActivities as readonly ActivityProjection[],
      storedActivities,
    );

    // `projectSignals`, not `projectPersistableSignals`: this is the read-only report, and it
    // compares the two fields a resync can actually repair. Provenance — the delivery guarantee,
    // the source system, the principal — is written once at receipt and deliberately left out of
    // the upsert's DO UPDATE set, so reporting a provenance mismatch here would be a finding no
    // repair clears, and a standing finding is one an operator mutes. The non-throwing projection
    // also keeps the report answerable when the definition map is incomplete, which is the
    // opposite choice from the write path above — a diagnostic that refuses to diagnose is worse
    // than one that reports less, while a write that invents a guarantee is worse than no write.
    const expectedSignals = projectSignals(events);
    const storedSignals = await this.fetchSignalRows(instanceId);
    const signalDrift = compareSimpleProjections(
      expectedSignals.map((s) => ({ id: s.id, status: s.status })),
      storedSignals.map((s) => ({ id: s.signal_id, status: s.status })),
    );

    const expectedTimers = projectTimers(events);
    const storedTimers = await this.fetchTimerRows(instanceId);
    const timerDrift = compareSimpleProjections(
      expectedTimers.map((t) => ({ id: t.id, status: t.status })),
      storedTimers.map((t) => ({ id: t.timer_id, status: t.status })),
    );

    const drifted =
      instanceDrift.instanceMissing ||
      instanceDrift.fields.length > 0 ||
      activityDrift.missingIds.length > 0 ||
      activityDrift.extraIds.length > 0 ||
      activityDrift.mismatchedIds.length > 0 ||
      signalDrift.missingIds.length > 0 ||
      signalDrift.extraIds.length > 0 ||
      signalDrift.mismatchedIds.length > 0 ||
      timerDrift.missingIds.length > 0 ||
      timerDrift.extraIds.length > 0 ||
      timerDrift.mismatchedIds.length > 0;

    return {
      instanceId,
      hasEvents: true,
      definitionId: definition?.id ?? null,
      instance: instanceDrift,
      activities: activityDrift,
      signals: signalDrift,
      timers: timerDrift,
      drifted,
    };
  }

  async listInstanceIds(opts: {
    readonly tenantId?: string;
    readonly status?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<readonly string[]> {
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId !== undefined) {
      params.push(opts.tenantId);
      filters.push(`tenant_id = $${params.length.toString()}`);
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      filters.push(`status = $${params.length.toString()}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    params.push(offset);
    const result = await this.conn.query<{ instance_id: string }>(
      `SELECT instance_id FROM ${SCHEMA}.workflow_instances ${where}
        ORDER BY started_at DESC
        LIMIT $${(params.length - 1).toString()} OFFSET $${params.length.toString()}`,
      params,
    );
    return result.rows.map((r) => r.instance_id);
  }

  async bulkResync(opts: {
    readonly tenantId?: string;
    readonly status?: string;
    readonly batchSize?: number;
    readonly maxInstances?: number;
  } = {}): Promise<readonly ResyncReport[]> {
    const batchSize = opts.batchSize ?? 100;
    const maxInstances = opts.maxInstances ?? Number.POSITIVE_INFINITY;
    const reports: ResyncReport[] = [];
    let offset = 0;
    while (reports.length < maxInstances) {
      const remaining = maxInstances - reports.length;
      const limit = Math.min(batchSize, remaining);
      const ids = await this.listInstanceIds({
        ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        limit,
        offset,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        reports.push(await this.resyncInstance(id));
      }
      if (ids.length < limit) break;
      offset += ids.length;
    }
    return reports;
  }

  private resolveDefinitionFor(events: readonly { readonly payload: Record<string, unknown> }[]): WorkflowDefinition | undefined {
    const first = events[0];
    if (first === undefined) return undefined;
    const definitionId =
      typeof first.payload["definitionId"] === "string"
        ? (first.payload["definitionId"] as string)
        : null;
    return definitionId === null ? undefined : this.definitions.get(definitionId);
  }

  private async fetchInstanceRow(instanceId: string): Promise<StoredInstanceRow | null> {
    const result = await this.conn.query<StoredInstanceRow>(
      `SELECT instance_id, status, current_state, variables, sequence_cursor,
              completed_at, failed_at, cancelled_at, suspended_at,
              compensation_started_at, compensation_completed_at,
              cancellation_requested_at, cancellation_requested_by,
              cancellation_disposition, cancellation_signalled_activity_ids
         FROM ${SCHEMA}.workflow_instances
        WHERE instance_id = $1
        LIMIT 1`,
      [instanceId],
    );
    return result.rows[0] ?? null;
  }

  private async fetchActivityRows(instanceId: string): Promise<readonly StoredActivityRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredActivityRow>(
      `SELECT activity_id, status, definition_activity_key
         FROM ${SCHEMA}.workflow_activities
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }

  private async fetchSignalRows(instanceId: string): Promise<readonly StoredSignalRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredSignalRow>(
      `SELECT signal_id, status
         FROM ${SCHEMA}.workflow_signals
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }

  private async fetchTimerRows(instanceId: string): Promise<readonly StoredTimerRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredTimerRow>(
      `SELECT timer_id, status
         FROM ${SCHEMA}.workflow_timers
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }
}

function compareInstanceProjection(
  expected: ProjectedInstance,
  stored: StoredInstanceRow | null,
): InstanceDrift {
  if (stored === null) {
    return { instanceMissing: true, fields: [] };
  }
  const fields: DriftField[] = [];
  const expectedVariables = expected.variables;
  const storedVariables = parseJsonObject(stored.variables);
  if (stored.status !== expected.status) {
    fields.push({ field: "status", stored: stored.status, expected: expected.status });
  }
  if (stored.current_state !== expected.currentState) {
    fields.push({
      field: "current_state",
      stored: stored.current_state,
      expected: expected.currentState,
    });
  }
  if (stored.sequence_cursor !== expected.sequenceCursor) {
    fields.push({
      field: "sequence_cursor",
      stored: stored.sequence_cursor,
      expected: expected.sequenceCursor,
    });
  }
  if (!shallowEqual(expectedVariables, storedVariables)) {
    fields.push({ field: "variables", stored: storedVariables, expected: expectedVariables });
  }
  // The cancellation fence, compared on the same footing as the terminal timestamps. It is the field
  // the driver loops read *instead of* the status, so a row whose `cancellation_requested_at` was
  // cleared would serve a cancelled instance's timers as live — and until this, nothing looked.
  const storedCancellation = cancellationProjectionFromRow(stored);
  // Every timestamp goes through `isoInstant`, including the six that were here before: node-postgres
  // returns a `TIMESTAMPTZ` as a `Date`, so the plain `!==` these used reported drift on every row
  // that had one set. Verified live against a real cluster; the offline fakes hand back strings,
  // which is why no test saw it.
  const timestampFields: Array<[string, unknown, string | null]> = [
    ["completed_at", stored.completed_at, expected.completedAt],
    ["failed_at", stored.failed_at, expected.failedAt],
    ["cancelled_at", stored.cancelled_at, expected.cancelledAt],
    ["suspended_at", stored.suspended_at, expected.suspendedAt],
    [
      "compensation_started_at",
      stored.compensation_started_at,
      expected.compensationStartedAt,
    ],
    [
      "compensation_completed_at",
      stored.compensation_completed_at,
      expected.compensationCompletedAt,
    ],
    [
      "cancellation_requested_at",
      storedCancellation.cancellationRequestedAt,
      expected.cancellationRequestedAt,
    ],
  ];
  for (const [name, storedValue, expectedValue] of timestampFields) {
    const storedInstant = isoInstant(storedValue);
    if (storedInstant !== (expectedValue === null ? null : isoInstant(expectedValue))) {
      fields.push({ field: name, stored: storedInstant, expected: expectedValue });
    }
  }
  const textFields: Array<[string, string | null, string | null]> = [
    [
      "cancellation_requested_by",
      storedCancellation.cancellationRequestedBy,
      expected.cancellationRequestedBy,
    ],
    [
      "cancellation_disposition",
      storedCancellation.cancellationDisposition,
      expected.cancellationDisposition,
    ],
  ];
  for (const [name, storedValue, expectedValue] of textFields) {
    if (storedValue !== expectedValue) {
      fields.push({ field: name, stored: storedValue, expected: expectedValue });
    }
  }
  // **Compared as a sequence, not as a set.** The projection builds this from a `Set` whose
  // insertion order is first-occurrence order over `listByInstance`, which orders by
  // `sequence_number` — unique per instance under `workflow_events_instance_sequence_key`, so the
  // order is a total and deterministic function of the log, and the only writer of the column is
  // `upsertProjection` from that same projection. A healthy row therefore matches element for
  // element, and a set comparison would be strictly weaker for no gain: it would pass a reordered
  // column that the healthy writer could never have produced. A stored value that is not a JSON
  // array of strings reads as drift rather than as emptiness, which is why the raw value is
  // reported.
  const storedIds = storedCancellation.cancellationSignalledActivityIds;
  if (storedIds === null || !sequenceEqual(storedIds, expected.cancellationSignalledActivityIds)) {
    fields.push({
      field: "cancellation_signalled_activity_ids",
      stored: storedIds ?? stored.cancellation_signalled_activity_ids,
      expected: expected.cancellationSignalledActivityIds,
    });
  }
  return { instanceMissing: false, fields };
}

function sequenceEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function compareActivityProjections(
  expected: readonly ActivityProjection[],
  stored: readonly StoredActivityRow[],
): ChildEntityDrift {
  const expectedById = new Map(expected.map((e) => [e.id, e] as const));
  const storedById = new Map(stored.map((s) => [s.activity_id, s] as const));
  const missingIds: string[] = [];
  const extraIds: string[] = [];
  const mismatchedIds: string[] = [];
  for (const [id, e] of expectedById) {
    const s = storedById.get(id);
    if (s === undefined) {
      missingIds.push(id);
      continue;
    }
    if (s.status !== e.status || s.definition_activity_key !== e.definitionActivityKey) {
      mismatchedIds.push(id);
    }
  }
  for (const id of storedById.keys()) {
    if (!expectedById.has(id)) extraIds.push(id);
  }
  return { missingIds, extraIds, mismatchedIds };
}

function compareSimpleProjections(
  expected: readonly { readonly id: string; readonly status: string }[],
  stored: readonly { readonly id: string; readonly status: string }[],
): ChildEntityDrift {
  const expectedById = new Map(expected.map((e) => [e.id, e] as const));
  const storedById = new Map(stored.map((s) => [s.id, s] as const));
  const missingIds: string[] = [];
  const extraIds: string[] = [];
  const mismatchedIds: string[] = [];
  for (const [id, e] of expectedById) {
    const s = storedById.get(id);
    if (s === undefined) {
      missingIds.push(id);
      continue;
    }
    if (s.status !== e.status) mismatchedIds.push(id);
  }
  for (const id of storedById.keys()) {
    if (!expectedById.has(id)) extraIds.push(id);
  }
  return { missingIds, extraIds, mismatchedIds };
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
