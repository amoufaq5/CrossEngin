/**
 * What the serving process does on a signal, a stray rejection and an uncaught exception.
 *
 * Before this the binary installed SIGINT/SIGTERM handlers only, so Node's defaults decided the
 * other two — and on v22 an unhandled rejection is fatal (`--unhandled-rejections=throw`, measured:
 * one `Promise.reject` anywhere ends the process with exit 1). A fire-and-forget callback in any
 * scheduler therefore took the whole server down mid-request with no drain and no pool close. And a
 * shutdown whose own close rejected was itself an unhandled rejection.
 *
 * The two faults are answered differently on purpose. A rejection nobody caught is a missing
 * `catch`, not a corrupted stack: the request or job it belonged to has already failed, and every
 * other one is unaffected — so it is logged with its stack, counted, and the process keeps serving.
 * An uncaught exception is thrown through a frame that did not expect it, so the process's state is
 * no longer something to keep serving from; it is logged and the process shuts down gracefully —
 * drained, with the pool closed — and exits 1.
 */

export interface ProcessLike {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (err: Error) => void): unknown;
  exit(code: number): void;
}

export interface ProcessLifecycleOptions {
  /** Drains and closes the server. Called at most once. */
  readonly close: () => Promise<void>;
  readonly log: (line: string) => void;
  /**
   * The longest a shutdown may take before the process exits regardless. A drain that hangs must not
   * keep a process the orchestrator has asked to stop; past this, what is still running is lost,
   * which the orchestrator's own kill would have done anyway, but the exit is ours and logged.
   */
  readonly deadlineMs: number;
  readonly setTimer?: (fn: () => void, ms: number) => void;
}

export interface ProcessLifecycle {
  /** Unhandled rejections logged so far; the process kept serving through each. */
  unhandledRejections(): number;
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return String(reason);
}

export function installProcessLifecycle(proc: ProcessLike, opts: ProcessLifecycleOptions): ProcessLifecycle {
  let rejections = 0;
  let closing: Promise<void> | null = null;
  const shutdown = (code: number): void => {
    // A second signal, or a fault during the shutdown, joins the one already running rather than
    // closing a server that is half closed.
    if (closing !== null) return;
    const setTimer =
      opts.setTimer ??
      ((fn: () => void, ms: number): void => {
        setTimeout(fn, ms).unref();
      });
    setTimer(() => {
      opts.log(`[process] shutdown exceeded ${String(opts.deadlineMs)} ms; exiting with work still running`);
      proc.exit(code === 0 ? 1 : code);
    }, opts.deadlineMs);
    closing = opts.close().then(
      () => proc.exit(code),
      (err: unknown) => {
        opts.log(`[process] shutdown did not complete cleanly: ${describe(err)}`);
        proc.exit(code === 0 ? 1 : code);
      },
    );
  };
  proc.on("SIGINT", () => shutdown(0));
  proc.on("SIGTERM", () => shutdown(0));
  proc.on("unhandledRejection", (reason) => {
    rejections += 1;
    opts.log(`[process] unhandled rejection #${String(rejections)} (serving continues): ${describe(reason)}`);
  });
  proc.on("uncaughtException", (err) => {
    opts.log(`[process] uncaught exception, shutting down: ${describe(err)}`);
    shutdown(1);
  });
  return { unhandledRejections: () => rejections };
}
