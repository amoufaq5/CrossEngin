# ADR-0268: Housekeeping `--watch` SIGINT-to-AbortController bridge

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0265 Q1 (closes), ADR-0266 (compositional), ADR-0267 (compositional) |

## Context

After ADR-0265 (`--watch`), ADR-0266 (`--threshold-alert`),
and ADR-0267 (`--watch-keep-going`), the housekeeping
dashboards had a remaining incident-room rough edge: Ctrl-C
during a watch loop exited the process with Node's default
SIGINT behavior (exit 130) WITHOUT running the action's
`finally` block. PG connection drops abruptly. PG handles
the dropped connection fine, but the operator sees no
graceful exit signal:

- No confirmation that PG cleanup ran.
- Process exit code 130 instead of the expected 0 for
  "operator cancelled cleanly."
- Test infrastructure can't observe shutdown behavior
  because the signal terminates Node before any test
  assertions can fire.

ADR-0265 Q1 explicitly listed this as a deferred Q:

> "SIGINT handler → AbortController bridge. Install a
> `process.on("SIGINT", () => controller.abort())` handler
> in production mode (skip in tests) so Ctrl-C exits
> cleanly with PG-connection close. The AbortSignal wiring
> already exists in the loop."

This ADR closes that Q. The mechanism reuses the existing
`abortSignal` path that `--watch` has supported since
M4.14.w — the bridge just wires SIGINT to that path.

## Decision

When `--watch` is active AND the caller has NOT supplied an
`abortSignal` override (tests typically do supply one),
install a SIGINT-to-AbortController bridge. The bridge:

1. Creates an internal AbortController.
2. Registers a SIGINT handler that aborts the controller.
3. Passes `controller.signal` to the watch loop as
   `abortSignal`.
4. Returns a cleanup closure that removes the handler.

The action's `try`/`finally` block calls cleanup
unconditionally — whether the loop exits via SIGINT,
natural maxIterations termination, or an unrecovered
error. This makes the handler installation/removal
RAII-style (always paired).

When the operator hits Ctrl-C, the SIGINT handler fires,
the controller aborts, the watch loop's existing abort path
exits the loop returning `{ halted: everHalted }`. The
action sees the natural return value, runs `finally`
(closes PG, removes SIGINT handler), and the process
exits with the appropriate code:

- Exit 0 — normal Ctrl-C without any tripped alert.
- Exit 3 — Ctrl-C after at least one tripped alert
  (sticky semantic from ADR-0267 + M4.14.t).

This is cleaner than Node's default exit 130 because:
1. PG connection closes via `closeConn` in `finally`.
2. The SIGINT handler is removed (test runners don't get
   poisoned by leftover handlers).
3. The exit code reflects the dashboard's state, not the
   signal that terminated it.

### Implementation

New exported helper `installSigintBridge` in
`housekeeping-watch.ts`:

```ts
export function installSigintBridge(
  register?: SignalRegistrar,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const handler = (): void => controller.abort();
  const defaultRegister: SignalRegistrar = (sig, h) => {
    process.on(sig, h);
    return () => process.removeListener(sig, h);
  };
  const removeHandler = (register ?? defaultRegister)("SIGINT", handler);
  return { signal: controller.signal, cleanup: removeHandler };
}
```

`SignalRegistrar` type:

```ts
export type SignalRegistrar = (
  signal: string,
  handler: () => void,
) => () => void;
```

Both housekeeping actions wire it conditionally:

```ts
const sigintBridge =
  ctx.watchOverride?.abortSignal === undefined
    ? installSigintBridge(ctx.watchOverride?.signalRegistrar)
    : undefined;
try {
  const result = await runHousekeepingWatchLoop({
    // ...
    abortSignal: ctx.watchOverride?.abortSignal ?? sigintBridge?.signal,
    // ...
  });
  return result.halted ? 3 : 0;
} finally {
  sigintBridge?.cleanup();
}
```

The outer `try`/`finally` (closing PG) wraps this, so the
cleanup ordering is: SIGINT handler removed → PG closed.

