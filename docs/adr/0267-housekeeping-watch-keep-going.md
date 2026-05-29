# ADR-0267: Housekeeping `--watch-keep-going` resilient watch mode

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0265 Q2 (closes), ADR-0266 (composes with --threshold-alert), ADR-0181 (exit code conventions) |

## Context

After ADR-0265 (`--watch` mode) and ADR-0266
(`--threshold-alert` CI gates), the housekeeping dashboards
had two failure modes that conflicted with long-running
incident monitoring:

1. **Transient `gather()` errors kill the dashboard.**
   A PG blip at minute 7 of a 30-minute watch loop exits
   the process with code 1. The operator's tmux pane goes
   blank; they have to restart manually + lose continuity.

2. **First-tripped alert exits immediately.**
   `--watch --threshold-alert wouldPruneCount:>1M` works
   great as a fail-fast CI gate. But operators wanting
   "show me each tick's alert state during this 5-minute
   window" can't get that — the loop exits at tick 1 if
   tripped.

ADR-0265 Q2 explicitly listed this as a deferred Q:

> "`--watch-keep-going` flag for error tolerance. Catches
> gather() errors per-tick, prints them in place of the
> report, continues. Operators monitoring during long
> incidents want resilience to transient PG blips."

This ADR closes that Q and extends the resilience to
threshold-alert behavior.

## Decision

Add `--watch-keep-going` boolean flag to both housekeeping
actions (`gateway housekeeping` and `retention housekeeping`).
Requires `--watch` (exits 2 otherwise). When set, the watch
loop behavior changes in two ways:

### 1. Error tolerance

When `gather()` throws during a tick:

- **Default mode**: error propagates, caller exits 1.
- **Keep-going**: error caught by the loop, passed to a
  caller-supplied `errorRender` callback, and the loop
  continues to the next tick.

The error envelope renders in place of the report:

- Human format: `retention housekeeping: (error this tick:
  <message>)` printed to stdout.
- JSON format: compact NDJSON envelope `{action, asOf,
  error: {message}}` — operators piping through
  `jq 'select(.error)'` find the error ticks.

### 2. Threshold-alert sticky tracking

When a threshold alert trips during a tick:

- **Default mode**: render the THRESHOLD ALERTS section +
  return `"halt"` from render — loop exits immediately with
  exit 3.
- **Keep-going**: render the THRESHOLD ALERTS section every
  tick that trips + record `everHalted=true` in the loop's
  result. Loop continues until natural termination
  (maxIterations / abortSignal / SIGINT).

