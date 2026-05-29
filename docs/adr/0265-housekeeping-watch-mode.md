# ADR-0265: Housekeeping `--watch` mode for incident-room monitoring

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0263 Q3 (operator UI surface — closes this Q), ADR-0264 Q6 (--watch mode — closes this Q), ADR-0241 (--format=yaml + printStructured), ADR-0181 (exit code semantics) |

## Context

After ADR-0263 and ADR-0264 shipped the two housekeeping
dashboards (`crossengin gateway housekeeping` and `crossengin
retention housekeeping`), both were one-shot read commands. SREs
watching a table grow during an incident hit the same external-
tooling workaround:

```bash
watch -n 5 'crossengin retention housekeeping'
```

This works but has three problems:

1. **Reconnection every tick.** `watch(1)` re-invokes the binary,
   which reconnects to PG on each tick — wasteful at 5-second
   intervals over a 30-minute incident (360 reconnects).

2. **Flickery rendering.** `watch(1)` clears the screen between
   ticks but the moment of darkness during reconnect is visible.

3. **Format coupling.** `watch -n 5 'crossengin ... --format json'`
   produces 360 pretty-printed JSON envelopes in a scrollback —
   unusable for log-aggregator pipes.

Both ADR-0263 Q3 and ADR-0264 Q6 explicitly listed `--watch` mode
as a deferred Q:

> "--watch mode for incident-room monitoring — re-renders every N
> seconds for SREs watching tables during incidents."

This ADR closes both.

## Decision

Add `--watch` + `--watch-interval <seconds>` flags to both
housekeeping actions. The dashboards loop in the same process:
open the PG connection once, render N times at the configured
interval. Both actions share the same loop implementation via a
new generic helper.

### Surface

```
$ crossengin gateway housekeeping [--watch] [--watch-interval <seconds>]
$ crossengin retention housekeeping [--watch] [--watch-interval <seconds>]
```

| Flag | Type | Default | Range |
|---|---|---|---|
| `--watch` | boolean | off (single-shot) | — |
| `--watch-interval` | integer (seconds) | 5 | [1, 3600] |

### Format compatibility

`--watch` requires `--format human` or `--format json`. Other
formats (csv, tsv, ndjson, yaml) are rejected with exit 2.

| Format | Behavior under --watch |
|---|---|
| human | ANSI clear-screen (`\x1b[2J\x1b[H`) + redraw per tick (live single-screen UX) |
| json | NDJSON stream — one **compact** envelope per line (operator pipes through `jq -c` or to log aggregators) |
| csv, tsv, ndjson, yaml | **Rejected with exit 2** (these are batch formats; json under --watch already produces line-delimited envelopes which is what ndjson would emit anyway) |

The csv/tsv/yaml rejection is hard. The ndjson rejection is
chosen for consistency — `--format ndjson` exists in the
codebase as "one ENTRY per line" while `--format json --watch`
emits "one ENVELOPE per line." Operators wanting an explicit
single-line behavior use `--format json` (which is conceptually
the same shape, structurally identical output).

### Termination

Three termination paths:

1. **Production: SIGINT.** Operators hit Ctrl-C. The watch loop
   doesn't install a SIGINT handler in v1 — Node's default
   exits with 130 (128 + 2), which is acceptable for incident-
   room use (PG drops the open connection, no data corruption,
   in-flight query rolled back).

2. **Tests: `watchOverride.maxIterations`.** Loop exits cleanly
   after N iterations. Used by every watch test to bound runs.

3. **Tests/future-prod: `watchOverride.abortSignal`.** AbortSignal
   that breaks the wait between ticks; clean exit returning 0.
   Designed so a future SIGINT handler can wire to an
   AbortController without changing the loop API.

### Error handling

If `gather()` throws during a tick, the watch loop exits with
exit 1 (matching single-shot behavior). No infinite retry, no
silent swallow.

Rationale: operators using `--watch` during an incident want to
know if the dashboard breaks (e.g., PG goes away). Silent
swallow would mask the failure. A future Q
(`--watch-keep-going`) can add resilience for long-running
incident monitoring once measured demand emerges.

### Implementation

New module `apps/architect-cli/src/housekeeping-watch.ts`:

- `WatchLoopOptions` interface (intervalMs, maxIterations?,
  abortSignal?, setTimeoutFn?, clearTimeoutFn?).
