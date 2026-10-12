/**
 * Durable per-tenant monthly spend ceiling for `POST /v1/ai/design`.
 *
 * The persistence dependency is structural (`MonthlySpendStore`) rather than a
 * direct import so the deployment can inject `PostgresTenantCostStore` from
 * `@crossengin/ai-architect-runtime-pg` — whose `getMonthly` / `addMonthly`
 * satisfy this shape exactly (atomic `INSERT … ON CONFLICT`, tenant RLS, so the
 * ceiling holds across replicas) — while this module stays offline-testable.
 */

export interface MonthlySpendStore {
  getMonthly(tenantId: string, periodKey: string): Promise<number>;
  addMonthly(tenantId: string, periodKey: string, dollars: number): Promise<number>;
}

export interface AiDesignBudgetOptions {
  readonly store: MonthlySpendStore;
  readonly maxUsdPerMonth: number;
  readonly maxUsdPerRequest?: number;
  readonly now?: () => Date;
  readonly periodKeyFor?: (date: Date) => string;
  readonly onDenied?: (tenantId: string, spentUsd: number, limitUsd: number) => void;
  /**
   * The durable estimator correction (ADR-0330). Absent leaves `inflationFor` answering 1, which is
   * the behaviour before it existed.
   */
  readonly inflationStore?: EstimateInflationStoreLike;
  readonly onInflationFallback?: (tenantId: string, provenance: string) => void;
}

/**
 * The slice of `PostgresEstimateInflationStore` the budget needs. Structural, so a test needs no
 * database and the app needs no second import path.
 */
export interface EstimateInflationStoreLike {
  load(tenantId: string): Promise<{
    readonly inflation: number;
    readonly provenance: string;
  }>;
  observe(tenantId: string, ratio: number): Promise<unknown>;
}

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly reason: "ok" | "month_exceeded";
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly remainingUsd: number;
}

export interface AiDesignBudget {
  check(tenantId: string): Promise<BudgetCheck>;
  record(tenantId: string, costUsd: number): Promise<number>;
  readonly maxUsdPerRequest: number | null;
  /**
   * The estimator's learned correction for this tenant, and the sink that updates it (ADR-0330).
   *
   * On the budget rather than beside it, because the correction is an input to the *same* ceiling
   * `maxUsdPerRequest` expresses — a caller holding one and not the other would price a request
   * against an estimate the deployment had already learned was optimistic.
   *
   * Both are optional on the interface: a deployment with no Postgres store has no durable place
   * to keep the figure, and `inflationFor` answering 1 there is the pre-ADR-0330 behaviour.
   */
  inflationFor?(tenantId: string): Promise<number>;
  observeInflation?(tenantId: string, ratio: number): Promise<void>;
}

export const DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH = 25;

/**
 * What an unreadable inflation store resolves to, matching the resolver's own fallback.
 *
 * 2, not 1. A store that exists and cannot be read is **lost knowledge**, and a tenant whose
 * correction was 40 reading as 1 would admit every request it had learned to delay. Reading it as
 * "no correction" is the one answer this must not give.
 */
export const UNREADABLE_BUDGET_INFLATION = 2;

/** `YYYY-MM` (UTC) — mirrors `monthlyPeriodKey` so keys match the shared ledger. */
function defaultPeriodKey(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}

function sanitizeSpend(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildAiDesignBudget(opts: AiDesignBudgetOptions): AiDesignBudget {
  const limitUsd = opts.maxUsdPerMonth;
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    throw new Error(`maxUsdPerMonth must be a finite number > 0, got ${String(opts.maxUsdPerMonth)}`);
  }
  const perRequest = opts.maxUsdPerRequest;
  const maxUsdPerRequest =
    perRequest !== undefined && Number.isFinite(perRequest) && perRequest > 0 ? perRequest : null;
  const now = opts.now ?? ((): Date => new Date());
  const periodKeyFor = opts.periodKeyFor ?? defaultPeriodKey;
  const { store, onDenied, inflationStore, onInflationFallback } = opts;

  return {
    maxUsdPerRequest,

    ...(inflationStore === undefined
      ? {}
      : {
          async inflationFor(tenantId: string): Promise<number> {
            try {
              const record = await inflationStore.load(tenantId);
              // A pessimistic fallback that nothing reports is a silently delayed tenant, so the
              // provenance is surfaced whenever the resolver had to substitute a figure.
              if (record.provenance !== "learned" && record.provenance !== "no_history") {
                onInflationFallback?.(tenantId, record.provenance);
              }
              return Math.max(1, record.inflation);
            } catch (err) {
              // Fail **pessimistic**, which is the opposite of most fail-closed choices here and is
              // the right direction for this one input: over-counting delays a request,
              // under-counting admits one the ceiling exists to refuse (ADR-0311). An unreadable
              // store is lost knowledge, not an absence of it.
              onInflationFallback?.(tenantId, "unreadable");
              void err;
              return UNREADABLE_BUDGET_INFLATION;
            }
          },
          async observeInflation(tenantId: string, ratio: number): Promise<void> {
            await inflationStore.observe(tenantId, ratio);
          },
        }),

    async check(tenantId: string): Promise<BudgetCheck> {
      const periodKey = periodKeyFor(now());
      let spentUsd: number;
      try {
        spentUsd = sanitizeSpend(await store.getMonthly(tenantId, periodKey));
      } catch {
        // Fail closed: an unreadable ledger leaves spend unknown, and letting an
        // unmetered LLM call through is costlier than a false denial, so the
        // tenant is reported as having consumed the whole ceiling.
        onDenied?.(tenantId, limitUsd, limitUsd);
        return {
          allowed: false,
          reason: "month_exceeded",
          spentUsd: limitUsd,
          limitUsd,
          remainingUsd: 0,
        };
      }
      const remainingUsd = Math.max(0, limitUsd - spentUsd);
      if (spentUsd >= limitUsd) {
        onDenied?.(tenantId, spentUsd, limitUsd);
        return { allowed: false, reason: "month_exceeded", spentUsd, limitUsd, remainingUsd };
      }
      return { allowed: true, reason: "ok", spentUsd, limitUsd, remainingUsd };
    },

    async record(tenantId: string, costUsd: number): Promise<number> {
      const periodKey = periodKeyFor(now());
      try {
        if (!Number.isFinite(costUsd) || costUsd <= 0) {
          return sanitizeSpend(await store.getMonthly(tenantId, periodKey));
        }
        return sanitizeSpend(await store.addMonthly(tenantId, periodKey, costUsd));
      } catch {
        // Best-effort accounting: the design call already succeeded, so a failed
        // ledger write must not surface as a request error; the next `check`
        // re-reads the store and the unrecorded dollars are simply not charged.
        return 0;
      }
    },
  };
}
