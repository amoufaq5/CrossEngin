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
}

export const DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH = 25;

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
  const { store, onDenied } = opts;

  return {
    maxUsdPerRequest,

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
