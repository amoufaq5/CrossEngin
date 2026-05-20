# ADR-0163: `expiringOptOuts` resolver for alert pipelines (Phase 2 M6.7.zz.tenant.opt-out.alerts)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0160 (M6.7.zz.tenant.opt-out opt_out flag), ADR-0161 (M6.7.zz.tenant.opt-out.reason opt_out_reason column), ADR-0162 (M6.7.zz.tenant.opt-out.expiry opt_out_until column) |

## Context

ADR-0162 / M6.7.zz.tenant.opt-out.expiry shipped `opt_out_until` with read-time auto-expiry semantics. Opt-outs are now self-managing — at the expiry instant they functionally lift without operator intervention. But the operator workflow still has a critical gap: **no advance warning before expiry**.

A legal hold expiring next week is a major operational event:

- Legal team may need to extend the hold (case still open).
- Compliance team may need to review whether normal retention is appropriate now.
- Operations team needs to plan for the data pruning that will start.
- Customer success may need to inform the customer (their contractual retention is changing).

Without a query surface, operators write ad-hoc SQL to find upcoming expirations, often forget to run it, and miss the lead time entirely. ADR-0162 Q2 lined this up:

> Q2: Expiry notifications. Integrate with `@crossengin/notifications` to alert operators 30/7/1 days before expiry. Deferred to a follow-up M6.7.zz.tenant.opt-out.alerts milestone.

M6.7.zz.tenant.opt-out.alerts closes Q2 by adding a query surface — `expiringOptOuts({withinDays, includeExpired})` — that operators wire into their notification pipeline via a scheduled job.

## Decision

Add `expiringOptOuts(input)` method to `PostgresTraceRetention`. Returns a sorted list of opt-outs whose `opt_out_until` falls within the configured window, optionally including already-expired entries. Substrate exposes the data; operator wires notification delivery via their own scheduled job (cron, Inngest, Kubernetes CronJob, etc.).

```ts
export interface ExpiringOptOut {
  readonly tenantId: string;
  readonly tableName: string;
  readonly optOutUntil: string;
  readonly optOutReason: string | null;
  readonly daysUntilExpiry: number;
}

export interface ExpiringOptOutsInput {
  readonly withinDays: number;
  readonly includeExpired?: boolean;
}

async expiringOptOuts(
  input: ExpiringOptOutsInput,
): Promise<ReadonlyArray<ExpiringOptOut>>;
```

### Semantics

- `withinDays`: positive finite number; matches opt-outs whose `opt_out_until <= clock() + withinDays * 86400 * 1000`.
- `includeExpired` (default `false`): when `false`, additionally requires `opt_out_until > clock()` (excludes already-expired); when `true`, returns all rows up to the cutoff including expired ones.
- Results sorted by `opt_out_until ASC` (soonest first).
- `daysUntilExpiry` computed as `(parseDate(opt_out_until) - clock()) / (86400 * 1000)` — positive for future, negative for expired (when `includeExpired=true`), zero on the boundary.
- Excludes rows with `opt_out_until IS NULL` (indefinite opt-outs — by definition no expiry to alert on).
- Excludes rows with `opt_out = false` (not opted out at all).

### Why a query surface, not active push

The substrate stays passive. Three alternatives were considered:

1. **Active push** — substrate emits notifications directly via `@crossengin/notifications`. Rejected — coupling between retention and notification substrates; operators may want different notification channels per environment (Slack in dev, PagerDuty in prod); scheduling logic belongs at the workflow / job layer.
2. **PG NOTIFY trigger** — `pg_notify` on row insert/update when opt_out_until crosses threshold. Rejected — operators dislike PG triggers (hidden behavior), no good way to express "30 days before" via PG event-time, requires LISTEN client process.
3. **Materialized view** — pre-computed table refreshed periodically. Rejected — refresh schedule becomes a configuration concern; query is fast enough on the indexed `opt_out_until` column without materialization.

The query surface is composable: operators wire a scheduled job (cron, Inngest, etc.) that calls `expiringOptOuts({withinDays: 30})` and pipes the result to their notification system. Each operator integrates with their own notification provider.

### Why both `withinDays` and `includeExpired`

