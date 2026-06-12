import type { ConcurrentResolution, ReplicationEvent } from "@crossengin/active-active-runtime";

/** A row of `meta.replication_events` reconstructed on read. */
export interface ReplicationEventRecord {
  readonly id: string;
  readonly eventKind: ReplicationEvent["kind"];
  readonly recordKey: string;
  readonly region: string;
  readonly fromRegion: string | null;
  readonly causalRelation: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** A row of `meta.replication_conflicts` reconstructed on read. */
export interface ReplicationConflictRecord {
  readonly id: string;
  readonly recordKey: string;
  readonly conflictKind: string;
  readonly resolutionStrategy: string;
  readonly autoResolved: boolean;
  readonly regionA: string;
  readonly regionB: string;
  readonly resolvedValue: unknown;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Maps a raw `meta.replication_events` row to a `ReplicationEventRecord`. */
export function rowToReplicationEvent(row: Record<string, unknown>): ReplicationEventRecord {
  return {
    id: String(row["id"]),
    eventKind: String(row["event_kind"]) as ReplicationEvent["kind"],
    recordKey: String(row["record_key"]),
    region: String(row["region"]),
    fromRegion: row["from_region"] === null || row["from_region"] === undefined ? null : String(row["from_region"]),
    causalRelation:
      row["causal_relation"] === null || row["causal_relation"] === undefined ? null : String(row["causal_relation"]),
    occurredAt: isoOf(row["occurred_at"]),
    recordedAt: isoOf(row["recorded_at"]),
  };
}

/** Maps a raw `meta.replication_conflicts` row to a `ReplicationConflictRecord`. */
export function rowToReplicationConflict(row: Record<string, unknown>): ReplicationConflictRecord {
  const resolved = row["resolved_value"];
  return {
    id: String(row["id"]),
    recordKey: String(row["record_key"]),
    conflictKind: String(row["conflict_kind"]),
    resolutionStrategy: String(row["resolution_strategy"]),
    autoResolved: row["auto_resolved"] === true,
    regionA: String(row["region_a"]),
    regionB: String(row["region_b"]),
    resolvedValue: typeof resolved === "string" ? (JSON.parse(resolved) as unknown) : resolved,
    occurredAt: isoOf(row["occurred_at"]),
    recordedAt: isoOf(row["recorded_at"]),
  };
}

/** Projects a runtime `ReplicationEvent` into the column tuple for an INSERT. */
export function replicationEventInsertParams(event: ReplicationEvent): readonly unknown[] {
  return [event.kind, event.key, event.region, event.fromRegion, event.relation, event.at];
}

/** Projects a runtime `ConcurrentResolution` into the column tuple for an INSERT. */
export function replicationConflictInsertParams(resolution: ConcurrentResolution): readonly unknown[] {
  return [
    resolution.key,
    resolution.kind,
    resolution.strategy,
    resolution.autoResolved,
    resolution.regions[0],
    resolution.regions[1],
    JSON.stringify(resolution.resolved),
    resolution.at,
  ];
}
