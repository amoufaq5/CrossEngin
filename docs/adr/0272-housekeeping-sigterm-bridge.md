# ADR-0272: Housekeeping `--watch` SIGTERM bridge alongside SIGINT

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0268 Q1 (closes), ADR-0265 (host watch loop), ADR-0270 Q8 (gateway companion), ADR-0271 (composes with --all-tenants under watch) |

## Context

ADR-0268 (M4.14.r) shipped the SIGINT-to-AbortController
bridge that lets `Ctrl-C` exit a watch loop cleanly with
PG closed via the action's `finally` block. The ADR's
Q1 explicitly carved out SIGTERM as future work:
"Kubernetes / systemd / container managers send SIGTERM
for graceful shutdown; current bridge only handles
SIGINT."

The operational pain is real. A housekeeping watch loop
deployed as a long-running pod (`kubectl run crossengin-
housekeeping --image ... -- gateway housekeeping --watch
...`) receives SIGTERM when:

- Kubernetes scales down the deployment
- The pod is evicted (node drain, preemption)
- A rolling update replaces it
- The container manager hits its graceful-shutdown timer

Without a SIGTERM handler the process exits at code 143
(Node default) with PG dropped abruptly + the watch
state lost (specifically the sticky-trip exit-3 from
M4.14.s — Kubernetes would see exit 143 instead of the
"any tick during this window tripped" signal the CI gate
depends on).

The fix is structurally trivial — install a second
handler under the same AbortController. Both signals
share the same shutdown semantic in housekeeping
dashboards; there's no operational reason to distinguish
"operator pressed Ctrl-C" from "Kubernetes scaled down
the pod"; both should drain cleanly with PG closed and
exit codes preserved.

## Decision

Extend the M4.14.r bridge to register handlers for BOTH
SIGINT AND SIGTERM under a shared AbortController. The
public API shape is unchanged — `{signal, cleanup}` —
but `cleanup()` now removes both handlers and the
internal handler fires the same `controller.abort()`
regardless of which signal triggered it.

Rename `installSigintBridge` → `installShutdownBridge`
to reflect the broader scope. The old name is preserved
as a deprecated alias pointing at the same
implementation (no external callers — all in-repo
consumers updated to the new name).

The single-controller design reflects the operator
mental model: from the dashboard's perspective, "stop
gracefully" is one event. The signal that triggered it
is incidental.

Test injection (the `SignalRegistrar` mechanism from
ADR-0268) extends naturally — tests pass a custom
registrar that captures handlers PER SIGNAL into a
`Map<string, () => void>`, then can fire either signal's
handler in isolation to verify each path works. The
existing M4.14.r SIGINT tests were updated to assert
that BOTH signals are registered + BOTH are removed on
cleanup; new M4.14.p tests fire the SIGTERM handler
specifically to exercise the Kubernetes path.

Help text on both housekeeping actions updated:

```
Under --watch, Ctrl-C (SIGINT) AND graceful shutdown signals
from container managers (SIGTERM from Kubernetes / systemd)
exit cleanly via a shared shutdown-to-AbortController bridge
(PG connection closes via the action's finally block).
```

## Rejected alternatives

1. **Two separate bridges, one per signal** —
   `installSigintBridge` + `installShutdownBridge` each
   with their own AbortController. Operators would have
   to compose signals via `AbortSignal.any([sigint,
   sigterm])` at every call site. The single bridge
   keeps the consumer-side wiring identical to M4.14.r.

2. **SIGTERM-only opt-in via a flag** (e.g.,
   `--enable-sigterm` or env var) — adds a knob without
   a reason to leave it off. The operational pain is
   universal; managed-service deployments expect
   SIGTERM handling by default.

3. **Skip SIGINT alias for backward compat** — the
   `installSigintBridge` name appeared in ADR-0268; the
   deprecated alias preserves the documented vocabulary
   while letting new code use the more accurate name.
   Drop-in for any future test that copies the M4.14.r
   pattern.

4. **Handle SIGHUP / SIGUSR1 / SIGUSR2 too** — those
   signals have different operational semantics
   (config reload, custom user actions); silently
   treating them as shutdown would surprise operators.
   Stay narrow.

5. **Separate render path for "shutdown via SIGTERM"
   vs "shutdown via SIGINT"** — both exit cleanly with
   no output, no visible distinction; the differentiation
   would add noise without information. Operators
   inspecting `$?` see exit code 0 (or 3 under sticky
   trip) in both cases.

