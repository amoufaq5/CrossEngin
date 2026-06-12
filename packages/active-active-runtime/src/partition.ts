import {
  canTransitionSplitBrain,
  type HealingStrategy,
  type SplitBrainStatus,
} from "@crossengin/active-active";
import type { Region } from "@crossengin/residency";

import type { ReplicationEngine, ReplicationMessage } from "./engine.js";

/**
 * Reconciles a set of per-region engines after a partition heals: every engine
 * receives every *other* engine's full snapshot, so all converge to identical
 * state. CRDT merges are commutative + associative + idempotent, so the exchange
 * needs no ordering and is safe to re-run (a re-delivered value is a no-op).
 */
export function reconcileEngines(engines: readonly ReplicationEngine[]): void {
  const messages: ReplicationMessage[] = engines.flatMap((engine) =>
    engine.snapshot().map((value) => ({ fromRegion: engine.region, value })),
  );
  for (const engine of engines) {
    for (const message of messages) {
      if (message.fromRegion !== engine.region) engine.receive(message);
    }
  }
}

/** One observation of the topology's connectivity: a partition of the regions into reachable groups. */
export interface PartitionObservation {
  readonly groups: readonly (readonly Region[])[];
}

/** The monitor's verdict for one observation. */
export interface PartitionReport {
  /** `healed` is also the steady healthy state (no active split-brain incident). */
  readonly status: SplitBrainStatus;
  readonly groups: readonly (readonly Region[])[];
  /** The strict-majority group that may keep accepting writes, or `null` when no group has quorum. */
  readonly quorum: readonly Region[] | null;
  /** The non-quorum groups (all groups when there's no quorum). */
  readonly minorities: readonly (readonly Region[])[];
  readonly healingStrategy: HealingStrategy | null;
  readonly at: string;
}

/** The strict-majority group (size·2 > total), or `null` if none. */
function majorityGroup(
  groups: readonly (readonly Region[])[],
  total: number,
): readonly Region[] | null {
  for (const group of groups) {
    if (group.length * 2 > total) return group;
  }
  return null;
}

/** Advances an open split-brain incident one step toward `healed` once connectivity is restored. */
function healStep(status: SplitBrainStatus): SplitBrainStatus {
  if (status === "detected" || status === "isolating") return "healing";
  if (status === "healing") return "healed";
  return status;
}

export interface PartitionMonitorOptions {
  /** The total number of regions in the topology (for quorum). */
  readonly totalRegions: number;
  readonly now?: () => Date;
}

/**
 * Tracks an active-active topology's connectivity and drives the split-brain
 * lifecycle (`@crossengin/active-active` statuses). A multi-group observation opens
 * an incident at `detected`; while split it reports the quorum side (the group that
 * may keep accepting writes) and the minorities to freeze. Once connectivity is
 * restored, successive observations advance `detected → healing → healed` (each step
 * guarded by `canTransitionSplitBrain`); reaching `healed` closes the incident, after
 * which a future split opens a fresh one. The caller reconciles the divergent engines
 * (`reconcileEngines`) on the `healing` step, where the CRDT merges converge them.
 */
export class PartitionMonitor {
  private readonly total: number;
  private readonly now: () => Date;
  /** `null` = no active incident (healthy). */
  private status: SplitBrainStatus | null = null;

  constructor(opts: PartitionMonitorOptions) {
    this.total = opts.totalRegions;
    this.now = opts.now ?? ((): Date => new Date());
  }

  observe(observation: PartitionObservation): PartitionReport {
    const groups = observation.groups;
    const isSplit = groups.length > 1;
    const quorum = isSplit ? majorityGroup(groups, this.total) : (groups[0] ?? null);
    const minorities = isSplit ? groups.filter((g) => g !== quorum) : [];

    let healingStrategy: HealingStrategy | null = null;
    if (isSplit) {
      if (this.status === null) this.status = "detected";
      healingStrategy = quorum !== null ? "prefer_quorum_side" : "freeze_and_audit";
    } else if (this.status !== null) {
      const next = healStep(this.status);
      if (next !== this.status && canTransitionSplitBrain(this.status, next)) {
        this.status = next;
      }
      healingStrategy = this.status === "healing" ? "auto_merge_concurrent" : null;
    }

    const reported: SplitBrainStatus = this.status ?? "healed";
    if (this.status === "healed") this.status = null; // incident closed; next split opens a fresh one

    return {
      status: reported,
      groups,
      quorum,
      minorities,
      healingStrategy,
      at: this.now().toISOString(),
    };
  }

  /** The current incident status, or `null` when healthy. */
  current(): SplitBrainStatus | null {
    return this.status;
  }
}
