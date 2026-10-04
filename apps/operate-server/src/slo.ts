import type { PipelineExecution } from "@crossengin/api-gateway";
import {
  closeOutClosesAlert,
  type IncidentCloseOut,
} from "@crossengin/incident-response-runtime";
import type {
  EnforcementDecision,
  LatencyEnforcementDecision,
  PageDirective,
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
  /**
   * The pages the engine planned for this decision.
   *
   * `EnforcementPlan.pages` has been built by both SLO engines since Phase 2 and read by **nothing**
   * — `summarize` dropped it, so an SLO breach declared an incident, activated a kill switch, and
   * planned a page that no code path ever touched. ADR-0325 recorded this as "the SLO loop still logs
   * its page"; it did not even do that. Carried through here so the dispatcher can deliver it
   * (ADR-0326).
   */
  readonly pages: readonly PageDirective[];
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
      pages: decision.plan.pages,
    };
  }
  if (decision.kind === "breach_ongoing") {
    return {
      ...base,
      kind: "breach_ongoing",
      severity: null,
      incidentId: decision.incidentId,
      killSwitchId: null,
      // An ongoing breach is one episode already paged for (ADR-0294); re-paging every tick is the
      // noise the adoption rule exists to prevent.
      pages: [],
    };
  }
  return {
    ...base,
    kind: "recovered",
    severity: null,
    incidentId: decision.incidentId,
    killSwitchId: decision.killSwitchId,
    closeOut: decision.closeOut,
    pages: [],
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
  /**
   * Delivers the pages a decision planned, and is **awaited** — unlike `onDecision`, which only
   * observes. A page is the one part of an enforcement decision that leaves the process, so a pass
   * that returned before its pages were sent would report a breach handled that nobody had been told
   * about (ADR-0326).
   */
  readonly onPage?: (decision: ObservedEnforcementDecision) => Promise<void>;
  /**
   * Closes the alert a breach's page opened, once the breach recovers (ADR-0326).
   *
   * Handed the **directives that were actually delivered** rather than freshly-planned ones, because
   * only this scheduler knows them: a `recovered` decision carries no severity and no plan, so there
   * is nothing to re-plan from, and re-planning at a guessed grade is how a resolve reaches a
   * rotation that was never paged. They are remembered per incident id, which is the provider's
   * `dedup_key`, so the resolve lands on the alert the trigger opened.
   *
   * The memory is in-process: a restart between the breach and the recovery forgets what it paged
   * and so resolves nothing, leaving the alert for a human. That is the fail-closed direction — the
   * alternative is guessing a grade and closing an alert somewhere nobody was ever woken.
   */
  readonly onResolvePage?: (
    decision: ObservedEnforcementDecision,
    pages: readonly PageDirective[],
  ) => Promise<void>;
  /**
   * Recovers the directives for an episode this process did not page (ADR-0327).
   *
   * ADR-0326 left the in-process memory as a known limit: a restart between a breach and its
   * recovery forgets what it paged and resolves nothing. This is the way back — the caller holds the
   * alert policy and can ask the incident store what grade the record was *declared* at, which is
   * the one authoritative answer, and plan from it. Deliberately a seam rather than logic here: the
   * scheduler must not learn about `AlertPolicy`, and inferring a grade is the mis-routed resolve
   * ADR-0326 exists to prevent.
   *
   * Answering `[]` — which is what a caller with no store, or a record it cannot read, must do — is
   * the fail-closed outcome: nothing is resolved and the alert is left for a human.
   */
  readonly recoverPages?: (
    decision: ObservedEnforcementDecision,
  ) => Promise<readonly PageDirective[]>;
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
  /**
   * What was paged, per incident id, so a recovery can close exactly those alerts.
   *
   * Bounded by the number of episodes currently open: an entry is added when a breach's pages are
   * delivered and removed on the recovery that ends the episode, whether or not it resolves.
   */
  private readonly paged = new Map<string, readonly PageDirective[]>();

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
          if (decision.pages.length > 0) {
            await this.opts.onPage?.(decision);
            // Remembered only after the delivery was attempted, keyed on the id the provider
            // dedups on.
            if (decision.incidentId !== null) this.paged.set(decision.incidentId, decision.pages);
          }
          if (decision.kind === "recovered") await this.resolvePages(decision);
        }
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
    return emitted;
  }

  /**
   * Closes the alerts this episode's page opened, if the recovery actually closed the record.
   *
   * The episode is over either way, so what was paged is forgotten in all cases — a `human_owned`
   * incident will not be resolved by this loop at any later tick, and keeping the entry would grow
   * the map for the lifetime of the process.
   */
  private async resolvePages(decision: ObservedEnforcementDecision): Promise<void> {
    const incidentId = decision.incidentId;
    if (incidentId === null) return;
    const remembered = this.paged.get(incidentId);
    this.paged.delete(incidentId);
    // `human_owned` means a human took the incident, and `failed` means the row is still open and
    // its state unknown — neither is an alert to close (ADR-0326). Checked before recovery, so a
    // restart does not go to the store for an episode it would not have resolved anyway.
    if (decision.closeOut === null || !closeOutClosesAlert(decision.closeOut)) return;
    // Remembered beats recovered: these are the directives that actually went out, so they match
    // the alert even if the policy has been edited since. The store is the fallback for an episode
    // this process did not page — i.e. one that spanned a restart (ADR-0327).
    const pages = remembered ?? (await this.opts.recoverPages?.(decision)) ?? [];
    if (pages.length === 0) return;
    await this.opts.onResolvePage?.(decision, pages);
  }

  /** What this loop would resolve for an incident, if it recovered now (for tests / metrics). */
  pagedFor(incidentId: string): readonly PageDirective[] | null {
    return this.paged.get(incidentId) ?? null;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
