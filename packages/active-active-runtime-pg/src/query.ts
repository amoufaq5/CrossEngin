import type { ReplicationConflictRecord, ReplicationEventRecord } from "./records.js";

export type ReplicationCommand = "events" | "conflicts" | "verify";

export interface ReplicationCliOptions {
  readonly command: ReplicationCommand;
  readonly since: string | null;
  readonly key: string | null;
  readonly limit: number | null;
  readonly format: "human" | "json";
}

export const REPLICATION_DRIFT_KINDS = [
  "concurrent_event_without_conflict",
  "conflict_without_concurrent_event",
  "conflict_not_auto_resolved",
  "conflict_same_region",
  "concurrent_event_wrong_relation",
] as const;
export type ReplicationDriftKind = (typeof REPLICATION_DRIFT_KINDS)[number];

export interface ReplicationDriftIssue {
  readonly kind: ReplicationDriftKind;
  readonly recordKey: string;
  readonly detail: string;
}

/**
 * Pure cross-table drift sweep over a window of replication events + conflicts.
 * Flags what neither table enforces per-row: a `concurrent_merged` event must
 * carry the `concurrent` relation and have a matching conflict row; a conflict
 * must be between two distinct regions, be `auto_resolved` (a CRDT concurrent
 * write always is), and map back to a concurrent event for its key. (Cross-table
 * checks are over the loaded window — pass a wide enough window for a clean sweep.)
 */
export function verifyReplicationLedger(
  events: readonly ReplicationEventRecord[],
  conflicts: readonly ReplicationConflictRecord[],
): readonly ReplicationDriftIssue[] {
  const issues: ReplicationDriftIssue[] = [];
  const concurrentEventKeys = new Set<string>();
  for (const event of events) {
    if (event.eventKind !== "concurrent_merged") continue;
    concurrentEventKeys.add(event.recordKey);
    if (event.causalRelation !== "concurrent") {
      issues.push({
        kind: "concurrent_event_wrong_relation",
        recordKey: event.recordKey,
        detail: `concurrent_merged event has relation '${event.causalRelation ?? "null"}', expected 'concurrent'`,
      });
    }
  }

  const conflictKeys = new Set<string>();
  for (const conflict of conflicts) {
    conflictKeys.add(conflict.recordKey);
    if (!conflict.autoResolved) {
      issues.push({ kind: "conflict_not_auto_resolved", recordKey: conflict.recordKey, detail: "concurrent_write conflict is not auto_resolved" });
    }
    if (conflict.regionA === conflict.regionB) {
      issues.push({ kind: "conflict_same_region", recordKey: conflict.recordKey, detail: `conflict regions are identical ('${conflict.regionA}')` });
    }
  }

  for (const key of concurrentEventKeys) {
    if (!conflictKeys.has(key)) {
      issues.push({ kind: "concurrent_event_without_conflict", recordKey: key, detail: "a concurrent_merged event has no matching conflict row" });
    }
  }
  for (const key of conflictKeys) {
    if (!concurrentEventKeys.has(key)) {
      issues.push({ kind: "conflict_without_concurrent_event", recordKey: key, detail: "a conflict row has no matching concurrent_merged event" });
    }
  }
  return issues;
}

/** The structural read surface the `crossengin-replication` CLI runs over (the stores satisfy it via an adapter). */
export interface ReplicationQuerySource {
  listEvents(opts: { readonly since?: Date; readonly key?: string; readonly limit?: number }): Promise<readonly ReplicationEventRecord[]>;
  listConflicts(opts: { readonly key?: string; readonly limit?: number }): Promise<readonly ReplicationConflictRecord[]>;
}

export interface RunReplicationResult {
  readonly exitCode: number;
}

export class CliUsageError extends Error {}

function listOpts(options: ReplicationCliOptions): { since?: Date; key?: string; limit?: number } {
  const out: { since?: Date; key?: string; limit?: number } = {};
  if (options.since !== null) out.since = new Date(options.since);
  if (options.key !== null) out.key = options.key;
  if (options.limit !== null) out.limit = options.limit;
  return out;
}

