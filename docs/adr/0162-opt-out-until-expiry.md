# ADR-0162: `opt_out_until` time-bound opt-outs (Phase 2 M6.7.zz.tenant.opt-out.expiry)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0159 (M6.7.zz.tenant.dashboard effectiveRetention), ADR-0160 (M6.7.zz.tenant.opt-out opt_out flag), ADR-0161 (M6.7.zz.tenant.opt-out.reason opt_out_reason column) |

## Context

ADR-0160 / M6.7.zz.tenant.opt-out shipped the `opt_out` flag making tenants permanently exempt from retention pruning. ADR-0161 added the `opt_out_reason` audit-context column. ADR-0160 Q2 lined up the natural next building block:

> Q2: Opt-out expiry. A `opt_out_until TIMESTAMPTZ NULLABLE` column for time-bound opt-outs (a 1-year legal hold). Currently operators manage expiry application-side; future milestone could push into the schema.

The pain it solves:

1. **Forgotten opt-outs.** Operators flip `opt_out=true` for a 6-month legal hold, then forget to lift it. The tenant's data accumulates indefinitely; storage cost grows, GDPR exposure expands, and compliance reports look wrong. The substrate can't help — opt_out is binary "on/off."
2. **Calendar-driven holds.** Most real-world opt-outs have known end dates: SEC investigations get a closure date, contracts have term lengths, clinical trials have completion timestamps. The operator KNOWS the expiry at the moment of flipping the flag — but can only record it in a comment or external calendar.
3. **Audit reports lag reality.** A dashboard showing "tenants currently opted out" today and the same query a year later returns the same row even though the hold expired. The substrate can't auto-lift; operators must remember.
4. **Compliance theater.** Lawyers stipulate "data must be retained until [date]." Operators set `opt_out=true` and hope the calendar reminder fires. When it doesn't, the data sits past the legal end-of-hold — potentially a worse compliance posture than the hold itself.

M6.7.zz.tenant.opt-out.expiry closes Q2 with self-managing time-bound opt-outs that auto-expire at read time.

## Decision

Add `opt_out_until TIMESTAMPTZ` (NULLABLE, no CHECK on the date) column to META_TENANT_RETENTION_POLICIES. Resolve "is the opt-out currently active?" at read time using the application clock (in the adapter) and PG's `now()` (in the SQL subqueries that exclude active opt-outs from platform-default sweeps).

```ts
{ name: "opt_out_until", type: "TIMESTAMPTZ" }
```

### Semantic

- `opt_out = false` → no opt-out at all (irrespective of opt_out_until).
- `opt_out = true, opt_out_until = NULL` → indefinite opt-out (never auto-expires).
- `opt_out = true, opt_out_until > now()` → **active** opt-out.
- `opt_out = true, opt_out_until <= now()` → **expired** opt-out (functionally equivalent to opt_out=false for read/prune semantics; row persists as audit trail).

The expired row is NOT auto-deleted by the substrate. Operators querying `WHERE opt_out = true AND opt_out_until < now()` find expired rows and decide: clear (`opt_out = false`), extend (update `opt_out_until`), or convert to an active per-tenant policy (`opt_out = false, enabled = true`).

### Resolver delta

```ts
| {
    source: "tenant_opt_out";
    retentionDays: null;
    enabled: false;
    tenantId: string;
    optOutReason: string | null;
    optOutUntil: string | null;  // NEW
  }
```

The `tenant_opt_out` variant only emits when the opt-out is **active** at the resolver's clock. Expired opt-outs fall through to the enabled check (which is `false` per the M6.7.zz.tenant.opt-out CHECK constraint) and then to platform-default — emitting the `platform` or `none` variant.

This means the resolver self-heals as expirations cross: at 11:59 PM the opt-out is active and tenant_opt_out wins; at 12:00 AM the platform default kicks in without any operator intervention.

### Prune + previewPrune delta

New status `skipped_opt_out_expired` added to `RetentionRunStatus` and `RetentionPreviewStatus` enums. The per-tenant iteration:

```ts
if (policy.optOut) {
  const active = this.isOptOutActive(policy, now);
  results.push({
    ...,
    status: active ? "skipped_opt_out" : "skipped_opt_out_expired",
    optOutUntil: policy.optOutUntil,
  });
  continue;
}
```

