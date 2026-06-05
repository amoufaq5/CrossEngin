import type { IncidentRecord } from "@crossengin/incident-response";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import {
  SloEnforcementEngine,
  type Clock,
  type EnforcementDecision,
  type RequestOutcome,
  type SloEnforcementEngineOptions,
  type SloRegistration,
} from "@crossengin/observability-runtime";
import { buildPersistentSloEnforcementEngine } from "@crossengin/observability-runtime-pg";
import { manifestRouteSpecs, type RouteSpec } from "@crossengin/operate-runtime";

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

/** A single route exposed by a compiled manifest: a (method, operationId) pair. */
export interface ServingRoute {
  readonly method: string;
  readonly surface: string;
}

/**
 * Derives one `ServingRoute` per (method, operationId) the compiled manifest
 * exposes. Each route becomes a candidate per-route SLO surface; the operationId
 * is the stable identifier (camelCase, e.g. `product.list`) that survives URL
 * path-parameter substitution.
 */
export function routesForManifest(manifest: Manifest): readonly ServingRoute[] {
  const specs: readonly RouteSpec[] = manifestRouteSpecs(manifest);
  return specs.map((spec) => ({ method: spec.method, surface: spec.operationId }));
}

/** Composes the per-route SLO id from a (method, surface) pair. */
export function perRouteSloId(method: string, surface: string): string {
  return `${method}-${surface}-availability`;
}

/** The default aggregate surface used when no per-route surface is passed. */
export const DEFAULT_SERVING_SURFACE = "operate-server";

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

function defaultAlertPolicy(): AlertPolicy {
  return {
    id: "operate-server",
    routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "operate-server-oncall" }] }],
  };
}

function sloEnforcementOptions(options: BuildServingSloEngineOptions): SloEnforcementEngineOptions {
  const surface = options.surface ?? DEFAULT_SERVING_SURFACE;
  const actor = options.systemActorUserId ?? DEFAULT_SLO_ACTOR;
  const slo: Slo = {
    id: `${surface}-availability`,
    surface,
    targets: [{ kind: "availability", target: options.target ?? 0.99, window: "30d" }],
  };
  const alertPolicy: AlertPolicy = options.alertPolicy ?? defaultAlertPolicy();
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

export interface BuildServingSloEngineForManifestOptions {
  readonly manifest: Manifest;
  /** Availability target applied to every per-route SLO (default 0.99). */
  readonly target?: number;
  /** A UUID system actor for the declared incidents / kill switches. */
  readonly systemActorUserId?: string;
  readonly alertPolicy?: AlertPolicy;
  readonly clock?: Clock;
  /**
   * When set, the returned engine is wrapped by `buildPersistentSloEnforcementEngine`
   * — same persistence semantics as `buildServingSloEngine`'s `conn` option, applied
   * across every per-route registration.
   */
  readonly conn?: PgConnection;
}

/**
 * Builds an availability SLO engine with **one SLO per (method, operationId)**
 * the manifest exposes — so a 5xx burst on one route declares its own incident
 * rather than diluting a global one. Routes the gateway doesn't expose get no
 * SLO; only routes derived from `manifestRouteSpecs` (CRUD + lifecycle
 * transitions) are covered. With `conn`, the engine is wrapped by
 * `buildPersistentSloEnforcementEngine` so per-route decisions persist too.
 */
export function buildServingSloEngineForManifest(
  options: BuildServingSloEngineForManifestOptions,
): SloEngineLike {
  const actor = options.systemActorUserId ?? DEFAULT_SLO_ACTOR;
  const target = options.target ?? 0.99;
  const alertPolicy: AlertPolicy = options.alertPolicy ?? defaultAlertPolicy();
  const routes = routesForManifest(options.manifest);
  const registrations: SloRegistration[] = routes.map((route) => ({
    slo: {
      id: perRouteSloId(route.method, route.surface),
      surface: route.surface,
      targets: [{ kind: "availability", target, window: "30d" }],
    },
    category: "availability",
  }));
  const engineOptions: SloEnforcementEngineOptions = {
    alertPolicy,
    systemActorUserId: actor,
    declaredBy: actor,
    registrations,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
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
  /** The fallback serving surface when `recordRequest` is called without one. */
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
 * recovery). With a per-route engine (P2.37) the listener passes the matched
 * route's surface so each route is its own SLO; absent a surface the aggregate
 * fallback is used.
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
    this.surface = options.surface ?? DEFAULT_SERVING_SURFACE;
    this.declaredBy = options.declaredBy ?? DEFAULT_SLO_ACTOR;
    this.clock = options.clock ?? { now: () => new Date() };
    this.onError = options.onError ?? (() => {});
    this.log = options.log ?? (() => {});
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  /**
   * Records one request: a 5xx status is an `error` outcome, anything else `ok`.
   * `surface` lets the listener pass the matched route's surface so per-route SLOs
   * fire on that route alone; if omitted, the monitor's aggregate surface is used.
   */
  recordRequest(status: number, latencyMs: number, surface?: string): void {
    this.engine.recordOutcome({
      surface: surface ?? this.surface,
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
        this.log(`[operate-server] SLO RECOVERED ${decision.incidentId} on ${decision.surface}`);
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
