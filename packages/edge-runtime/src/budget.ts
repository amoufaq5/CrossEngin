import {
  evaluateBudget,
  BudgetBreachRecordSchema,
  type BudgetSeverity,
  type LatencyPercentile,
  type RouteLatencyBudget,
  type BudgetBreachRecord,
} from "@crossengin/edge";

/** A per-route latency distribution computed from the rolling sample window. */
export interface RouteLatencySnapshot {
  readonly routeId: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

/**
 * A lightweight latency-budget breach the monitor emits — the route + percentile
 * that blew its budget, by how much, at what severity. `toBudgetBreachRecord`
 * promotes it to the schema-valid `@crossengin/edge` audit record; an `onBreach`
 * consumer can also bridge it to `observability-runtime`'s latency engine to
 * declare a `performance` incident.
 */
export interface BudgetBreach {
  readonly routeId: string;
  readonly percentile: LatencyPercentile;
  readonly budgetMs: number;
  readonly observedMs: number;
  readonly exceededByMs: number;
  readonly severity: BudgetSeverity;
  readonly sampleCount: number;
  readonly at: string;
}

/** Nearest-rank percentile (`p` in 0..100) over an unsorted sample list. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index]!;
}

export interface LatencyBudgetMonitorOptions {
  /** Max samples retained per route (the rolling window); default 1000. */
  readonly windowSize?: number;
  /** Called for each breached percentile when `evaluate` runs. */
  readonly onBreach?: (breach: BudgetBreach) => void;
  readonly now?: () => Date;
}

interface RouteWindow {
  readonly samples: number[];
  firstAt: string;
}

/**
 * Records per-route request latencies into a bounded rolling window and evaluates
 * them against a `RouteLatencyBudget` via the `@crossengin/edge` `evaluateBudget`
 * contract. Each breached percentile is emitted as a `BudgetBreach` (and forwarded
 * to `onBreach`). The monitor holds no transport — a consumer bridges breaches to
 * paging / incident declaration (e.g. `observability-runtime`'s latency engine).
 */
export class LatencyBudgetMonitor {
  private readonly windowSize: number;
  private readonly onBreach: ((breach: BudgetBreach) => void) | undefined;
  private readonly now: () => Date;
  private readonly routes = new Map<string, RouteWindow>();

  constructor(opts: LatencyBudgetMonitorOptions = {}) {
    this.windowSize = opts.windowSize ?? 1000;
    this.onBreach = opts.onBreach;
    this.now = opts.now ?? ((): Date => new Date());
  }

  /** Records one request's latency (ms) for `routeId` into the rolling window. */
  record(routeId: string, latencyMs: number): void {
    let window = this.routes.get(routeId);
    if (window === undefined) {
      window = { samples: [], firstAt: this.now().toISOString() };
      this.routes.set(routeId, window);
    }
    window.samples.push(latencyMs);
    if (window.samples.length > this.windowSize) window.samples.shift();
  }

  /** The route's current p50/p95/p99 over the window, or `null` if no samples. */
  snapshot(routeId: string): RouteLatencySnapshot | null {
    const window = this.routes.get(routeId);
    if (window === undefined || window.samples.length === 0) return null;
    return {
      routeId,
      count: window.samples.length,
      p50Ms: percentile(window.samples, 50),
      p95Ms: percentile(window.samples, 95),
      p99Ms: percentile(window.samples, 99),
    };
  }

  /**
   * Evaluates `budget.routeId`'s window against the budget, emitting a `BudgetBreach`
   * per breached percentile (and calling `onBreach`). Returns the breaches (empty if
   * within budget or no samples).
   */
  evaluate(budget: RouteLatencyBudget): readonly BudgetBreach[] {
    const snap = this.snapshot(budget.routeId);
    if (snap === null) return [];
    const at = this.now().toISOString();
    const breaches: BudgetBreach[] = [];
    for (const result of evaluateBudget(budget, { p50Ms: snap.p50Ms, p95Ms: snap.p95Ms, p99Ms: snap.p99Ms })) {
      if (!result.breached) continue;
      const breach: BudgetBreach = {
        routeId: budget.routeId,
        percentile: result.percentile,
        budgetMs: result.budgetMs,
        observedMs: result.observedMs,
        exceededByMs: result.exceededByMs,
        severity: budget.alertSeverity,
        sampleCount: snap.count,
        at,
      };
      breaches.push(breach);
      this.onBreach?.(breach);
    }
    return breaches;
  }
}

/**
 * Promotes a `BudgetBreach` to the schema-valid `@crossengin/edge`
 * `BudgetBreachRecord` audit shape. `alertSent` defaults to `true` (emitting the
 * record is the alert; the contract also requires it for `critical` breaches); the
 * window bounds default to the breach's first-sample/observation window if not given.
 */
export function toBudgetBreachRecord(
  breach: BudgetBreach,
  opts: { readonly id: string; readonly windowStart: string; readonly windowEnd?: string; readonly alertSent?: boolean },
): BudgetBreachRecord {
  return BudgetBreachRecordSchema.parse({
    id: opts.id,
    routeId: breach.routeId,
    percentile: breach.percentile,
    budgetMs: breach.budgetMs,
    observedMs: breach.observedMs,
    severity: breach.severity,
    observedAt: breach.at,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd ?? breach.at,
    sampleCount: breach.sampleCount,
    alertSent: opts.alertSent ?? true,
  });
}
