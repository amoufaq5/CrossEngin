export interface AbortWhileOptions {
  /** Probed every `intervalMs`; `true` aborts the signal handed to the task. */
  readonly shouldAbort: () => Promise<boolean>;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Passed to `AbortController.abort`, so the task sees it as `signal.reason`. */
  readonly reason?: unknown;
  /** Called once, when the probe first says to abort. */
  readonly onAbort?: () => void;
}

/**
 * Runs `task` with an `AbortSignal` that trips when `shouldAbort` first returns `true` — the
 * cooperative half of cancellation. It gives the task a *channel*, not a kill: `task` is still
 * awaited, and a task that ignores the signal runs to completion. The watcher stops the moment the
 * task settles (a `done` flag checked before every probe) and `abortWhile` awaits it, so no probe
 * outlives the work. Mirrors `renewWhile`'s shape.
 *
 * A probe that *throws* does not abort. Mid-flight the handler is already part-done, and a database
 * blip is not a cancellation — discarding real work on an unanswered question is the expensive
 * mistake here, and the next probe retries. This is the opposite choice from the pre-flight check in
 * `processJobBatch`, where nothing has been done yet and deferring the item costs nothing.
 */
export async function abortWhile<T>(
  task: (signal: AbortSignal) => Promise<T>,
  opts: AbortWhileOptions,
): Promise<T> {
  const controller = new AbortController();
  let done = false;
  const watcher = (async () => {
    while (!done) {
      await opts.sleep(opts.intervalMs);
      if (done) break;
      let abort = false;
      try {
        abort = await opts.shouldAbort();
      } catch {
        abort = false;
      }
      if (abort) {
        controller.abort(opts.reason);
        opts.onAbort?.();
        break;
      }
    }
  })();
  try {
    return await task(controller.signal);
  } finally {
    done = true;
    await watcher;
  }
}
