import type { PipelineExecution } from "@crossengin/api-gateway";
import type { IncidentCloseOut } from "@crossengin/incident-response-runtime";
import type {
  EnforcementDecision,
  LatencyEnforcementDecision,
  RequestOutcome,
} from "@crossengin/observability-runtime";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

/** Anything that ingests a request outcome — both SLO engines satisfy this. */
export interface OutcomeRecorder {
  recordOutcome(outcome: RequestOutcome): void;
}

export interface OutcomeMapOptions {
  /** Derives the SLO surface from an execution (default: its `routeOperationId`). */
  readonly surfaceOf?: (execution: PipelineExecution) => string | null;
}

const UNROUTED_SURFACE = "unrouted";

/**
 * Projects a gateway `PipelineExecution` into an observability `RequestOutcome`:
 * a 5xx final status is an availability failure (`error`), everything else is
 * `ok` (a 4xx is a client error, not an SLO breach); latency comes from the
 * pipeline's own measured `totalDurationMs`, the timestamp from `completedAt`.
 */
export function pipelineExecutionToOutcome(
  execution: PipelineExecution,
  opts: OutcomeMapOptions = {},
): RequestOutcome {
  const surface = opts.surfaceOf?.(execution) ?? execution.routeOperationId ?? UNROUTED_SURFACE;
  const isServerError = execution.finalResponseStatus >= 500;
  return {
    surface,
    outcome: isServerError ? "error" : "ok",
    at: execution.completedAt,
    statusCode: execution.finalResponseStatus,
    latencyMs: execution.totalDurationMs,
  };
}

export interface SloRequestObserverOptions {
  /** The SLO engines fed by every request — availability, latency, or both. */
  readonly recorders: readonly OutcomeRecorder[];
  readonly surfaceOf?: (execution: PipelineExecution) => string | null;
}

/**
 * The bridge between the live request stream and the SLO engines: each finished
 * `PipelineExecution` becomes a `RequestOutcome` recorded into every registered
 * engine. Recording is cheap (an in-memory window append); breach *evaluation*
 * runs on a timer via `SloEvaluationScheduler`, so a hot path never pays the
 * burn-rate computation.
 */
export class SloRequestObserver {
  constructor(private readonly opts: SloRequestObserverOptions) {}

  observe(execution: PipelineExecution): void {
    const outcome = pipelineExecutionToOutcome(execution, { surfaceOf: this.opts.surfaceOf });
    for (const recorder of this.opts.recorders) {
      recorder.recordOutcome(outcome);
    }
  }

  /** An execution sink suitable for `OperateHttpServerOptions.onExecution`. */
  asExecutionSink(): (execution: PipelineExecution) => void {
    return (execution) => this.observe(execution);
  }
}

export interface ObservedEnforcementDecision {
  readonly signal: "availability" | "latency";
  readonly kind: "breach_opened" | "breach_ongoing" | "recovered";
  readonly surface: string;
  readonly sloId: string;
  readonly severity: string | null;
  readonly incidentId: string | null;
  readonly killSwitchId: string | null;
  /**
   * On a recovery, what became of the declared incident — cancelled, left to the human who triaged
   * it, never stored, or a close-out that failed and left the row open. Null otherwise.
   */
  readonly closeOut: IncidentCloseOut | null;
}

export function summarizeAvailabilityDecision(
  decision: EnforcementDecision,
): ObservedEnforcementDecision {
  return summarize("availability", decision);
}

export function summarizeLatencyDecision(
  decision: LatencyEnforcementDecision,
): ObservedEnforcementDecision {
  return summarize("latency", decision);
}

function summarize(
  signal: "availability" | "latency",
  decision: EnforcementDecision | LatencyEnforcementDecision,
): ObservedEnforcementDecision {
  const base = { signal, surface: decision.surface, sloId: decision.sloId, closeOut: null };
  if (decision.kind === "breach_opened") {
    return {
      ...base,
      kind: "breach_opened",
      severity: decision.severity,
      incidentId: decision.plan.incident.id,
      killSwitchId: decision.plan.killSwitch?.id ?? null,
    };
  }
  if (decision.kind === "breach_ongoing") {
    return {
      ...base,
      kind: "breach_ongoing",
      severity: null,
      incidentId: decision.incidentId,
      killSwitchId: null,
    };
  }
  return {
    ...base,
    kind: "recovered",
    severity: null,
    incidentId: decision.incidentId,
    killSwitchId: decision.killSwitchId,
    closeOut: decision.closeOut,
  };
}

export type DecisionEvaluator = () => Promise<readonly ObservedEnforcementDecision[]>;

/**
 * Whatever can be driven for decisions, structurally: the pure engines and the Postgres-persisting
 * wrappers around them both satisfy this, so the scheduler does not care which it was handed.
 */
export interface DecisionSource<D> {
  evaluate(now?: Date): Promise<readonly D[]>;
}

export function availabilityEvaluator(
  engine: DecisionSource<EnforcementDecision>,
): DecisionEvaluator {
  return async () => (await engine.evaluate()).map(summarizeAvailabilityDecision);
}

export function latencyEvaluator(
  engine: DecisionSource<LatencyEnforcementDecision>,
): DecisionEvaluator {
  return async () => (await engine.evaluate()).map(summarizeLatencyDecision);
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface SloEvaluationSchedulerOptions {
  readonly evaluators: readonly DecisionEvaluator[];
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onDecision?: (decision: ObservedEnforcementDecision) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically drives every SLO engine's `evaluate()` and routes the resulting
 * decisions to `onDecision`. Mirrors `PruneScheduler` / `JobScheduler`: the
 * timer is `unref`'d so it never holds the process open, and an evaluation that
 * throws is routed to `onError` rather than out of the timer. Evaluation is
 * deliberately decoupled from recording — the observer records on every request,
 * this ticks on an interval so burn windows are computed at most once per tick.
 *
 * A pass is async because declaring an incident asks the store for its id, so a tick can outlive its
 * interval. A tick that arrives while a pass is still running is skipped rather than queued — piling
 * passes up behind a slow store would multiply the work it is already struggling with.
 */
export class SloEvaluationScheduler {
  private handle: IntervalHandle | null = null;
  private running = false;

  constructor(private readonly opts: SloEvaluationSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => {
      // `evaluateOnce` routes its own failures to `onError`, so nothing escapes into the timer.
      void this.evaluateOnce();
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async evaluateOnce(): Promise<readonly ObservedEnforcementDecision[]> {
    if (this.running) return [];
    this.running = true;
    const emitted: ObservedEnforcementDecision[] = [];
    try {
      for (const evaluator of this.opts.evaluators) {
        for (const decision of await evaluator()) {
          emitted.push(decision);
          this.opts.onDecision?.(decision);
        }
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
    return emitted;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