6. **Force exit after a hard-coded timeout if cleanup
   stalls** — Kubernetes already sends SIGKILL after
   its grace period if the process hasn't exited. The
   bridge doesn't need to second-guess; PG's close is
   fast enough in practice. Future Q if measured slow.

7. **Telemetry hook for SIGTERM events** (e.g., emit
   an instrumentation event) — instrumentation in the
   housekeeping dashboard is post-tick render; signal
   handling is process-level lifecycle. The two
   surfaces don't overlap cleanly. Future Q if needed.

## Implementation notes

The M4.14.r `captureSignalRegistrar()` test helper
threw on any signal that wasn't SIGINT
(`if (signal !== "SIGINT") throw new Error(...)`).
M4.14.p widens it to a `Map<string, () => void>`
keyed by signal name, with separate `signals[]` tracking
on the cleanup side so tests can assert exact
register/remove pairs.

The bridge is invoked at the same call site in both
`gateway-housekeeping.ts` and `retention-housekeeping.ts`
— a single conditional in each dispatcher that skips
the bridge when the caller supplies `abortSignal`
directly (tests use this path to bypass the registrar
entirely). The conditional logic is unchanged from
M4.14.r; only the function name + cleanup behavior
expanded.

Local variable rename `sigintBridge` → `shutdownBridge`
in both call sites for naming consistency.

## Tests

2 new tests + 4 modified existing tests across both
dashboards:

- **Modified (gateway + retention)**: "installs the
  shutdown bridge under --watch + cleans up on natural
  exit (both signals)" — asserts both SIGINT and
  SIGTERM registered; asserts `removeCalls.count === 2`
  with `signals.sort() === ["SIGINT", "SIGTERM"]`
- **Modified (gateway + retention)**: "does NOT install
  the bridge when abortSignal override is supplied
  (neither signal registered)" — asserts
  `handlers.size === 0` (neither registered when the
  caller passes its own signal)
- **Modified (retention)**: "cleans up both signal
  handlers even when the loop throws" — asserts both
  handlers cleaned up via the cleanup() call in the
  action's finally block
- **New (gateway + retention)**: "M4.14.p — firing the
  captured SIGTERM handler aborts the loop cleanly
  (Kubernetes shutdown)" — fires the SIGTERM handler
  during the wait between ticks; asserts exit code 0
  (NOT 143 — Node's default SIGTERM exit) and exactly
  one render cycle completed

Workspace test count goes 9,633 → 9,635.

## Consequences

- Housekeeping watch loops deployed as Kubernetes pods
  exit cleanly on rolling updates, scale-downs, and
  evictions instead of dropping PG abruptly.
- The sticky-trip exit-3 from M4.14.s survives SIGTERM
  — managed-service CI gates that depend on "did any
  tick during this watch window trip the threshold?"
  signal continue working under graceful shutdown.
- Operators reading the help text learn that BOTH
  Ctrl-C and Kubernetes shutdown work the same way;
  no separate documentation needed for each
  environment.
- Future signal-handling Qs (SIGHUP for config reload,
  SIGUSR1 / SIGUSR2 for custom actions) have a clear
  pattern to follow: extend `installShutdownBridge`
  with a different name OR add a new bridge with its
  own semantic.
- Backward compat preserved end-to-end via the
  `installSigintBridge` deprecated alias.

## Future Qs

1. **Hard cleanup timeout** — force exit after N
   seconds if PG close hangs. Today PG close is fast
   in practice; Kubernetes' grace period (default 30s)
   covers it. Defer until measured slow.
2. **Telemetry hook for shutdown events** — emit an
   instrumentation event recording which signal
   triggered shutdown + how long cleanup took.
   Pairs with future observability work on housekeeping
   dashboards.
3. **SIGHUP for config reload** — operators may want
   to reload `--threshold-alert` config without
   restarting the loop. Different semantic from
   shutdown; warrants its own bridge.
4. **Second-Ctrl-C confirmation prompt** — if
   operators hit Ctrl-C twice during cleanup, force
   exit at 130. Today the bridge runs cleanup
   regardless; second Ctrl-C is ignored.
5. **Compose external `abortSignal` via
   `AbortSignal.any([external, sigintBridge.signal,
   sigtermBridge.signal])`** — operators wanting to
   wire their own AbortController in parallel with
   the bridge.
6. **Bridge unification with `gateway start`** — the
   `gateway start` action is similarly long-running
   and would benefit from the same shutdown handling.
   Different code path; future milestone if measured
   needed.
7. **SIGQUIT handling** — defaults to a core dump
   under Node; usually not what operators want for a
   CLI tool. Defer unless requested.
