import type { IncidentRecord, Severity } from "@crossengin/incident-response";
import type { AlertPolicy } from "@crossengin/observability";
import {
  planIncidentDeclaration,
  planPageDirective,
  type PageDirective,
} from "@crossengin/observability-runtime";
import {
  formatWorkerHealth,
  summarizeWorkerHealth,
  type Clock,
  type HeartbeatSnapshot,
  type IntervalHandle,
  type IntervalScheduler,
  type WorkerHealthReport,
} from "@crossengin/workflow-worker";

/**
 * The severity for a stale-worker incident, scaled by how many workers are down:
 * 3+ stale workers is a SEV2 (a meaningful chunk of the pool is gone), 1–2 is a
 * SEV3. Zero stale → no incident. Pure.
 */
export function staleWorkerSeverity(staleCount: number): Severity | null {
  if (staleCount <= 0) return null;
  return staleCount >= 3 ? "sev2" : "sev3";
}

export interface StaleWorkerEnforcement {
  readonly incident: IncidentRecord;
  readonly pages: readonly PageDirective[];
  readonly severity: Severity;
}

export interface PlanStaleWorkerInput {
  readonly report: WorkerHealthReport;
  readonly now: Date;
  readonly incidentId: string;
  readonly declaredBy: string;
  readonly surface?: string;
  readonly policy?: AlertPolicy;
}

/**
 * Turns a stale-worker `WorkerHealthReport` into an enforcement plan: a declared
 * `IncidentRecord` (severity scaled by stale count, detail = the formatted
 * health summary) + page directives from the alert policy (if supplied). Pure —
 * `null` when no workers are stale. The actual page delivery is the caller's
 * sink; this produces the records.
 */
export function planStaleWorkerEnforcement(input: PlanStaleWorkerInput): StaleWorkerEnforcement | null {
  const severity = staleWorkerSeverity(input.report.stale);
  if (severity === null) return null;
  const incident = planIncidentDeclaration({
    incidentId: input.incidentId,
    title: `${input.report.stale.toString()} workflow worker(s) stale`,
    severity,
    category: "availability",
    surface: input.surface ?? "workflow-worker",
    nowIso: input.now.toISOString(),
    declaredBy: input.declaredBy,
    detail: formatWorkerHealth(input.report),
  });
  const pages =
    input.policy === undefined
      ? []
      : [planPageDirective(input.policy, severity, input.incidentId)].filter((p): p is PageDirective => p !== null);
  return { incident, pages, severity };
}

/** The slice of `PostgresWorkerHeartbeatStore` the monitor reads. */
export interface HeartbeatSource {
  listAll(): Promise<readonly HeartbeatSnapshot[]>;
}

export interface StaleWorkerMonitorOptions {
  readonly source: HeartbeatSource;
  readonly declaredBy: string;
  /** Mints a unique incident id per detection (e.g. `formatIncidentId(year, seq++)`). */
  readonly nextIncidentId: () => string;
  readonly onIncident: (plan: StaleWorkerEnforcement) => void | Promise<void>;
  readonly staleAfterMs?: number;
  readonly surface?: string;
  readonly policy?: AlertPolicy;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

const DEFAULT_SCHEDULER_LOCAL: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Periodically reads every worker heartbeat, summarizes health, and — when any
 * worker is stale — plans an incident (+ pages) and hands it to `onIncident`.
 * The consumer-side bridge that turns P2.11 detection into a real page, keeping
 * `@crossengin/workflow-worker` itself off the incident packages.
 */
export class StaleWorkerMonitor {
  private readonly opts: StaleWorkerMonitorOptions;
  private readonly clock: Clock;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: StaleWorkerMonitorOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER_LOCAL;
  }

  /** Reads heartbeats, and if any worker is stale plans + emits an incident. Returns the health report. */
  async checkOnce(): Promise<WorkerHealthReport> {
    const now = this.clock.now();
    const snapshots = await this.opts.source.listAll();
    const report = summarizeWorkerHealth(snapshots, {
      now,
      ...(this.opts.staleAfterMs !== undefined ? { staleAfterMs: this.opts.staleAfterMs } : {}),
    });
    if (report.stale > 0) {
      const plan = planStaleWorkerEnforcement({
        report,
        now,
        incidentId: this.opts.nextIncidentId(),
        declaredBy: this.opts.declaredBy,
        ...(this.opts.surface !== undefined ? { surface: this.opts.surface } : {}),
        ...(this.opts.policy !== undefined ? { policy: this.opts.policy } : {}),
      });
      if (plan !== null) await this.opts.onIncident(plan);
    }
    return report;
  }

  start(intervalMs: number): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => void this.safeCheck(), intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  private async safeCheck(): Promise<void> {
    try {
      await this.checkOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