### Test injection

`WatchOverride` (and the mirrored `RetentionWatchOverride` +
`GatewayWatchOverride` interfaces) gains a
`signalRegistrar?: SignalRegistrar` field. Tests supply a
capturing stub:

```ts
function captureSignalRegistrar() {
  const captured: { handler: (() => void) | null } = { handler: null };
  const removeCalls = { count: 0 };
  const registrar: SignalRegistrar = (signal, handler) => {
    if (signal !== "SIGINT") throw new Error(`unexpected: ${signal}`);
    captured.handler = handler;
    return () => { removeCalls.count++; };
  };
  return { registrar, captured, removeCalls };
}
```

The test then synchronously invokes `captured.handler()` to
simulate Ctrl-C without poisoning the test runner's actual
SIGINT events. This pattern is borrowed from how Node SDKs
test signal-based shutdown without using real signals.

Tests verify:
1. Registrar IS called when `--watch` + no `abortSignal`
   override.
2. Firing the captured handler aborts the loop cleanly
   (exit 0, no exit 130).
3. Registrar is NOT called when caller supplies
   `abortSignal` directly (override path).
4. Cleanup runs in `finally` even when the loop throws.

### Production default

Production callers omit `signalRegistrar`. The default
implementation uses `process.on("SIGINT", handler)` and
returns `() => process.removeListener("SIGINT", handler)`.
This is the bog-standard Node pattern.

## Rejected alternatives

1. **Always install SIGINT handler unconditionally
   (even when abortSignal override provided).**
   Tests would have to clean up the real handler at the
   end of every test. Cleaner to skip when override is
   present.

2. **Skip installing the bridge when running under
   vitest (auto-detect test mode).** Brittle —
   depends on environment detection. Explicit override
   via `signalRegistrar` is testable + production-safe.

3. **Install handler for SIGTERM as well.**
   SIGTERM is for orchestrated shutdown (Kubernetes,
   systemd, etc.), where the watch loop might be
   running unattended. Deferred to future Q.

4. **Use `AbortSignal.any([signalRegistrar, override])`
   to combine signals.** Modern Node 22+ has it but the
   semantic of "either abort = abort" requires explicit
   intent. Operators supplying override are saying "I'm
   driving abort," not "I want to compose."

5. **Hide the SIGINT bridge behind a separate
   `--watch-clean-sigint` flag.** Default-off would mean
   most operators don't get the benefit; default-on with
   a flag to opt out is unnecessary complexity.

6. **Track the SIGINT in a metric / log message.**
   Implicit assumption — "operator hit Ctrl-C" doesn't
   need its own log line. The clean exit code (0 vs 130)
   is the signal.

7. **Return a special exit code (e.g., 4) for
   "SIGINT-during-watch."** Conflates the why with the
   what. Operators care about whether trips fired, not
   how the loop exited.

8. **Move SIGINT handling into the watch loop itself.**
   Couples loop to signal events; harder to test.
   Bridge-style separation (loop accepts abortSignal,
   action installs handler) is cleaner.

9. **Use Node's experimental `process.exitCode = 0` pattern
   in the handler.** Doesn't actually run the cleanup;
   only sets the exit code. The clean-exit path needs
   the loop to return AND finally to run.

## Drawbacks

1. **One process.on handler per `--watch` invocation.**
   If operators run nested `crossengin retention
   housekeeping --watch` from inside another watch loop
   (unusual), handlers stack. Cleanup removes them in
   LIFO order via `process.removeListener`. No leak.

2. **Multiple Ctrl-C presses still terminate hard.**
   After the first Ctrl-C, the handler aborts the
   controller. If the operator hits Ctrl-C again before
   the loop exits, Node's default SIGINT behavior takes
   over (exit 130). For long-running cleanup, this
   could matter. Acceptable for v1 — operators
   sub-second-spamming Ctrl-C are saying "I'm done
   waiting."

