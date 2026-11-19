import { assertScopeTenantId, type PgConnection } from "@crossengin/kernel-pg";
import type { ActivityKind, ActivityStatus, WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { type EventLog, projectInstance } from "@crossengin/workflow-runtime";

import { projectPersistableActivities } from "./activity-provenance.js";
import { PostgresActivityStore } from "./activity-store.js";
import { PostgresEventLog } from "./event-log.js";
import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import { PostgresInstanceStore } from "./instance-store.js";
import { projectPersistableSignals } from "./signal-provenance.js";
import { PostgresSignalDeduplicator, PostgresSignalStore } from "./signal-store.js";
import { projectPersistableTimers } from "./timer-provenance.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import { PostgresTimerStore } from "./timer-store.js";

/** The log and the four projection stores one append writes through. */
export interface ProjectionWriteScope {
  readonly inner: EventLog;
  readonly instanceStore: PostgresInstanceStore;
  readonly activityStore: PostgresActivityStore;
  readonly signalStore: PostgresSignalStore;
  readonly timerStore: PostgresTimerStore;
}

/**
 * Runs one append — the event and every projection it moves — as one unit, under the event's tenant.
 */
export type AppendUnit = <T>(
  tenantId: string,
  work: (scope: ProjectionWriteScope) => Promise<T>,
) => Promise<T>;

/**
 * One append, one transaction, under the event's own tenant context.
 *
 * The append used to be up to `2 + A + S + T` separate statements on the pool: the event committed
 * on its own and the projections followed, so anything that failed after the `INSERT` — a refused
 * provenance, `SignalIdempotencyConflict`, a dropped connection — left the event committed and the
 * claim tables stale. A `timer_scheduled` whose projection write failed was never fired, and because
 * a provenance refusal recurs on every later append of that instance, its projection never advanced
 * again: "refuse rather than persist" was "persist the event, then throw" (R15-05). In one
 * transaction the log and its projections commit or roll back together, which is also what makes
 * `WorkflowReplayer.verifyInstance`'s equality comparison sound: read under one snapshot, the
 * projection is the fold of the log by construction, and a difference is drift rather than a
 * concurrent append caught between two reads (CLAUDE.md register P2.17).
 *
 * The tenant context is set because the five tables carry one isolation policy each and nothing
 * else, so a confined session's writes are refused without it; the scope is a fact about the event,
 * not something a caller chooses. The *reads* the engine makes outside an append are still unscoped
 * (CLAUDE.md, "Four stores in `workflow-runtime-pg` set no tenant context"), so this does not by
 * itself make the engine usable as a confined role.
 */
export function transactionalAppendUnit(
  conn: PgConnection,
  resolvers: {
    readonly instanceResolver: WorkflowInstanceIdResolver;
    readonly definitionResolver: WorkflowDefinitionIdResolver;
  },
): AppendUnit {
  return async (tenantId, work) => {
    assertScopeTenantId(tenantId);
    return conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      const instanceResolver = resolvers.instanceResolver.boundTo(tx);
      const definitionResolver = resolvers.definitionResolver.boundTo(tx);
      return work({
        inner: new PostgresEventLog({ conn: tx, instanceResolver }),
        instanceStore: new PostgresInstanceStore({ conn: tx, instanceResolver, definitionResolver }),
        activityStore: new PostgresActivityStore({ conn: tx, instanceResolver }),
        signalStore: new PostgresSignalStore({ conn: tx, instanceResolver }),
        timerStore: new PostgresTimerStore({ conn: tx, instanceResolver }),
      });
    });
  };
}

export interface ProjectingEventLogOptions {
  readonly inner: EventLog;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly instanceStore: PostgresInstanceStore;
  readonly activityStore: PostgresActivityStore;
  readonly signalStore: PostgresSignalStore;
  readonly timerStore: PostgresTimerStore;
  /**
   * Writes each append as one unit (`transactionalAppendUnit`). **Required**, and `null` is the
   * explicit claim that the event and its projections are written as separate statements through
   * the stores above — which is only honest for a log with no transaction to offer.
   */
  readonly appendUnit: AppendUnit | null;
  /** Forgets an id mapping a rolled-back append registered; the resolver the stores above share. */
  readonly instanceResolver?: WorkflowInstanceIdResolver;
}

