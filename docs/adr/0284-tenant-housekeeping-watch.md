# ADR-0284: `tenant housekeeping --watch` cross-dashboard live monitoring

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0265 Q1 + ADR-0276 Q1 (closes), ADR-0265 (gateway housekeeping --watch), ADR-0276 (retention housekeeping --watch), ADR-0181 (threshold-alert CI gate), ADR-0273 (tenant housekeeping cross-dashboard combined view), housekeeping-watch.ts shared infrastructure |

## Context

ADR-0273 shipped `tenant housekeeping` as a
one-shot cross-dashboard combined view that
concatenates gateway + retention housekeeping
under one envelope with one PG connection and
union threshold-alert evaluation.

ADR-0265 + ADR-0276 each shipped per-dashboard
`--watch` modes for the individual surfaces. The
deferred Q in both:

> "Q1 (ADR-0265): Combine with retention
> housekeeping --watch under a single cross-
> dashboard live monitoring command."
>
> "Q1 (ADR-0276): A `tenant housekeeping --watch`
> combining both watch loops under one cross-
> dashboard view has subtle ordering — interleaved
> renders garble layout; sequential per-tick
> doubles latency. Documented as future Q in
> ADR-0276."

Real workflows driving this:

1. **Multi-substrate incident monitoring** —
   during an incident, an operator runs
   `tenant housekeeping --watch` on a single
   terminal to see BOTH gateway-side throughput
   (idempotency churn + rate-limit decisions)
   AND retention-side accumulation (workflow
   trace backpressure) in one screen. Avoids
   tmux/screen split-watching.
2. **Union-alert CI gating** — operators
   wanting "exit 3 if EITHER dashboard's
   threshold trips" don't need two separate
   watch processes; one `tenant housekeeping
   --watch --threshold-alert ...` does both.
3. **Pre-deployment soak** — before promoting
   a tier change or a new pruning policy, an
   operator runs a watch with
   `--watch-keep-going` to observe both
   dashboards over a window; resilient to
   transient PG blips.

## Decision

Add `--watch` (plus the standard
`--watch-interval` and `--watch-keep-going`)
to `tenant housekeeping`. Reuse the shared
`housekeeping-watch.ts` infrastructure
(`parseWatchFlags`, `runHousekeepingWatchLoop`,
`installShutdownBridge`).

### Atomic gather + single render per tick

The subtle ordering concern from the deferred Q
is solved by making each tick a SINGLE gather
that fetches BOTH dashboards via `Promise.all`
BEFORE rendering ONCE. Interleaved renders are
impossible — the loop doesn't render until both
gather promises resolve.

```ts
type CombinedReport = {
  readonly gateway: HousekeepingReport;
  readonly retention: RetentionHousekeepingReport;
  readonly tripped: ReadonlyArray<TrippedAlert>;
};

const gather = async (): Promise<CombinedReport> => {
  const [gateway, retentionReport] = await Promise.all([
    gatherHousekeepingReport({ conn, retention, idempotencyStore, now, tenantId, allTenants }),
    gatherRetentionHousekeepingReport({ conn, retention, now, tenantId, allTenants }),
  ]);
  const tripped =
    alerts.length > 0
      ? evaluateAlertsAcrossDashboards(gateway, retentionReport, alerts)
      : [];
  return { gateway, retention: retentionReport, tripped };
};
```

The PG connection is request-serial so
`Promise.all` interleaves the two gather
sequences rather than true-parallelizing — total
wall-clock is approximately the sum, not the
max. That trade-off is acceptable: a single
shared connection avoids connection-pool
complexity at the architect-cli layer, and
operators running --watch don't have
millisecond-tier latency requirements.

### Threshold-alert evaluation

Alerts evaluate across the UNION of tables
from both dashboards (the existing
`evaluateAlertsAcrossDashboards` from ADR-0273).
Under --watch, the tripped state at each tick
drives the loop:

- Default mode: first tick with `tripped.length
  > 0` exits the loop with exit 3.
- `--watch-keep-going` mode: trips are recorded
  as "ever halted" but the loop continues; exit
  3 fires only at maxIterations or SIGINT if
  any tick ever tripped.

This matches the per-dashboard semantic from
ADR-0265 + ADR-0276 exactly; no new alert
behavior is introduced.

### Single PG connection across ticks

The connection opens once before the loop and
closes in the `finally` block after the loop
returns. Each tick reuses the same connection;
no per-tick reconnection cost. Matches the
gateway + retention single-dashboard --watch
behavior.

### Output formats under --watch

- **Human format** — ANSI clear-screen between
  ticks (`\x1b[2J\x1b[H`), then the full
  combined view (gateway + retention sections,
  optionally followed by THRESHOLD ALERTS
  block). Single-screen UX for operators
  watching during incidents.
- **JSON format** — NDJSON-of-envelopes: one
  envelope per line, no ANSI clears (would
  break log aggregators consuming the stream).
  The envelope shape matches the single-tick
  JSON exactly so consumers can flip between
  the two modes without parser changes.

### SIGINT + SIGTERM bridge

Reuses `installShutdownBridge` from
`housekeeping-watch.ts`. Operators pressing
Ctrl-C OR Kubernetes sending SIGTERM both
trigger the AbortController shared with the
watch loop; the loop returns cleanly, the
`finally` block closes the PG connection, the
process exits gracefully. No connection-drop
mid-query, no orphaned watch state.

### Test injection

