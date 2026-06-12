import {
  incrementVectorClock,
  isAutoResolvable,
  preferredStrategyFor,
  EMPTY_VECTOR_CLOCK,
  type CausalRelation,
  type ConflictKind,
  type Crdt,
  type ResolutionStrategy,
} from "@crossengin/active-active";
import type { Region } from "@crossengin/residency";

import { mergeCrdt, mergeReplicatedValues, type ReplicatedValue } from "./replicated-value.js";

/** A replicated value broadcast from one region to its peers. */
export interface ReplicationMessage {
  readonly fromRegion: Region;
  readonly value: ReplicatedValue;
}

export const REPLICATION_EVENT_KINDS = [
  "local_write",
  "remote_applied",
  "concurrent_merged",
  "stale_ignored",
] as const;
export type ReplicationEventKind = (typeof REPLICATION_EVENT_KINDS)[number];

/** A normalized record of one engine action, for observability. */
export interface ReplicationEvent {
  readonly kind: ReplicationEventKind;
  readonly key: string;
  /** The engine's own region. */
  readonly region: Region;
  /** The remote source region for a received message; `null` for a local write. */
  readonly fromRegion: Region | null;
  /** The incoming clock's relation to the local clock; `null` for a local write / first apply. */
  readonly relation: CausalRelation | null;
  readonly at: string;
}

/**
 * A concurrent-write resolution: two regions wrote the same key with causally
 * concurrent clocks, and the CRDT merge resolved them deterministically. The
 * `kind` / `strategy` are classified through the `@crossengin/active-active`
 * conflict contracts; CRDT keys are always `autoResolved` (the merge is the
 * resolution), so this is an audit record, not an open incident.
 */
export interface ConcurrentResolution {
  readonly key: string;
  readonly kind: ConflictKind;
  readonly strategy: ResolutionStrategy;
  readonly autoResolved: boolean;
  readonly regions: readonly [Region, Region];
  readonly resolved: ReplicatedValue;
  readonly at: string;
}

export interface ReplicationEngineOptions {
  readonly region: Region;
  readonly now?: () => Date;
}

/**
 * The per-region active-active replication engine. It holds the region's local
 * copy of every replicated key, applies local CRDT writes (bumping this region's
 * vector-clock counter), and merges remote replicated values — classifying each
 * remote write as causally newer (applied), older/equal (stale, but the idempotent
 * CRDT merge is still safe), or concurrent (merged conflict-free, logged as a
 * `ConcurrentResolution`). Because every CRDT merge is commutative + associative +
 * idempotent, N regions that exchange all writes converge to identical state
 * regardless of delivery order or duplication.
 */
export class ReplicationEngine {
  readonly region: Region;
  private readonly now: () => Date;
  private readonly state = new Map<string, ReplicatedValue>();
  private readonly emitted: ReplicationEvent[] = [];
  private readonly resolutions: ConcurrentResolution[] = [];

  constructor(opts: ReplicationEngineOptions) {
    this.region = opts.region;
    this.now = opts.now ?? ((): Date => new Date());
  }

  private emit(event: Omit<ReplicationEvent, "region" | "at">): void {
    this.emitted.push({ ...event, region: this.region, at: this.now().toISOString() });
  }

  /**
   * Applies a local CRDT write for `key`: merges it into the current value (so a
   * caller can pass a small delta CRDT), bumps this region's vector-clock counter,
   * and returns the broadcastable message peers should `receive`.
   */
  localWrite(key: string, crdt: Crdt): ReplicationMessage {
    const existing = this.state.get(key);
    const mergedCrdt = existing === undefined ? crdt : mergeCrdt(existing.crdt, crdt);
    const clock = incrementVectorClock(existing?.clock ?? EMPTY_VECTOR_CLOCK, this.region);
    const value: ReplicatedValue = {
      key,
      crdt: mergedCrdt,
      clock,
      lastWriter: this.region,
      updatedAt: this.now().toISOString(),
    };
    this.state.set(key, value);
    this.emit({ kind: "local_write", key, fromRegion: null, relation: null });
    return { fromRegion: this.region, value };
  }

  /** Merges a remote replicated value, classifying + (for concurrency) logging it. Returns the new local value. */
  receive(message: ReplicationMessage): ReplicatedValue {
    const incoming = message.value;
    const existing = this.state.get(incoming.key);
    if (existing === undefined) {
      this.state.set(incoming.key, incoming);
      this.emit({ kind: "remote_applied", key: incoming.key, fromRegion: message.fromRegion, relation: null });
      return incoming;
    }

    const { value, relation } = mergeReplicatedValues(existing, incoming);
    this.state.set(incoming.key, value);

    if (relation === "concurrent") {
      const strategy = preferredStrategyFor("concurrent_write");
      this.resolutions.push({
        key: incoming.key,
        kind: "concurrent_write",
        strategy,
        autoResolved: isAutoResolvable(strategy),
        regions: [existing.lastWriter, incoming.lastWriter],
        resolved: value,
        at: this.now().toISOString(),
      });
      this.emit({ kind: "concurrent_merged", key: incoming.key, fromRegion: message.fromRegion, relation });
    } else if (relation === "after") {
      this.emit({ kind: "remote_applied", key: incoming.key, fromRegion: message.fromRegion, relation });
    } else {
      // "before" / "equal": the incoming write carries no new causal information; the
      // CRDT merge already applied is idempotent, so the value is unchanged in effect.
      this.emit({ kind: "stale_ignored", key: incoming.key, fromRegion: message.fromRegion, relation });
    }
    return value;
  }

  /** The current local value for `key`, or `null`. */
  value(key: string): ReplicatedValue | null {
    return this.state.get(key) ?? null;
  }

  /** The keys this engine holds, sorted. */
  keys(): readonly string[] {
    return [...this.state.keys()].sort();
  }

  /** A snapshot of every replicated value (for reconciliation / inspection), key-sorted. */
  snapshot(): readonly ReplicatedValue[] {
    return this.keys().map((k) => this.state.get(k)!);
  }

  /** The emitted event log (newest last). */
  events(): readonly ReplicationEvent[] {
    return this.emitted;
  }

  /** The logged concurrent-write resolutions. */
  concurrentResolutions(): readonly ConcurrentResolution[] {
    return this.resolutions;
  }
}