- `WatchLoopInput<R>` interface (gather, render,
  clearScreenBeforeRender, io, options).
- `runHousekeepingWatchLoop<R>` generic loop — calls gather()
  + render() per tick + optional ANSI clear-screen + waits the
  interval or aborts.
- `parseWatchFlags(command, io, label)` shared flag-validator
  with format compatibility check; returns parsed flags OR an
  exit code (2) on misuse.
- `WatchOverride` interface bundling the test-injection hooks.

Both `retention-housekeeping.ts` and `gateway-housekeeping.ts`:

1. Call `parseWatchFlags` early (before PG resolution so misuse
   exits cleanly without burning a connection).
2. Set up connection + adapters (existing logic).
3. Build a `gather()` closure capturing the active connection
   and clock.
4. If `--watch`, call `runHousekeepingWatchLoop` with a
   render closure that does JSON streaming (compact one-line
   envelopes) or human rendering (multi-section text).
5. If not `--watch`, single-shot (existing behavior preserved
   exactly).

`RetentionContext` and `GatewayContext` each gain a
`watchOverride?: WatchOverride` field for test injection. Same
shape on both (declared structurally to avoid cross-module
imports in the context types).

### Connection lifecycle

The watch loop keeps the connection open for the full lifetime
of the loop. This is the headline performance win over `watch
-n 5 'crossengin ...'`:

- 360 ticks at 5-second intervals over 30 minutes
  = 1 connection vs 360 connections.
- No reconnect-blip rendering pause.
- PG sees one long-lived client (better connection-pool
  utilization for ops teams).

When the loop exits (maxIterations / abort / error), the
connection closes via the existing finally block in the action
function.

### Clock semantics

`gather()` reads the clock per call, so each tick's `asOf`
field moves forward. Tests inject `clockOverride: () =>
fixedNow` to pin to a specific timestamp (existing behavior).

Production reads `new Date()` per tick — operators expect the
dashboard's `asOf` to update.

## Rejected alternatives

1. **Document `watch -n 5 'crossengin ...'` as the operator
   workflow.** Doesn't solve the connection-reconnect overhead,
   doesn't solve the flicker, and the moment of darkness during
   reconnect is visually obvious during high-stakes incidents.
   Built-in --watch is a clear win.

2. **`--watch <seconds>` taking the interval as the flag value.**
   Considered (kubectl-style `kubectl get pods -w`), but flag-
   value parsing conflicts with the boolean default. The two-
   flag pattern (`--watch` + `--watch-interval`) is clearer and
   matches `watch -n` Unix convention.

3. **Default interval 1 second.** Too aggressive — most tables
   don't change meaningfully every second + PG load multiplies.
   Default 5 seconds matches `watch(1)`'s default.

4. **Default interval 30 seconds.** Too slow for incident
   monitoring — operators want sub-minute feedback. 5 seconds
   is the right balance.

5. **Install SIGINT handler in v1 for graceful PG shutdown.**
   Deferred. Node's default exit (130) drops the connection;
   PG cleans up. Watch users explicitly opt into long-running
   mode and Ctrl-C is the canonical exit. SIGINT-as-clean-
   shutdown is a future Q (`AbortController` wiring already
   exists in the loop, just needs the SIGINT → controller
   bridge).

6. **Loop swallows gather() errors and continues.** Deferred.
   Silent swallow during an incident is wrong — operators want
   the dashboard to break loudly if PG goes away. Resilient
   mode is a future Q via `--watch-keep-going` flag.

7. **Allow `--format ndjson` under --watch.** Rejected — under
   `--watch`, `--format json` already emits NDJSON-of-envelopes.
   Allowing both would create two ways to express the same
   thing. The mental model "json under watch = streaming
   envelopes" is clean.

8. **Allow `--format yaml` under --watch.** Rejected — YAML
   document separators (`---`) would be needed between ticks,
   adding complexity for a low-demand case. Operators wanting
   YAML use single-shot mode.

9. **Allow `--format csv/tsv` under --watch.** Rejected — these
   are batch formats. Operators wanting tabular per-tick output
   pipe `--format json --watch` through `jq -r @csv` or similar.

