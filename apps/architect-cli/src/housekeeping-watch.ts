import type { ParsedCommand, OutputFormat } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import type { IoStreams } from "./format.js";
import { printError } from "./format.js";

// M4.14.w — shared `--watch` mode infrastructure for housekeeping dashboards
// (retention housekeeping + gateway housekeeping).
//
// SREs watching tables during incidents want a live single-screen view
// without invoking `watch -n N` from the shell (which re-runs the binary
// + reconnects to PG each tick — wasteful + flickery). `--watch` loops in
// the same process: open the PG connection once, render N times.
//
// The loop is generic over the report type so both housekeeping actions
// share the same termination + interval + ANSI-clear logic.

const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H";
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 5;

export interface WatchLoopOptions {
  // Interval between renders, in milliseconds.
  readonly intervalMs: number;
  // For tests: cap at N iterations and return cleanly. Undefined = loop
  // until abort (production behavior).
  readonly maxIterations?: number;
  // For tests OR production SIGINT: abort the wait between iterations.
  readonly abortSignal?: AbortSignal;
  // For tests: inject setTimeout so timer-based loops can be driven
  // synchronously. Defaults to global setTimeout.
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  // For tests: inject clearTimeout so abort path cancels cleanly.
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export interface WatchLoopInput<R> {
  readonly gather: () => Promise<R>;
  // Caller-supplied per-tick render. For human format, the caller renders
  // text; for json streaming, the caller writes compact NDJSON-of-envelope.
  // The loop handles screen-clearing separately via clearScreenBeforeRender.
  // Return "halt" to break the loop after this tick (used by threshold-alert
  // CI-gate semantics — first tick that trips an alert exits the loop).
  // Under keepGoing=true the "halt" return is RECORDED into the result's
  // `halted` field (sticky) but does NOT exit the loop.
  readonly render: (report: R) => "halt" | void;
  // Whether to emit ANSI clear-screen + cursor-home BEFORE each render.
  // True for human format (live single-screen UX); false for json
  // streaming (line-delimited envelopes piped to log aggregators).
  readonly clearScreenBeforeRender: boolean;
  readonly io: IoStreams;
  readonly options: WatchLoopOptions;
  // M4.14.s — keep-going mode. When true:
  //   - render's "halt" return is RECORDED into result.halted but does NOT
  //     exit the loop (sticky tracking across all ticks).
  //   - gather() errors are caught and passed to errorRender + loop continues.
  // When false (default): errors propagate, "halt" exits the loop immediately.
  readonly keepGoing?: boolean;
  // Required when keepGoing=true and gather() may throw — caller renders the
  // error in place of the report (e.g., "(error: ...)" line or JSON envelope
  // with error field). When keepGoing=false, errors propagate so this is
  // ignored.
  readonly errorRender?: (err: Error) => void;
}

// Result of a watch loop run. `halted` indicates the render callback returned
// "halt" AT LEAST ONCE during this run. Under default mode that means the
// loop exited early; under keepGoing=true it means at least one tick tripped
// (sticky). Callers map halted=true to an appropriate exit code (typically
// 3 for CI gates per ADR-0181).
export interface WatchLoopResult {
  readonly halted: boolean;
}

export async function runHousekeepingWatchLoop<R>(
  input: WatchLoopInput<R>,
): Promise<WatchLoopResult> {
  let iteration = 0;
  let everHalted = false;
  while (true) {
    iteration++;
    let report: R | undefined;
    let gatherError: Error | undefined;
    try {
      report = await input.gather();
    } catch (err) {
      if (!input.keepGoing) throw err;
      gatherError = err instanceof Error ? err : new Error(String(err));
    }
    if (input.clearScreenBeforeRender) {
      input.io.stdout.write(ANSI_CLEAR_SCREEN);
    }
    if (gatherError !== undefined) {
      // keep-going + error: defer to caller's errorRender. If they didn't
      // supply one, swallow silently (still record nothing — only "halt"
      // marks halted).
      input.errorRender?.(gatherError);
    } else {
      // Non-null assertion safe — gather() succeeded so report is defined.
      const haltSignal = input.render(report as R);
      if (haltSignal === "halt") {
        everHalted = true;
        if (!input.keepGoing) return { halted: true };
      }
    }
    if (input.options.maxIterations !== undefined && iteration >= input.options.maxIterations) {
      return { halted: everHalted };
    }
    if (input.options.abortSignal?.aborted) return { halted: everHalted };
    await waitInterval(input.options);
    if (input.options.abortSignal?.aborted) return { halted: everHalted };
  }
}

function waitInterval(options: WatchLoopOptions): Promise<void> {
  const setTimeoutFn =
    options.setTimeoutFn ?? (setTimeout as (cb: () => void, ms: number) => unknown);
  const clearTimeoutFn = options.clearTimeoutFn ?? (clearTimeout as (handle: unknown) => void);
  return new Promise<void>((resolve) => {
    const handle = setTimeoutFn(() => resolve(), options.intervalMs);
    if (options.abortSignal !== undefined) {
      if (options.abortSignal.aborted) {
        clearTimeoutFn(handle);
        resolve();
        return;
      }
      options.abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeoutFn(handle);
          resolve();
        },
        { once: true },
      );
    }
  });
}