export class ProjectingEventLog implements EventLog {
  private readonly inner: EventLog;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly instanceStore: PostgresInstanceStore;
  private readonly activityStore: PostgresActivityStore;
  private readonly signalStore: PostgresSignalStore;
  private readonly timerStore: PostgresTimerStore;
  private readonly appendUnit: AppendUnit | null;
  private readonly instanceResolver: WorkflowInstanceIdResolver | undefined;
  private readonly createdInstances: Set<string> = new Set();

  constructor(opts: ProjectingEventLogOptions) {
    this.inner = opts.inner;
    this.definitions = opts.definitions;
    this.instanceStore = opts.instanceStore;
    this.activityStore = opts.activityStore;
    this.signalStore = opts.signalStore;
    this.timerStore = opts.timerStore;
    this.appendUnit = opts.appendUnit;
    this.instanceResolver = opts.instanceResolver;
  }

  async append(event: WorkflowEvent): Promise<void> {
    if (this.appendUnit === null) {
      await this.appendThrough(this.ownScope(), event);
      return;
    }
    try {
      await this.appendUnit(event.tenantId, (scope) => this.appendThrough(scope, event));
    } catch (err) {
      // The transaction rolled back, so an instance it created does not exist: the id it registered
      // in the shared cache would otherwise resolve to a row that was never committed.
      if (event.kind === "instance_started") {
        this.instanceResolver?.invalidate(event.instanceId);
        this.createdInstances.delete(event.instanceId);
      }
      throw err;
    }
  }

  private ownScope(): ProjectionWriteScope {
    return {
      inner: this.inner,
      instanceStore: this.instanceStore,
      activityStore: this.activityStore,
      signalStore: this.signalStore,
      timerStore: this.timerStore,
    };
  }

  private async appendThrough(scope: ProjectionWriteScope, event: WorkflowEvent): Promise<void> {
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
      await scope.instanceStore.create({
        projection: initialProjection,
        definitionId,
      });
      this.createdInstances.add(event.instanceId);
    }

    await scope.inner.append(event);
    await this.persistProjections(scope, event);
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

  private async persistProjections(scope: ProjectionWriteScope, event: WorkflowEvent): Promise<void> {
    const events = await scope.inner.listByInstance(event.instanceId);
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
        await scope.instanceStore.upsertProjection(projection);
      }
    }

    // All three child projections refuse rather than persist a row whose required columns cannot be
    // answered from the log plus the definition. That aborts the append, which is the loud outcome:
    // the alternative is a row claiming a guarantee nobody promised, a schedule nobody declared, or
    // a retry ceiling nobody chose — in the very tables those facts are read back from. The casts
    // these three lines used to carry are gone with them: `ActivityProjection` is no longer
    // structurally satisfied by what the pure fold produces, so the type system now holds the gap
    // open instead of letting a cast close it.
    const activities = projectPersistableActivities(events, definition);
    if (activities.length > 0) {
      await scope.activityStore.upsertMany(activities);
    }

    const signals = projectPersistableSignals(events, definition);
    if (signals.length > 0) {
      await scope.signalStore.upsertMany(signals);
    }

    const timers = projectPersistableTimers(events, definition);
    if (timers.length > 0) {
      await scope.timerStore.upsertMany(timers);
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
  /**
   * Beside the store rather than inside it: the store writes one row, while this answers a question
   * about the whole table — which is `WorkflowEngine`'s to ask, not `ProjectingEventLog`'s.
   */
  readonly signalDeduplicator: PostgresSignalDeduplicator;
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
    signalDeduplicator: new PostgresSignalDeduplicator(input.conn),
    timerStore: new PostgresTimerStore({ conn: input.conn, instanceResolver }),
  };
}

export interface ActivityKindFilter {
  readonly kind: ActivityKind;
  readonly status: ActivityStatus;
}
void ({} as ActivityKindFilter);