Both branches `continue` without issuing per-tenant DELETE. The expired branch surfaces a distinct status so operators auditing a prune run see "this tenant's opt-out expired and platform default applies" rather than the ambiguous `skipped_disabled` (which would conflate genuinely-disabled rows with expired opt-outs).

The platform-default DELETE NOT IN subquery widens to exclude only *active* opt-outs:

```sql
tenant_id NOT IN (
  SELECT tenant_id FROM meta.tenant_retention_policies
  WHERE table_name = $2
    AND (enabled = true
         OR (opt_out = true
             AND (opt_out_until IS NULL OR opt_out_until > now())))
)
```

Expired opt-out rows are NOT in this exclusion set, so platform-default pruning sweeps their tenant_id's data. Same widening applies to the previewPrune COUNT subquery.

### Clock authority

The adapter uses its injected `clock: () => number` for the in-application expiry check (`isOptOutActive`). The SQL subqueries use PG's native `now()`. Two clock sources — a deliberate trade-off:

- **Application clock (adapter):** Testable. The clock injection allows deterministic tests showing the same row resolves to different states across clock values.
- **PG `now()` (SQL):** Avoids parameter-shape changes to the existing DELETE / COUNT queries. Sub-second drift between the application and PG clocks is acceptable for retention semantics (we're measuring days, not seconds).

In practice operator deployments NTP-sync both clocks. The race window is microseconds.

## Why NULLABLE, no CHECK on the date

**NULLABLE** because most opt-outs are indefinite (legal hold with unknown duration, VIP contract until customer revocation). Forcing operators to pick a date when none is known would be a footgun.

**No CHECK on the date value itself.** Considered constraints:

- `CHECK (opt_out_until IS NULL OR opt_out_until > created_at)` — would force future-dated opt-outs.
- `CHECK (opt_out_until IS NULL OR opt_out_until > now())` — PG evaluates this at INSERT/UPDATE only; rows inserted with future dates would slip through the CHECK after time passes (which is the entire point of the column).

Neither helps. Operators can legitimately set past dates (backfilling historical holds, testing expiry semantics) — the substrate doesn't prescribe.

**No CHECK tying opt_out_until to opt_out=true.** A row may have `opt_out=false, opt_out_until=<some-date>` if the operator pre-staged the expiry before flipping opt_out (legal team writes the date during contract review; operations team flips the flag after sign-off). Mirrors the ADR-0161 decision for `opt_out_reason`.

## Use cases unblocked

**1. Time-bound legal hold**

```sql
INSERT INTO meta.tenant_retention_policies
  (tenant_id, table_name, retention_days, enabled, opt_out, opt_out_reason, opt_out_until)
VALUES
  ('11111111-...', 'workflow_traces', 90, false, true,
   'legal_hold:case#42', '2027-01-01T00:00:00Z');
```

For 8 months the prune skips this tenant entirely. On 2027-01-01 at 00:00 UTC, the next prune run automatically prunes via platform default — no operator action needed. The row persists as audit trail: "this tenant was on legal hold until 2027-01-01 due to case#42."

**2. Audit "opt-outs expiring soon"**

```sql
SELECT tenant_id, opt_out_reason, opt_out_until
FROM meta.tenant_retention_policies
WHERE opt_out = true
  AND opt_out_until BETWEEN now() AND now() + INTERVAL '30 days'
ORDER BY opt_out_until;
```

Operators get a 30-day expiry runway. Renew before expiry, or document the planned auto-lift.

**3. Cleanup expired opt-out rows**

```sql
SELECT tenant_id, table_name, opt_out_reason, opt_out_until
FROM meta.tenant_retention_policies
WHERE opt_out = true AND opt_out_until < now();
```

Optional follow-up to mark them inactive (or delete the rows entirely if the audit trail is preserved elsewhere). Substrate doesn't force this — expired rows are harmless; they just look like "disabled per-tenant policy" to downstream consumers.

**4. Clock-driven testing**

```ts
const before = new PostgresTraceRetention({ conn, clock: () => parseDate("2026-12-15") });
const after = new PostgresTraceRetention({ conn, clock: () => parseDate("2027-02-01") });
// Same row, two clocks — different resolutions.
```

Deterministic, fast, no database time mocking needed.

## Drawbacks

1. **Two clock sources.** The application clock and PG's `now()` can drift. For sub-second drift, retention semantics (measured in days) are unaffected. Operators NTP-sync in practice.
2. **Expired rows persist.** The substrate doesn't auto-delete expired opt-out rows. Audit table grows over time. Operators clean up periodically. Could be addressed by a future retention policy on the retention table itself (turtles all the way down), but premature.
3. **No notification on expiry.** Operators must query for upcoming expiries. A future "opt-out expiring soon" alert pipeline could integrate with notifications. Out of scope for this milestone.
4. **Clock-skew between replicas.** A multi-region deployment with replica clocks drifting could see different resolution decisions at the expiry instant. NTP keeps this in the milliseconds. Operators concerned about clock-skew at the second granularity should consider PG-side resolution exclusively (refactor `effectiveRetention` to use a PG-side `now()` query); deferred until operators demand it.
5. **Status enum growth.** `RetentionRunStatus` grows 4 → 5 with `skipped_opt_out_expired`. Consumers exhaustively matching on status see compile-time errors and need to add the branch. Documented as the intended discriminator for distinguishing genuine "disabled" from "opt-out expired."

## Alternatives considered

1. **`opt_out_until` as TIMESTAMP not TIMESTAMPTZ.** Timezone ambiguity. Rejected — retention crosses timezones; UTC anchoring via TIMESTAMPTZ is correct.
2. **Auto-clear opt_out on expiry via PG trigger or scheduled job.** A trigger that mutates the row to `opt_out=false` when expiry crosses. Rejected — bidirectional state drift (the historical record loses the "this tenant was opted out for reason X until date Y" signal), implementation complexity (PG triggers, cron sweeps), and read-time evaluation is simpler.
3. **`opt_out_until` interval-typed (`INTERVAL '1 year'`)**. Operators set durations, not endpoints. Rejected — relative durations create "what's the actual end date?" ambiguity (relative to creation? relative to flag flip?). Absolute timestamps are clearer.
4. **Separate `meta.tenant_retention_opt_out_expirations(tenant_id, table_name, expires_at)` table.** A side-table for expirations only. Rejected — joins everywhere; opt_out_until is conceptually a property of the opt-out, not a separate concept.
5. **Boolean `opt_out_indefinite BOOLEAN` instead of NULL semantics.** Operators set `opt_out_indefinite=true` for forever-holds, and `opt_out_until` for time-bound. Rejected — NULL already cleanly encodes "no expiry" with no extra column.
6. **Reuse `last_pruned_at` or similar for expiry signal.** Reuses an existing column for a new meaning. Rejected — overloading is the path to bugs.
7. **PG-side-only resolution (skip application clock).** All expiry decisions made in PG via `now()`. Rejected — kills testability. The injected clock pattern is established (PostgresLatencyTracker, etc.).

## Open questions

1. **Auto-cleanup of expired rows.** A future periodic job sweeping `WHERE opt_out = true AND opt_out_until < now() - INTERVAL '1 year'` to delete stale audit rows. Deferred — until operators show retention-table growth is a concern.
2. **Expiry notifications.** Integrate with `@crossengin/notifications` to alert operators 30/7/1 days before expiry. Deferred to a follow-up M6.7.zz.tenant.opt-out.alerts milestone.
3. **Set-at timestamp.** A future `opt_out_until_set_at TIMESTAMPTZ` for audit ("operator set expiry on date X, originally for duration Y"). Pair with ADR-0161 Q2 (actor attribution) into a unified policy-change audit log.
4. **CLI exposure.** `crossengin retention opt-out <tenant> <table> --until "2027-01-01" --reason "<reason>"`. Defer to the M6.7.zz.tenant.cli milestone (ADR-0159 Q5).
5. **Per-table vs all-table opt-outs.** Today an opt-out is per (tenant, table) pair. A future "opt out this tenant from EVERY trace table until X" would need either a wildcard table_name (schema change) or a bulk-INSERT helper (operator-side). Defer.
6. **Race semantics at exact expiry instant.** What happens when a prune runs at exactly `opt_out_until`? Current code uses `>` (strict greater than), so `opt_out_until == now()` is expired. Documented behavior; tests assert it.
7. **History-aware queries.** "What was tenant X's opt_out status on 2026-06-01?" would require an append-only history table. Defer to the unified policy-change audit log milestone.