10. **Share the watch loop via inheritance/class hierarchy.**
    Considered (e.g., abstract `HousekeepingDashboard` class
    with `gather()` + `renderHuman()` methods). Rejected for
    YAGNI — a simple generic function with closures is enough,
    matches the existing CLI code style which avoids classes.

## Drawbacks

1. **No SIGINT-as-clean-shutdown in v1.** Operators hitting
   Ctrl-C see Node's default exit-130 path. PG connection drops
   ungracefully but recovers fine. Future Q.

2. **No error-tolerant mode.** Transient PG errors during an
   incident kill the watch. Operators wrap in shell loop for
   resilience. Future Q (`--watch-keep-going`).

3. **ANSI clear-screen written for non-TTY output.** Operators
   piping `--watch --format human` to a file see `\x1b[2J\x1b[H`
   in the output. Acceptable for v1 — operators using --watch
   typically watch in a terminal; piping is the json format's
   job.

4. **Default interval is a global constant** (`DEFAULT_INTERVAL_SECONDS
   = 5`). Operators wanting a different default per environment
   set it via `--watch-interval` explicitly. No environment-
   variable override yet.

5. **No max-iterations CLI flag.** Tests inject via
   `watchOverride.maxIterations`; operators wanting bounded
   runs use shell wrappers or future-Q dedicated flag.

6. **Watch loop runs sequentially per tick.** No overlap
   between gather + render + wait — at very-high-volume tables
   where gather takes longer than the interval, ticks pile up.
   In practice, gather is sub-second; out of scope.

## Future Qs

1. **SIGINT handler → AbortController bridge.** Install a
   `process.on("SIGINT", () => controller.abort())` handler
   in production mode (skip in tests) so Ctrl-C exits cleanly
   with PG-connection close. The AbortSignal wiring already
   exists in the loop.

2. **`--watch-keep-going` flag for error tolerance.** Catches
   gather() errors per-tick, prints them in place of the
   report, continues. Operators monitoring during long
   incidents want resilience to transient PG blips.

3. **`--watch-max-iterations <N>` CLI flag.** Operator-visible
   version of the test-injection hook. Useful for time-bounded
   runs in CI or for "let me see 10 snapshots then stop."

4. **`--watch-clear-mode <ansi|separator|none>` flag.** Some
   operators pipe to files and want plain text. `separator` mode
   prints `--- tick N at <iso> ---` between renders.

5. **`CROSSENGIN_WATCH_INTERVAL` env var.** Operator-wide
   default interval without per-command flag. Defer until
   measured demand.

6. **Watch mode integration with `--threshold-alert`.**
   When the threshold-alert Q (separate ADR) lands, `--watch`
   could exit non-zero on first threshold violation (CI-gate
   loop). Or print a beep + continue in resilient mode.

## Operator workflow examples

### Live monitor during an incident

```bash
crossengin retention housekeeping --watch
```

Single screen, refreshes every 5 seconds, shows all 6 retention-
substrate tables. Ctrl-C to exit.

### Log-aggregator pipe

```bash
crossengin retention housekeeping --watch --watch-interval 30 --format json \
  | tee -a /var/log/housekeeping/$(date +%F).ndjson
```

NDJSON stream at 30-second intervals to a daily log file.
Operators replay incidents later.

### High-frequency monitoring during a known event

```bash
crossengin gateway housekeeping --watch --watch-interval 1
```

1-second refresh during a controlled load test or migration
to watch row growth in real time.

## Testing

17 new tests across two files (8 retention + 9 gateway). The
parallel test sets cover:

- Loop runs N times when `maxIterations: N`.
- Human format emits ANSI clear-screen between ticks.
- JSON format streams NDJSON (one compact envelope per line, no
  screen clearing).
- `--watch-interval` threads custom interval through to
  setTimeout.
- `--watch-interval` requires `--watch` (exit 2).
- `--watch-interval` rejects 0, >3600, non-integer, non-numeric
  (exit 2).
- `--watch` rejects csv/tsv/ndjson/yaml (exit 2).
- `--watch` validation fires before PG resolution (no PG-env
  error on misuse).
- `abortSignal` cancels the loop between ticks (clean exit 0).
- `gather()` errors propagate as exit 1 (no infinite retry).

Test injection uses `watchOverride.setTimeoutFn` that fires
synchronously, draining N iterations instantly without real
timer delays.

Workspace test count 9,526 → 9,543 (+17).