Three operator workflows need distinct query shapes:

1. **"What expires soon?"** — `withinDays: 30, includeExpired: false`. The common dashboard / alert query.
2. **"What's already expired?"** — `withinDays: 0, includeExpired: true`. Cleanup audit query — operators decide to clear / extend / convert each expired row.
3. **"Everything with an expiry, expired or not, in the next year"** — `withinDays: 365, includeExpired: true`. Broad audit query for compliance reports.

One method with two parameters covers all three. Splitting into separate methods (`upcomingOptOuts` / `expiredOptOuts`) would force operators to call both for case 3, double the API surface, and miss the obvious composability.

### Why include `daysUntilExpiry` in the result

Operators rendering dashboards need to bucket by urgency tier (30d / 7d / 1d). Computing the diff per row in operator code is mechanical but error-prone (timezone handling, clock source consistency). The substrate has the authoritative clock (the injected `clock()` used everywhere else); pre-computing the diff at the source eliminates an entire class of off-by-one bugs.

`daysUntilExpiry` is a float — not rounded. Operators format for display; substrate preserves precision.

### Why throw on invalid `withinDays`

`Number.isFinite() && withinDays >= 0` is checked. Negative values would invert the window semantically (look in the past); `Infinity` would scan the whole table without bound; `NaN` would propagate to PG as an invalid parameter. Throwing at the API boundary catches operator typos immediately rather than producing wrong results.

## Use cases unblocked

**1. Scheduled 30-day alert sweep**

```ts
// Cron job at 09:00 UTC daily
const expiring = await retention.expiringOptOuts({ withinDays: 30 });
for (const e of expiring) {
  const urgency =
    e.daysUntilExpiry < 1 ? "critical" :
    e.daysUntilExpiry < 7 ? "warning" :
    "info";
  await notifications.send({
    channel: "slack",
    target: "#compliance-alerts",
    severity: urgency,
    title: `Opt-out expiring in ${Math.ceil(e.daysUntilExpiry)} day(s)`,
    body: `Tenant ${e.tenantId} for ${e.tableName} — ${e.optOutReason ?? "no reason"}`,
  });
}
```

Operators wire this into their existing job scheduler (Inngest, Kubernetes CronJob, AWS EventBridge). Each tenant × table expiration produces one notification per run; operators dedupe via correlation keys at their notification layer.

**2. Compliance cleanup query**

```ts
const expired = await retention.expiringOptOuts({
  withinDays: 0,
  includeExpired: true,
});
// expired[*].daysUntilExpiry < 0
console.table(expired.map((e) => ({
  tenant: e.tenantId,
  table: e.tableName,
  expiredAgoDays: -e.daysUntilExpiry,
  reason: e.optOutReason,
})));
```

Compliance team reviews quarterly — for each expired row, decide: clear (`opt_out = false`), extend (`opt_out_until = <new date>`), or convert to active per-tenant policy (`opt_out = false, enabled = true`).

**3. Quarterly compliance report**

```ts
const annual = await retention.expiringOptOuts({
  withinDays: 365,
  includeExpired: true,
});
// All opt-outs with a defined expiry, expired or upcoming, within the year
```

SOC 2 / HIPAA / 21 CFR 11 auditors get a single-query view of every time-bound opt-out and its current status.

**4. Tiered alert pipeline**

```ts
const all = await retention.expiringOptOuts({ withinDays: 30 });
const tiers = {
  "1d": all.filter((x) => x.daysUntilExpiry < 1),
  "7d": all.filter((x) => x.daysUntilExpiry >= 1 && x.daysUntilExpiry < 7),
  "30d": all.filter((x) => x.daysUntilExpiry >= 7 && x.daysUntilExpiry < 30),
};
// Send distinct severity-leveled notifications per tier
```

The float precision in `daysUntilExpiry` lets operators bucket precisely without re-parsing dates.

## Drawbacks