3. **SIGTERM not bridged.** Kubernetes/systemd send
   SIGTERM for graceful shutdown. Watch dashboards
   running as managed services lose the same clean-
   shutdown benefit. Future Q.

4. **No "graceful timeout."** If PG close hangs (rare
   but possible), the cleanup doesn't time out — the
   process eventually hangs until OS-level kill.
   Acceptable for v1; future Q to add a hard-cutoff
   timer.

5. **Test-injection requires a non-trivial stub.** Tests
   that want to verify SIGINT behavior need to set up
   the capturing registrar pattern. Documented + reused
   across both housekeeping test files; not a real
   ergonomic burden.

6. **Production callers can't pass a custom
   AbortSignal AND get the SIGINT bridge.** If the
   override is set, the bridge skips. Future Q to
   compose via `AbortSignal.any()` for callers wanting
   "either operator-driven OR Ctrl-C cancels."

## Future Qs

1. **SIGTERM bridge for managed-service shutdown.**
   Add a second `installSigintBridge`-like helper or
   widen the existing one to accept an array of
   signals. Pairs with deployment integration.

2. **Compose external abortSignal with SIGINT bridge
   via `AbortSignal.any()`.** Callers wanting "Ctrl-C OR
   timeout cancels" can supply a timeout signal AND get
   the SIGINT bridge automatically.

3. **Hard timeout on cleanup phase.** If PG `close()`
   hangs after SIGINT, abort the process after N
   seconds with a clear message. Defaults somewhere
   between 3-10s.

4. **Confirmation prompt before second SIGINT terminates
   hard.** "Are you sure? Press Ctrl-C again to force
   exit." Overkill for v1; operators expect Ctrl-C-Ctrl-C
   = "really exit."

5. **Document the clean-shutdown sequence in operator
   guides.** Single ADR-0267-style operator guide explains
   what happens when each signal is received, especially
   for incident-room operators training new SREs.

6. **Bridge for `gateway start` too.** The gateway HTTP
   server (`crossengin gateway start`) has similar
   SIGINT needs but already uses `waitForShutdown`
   pattern. Possible future unification.

7. **Telemetry hook for SIGINT events.** Increment a
   metric / emit a structured log line when SIGINT
   fires. Operator-observability concern; defer until
   a metrics framework lands in the CLI.

## Operator workflow examples

### Clean exit during incident monitoring

```bash
crossengin retention housekeeping --watch
# Operator monitors for an hour...
# Operator: ^C
# Process: closes PG, removes SIGINT handler, exits 0.
echo $?  # 0
```

Before this ADR: exit 130 with PG dropped abruptly.

### Composition with --watch-keep-going

```bash
crossengin retention housekeeping --watch --watch-keep-going \
  --threshold-alert wouldPruneCount:>1M
# Operator monitors. At minute 5, alert trips (rendered).
# Operator at minute 10: ^C
# Process: PG closes cleanly, exits 3 (sticky trip).
echo $?  # 3
```

The SIGINT bridge composes naturally with sticky trip
tracking — the operator sees the gate fired AND the
graceful exit.

### Pipeline integration

```bash
timeout 600 crossengin retention housekeeping --watch \
  --threshold-alert oldestAt:>30d
# Timeout fires after 10 min — sends SIGTERM (not SIGINT).
# Bridge does NOT intercept SIGTERM (future Q).
# Process exits via Node default (143 for SIGTERM).
```

SIGTERM bridging is the next milestone for managed-service
operators.

## Testing

7 new tests across two files:

- **retention-housekeeping.test.ts** (4 tests): installs
  bridge when no override, firing captured handler aborts
  cleanly (exit 0), does NOT install when override is
  supplied, cleanup runs even when loop throws.

- **gateway.test.ts** (3 tests): same shape adapted to
  gateway's idempotency-store-included fixtures.

Workspace test count 9,604 → 9,611 (+7). Coverage on
`housekeeping-watch.ts` jumped 91.74% → 97.54%
statements (the SIGINT bridge code path is now
exercised).