Sticky semantic: once any tick trips, the final exit code
is 3 regardless of whether subsequent ticks un-trip. This
matches CI-gate intent ("did anything go wrong during this
window?").

### Exit code matrix

| Mode | Errors? | Trips? | Exit |
|---|---|---|---|
| default | no | no | 0 |
| default | yes | — | 1 (error propagates) |
| default | no | yes (tick N) | 3 (loop exits at tick N) |
| keep-going | no | no | 0 |
| keep-going | yes | no | 0 (errors rendered, ignored for exit) |
| keep-going | — | yes (any tick) | 3 (sticky) |
| keep-going | yes | yes | 3 (trip wins over error) |

### Why errors don't map to exit 1 under keep-going

The whole point of keep-going is opt-in tolerance of
transient errors. Operators saying "keep going through
blips" are saying "I don't want the blip itself to fail
me." If they wanted exit 1 on errors, they'd run without
keep-going.

If errors persist (every tick fails), the loop runs through
maxIterations rendering errors each tick and exits 0. This
is the right outcome for the "long incident, dashboard
dead" case — the operator sees the errors visually, they
don't want a non-zero exit overriding their visual signal.

For CI-gate use, operators wanting "fail if ANY tick errored"
combine WITHOUT keep-going + accept the exit 1 trade-off.

### Implementation

`WatchLoopInput<R>` (in `housekeeping-watch.ts`) gains:

- `keepGoing?: boolean` — opt-in resilience.
- `errorRender?: (err: Error) => void` — caller-supplied
  per-tick error renderer.

The loop's behavior:

```ts
try {
  report = await input.gather();
} catch (err) {
  if (!input.keepGoing) throw err;
  gatherError = err;
}
if (gatherError !== undefined) {
  input.errorRender?.(gatherError);
} else {
  const haltSignal = input.render(report);
  if (haltSignal === "halt") {
    everHalted = true;
    if (!input.keepGoing) return { halted: true };
  }
}
// ... loop continues with maxIterations / abortSignal checks
```

`parseWatchFlags` extends to parse `--watch-keep-going`
(boolean), validates `--watch-keep-going` requires `--watch`
(exit 2 otherwise), and includes it in the returned
`ParsedWatchFlags`.

Both housekeeping action files thread `keepGoing` + a
`renderError` closure through to the watch loop. The
`renderError` closure uses the same format-aware logic as
`renderTick` (JSON envelope vs human text).

### Composition with `--threshold-alert`

Watch keep-going + threshold-alert is the canonical
incident-monitoring pattern. Example:

```bash
timeout 600 crossengin retention housekeeping --watch \
  --watch-keep-going \
  --threshold-alert wouldPruneCount:>1000000
```

For 10 minutes:
- Renders the dashboard every 5s.
- Skips through any transient PG blips.
- Notes every tick the threshold trips.
- Final exit code:
  - 124 = timeout fired (no trip during 10 minutes).
  - 3 = at least one tick tripped.

## Rejected alternatives

1. **Always-on keep-going under --watch (no separate flag).**
   Breaking change to ADR-0265 semantic. Operators using
   --watch today rely on errors crashing the loop. Opt-in
   preserves backwards compat.

2. **`--watch-keep-going` implies `--watch`.** Considered
   ergonomic but breaks the "every flag requires its
   parent" convention from `--watch-interval`. Operators
   reading the help text expect explicit composition.

3. **Map errors-under-keep-going to exit 1 at end (sticky
   error tracking).** Loses the "tolerance is the point"
   semantic. Operators choosing keep-going don't want
   transient errors to dominate their exit code.

4. **Render errors to stderr instead of stdout.** Inconsistent
   with the main report rendering (stdout). Operators piping
   `crossengin ... | log_aggregator` expect a single stream
   with both reports and errors.

5. **Exit 4 for "keep-going completed with errors."** Adds
   another exit code to the vocabulary. ADR-0181 keeps it
   tight at 0/1/2/3; exit 0 here is "the watch did what you
   asked, including surviving errors."

6. **Track "any error ever" as a JSON envelope flag.**
   Bloats the per-tick envelope. Operators wanting "did
   any error occur" can `jq 'select(.error)' | wc -l`.

7. **Auto-detect transient vs persistent errors.** Heuristic
   ("network timeout = transient, schema-not-found =
   persistent") would be wrong half the time. Operator
   policy concern — defer.

8. **`--watch-keep-going-attempts N` to bound retry count.**
   Loop already bounded by maxIterations / abortSignal /
   SIGINT. Adding another retry cap multiplies flags.
   Operators wanting "give up after 3 errors" run their
   own bash loop.

9. **Halt-on-Nth-trip under keep-going (`--watch-trip-
   threshold N`).** Operators wanting "fail if 3+ ticks
   trip" can jq the NDJSON output. Adding a flag for this
   single corner case isn't worth the surface.

## Drawbacks

1. **Sticky halted tracking obscures recovery.** If tick 1
   trips and ticks 2-100 don't, the exit is still 3.
   Operators wanting "alert only if last tick tripped"
   can't express it. (CI-gate semantic favors stickiness.)

2. **errorRender doesn't get tick number or timing.**
   Operators wanting "tick 7 errored at 12:34:56" check
   stderr timestamps. Adding the metadata would
   complicate the renderer interface.

3. **No retry-with-backoff.** Each tick uses the same
   `--watch-interval` regardless of recent errors.
   Operators wanting exponential backoff use shell wrappers.

4. **Errors don't preserve report context.** When a tick
   errors, the previous tick's report doesn't render again.
   The dashboard shows the error message replacing the
   data, then the next tick (if successful) refreshes.
   For 5-second intervals + ANSI clear-screen, this is a
   brief flash of error then back to data.

5. **No way to test "errored tick + recovered tick" easily.**
   Tests use a `callCount`-based flaky retention adapter;
   the pattern works but is hand-rolled rather than from
   a shared library.

6. **`--watch-keep-going` without `--threshold-alert` is
   just error tolerance.** Operators get the keep-going
   error renderer but not the trip-tracking. That's fine
   — it's still the canonical "incident monitor" use case.

## Future Qs

1. **`--watch-keep-going-retries N` to bound recovery
   attempts.** Loop exits 1 if N consecutive errors occur
   (PG truly went away). Useful for CI scenarios mid-keep-
   going where pure-tolerance loses signal.

2. **Render previous report on error tick.** Operators
   wanting "show me the last good state when the error
   hits" enable a flag. Adds state to the renderer.

3. **Backoff between errored ticks.** Auto-double the
   interval after each error tick, reset on success. Bounds
   on PG retry pressure during prolonged outages.

4. **Per-tick timestamp in error render.** Add `asOf` to
   the error envelope (already in JSON; human format
   needs prefix). Operators correlating across logs.

5. **Last-tick-state semantic for halted tracking.** Add
   `--watch-trip-mode {sticky,last}` flag. `last` mode
   exits 3 only if the FINAL tick tripped; recovered
   alerts pass. Defer until measured demand.

6. **Composes with future `--threshold-alert-file <path>`
   (ADR-0266 Q5).** When alert file lands, --watch-keep-
   going + file should compose naturally without new
   wiring.

7. **`--watch-keep-going-stderr` flag** to route error
   envelopes to stderr while keeping report on stdout.
   Operators piping reports to log aggregators but
   stderr to incident channels.

## Operator workflow examples

### Long-running incident dashboard

```bash
crossengin retention housekeeping --watch --watch-keep-going
```

Sits in a tmux pane for hours. Survives transient PG blips.
Operator Ctrl-Cs when done. Exit 130 (Node SIGINT default).

### Time-bounded CI gate with resilience

```bash
timeout 600 crossengin gateway housekeeping --watch \
  --watch-keep-going \
  --threshold-alert wouldPruneCount:>1000000 \
  --threshold-alert lastPrunedAt:>24h
```

Watches for 10 minutes. Tolerates transient errors. Exits 3
if EITHER alert tripped at ANY tick; 124 (timeout) otherwise.

### Streaming JSON to log aggregator

```bash
crossengin retention housekeeping --watch --watch-keep-going \
  --format json \
  --threshold-alert oldestAt:>365d \
  | tee -a /var/log/housekeeping.ndjson
```

NDJSON stream of envelopes (data + occasional error envelopes
during PG blips). Log aggregator parses each line.

### Severity tiers with keep-going

```bash
# Critical: fail-fast on first trip
crossengin retention housekeeping --watch \
  --threshold-alert wouldPruneCount:>10000000 \
  || page_oncall

# Warn: keep-going + final exit 3 if EVER tripped
timeout 300 crossengin retention housekeeping --watch \
  --watch-keep-going \
  --threshold-alert wouldPruneCount:>5000000 \
  || slack_warn
```

## Testing

13 new tests across two files:

- **retention-housekeeping.test.ts** (7 tests):
  --watch-keep-going requires --watch, exit 0 on clean
  ticks, exit 3 sticky on trip + maxIterations terminates,
  catches gather errors + renders them + exits 0, WITHOUT
  flag errors still propagate exit 1, JSON error envelope
  format, sticky halt across recovering trip.

- **gateway.test.ts** (6 tests): same shape adapted to
  gateway's idempotency-store-included fixtures.

Workspace test count 9,591 → 9,604 (+13). Coverage on
`housekeeping-watch.ts` improved 89.88% → 91.74% statements
(new error path covered).