1. **No built-in deduplication.** Operators running the alert sweep daily see the same opt-out for 30 consecutive days. Dedup belongs at the notification layer (most providers support correlation keys + cooldown windows). Substrate intentionally doesn't track "have we alerted on this row before?" state — that would require a new table for alert state which couples retention to alert delivery.
2. **No tier bucketing in the API.** Operators bucket in app code via `daysUntilExpiry` comparisons. Considered API shapes like `tiers: [1, 7, 30]` returning a Record<tier, ExpiringOptOut[]>. Rejected — prescriptive; operators have different tier definitions (some want 60/30/14/7/3/1, some want only 30/7).
3. **No notification provider integration.** Operators do the notification glue themselves. Considered shipping a thin convenience wrapper integrating with `@crossengin/notifications`. Rejected — couples substrates; operators may use external notification systems (Datadog, PagerDuty, custom) and wrap accordingly.
4. **Clock source.** The adapter uses the injected `clock()` for the cutoff calculation. PG's `now()` is NOT used here (unlike the prune-side NOT IN subquery from ADR-0162). The query receives `cutoffMs` as a numeric parameter so the SQL semantic is fully driven by the application clock — important for testability. The trade-off: a substrate-side cron firing at the same wall-clock time across multiple replicas could see slightly different results if their clocks drift. Operators NTP-sync.
5. **Scan cost on large opt-out tables.** Production deployments with thousands of opt-outs query at `opt_out = true AND opt_out_until IS NOT NULL AND opt_out_until <range>`. The existing composite index on `(tenant_id, table_name)` doesn't help much here. A future Q is whether to add an index on `opt_out_until WHERE opt_out = true` for fast range scans. Defer until measured.

## Alternatives considered

1. **Active push via `@crossengin/notifications`.** Rejected — substrate coupling, scheduling logic at wrong layer, operator's choice of notification provider varies.
2. **PG NOTIFY trigger.** Rejected — hidden behavior, no good "30 days before" event-time expression, requires LISTEN client process.
3. **Materialized view.** Rejected — refresh schedule complexity, no materialization needed for this query shape.
4. **Separate `upcomingOptOuts()` + `expiredOptOuts()` methods.** Rejected — operators with broad audit needs would call both; one parameterized method is composable.
5. **Tier bucketing in the API (`tiers: [1, 7, 30]`).** Rejected — prescriptive; operator tier definitions vary.
6. **Stateful alert tracking (substrate-side dedup).** Rejected — couples retention to alert delivery; dedup belongs at the notification layer.
7. **Return raw rows without `daysUntilExpiry`.** Rejected — operators re-implement clock-aware diff per dashboard; substrate has the authoritative clock.
8. **Cursor-based pagination on the result.** Rejected — opt-outs are bounded (rare event); production deployments have thousands at most. Add pagination if measured.

## Open questions

1. **Index on `opt_out_until`.** A partial index `CREATE INDEX ... ON meta.tenant_retention_policies (opt_out_until) WHERE opt_out = true` would speed range scans. Defer until measured (production opt-out tables are small).
2. **Cursor pagination.** Add if operators with thousands of expiring opt-outs report slow dashboard renders. Currently unlimited.
3. **Alert state tracking.** A `meta.tenant_retention_opt_out_alerts(tenant_id, table_name, tier, last_alerted_at)` table to dedupe alerts across runs. Defer to a future M6.7.zz.tenant.opt-out.alert-state milestone if operators ask.
4. **CLI exposure.** `crossengin retention expiring --within-days 30 [--include-expired]`. Defer to the M6.7.zz.tenant.cli milestone (ADR-0159 Q5).
5. **Webhook delivery.** Substrate could ship a thin wrapper that POSTs the expiring list to a configured webhook URL. Defer — operators wire delivery themselves.
6. **Per-tier convenience method.** `expiringOptOutsByTier(tiers: number[])` returning `Record<tier, ExpiringOptOut[]>`. Defer — operators bucket in app code today.
7. **Reverse query "recently lifted opt-outs".** A `recentlyExpiredOptOuts({sinceDays})` for "what lifted in the last 7 days?" — useful for "did we miss this expiry's notification?" audits. Subset of the current method (`withinDays: 0, includeExpired: true, plus a time-floor`); could be added if operators ask.
8. **Slack / Email / Webhook integrations.** Built into `@crossengin/notifications` substrate via channel types; operators wire from there. Out of this milestone's scope.
