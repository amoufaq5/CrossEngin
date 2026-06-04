import type { PgConnection } from "@crossengin/kernel-pg";
import type { ActivityKind, ActivityStatus, WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import {
  type EventLog,
  projectActivities,
  projectInstance,
  projectSignals,
  projectTimers,
} from "@crossengin/workflow-runtime";

import { PostgresActivityStore, type ActivityProjection } from "./activity-store.js";
import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { PostgresInstanceStore } from "./instance-store.js";
import { PostgresSignalStore, type SignalProjection } from "./signal-store.js";
import { PostgresTimerStore, type TimerProjection } from "./timer-store.js";

export interface ProjectingEventLogOptions {
  readonly inner: EventLog;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly instanceStore: PostgresInstanceStore;
  readonly activityStore: PostgresActivityStore;
  readonly signalStore: PostgresSignalStore;
  readonly timerStore: PostgresTimerStore;
}

export class ProjectingEventLog implements EventLog {
  private readonly inner: EventLog;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly instanceStore: PostgresInstanceStore;
  private readonly activityStore: PostgresActivityStore;
  private readonly signalStore: PostgresSignalStore;
  private readonly timerStore: PostgresTimerStore;
  private readonly createdInstances: Set<string> = new Set();

  constructor(opts: ProjectingEventLogOptions) {
    this.inner = opts.inner;
    this.definitions = opts.definitions;
    this.instanceStore = opts.instanceStore;
    this.activityStore = opts.activityStore;
    this.signalStore = opts.signalStore;
    this.timerStore = opts.timerStore;
  }

  async append(event: WorkflowEvent): Promise<void> {
    if (event.kind === "instance_started") {
      const initialProjection = projectInstance([event]);
      if (initialProjection === null) {
        throw new Error(`failed to project initial instance for ${event.instanceId}`);
      }
      const definitionId =
        typeof event.payload["definitionId"] === "string"
          ? (event.payload["definitionId"] as string)
          : initialProjection.definitionId;
      if (definitionId.length === 0) {
        throw new Error(`instance_started event missing definitionId for ${event.instanceId}`);
      }
      await this.instanceStore.create({
        projection: initialProjection,
        definitionId,
      });
      this.createdInstances.add(event.instanceId);
    }

    await this.inner.append(event);
    await this.persistProjections(event);
  }

  async appendBatch(events: readonly WorkflowEvent[]): Promise<void> {
    for (const event of events) {
      await this.append(event);
    }
  }

  async listByInstance(instanceId: string): Promise<readonly WorkflowEvent[]> {
    return this.inner.listByInstance(instanceId);
  }

  async latestSequence(instanceId: string): Promise<number | null> {
    return this.inner.latestSequence(instanceId);
  }

  async count(): Promise<number> {
    return this.inner.count();
  }

  private async persistProjections(event: WorkflowEvent): Promise<void> {
    const events = await this.inner.listByInstance(event.instanceId);
    if (events.length === 0) return;

    const first = events[0]!;
    const definitionId =
      typeof first.payload["definitionId"] === "string"
        ? (first.payload["definitionId"] as string)
        : null;
    const definition = definitionId === null ? undefined : this.definitions.get(definitionId);

    if (event.kind !== "instance_started") {
      const projection = projectInstance(events, definition);
      if (projection !== null) {
        await this.instanceStore.upsertProjection(projection);
      }
    }

    const activities = projectActivities(events);
    await this.activityStore.upsertMany(activities as readonly ActivityProjection[]);

    const signals = projectSignals(events);
    if (signals.length > 0) {
      const projections: SignalProjection[] = signals.map((s) => ({
        id: s.id,
        instanceId: s.instanceId,
        tenantId: s.tenantId,
        signalName: s.signalName,
        correlationKey: s.correlationKey,
        deliveryGuarantee: s.deliveryGuarantee,
        sourceSystem: s.sourceSystem,
        status: s.status,
        receivedAt: s.receivedAt,
        matchedAt: s.matchedAt,
        consumedAt: s.consumedAt,
      }));
      await this.signalStore.upsertMany(projections);
    }

    const timers = projectTimers(events);
    if (timers.length > 0) {
      const projections: TimerProjection[] = timers.map((t) => ({
        id: t.id,
        instanceId: t.instanceId,
        tenantId: t.tenantId,
        timerName: t.timerName,
        kind: t.kind,
        status: t.status,
        scheduledAt: t.scheduledAt,
        fireAt: t.fireAt,
        firedAt: t.firedAt,
        cancelledAt: t.cancelledAt,
      }));
      await this.timerStore.upsertMany(projections);
    }
  }
}

export interface BuildPersistentStoresInput {
  readonly conn: PgConnection;
  readonly instanceResolver?: WorkflowInstanceIdResolver;
  readonly definitionResolver?: WorkflowDefinitionIdResolver;
}

export interface PersistentStores {
  readonly instanceResolver: WorkflowInstanceIdResolver;
  readonly definitionResolver: WorkflowDefinitionIdResolver;
  readonly instanceStore: PostgresInstanceStore;
  readonly activityStore: PostgresActivityStore;
  readonly signalStore: PostgresSignalStore;
  readonly timerStore: PostgresTimerStore;
}

export function buildPersistentStores(input: BuildPersistentStoresInput): PersistentStores {
  const instanceResolver = input.instanceResolver ?? new WorkflowInstanceIdResolver(input.conn);
  const definitionResolver =
    input.definitionResolver ?? new WorkflowDefinitionIdResolver(input.conn);
  return {
    instanceResolver,
    definitionResolver,
    instanceStore: new PostgresInstanceStore({
      conn: input.conn,
      instanceResolver,
      definitionResolver,
    }),
    activityStore: new PostgresActivityStore({ conn: input.conn, instanceResolver }),
    signalStore: new PostgresSignalStore({ conn: input.conn, instanceResolver }),
    timerStore: new PostgresTimerStore({ conn: input.conn, instanceResolver }),
  };
}

export interface ActivityKindFilter {
  readonly kind: ActivityKind;
  readonly status: ActivityStatus;
}
void ({} as ActivityKindFilter);
