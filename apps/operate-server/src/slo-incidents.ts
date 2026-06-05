import type { IncidentRecord } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import {
  SloEnforcementEngine,
  type Clock,
  type EnforcementDecision,
  type RequestOutcome,
  type SloEnforcementEngineOptions,
} from "@crossengin/observability-runtime";
import { buildPersistentSloEnforcementEngine } from "@crossengin/observability-runtime-pg";

/** A system actor id (UUID) used as the default SLO incident declarer. */
export const DEFAULT_SLO_ACTOR = "00000000-0000-4000-8000-000000000000";

/** The structural write surface the monitor persists through — `PostgresIncidentSink` satisfies it. */
export interface IncidentPersistSink {
  record(incident: IncidentRecord): Promise<void>;
  resolve(incidentId: string, actorUserId: string): Promise<void>;
}

/**
 * The structural slice of an SLO engine the monitor drives. `evaluate` may be
 * sync (the in-process `SloEnforcementEngine`) or async (the persistent wrapper
 * from `@crossengin/observability-runtime-pg`, which writes an evaluation
 * snapshot per `breach_opened` + an enforcement action per decision); `sweep`
 * always awaits.
 */
export interface SloEngineLike {
  recordOutcome(outcome: RequestOutcome): void;
  evaluate(now?: Date): readonly EnforcementDecision[] | Promise<readonly EnforcementDecision[]>;
}

export interface BuildServingSloEngineOptions {
  /** The aggregate serving surface the availability SLO covers (request outcomes ride this). */
  readonly surface?: string;
  /** Availability target (default 0.99). */
  readonly target?: number;
  /** A UUID system actor for the declared incidents / kill switches. */
  readonly systemActorUserId?: string;
  readonly alertPolicy?: AlertPolicy;
  readonly clock?: Clock;
  /**
   * When set, the returned engine is wrapped by `buildPersistentSloEnforcementEngine`
   * (from `@crossengin/observability-runtime-pg`): every `evaluate()` writes an
   * enforcement action per decision to `meta.slo_enforcement_actions` and an
   * evaluation snapshot per `breach_opened` to `meta.slo_evaluations`. With no
   * conn, returns the in-process engine — no persistence.
   */
  readonly conn?: PgConnection;
}

function sloEnforcementOptions(options: BuildServingSloEngineOptions): SloEnforcementEngineOptions {
  const surface = options.surface ?? "operate-server";
  const actor = options.systemActorUserId ?? DEFAULT_SLO_ACTOR;
  const slo: Slo = {
    id: `${surface}-availability`,
    surface,
    targets: [{ kind: "availability", target: options.target ?? 0.99, window: "30d" }],
  };
  const alertPolicy: AlertPolicy = options.alertPolicy ?? {
    id: "operate-server",
    routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "operate-server-oncall" }] }],
  };
  return {
    alertPolicy,
    systemActorUserId: actor,
    declaredBy: actor,
    registrations: [{ slo, category: "availability" }],
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
}

/**
 * Builds an availability SLO engine for the operate-server serving surface: one
 * rolling-window availability SLO whose burn-rate breach declares an
 * `IncidentRecord`. The defaults (surface `operate-server`, 99% / 30d, a single
 * P1 page route) make it usable with no config; the declarer is a UUID so the
 * declared incident's `declared_by` satisfies the `meta.users` FK on persist.
 *
 * Without `conn` returns the in-process `SloEnforcementEngine`; with `conn`
 * returns a persistent wrapper that also writes every decision + breach snapshot
 * to `meta.slo_enforcement_actions` / `meta.slo_evaluations` (M8.5).
 */
export function buildServingSloEngine(options: BuildServingSloEngineOptions = {}): SloEngineLike {
  const engineOptions = sloEnforcementOptions(options);
  if (options.conn === undefined) return new SloEnforcementEngine(engineOptions);
  return buildPersistentSloEnforcementEngine(options.conn, engineOptions);
}

const DEFAULT_SCHEDULER: SloScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface SloScheduler {
  setInterval(handler: () => void, ms: number): object;
  clearInterval(handle: object): void;
}

export interface OperateSloMonitorOptions {
  readonly engine: SloEngineLike;
  /** When set, declared incidents persist to `meta.incidents` (else log-only). */
  readonly sink?: IncidentPersistSink;
  /** The serving surface request outcomes are recorded under (matches the SLO). */
  readonly surface?: string;
  /** Actor for the `resolve` transition on recovery. */
  readonly declaredBy?: string;
  readonly clock?: { now(): Date };
  readonly onError?: (err: unknown) => void;
  readonly log?: (line: string) => void;
  readonly scheduler?: SloScheduler;
}

/**
 * Drives the serving SLO loop: feeds each HTTP request's outcome into the engine
 * and, on a `sweep`, persists a declared availability incident to `meta.incidents`
 * via the shared `@crossengin/incident-response-pg` sink (and resolves it on
 * recovery). The second consumer of `incident-response-pg` — the serving app now
 * declares its own SLO breaches through the same sink the worker uses.
 */
export class OperateSloMonitor {
  private readonly engine: SloEngineLike;
  private readonly sink: IncidentPersistSink | null;
  private readonly surface: string;
  private readonly declaredBy: string;
  private readonly clock: { now(): Date };
  private readonly onError: (err: unknown) => void;
  private readonly log: (line: string) => void;
  private readonly scheduler: SloScheduler;
  private handle: object | null = null;

  constructor(options: OperateSloMonitorOptions) {
    this.engine = options.engine;
    this.sink = options.sink ?? null;
    this.surface = options.surface ?? "operate-server";
    this.declaredBy = options.declaredBy ?? DEFAULT_SLO_ACTOR;
    this.clock = options.clock ?? { now: () => new Date() };
    this.onError = options.onError ?? (() => {});
    this.log = options.log ?? (() => {});
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Records one request: a 5xx status is an `error` outcome, anything else `ok`. */
  recordRequest(status: number, latencyMs: number): void {
    this.engine.recordOutcome({
      surface: this.surface,
      outcome: status >= 500 ? "error" : "ok",
      at: this.clock.now().toISOString(),
      statusCode: status,
      latencyMs,
    });
  }

  /** Evaluates the SLO; persists a newly declared incident and resolves a recovered one. */
  async sweep(now: Date = this.clock.now()): Promise<readonly EnforcementDecision[]> {
    const decisions = await this.engine.evaluate(now);
    for (const decision of decisions) {
      if (decision.kind === "breach_opened") {
        this.log(`[operate-server] SLO BREACH ${decision.plan.incident.id} ${decision.severity} on ${decision.surface}`);
        if (this.sink !== null) await this.sink.record(decision.plan.incident);
      } else if (decision.kind === "recovered") {
        this.log(`[operate-server] SLO RECOVERED ${decision.incidentId}`);
        if (this.sink !== null) await this.sink.resolve(decision.incidentId, this.declaredBy);
      }
    }
    return decisions;
  }

  start(intervalMs: number): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => void this.safeSweep(), intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  private async safeSweep(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.onError(err);
    }
  }
}