`TenantContext` gains an optional
`watchOverride?: WatchOverride` field
(reusing the shape from
`housekeeping-watch.ts`). Tests pass:
- `maxIterations` to bound the loop
- `setTimeoutFn` to drive the inter-tick wait
  synchronously
- `abortSignal` for explicit termination
- `signalRegistrar` to record SIGINT/SIGTERM
  installation without poisoning the test
  runner's own signal handlers

Production callers leave `watchOverride`
undefined and get real `setTimeout` + real
`process.on/off` bridge.

### Format compatibility gate

`parseWatchFlags` already enforces "--watch
requires --format human or json" — csv/tsv/
ndjson/yaml are batch formats. The check
fires before any PG resolution so misuse exits
fast.

### Mutual-exclusivity with --tenant and --all-tenants

No changes to the existing mutual-exclusivity
rules from ADR-0273. Under --watch, the same
`--tenant <uuid|slug>` or `--all-tenants`
filter applies to every tick; resolved once
before the loop starts.

## Rejected alternatives

1. **Sequential per-tick: gateway gather →
   render → retention gather → render** —
   would double the tick latency AND render
   the dashboards at different snapshots
   (gateway snapshot at T+0, retention
   snapshot at T+gather-duration). Atomic
   gather is the right design.

2. **Interleaved per-section rendering as
   each dashboard's gather resolves** —
   garbles layout (the ADR-0276 Q1 concern).
   Atomic gather + single render eliminates
   the problem.

3. **Two independent watch loops in
   parallel, two terminal windows** —
   defeats the purpose of the combined
   view; operators wanting single-screen
   monitoring don't want two windows.

4. **Cross-dashboard alert ordering
   (gateway alerts before retention alerts
   in the THRESHOLD ALERTS section)** —
   the existing
   `evaluateAlertsAcrossDashboards`
   already emits in gateway-first /
   retention-second order; reused as-is.

5. **--watch implies --threshold-alert
   '*'** — operators watching without
   alerts want the live view without
   CI-gate behavior. Opt-in matches the
   single-dashboard convention.

6. **Different default --watch-interval
   for the combined view (e.g., 10s
   instead of 5s) since the gather is
   2× the work** — adds API surface
   complexity for marginal latency gain.
   Operators tune via --watch-interval
   if they care.

7. **A new --watch-skip-retention or
   --watch-skip-gateway flag to drop one
   dashboard from each tick** — that's
   exactly what running the per-
   dashboard `--watch` does. No need to
   duplicate.

8. **Render combined alert summary at
   tick start (compact one-line "N
   gateway + M retention tripped")** —
   the existing per-alert THRESHOLD
   ALERTS block already conveys this;
   one-line summary would be redundant.

9. **--watch-once flag that exits after
   first tick** — that's just running
   without --watch. Not needed.

10. **Stagger the two gathers to reduce
    PG load (gateway, then 100ms,
    then retention)** — premature
    optimization. PG handles back-to-
    back queries fine; the wall-clock
    saved is negligible vs the test
    surface added.

## Drawbacks

- **Atomic gather doubles single-tick PG
  query work vs running one --watch loop
  on either dashboard alone** — acceptable
  trade-off; operators wanting one
  dashboard's view run the per-dashboard
  --watch. The combined-view advantage is
  precisely that both are visible at
  once.
- **NDJSON output for the combined view
  has both gateway + retention nested
  under each envelope** — larger lines
  per tick. Log aggregators handle this
  fine; operators wanting compact
  per-tick lines run the per-dashboard
  --watch.
- **No per-dashboard --watch-interval
  scaling** — both dashboards refresh
  at the same interval. Operators
  wanting different refresh rates run
  two terminal windows with the
  per-dashboard --watch.
- **The single-tick code path is
  preserved AND the watch path
  duplicates the render shape** — kept
  the renderTick closure unified across
  both paths to prevent drift, but
  there's still some duplication
  between renderTick (used by watch)
  and the single-tick render block
  below. Acceptable; future refactor
  could collapse them.
- **Operators must remember the
  combined-view alert field set is the
  UNION (perTenantPolicyCount is
  retention-only)** — the existing
  ADR-0273 documentation covers this;
  no new ambiguity introduced.

## Future Qs

1. **Per-section --watch-interval (e.g.,
   --watch-gateway-interval 5
   --watch-retention-interval 30)** —
   gateway data churns faster than
   retention; operators watching long
   incidents might want different
   refresh rates. Defer until operator
   demand emerges.

2. **Streaming partial updates (render
   gateway section as soon as it
   resolves, then retention)** —
   would re-introduce the layout-
   garbling concern from rejected
   alternative 2 unless we use ANSI
   cursor positioning to overwrite
   sections in-place. Defer; complex
   for marginal UX gain.

3. **--watch-summary-only flag
   collapsing each tick to a one-line
   summary** — useful for terminal
   workflows where the full view is
   too verbose. Pairs with future
   compact-output design.

4. **Persist watch ticks to a
   structured audit table for later
   playback** — out of scope; pairs
   with a future audit-log surface.

5. **--watch combined with --diff
   <other> across two tenants** —
   compare two tenants' housekeeping
   dashboards live. Complex layout
   design; defer.

6. **GitHub Actions integration:
   `tenant housekeeping --watch
   --threshold-alert ... | tee
   $GITHUB_STEP_SUMMARY`** —
   already works with NDJSON; we
   could add a `--summary-md`
   render path emitting Markdown
   ready for GHA. Defer; pairs
   with a broader summary-md
   feature.

7. **`--watch` on `tenant policies`**
   — policies change rarely; watching
   them is mostly noise. Defer unless
   operator workflows surface.
