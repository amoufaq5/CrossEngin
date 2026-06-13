import {
  ReplicationEngine,
  type ReplicatedValue,
  type ReplicationEngineOptions,
  type ReplicationEvent,
  type ReplicationMessage,
} from "@crossengin/active-active-runtime";

import type { PostgresReplicationConflictStore } from "./conflict-store.js";
import type { PostgresReplicationEventStore } from "./event-store.js";

/** The CRDT payload type, derived from the engine's own `localWrite` signature (avoids a direct `active-active` dep). */
type Crdt = Parameters<ReplicationEngine["localWrite"]>[1];

export interface PersistingReplicationEngineDeps {
  readonly eventStore: PostgresReplicationEventStore;
  readonly conflictStore: PostgresReplicationConflictStore;
}

/**
 * Wraps a `ReplicationEngine` so every `localWrite` / `receive` also persists the
 * events + concurrent-resolutions it newly appended — the "writer" that drains a
 * live engine into `meta.replication_events` / `meta.replication_conflicts` as it
 * runs (the same pattern as `observability-runtime-pg`'s
 * `buildPersistentSloEnforcementEngine`, no separate worker). It flushes only the
 * delta since the last op (the engine's logs are append-only), so re-flushing is a
 * no-op and a long-lived engine doesn't re-persist its whole history each call.
 */
export class PersistingReplicationEngine {
  private readonly engine: ReplicationEngine;
  private readonly eventStore: PostgresReplicationEventStore;
  private readonly conflictStore: PostgresReplicationConflictStore;
  private flushedEvents = 0;
  private flushedConflicts = 0;

  constructor(engine: ReplicationEngine, deps: PersistingReplicationEngineDeps) {
    this.engine = engine;
    this.eventStore = deps.eventStore;
    this.conflictStore = deps.conflictStore;
  }

  get region(): ReplicationEngine["region"] {
    return this.engine.region;
  }

  /** Applies a local CRDT write, persists the new event, and returns the broadcast message. */
  async localWrite(key: string, crdt: Crdt): Promise<ReplicationMessage> {
    const message = this.engine.localWrite(key, crdt);
    await this.flush();
    return message;
  }

  /** Merges a remote value, persists the new event (+ any concurrent-resolution), and returns the value. */
  async receive(message: ReplicationMessage): Promise<ReplicatedValue> {
    const value = this.engine.receive(message);
    await this.flush();
    return value;
  }

  value(key: string): ReplicatedValue | null {
    return this.engine.value(key);
  }

  snapshot(): readonly ReplicatedValue[] {
    return this.engine.snapshot();
  }

  events(): readonly ReplicationEvent[] {
    return this.engine.events();
  }

  /** Persists every event + resolution the engine appended since the last flush. */
  private async flush(): Promise<void> {
    const events = this.engine.events();
    for (; this.flushedEvents < events.length; this.flushedEvents += 1) {
      await this.eventStore.record(events[this.flushedEvents]!);
    }
    const conflicts = this.engine.concurrentResolutions();
    for (; this.flushedConflicts < conflicts.length; this.flushedConflicts += 1) {
      await this.conflictStore.record(conflicts[this.flushedConflicts]!);
    }
  }
}

/**
 * One-call factory: builds a fresh `ReplicationEngine` for `region` and wraps it in
 * a `PersistingReplicationEngine` over the two stores, so every op persists.
 */
export function buildPersistentReplicationEngine(
  options: ReplicationEngineOptions,
  deps: PersistingReplicationEngineDeps,
): PersistingReplicationEngine {
  return new PersistingReplicationEngine(new ReplicationEngine(options), deps);
}