export function formatEvents(events: readonly ReplicationEventRecord[]): string {
  if (events.length === 0) return "no replication events";
  return events
    .map((e) => `${e.occurredAt}  ${e.eventKind.padEnd(17)} ${e.recordKey}  ${e.region}${e.fromRegion !== null ? ` <- ${e.fromRegion}` : ""}${e.causalRelation !== null ? ` (${e.causalRelation})` : ""}`)
    .join("\n");
}

export function formatConflicts(conflicts: readonly ReplicationConflictRecord[]): string {
  if (conflicts.length === 0) return "no replication conflicts";
  return conflicts
    .map((c) => `${c.occurredAt}  ${c.recordKey}  ${c.conflictKind}/${c.resolutionStrategy}  ${c.regionA}|${c.regionB}  auto=${c.autoResolved}`)
    .join("\n");
}

export function formatVerify(issues: readonly ReplicationDriftIssue[]): string {
  if (issues.length === 0) return "replication ledger: no drift";
  return [`replication ledger: ${issues.length} drift issue(s)`, ...issues.map((i) => `  [${i.kind}] ${i.recordKey}: ${i.detail}`)].join("\n");
}

/**
 * Runs a parsed replication query over a source: `events` / `conflicts` list the
 * windowed rows; `verify` runs the cross-table drift sweep and **exits 1 on any
 * drift** (the CI-gate contract, like `crossengin-slo slo verify`).
 */
export async function runReplicationQuery(
  options: ReplicationCliOptions,
  source: ReplicationQuerySource,
  out: (line: string) => void,
): Promise<RunReplicationResult> {
  if (options.command === "events") {
    const events = await source.listEvents(listOpts(options));
    out(options.format === "json" ? JSON.stringify(events, null, 2) : formatEvents(events));
    return { exitCode: 0 };
  }
  if (options.command === "conflicts") {
    const conflicts = await source.listConflicts(listOpts(options));
    out(options.format === "json" ? JSON.stringify(conflicts, null, 2) : formatConflicts(conflicts));
    return { exitCode: 0 };
  }
  // verify — load a wide window of both and sweep
  const limit = options.limit ?? 1000;
  const events = await source.listEvents({ ...(options.since !== null ? { since: new Date(options.since) } : {}), limit });
  const conflicts = await source.listConflicts({ limit });
  const issues = verifyReplicationLedger(events, conflicts);
  out(options.format === "json" ? JSON.stringify(issues, null, 2) : formatVerify(issues));
  return { exitCode: issues.length > 0 ? 1 : 0 };
}

function takeValue(argv: readonly string[], i: number, name: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new CliUsageError(`--${name} requires a value`);
  return v;
}

/** Parses `replication <events|conflicts|verify> [--since iso] [--key k] [--limit n] [--format human|json]`. */
export function parseReplicationArgs(argv: readonly string[]): ReplicationCliOptions {
  const command = argv[0];
  if (command !== "events" && command !== "conflicts" && command !== "verify") {
    throw new CliUsageError(`unknown replication command '${command ?? ""}' (events|conflicts|verify)`);
  }
  let since: string | null = null;
  let key: string | null = null;
  let limit: number | null = null;
  let format: "human" | "json" = "human";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") {
      since = takeValue(argv, i, "since");
      i += 1;
    } else if (arg === "--key") {
      key = takeValue(argv, i, "key");
      i += 1;
    } else if (arg === "--limit") {
      const raw = takeValue(argv, i, "limit");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new CliUsageError(`--limit must be a positive integer`);
      limit = n;
      i += 1;
    } else if (arg === "--format") {
      const raw = takeValue(argv, i, "format");
      if (raw !== "human" && raw !== "json") throw new CliUsageError(`--format must be human or json`);
      format = raw;
      i += 1;
    } else {
      throw new CliUsageError(`unknown argument: ${arg ?? ""}`);
    }
  }
  return { command, since, key, limit, format };
}
