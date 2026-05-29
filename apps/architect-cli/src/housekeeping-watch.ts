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
  readonly render: (report: R) => void;
  // Whether to emit ANSI clear-screen + cursor-home BEFORE each render.
  // True for human format (live single-screen UX); false for json
  // streaming (line-delimited envelopes piped to log aggregators).
  readonly clearScreenBeforeRender: boolean;
  readonly io: IoStreams;
  readonly options: WatchLoopOptions;
}

export async function runHousekeepingWatchLoop<R>(input: WatchLoopInput<R>): Promise<void> {
  let iteration = 0;
  while (true) {
    iteration++;
    const report = await input.gather();
    if (input.clearScreenBeforeRender) {
      input.io.stdout.write(ANSI_CLEAR_SCREEN);
    }
    input.render(report);
    if (input.options.maxIterations !== undefined && iteration >= input.options.maxIterations) {
      return;
    }
    if (input.options.abortSignal?.aborted) return;
    await waitInterval(input.options);
    if (input.options.abortSignal?.aborted) return;
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
}

export interface ParsedWatchFlags {
  readonly watch: boolean;
  readonly intervalSeconds: number;
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
  if (!watch && intervalFlag !== null) {
    printError(io, `${actionLabel}: --watch-interval requires --watch`);
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
  return { watch, intervalSeconds };
}

function isWatchCompatibleFormat(format: OutputFormat): format is "human" | "json" {
  return format === "human" || format === "json";
}
