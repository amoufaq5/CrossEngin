/**
 * Durable per-tenant monthly spend ceiling for `POST /v1/ai/design`.
 *
 * The persistence dependency is structural (`MonthlySpendStore`) rather than a
 * direct import so the deployment can inject `PostgresTenantCostStore` from
 * `@crossengin/ai-architect-runtime-pg`, whose three methods satisfy this shape exactly — while this
 * module stays offline-testable. `reserveMonthly` is the conditional atomic charge that keeps the
 * ceiling across replicas; `addMonthly` settles the difference afterwards (an upsert for a top-up,
 * a floored `UPDATE` for a refund); `getMonthly` reads the month's total. All run under tenant RLS.
 */

export interface MonthlySpendStore {
  getMonthly(tenantId: string, periodKey: string): Promise<number>;
  addMonthly(tenantId: string, periodKey: string, dollars: number): Promise<number>;
  /** The conditional charge (`PostgresTenantCostStore.reserveMonthly`); `reserved: false` is a refusal. */
  reserveMonthly(
    tenantId: string,
    periodKey: string,
    dollars: number,
    limitDollars: number,
  ): Promise<{ readonly reserved: boolean; readonly dollarsUsed: number | null }>;
}

/** An estimate set aside against one month, settled once the call's real cost is known. */
export interface SpendReservation {
  readonly dollars: number;
  readonly periodKey: string;
  settle(actualDollars: number): Promise<void>;
}

export interface AiDesignBudgetOptions {
  readonly store: MonthlySpendStore;
  readonly maxUsdPerMonth: number;
  readonly now?: () => Date;
  readonly periodKeyFor?: (date: Date) => string;
  readonly onDenied?: (tenantId: string, spentUsd: number, limitUsd: number) => void;
  /** The ledger could not be read, so the design was refused without a spend figure (ADR-0470). */
  readonly onUnavailable?: (tenantId: string, err: unknown) => void;
  /** A request whose estimate the month could not absorb, though the month was not yet spent. */
  readonly onReservationRefused?: (tenantId: string, estimateUsd: number, limitUsd: number) => void;
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

/**
 * The answer to "may this tenant start a design", discriminated on `reason` (ADR-0470).
 *
 * `unavailable` carries **no** `spentUsd`, which is the point: before it existed an unreadable ledger
 * answered `month_exceeded` with `spentUsd: limitUsd`, so a database blip told a tenant its month was
 * spent — a 402 claiming a figure nobody had read, which no retry could clear in the tenant's mind.
 * Denying is still right (an unmetered call is costlier than a false denial); what changed is that the
 * denial says what it knows.
 */
export type BudgetCheck =
  | {
      readonly allowed: true;
      readonly reason: "ok";
      readonly spentUsd: number;
      readonly limitUsd: number;
      readonly remainingUsd: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "month_exceeded";
      readonly spentUsd: number;
      readonly limitUsd: number;
      readonly remainingUsd: number;
    }
  | { readonly allowed: false; readonly reason: "unavailable"; readonly limitUsd: number };

export interface AiDesignBudget {
  check(tenantId: string): Promise<BudgetCheck>;
  /**
   * Charges `dollars` against the tenant's month if, and only if, the month can absorb it — one
   * statement, so concurrent requests cannot each read the same headroom and all spend it, which
   * a `check` before the call and a write after it allowed. `null` is a refusal; a ledger that cannot be written is
   * a refusal too (the fail-closed direction `check` already takes). The settle is unconditional
   * and charged to the reservation's own month, so a call that straddles midnight on the last day
   * is not split across two.
   */
  reserve(tenantId: string, dollars: number): Promise<SpendReservation | null>;
  /**
   * The estimator's learned correction for this tenant, and the sink that updates it (ADR-0330).
   *
   * On the budget rather than beside it, because the correction is an input to the *same*
   * estimate `reserve` is charged — a caller holding one and not the other would reserve against an
   * estimate the deployment had already learned was optimistic.
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
  const now = opts.now ?? ((): Date => new Date());
  const periodKeyFor = opts.periodKeyFor ?? defaultPeriodKey;
  const { store, onDenied, onUnavailable, onReservationRefused, inflationStore, onInflationFallback } =
    opts;

  return {
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
      } catch (err) {
        // Fail closed: an unreadable ledger leaves spend unknown, and letting an unmetered LLM call
        // through is costlier than a false denial — but the denial is `unavailable`, not
        // `month_exceeded`, because no spend was read and a figure here would be invented.
        onUnavailable?.(tenantId, err);
        return { allowed: false, reason: "unavailable", limitUsd };
      }
      const remainingUsd = Math.max(0, limitUsd - spentUsd);
      if (spentUsd >= limitUsd) {
        onDenied?.(tenantId, spentUsd, limitUsd);
        return { allowed: false, reason: "month_exceeded", spentUsd, limitUsd, remainingUsd };
      }
      return { allowed: true, reason: "ok", spentUsd, limitUsd, remainingUsd };
    },

    async reserve(tenantId: string, dollars: number): Promise<SpendReservation | null> {
      const periodKey = periodKeyFor(now());
      const amount = Number.isFinite(dollars) && dollars > 0 ? dollars : 0;
      const outcome = await store.reserveMonthly(tenantId, periodKey, amount, limitUsd);
      if (!outcome.reserved) {
        onReservationRefused?.(tenantId, amount, limitUsd);
        return null;
      }
      return {
        dollars: amount,
        periodKey,
        async settle(actualDollars: number): Promise<void> {
          const actual = Number.isFinite(actualDollars) && actualDollars > 0 ? actualDollars : 0;
          const delta = actual - amount;
          if (delta === 0) return;
          await store.addMonthly(tenantId, periodKey, delta);
        },
      };
    },
  };
}
