import type { HeartbeatMode, HeartbeatSnapshot } from "./heartbeat.js";

/**
 * Liveness of a worker as judged from its heartbeat: `healthy` (beating within
 * the staleness window), `stale` (a `running` worker that stopped beating —
 * presumed dead / hung), or `stopped` (cleanly shut down).
 */
export const WORKER_HEALTH_STATUSES = ["healthy", "stale", "stopped"] as const;
export type WorkerHealth = (typeof WORKER_HEALTH_STATUSES)[number];

/** How long without a heartbeat before a `running` worker is presumed dead. */
export const DEFAULT_STALE_AFTER_MS = 60_000;

export interface WorkerHealthOptions {
  readonly now: Date;
  readonly staleAfterMs?: number;
}

/** A `running` worker that has gone silent — the actionable signal for an incident. */
export interface StaleWorkerAlert {
  readonly workerId: string;
  readonly mode: HeartbeatMode;
  readonly hostname: string | null;
  readonly lastHeartbeatAt: string;
  readonly ageMs: number;
}

/**
 * Classifies one heartbeat: `stopped` if the worker reported a clean shutdown,
 * else `stale` when its last heartbeat is older than `staleAfterMs`, else
 * `healthy`. Pure — `now` is injected.
 */
export function classifyWorkerHealth(
  snapshot: HeartbeatSnapshot,
  opts: WorkerHealthOptions,
): WorkerHealth {
  if (snapshot.status === "stopped") return "stopped";
  const ageMs = opts.now.getTime() - Date.parse(snapshot.lastHeartbeatAt);
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return ageMs > staleAfterMs ? "stale" : "healthy";
}

export interface WorkerHealthReport {
  readonly total: number;
  readonly healthy: number;
  readonly stale: number;
  readonly stopped: number;
  /** The stale (presumed-dead) workers, the actionable alerts. */
  readonly alerts: readonly StaleWorkerAlert[];
}

/**
 * Folds a heartbeat list into a health report — counts per class + the stale
 * workers as `StaleWorkerAlert`s (sorted oldest-heartbeat first). Pure: the
 * caller supplies the snapshots (from `PostgresWorkerHeartbeatStore.listAll`)
 * and `now`, then routes the alerts to an incident / page as it sees fit.
 */
export function summarizeWorkerHealth(
  snapshots: readonly HeartbeatSnapshot[],
  opts: WorkerHealthOptions,
): WorkerHealthReport {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  let healthy = 0;
  let stale = 0;
  let stopped = 0;
  const alerts: StaleWorkerAlert[] = [];
  for (const s of snapshots) {
    const health = classifyWorkerHealth(s, { now: opts.now, staleAfterMs });
    if (health === "healthy") healthy += 1;
    else if (health === "stopped") stopped += 1;
    else {
      stale += 1;
      alerts.push({
        workerId: s.workerId,
        mode: s.mode,
        hostname: s.hostname,
        lastHeartbeatAt: s.lastHeartbeatAt,
        ageMs: opts.now.getTime() - Date.parse(s.lastHeartbeatAt),
      });
    }
  }
  alerts.sort((a, b) => Date.parse(a.lastHeartbeatAt) - Date.parse(b.lastHeartbeatAt));
  return { total: snapshots.length, healthy, stale, stopped, alerts };
}

/** A one-line operator/incident summary of a health report. */
export function formatWorkerHealth(report: WorkerHealthReport): string {
  const base = `${report.total.toString()} workers: ${report.healthy.toString()} healthy, ${report.stale.toString()} stale, ${report.stopped.toString()} stopped`;
  if (report.alerts.length === 0) return base;
  const ids = report.alerts.map((a) => `${a.workerId}(${a.mode}, ${Math.round(a.ageMs / 1000).toString()}s)`).join(", ");
  return `${base} — STALE: ${ids}`;
}