// Test-injection hooks bundled in a single optional field so consumers can
// pass-through without per-field plumbing. Production callers leave this
// undefined.
export interface WatchOverride {
  readonly maxIterations?: number;
  readonly abortSignal?: AbortSignal;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  // M4.14.r — test-injection for the SIGINT-to-AbortController bridge.
  // Production uses real process.on/off; tests pass a recording stub that
  // captures the handler for synchronous invocation.
  readonly signalRegistrar?: SignalRegistrar;
}

// Function that registers a signal handler and returns a removal closure.
// Default production implementation uses Node's process events. Tests
// supply a stub that captures the handler so tests can simulate SIGINT
// without poisoning the test runner's own signal handlers.
export type SignalRegistrar = (signal: string, handler: () => void) => () => void;

// M4.14.r — SIGINT-to-AbortController bridge. Production: installs a
// SIGINT handler that aborts an internal AbortController, returns the
// signal + cleanup closure. The watch loop exits cleanly (via the
// existing abortSignal path) when the operator hits Ctrl-C; the
// caller's finally block runs (closes PG, etc.) before process exit.
// Without this bridge, SIGINT exits the process at 130 with PG
// connection dropped abruptly — PG handles it but the operator gets no
// graceful shutdown signal.
//
// Tests pass a custom `register` that records the handler for manual
// invocation; production omits it and gets `process.on("SIGINT", ...)`.
export function installSigintBridge(register?: SignalRegistrar): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const handler = (): void => controller.abort();
  const defaultRegister: SignalRegistrar = (sig, h) => {
    process.on(sig, h);
    return () => {
      process.removeListener(sig, h);
    };
  };
  const removeHandler = (register ?? defaultRegister)("SIGINT", handler);
  return { signal: controller.signal, cleanup: removeHandler };
}

export interface ParsedWatchFlags {
  readonly watch: boolean;
  readonly intervalSeconds: number;
  // M4.14.s — resilient watch mode. When true, errors are caught + rendered
  // (the loop keeps running) and threshold-alert trips don't halt early
  // (they're recorded as "ever tripped" but the loop continues until
  // maxIterations / abortSignal / SIGINT). Useful for long-running incident
  // monitoring where transient PG blips shouldn't kill the dashboard.
  readonly keepGoing: boolean;
}

// Returns the parsed flag values OR an exit code (2) on validation failure.
// The error message is already printed to ctx.io.stderr; callers just
// propagate the exit code.
export function parseWatchFlags(
  command: ParsedCommand,
  io: IoStreams,
  actionLabel: string,
): ParsedWatchFlags | number {
  const watch = getBooleanFlag(command, "watch");
  const intervalFlag = getStringFlag(command, "watch-interval");
  const keepGoing = getBooleanFlag(command, "watch-keep-going");
  if (!watch && intervalFlag !== null) {
    printError(io, `${actionLabel}: --watch-interval requires --watch`);
    return 2;
  }
  if (!watch && keepGoing) {
    printError(io, `${actionLabel}: --watch-keep-going requires --watch`);
    return 2;
  }
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  if (intervalFlag !== null) {
    const trimmed = intervalFlag.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_INTERVAL_SECONDS ||
      parsed > MAX_INTERVAL_SECONDS ||
      String(parsed) !== trimmed
    ) {
      printError(
        io,
        `${actionLabel}: invalid --watch-interval '${intervalFlag}' (must be integer in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}] seconds)`,
      );
      return 2;
    }
    intervalSeconds = parsed;
  }
  if (watch && !isWatchCompatibleFormat(command.format)) {
    printError(
      io,
      `${actionLabel}: --watch requires --format human or json (got --format ${command.format}). csv/tsv/ndjson/yaml are batch formats; under --watch, json streams NDJSON-of-envelopes (one line per tick).`,
    );
    return 2;
  }
  return { watch, intervalSeconds, keepGoing };
}

function isWatchCompatibleFormat(format: OutputFormat): format is "human" | "json" {
  return format === "human" || format === "json";
}
