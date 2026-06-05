import { SEVERITIES, type IncidentRecord, type Severity } from "@crossengin/incident-response";
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

/** True when `a` is strictly more severe than `b` (`sev1` is the most severe). */
export function isMoreSevere(a: Severity, b: Severity): boolean {
  return SEVERITIES.indexOf(a) < SEVERITIES.indexOf(b);
}

export interface StaleWorkerEnforcement {
  readonly incident: IncidentRecord;
  readonly pages: readonly PageDirective[];
  readonly severity: Severity;
}

/** An escalation of an already-open incident: the new (higher) severity + the
 * page directives recomputed at that severity, so on-call is re-paged at the
 * higher urgency. */
export interface StaleWorkerEscalation {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly pages: readonly PageDirective[];
}

/**
 * Resolves the page directives for a stale-worker incident at a given severity
 * from the alert policy (empty when no policy is supplied or the policy has no
 * route for the resolved alert severity). Shared by the declaration plan and the
 * escalation path so both page through the same policy resolution. Pure.
 */
export function staleWorkerPages(
  policy: AlertPolicy | undefined,
  severity: Severity,
  incidentId: string,
): readonly PageDirective[] {
  if (policy === undefined) return [];
  const page = planPageDirective(policy, severity, incidentId);
  return page === null ? [] : [page];
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
  const pages = staleWorkerPages(input.policy, severity, input.incidentId);
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
  /** Fired when the open stale-worker incident clears (all workers recovered). */
  readonly onResolve?: (incidentId: string) => void | Promise<void>;
  /** Fired when more workers go stale and the open incident's severity should
   * rise. Carries the page directives recomputed at the higher severity so the
   * consumer can re-page on-call at the higher urgency. */
  readonly onEscalate?: (escalation: StaleWorkerEscalation) => void | Promise<void>;
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
 * Periodically reads every worker heartbeat, summarizes health, and tracks an
 * **ongoing** stale-worker incident: it `onIncident`-declares one when staleness
 * opens (0 → >0), holds it while stale workers persist (no re-declare), and
 * `onResolve`s it when staleness clears (>0 → 0). One incident per stale period
 * — no storm. The consumer-side bridge that turns P2.11 detection into a real
 * page + resolve, keeping `@crossengin/workflow-worker` off the incident packages.
 */
export class StaleWorkerMonitor {
  private readonly opts: StaleWorkerMonitorOptions;
  private readonly clock: Clock;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;
  private openIncidentId: string | null = null;
  private openSeverity: Severity | null = null;

  constructor(opts: StaleWorkerMonitorOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER_LOCAL;
  }

  /**
   * Reads heartbeats; opens an incident when staleness begins, resolves the open
   * one when it clears, and is a no-op while staleness is ongoing or absent.
   * Returns the health report.
   */
  async checkOnce(): Promise<WorkerHealthReport> {
    const now = this.clock.now();
    const snapshots = await this.opts.source.listAll();
    const report = summarizeWorkerHealth(snapshots, {
      now,
      ...(this.opts.staleAfterMs !== undefined ? { staleAfterMs: this.opts.staleAfterMs } : {}),
    });
    if (report.stale > 0) {
      if (this.openIncidentId === null) {
        const plan = planStaleWorkerEnforcement({
          report,
          now,
          incidentId: this.opts.nextIncidentId(),
          declaredBy: this.opts.declaredBy,
          ...(this.opts.surface !== undefined ? { surface: this.opts.surface } : {}),
          ...(this.opts.policy !== undefined ? { policy: this.opts.policy } : {}),
        });
        if (plan !== null) {
          this.openIncidentId = plan.incident.id;
          this.openSeverity = plan.severity;
          await this.opts.onIncident(plan);
        }
      } else {
        // ongoing — escalate (raise) the open incident's severity if more
        // workers have gone stale; never de-escalate, never re-declare
        const current = staleWorkerSeverity(report.stale);
        if (current !== null && this.openSeverity !== null && isMoreSevere(current, this.openSeverity)) {
          const id = this.openIncidentId;
          this.openSeverity = current;
          await this.opts.onEscalate?.({
            incidentId: id,
            severity: current,
            pages: staleWorkerPages(this.opts.policy, current, id),
          });
        }
      }
    } else if (this.openIncidentId !== null) {
      const resolved = this.openIncidentId;
      this.openIncidentId = null;
      this.openSeverity = null;
      await this.opts.onResolve?.(resolved);
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
