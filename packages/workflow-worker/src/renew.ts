/**
 * Extends a claim's lease while long-running work runs. Backed by the Postgres `renewTimerClaim`.
 * `renew` returns `false` if the lease was lost (stolen after lapse, or the timer already fired) —
 * the heartbeat then stops and reports via `onLeaseLost`.
 */
export interface ClaimRenewer {
  renew(opts: { readonly timerId: string; readonly workerId: string }): Promise<boolean>;
}

export interface RenewWhileOptions {
  readonly renewer: ClaimRenewer;
  readonly timerId: string;
  readonly workerId: string;
  /** How often to renew (ms). */
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Called if a renewal returns false (lease lost) — the caller may cancel the work. */
  readonly onLeaseLost?: () => void;
}

/**
 * Runs `task` while a background heartbeat renews its claim every `intervalMs`, so a slow fire keeps
 * its lease and no other worker steals the timer. The heartbeat stops the moment `task` settles (a
 * `done` flag checked before every renew, so no renewal races past completion), and `renewWhile`
 * awaits it before returning — leaving no dangling timers. A lost lease stops the heartbeat and
 * fires `onLeaseLost`, but does **not** abort `task` (idempotent firing makes a double-fire safe);
 * the caller decides what to do.
 */
export async function renewWhile<T>(task: Promise<T>, opts: RenewWhileOptions): Promise<T> {
  let done = false;
  const heartbeat = (async () => {
    while (!done) {
      await opts.sleep(opts.intervalMs);
      if (done) break;
      let ok = false;
      try {
        ok = await opts.renewer.renew({ timerId: opts.timerId, workerId: opts.workerId });
      } catch {
        ok = false;
      }
      if (!ok) {
        opts.onLeaseLost?.();
        break;
      }
    }
  })();
  try {
    return await task;
  } finally {
    done = true;
    await heartbeat;
  }
}
