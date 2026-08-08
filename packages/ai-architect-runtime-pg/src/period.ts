/**
 * The monthly billing period key (`YYYY-MM`, UTC) a cost row is bucketed under.
 * The Architect's per-tenant dollar ceiling resets each calendar month, so spend
 * is accumulated per `(tenant, month)`.
 */
export function monthlyPeriodKey(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}
