import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import {
  type ActivityRegistry,
  type Clock,
  type IdGenerator,
  type WorkflowInstrumentation,
  WorkflowEngine,
  createDefaultRegistry,
} from "@crossengin/workflow-runtime";

import { PostgresEventLog } from "./event-log.js";
import { PostgresWorkflowInstrumentation } from "./instrumentation.js";
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
  readonly instrumentation?: WorkflowInstrumentation;
  readonly persistTraces?: boolean;
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
  const instrumentation = resolveInstrumentation(input, stores);
  const engine = new WorkflowEngine({
    eventLog,
    definitions: input.definitions,
    activityRegistry: input.activityRegistry ?? createDefaultRegistry(),
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(input.idGenerator !== undefined ? { idGenerator: input.idGenerator } : {}),
    ...(input.systemActorId !== undefined ? { systemActorId: input.systemActorId } : {}),
    ...(instrumentation !== undefined ? { instrumentation } : {}),
  });
  return { engine, eventLog, stores };
}

function resolveInstrumentation(
  input: BuildPersistentEngineInput,
  stores: PersistentStores,
): WorkflowInstrumentation | undefined {
  if (input.instrumentation !== undefined) return input.instrumentation;
  if (input.persistTraces === true) {
    return new PostgresWorkflowInstrumentation({
      conn: input.conn,
      instanceResolver: stores.instanceResolver,
      definitionResolver: stores.definitionResolver,
    });
  }
  return undefined;
}
