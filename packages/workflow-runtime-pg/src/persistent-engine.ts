import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import {
  type ActivityRegistry,
  type Clock,
  type IdGenerator,
  WorkflowEngine,
  createDefaultRegistry,
} from "@crossengin/workflow-runtime";

import { PostgresEventLog } from "./event-log.js";
import {
  ProjectingEventLog,
  buildPersistentStores,
  type PersistentStores,
} from "./projecting-event-log.js";

export interface BuildPersistentEngineInput {
  readonly conn: PgConnection;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly activityRegistry?: ActivityRegistry;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly systemActorId?: string;
  /**
   * Leave a scheduled activity `scheduled` for a distributed worker to claim and execute, instead of
   * running its handler inline in whichever process scheduled it. Default false, as the engine's own
   * default is.
   *
   * It is the activity worker's precondition, not a preference: inline, the row is `scheduled` only
   * for the window between the `activity_scheduled` append and the `activity_started` one, so a
   * worker polling the same database can claim it inside that window and run the handler a second
   * time. The duplicate append collides on `workflow_events_instance_sequence_key`, so the *log*
   * survives — but the handler's side effects have already happened twice. So a deployment that runs
   * the activity worker must defer, and one that does not must not.
   */
  readonly deferActivities?: boolean;
}

export interface PersistentEngineBundle {
  readonly engine: WorkflowEngine;
  readonly eventLog: ProjectingEventLog;
  readonly stores: PersistentStores;
}

export function buildPersistentEngine(
  input: BuildPersistentEngineInput,
): PersistentEngineBundle {
  const stores = buildPersistentStores({ conn: input.conn });
  const innerEventLog = new PostgresEventLog({
    conn: input.conn,
    instanceResolver: stores.instanceResolver,
  });
  const eventLog = new ProjectingEventLog({
    inner: innerEventLog,
    definitions: input.definitions,
    instanceStore: stores.instanceStore,
    activityStore: stores.activityStore,
    signalStore: stores.signalStore,
    timerStore: stores.timerStore,
  });
  const engine = new WorkflowEngine({
    eventLog,
    definitions: input.definitions,
    activityRegistry: input.activityRegistry ?? createDefaultRegistry(),
    // Not optional for a persistent engine: the in-process default forgets every accepted key on
    // restart and shares nothing with a second replica, so `exactly_once_idempotent` would be a
    // promise readable only from the process that happened to make it.
    signalDeduplicator: stores.signalDeduplicator,
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(input.idGenerator !== undefined ? { idGenerator: input.idGenerator } : {}),
    ...(input.systemActorId !== undefined ? { systemActorId: input.systemActorId } : {}),
    ...(input.deferActivities !== undefined ? { deferActivities: input.deferActivities } : {}),
  });
  return { engine, eventLog, stores };
}
