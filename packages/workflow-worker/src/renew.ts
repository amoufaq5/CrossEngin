/**
 * Extends a claim's lease while long-running work runs. Backed by the Postgres `renewTimerClaim`.
 * `renew` returns `false` if the lease was lost (stolen after lapse, or the timer already fired) —
 * the heartbeat then stops and reports via `onLeaseLost`.
 *
 * `tenantId` is **required** on all three paths (timer, activity, job) because the claimed row is
 * tenant-scoped and the queue tables carry one tenant-isolation policy: a renew that cannot name the
 * row's tenant matches 0 rows for a session that policy confines, and answers *lease lost* for a
 * lease it still holds. Every claimed item already carries the tenant, so the fact is never absent.
 */
export interface ClaimRenewer {
  renew(opts: {
    readonly timerId: string;
    readonly workerId: string;
    readonly tenantId: string;
  }): Promise<boolean>;
}

/**
 * Extends one claim immediately before its item starts, and answers whether this worker still holds
 * it.
 *
 * A batch claims every item for `leaseMs` at once, while `renewWhile` heartbeats only the item that
 * is executing — so the items queued behind a slow one age out of their lease before they are
 * reached, another worker claims them, and the first one then runs them anyway. Renewing at the start
 * of each item closes that: if the claim was taken in the meantime the renew matches no row (it is
 * fenced on `claimed_by`) and the item is skipped as `lease_lost`; if it lapsed and nobody took it,
 * the renew re-extends it and the item runs under a lease it holds. A renew that throws is a lost
 * lease, not a held one — the item is not started on a fact nobody established.
 */
export async function reaffirmClaim(
  renewer: ClaimRenewer,
  claim: { readonly id: string; readonly workerId: string; readonly tenantId: string },
): Promise<boolean> {
  try {
    return await renewer.renew({ timerId: claim.id, workerId: claim.workerId, tenantId: claim.tenantId });
  } catch {
    return false;
  }
}

export interface RenewWhileOptions {
  readonly renewer: ClaimRenewer;
  readonly timerId: string;
  readonly workerId: string;
  /** The claimed row's tenant, which the renew needs to find the row under row-level security. */
  readonly tenantId: string;
  /** How often to renew (ms). */
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Called if a renewal returns false (lease lost) — the caller may cancel the work. */
  readonly onLeaseLost?: () => void;
}

/**
 * The `AbortSignal.reason` a task sees when its lease was lost mid-flight — distinct from a
 * cancellation, so a handler (or a log line) can tell "somebody stopped this run" from "another
 * worker owns this run now".
 */
export class LeaseLostError extends Error {
  constructor(readonly claimId: string) {
    super(`lease on ${claimId} lost mid-flight; another worker may own it now`);
    this.name = "LeaseLostError";
  }
}

/**
 * Runs `task` while a background heartbeat renews its claim every `intervalMs`, so a slow fire keeps
 * its lease and no other worker steals the timer. The heartbeat stops the moment `task` settles (a
 * `done` flag checked before every renew, so no renewal races past completion), and `renewWhile`
 * awaits it before returning — leaving no dangling timers. A lost lease stops the heartbeat and
 * fires `onLeaseLost`.
 *
 * Two task shapes, and what a lost lease does differs between them on purpose (ADR-0469):
 *
 * - **A promise** (the timer and activity paths): the work is already running and cannot be told
 *   anything, so a lost lease aborts nothing — firing a timer or an activity is idempotent, which is
 *   what makes a double-fire safe there.
 * - **A function of an `AbortSignal`** (the job path): the signal is aborted with a `LeaseLostError`
 *   the moment a renew answers `false`. A job handler's business writes are *not* idempotent the way
 *   a timer fire is — a run whose lease lapsed is re-claimed and re-executed by another worker, and a
 *   handler that ran on would make the same writes twice. Aborting is the channel that tells it to
 *   stop; the engine's finalize is fenced on `claimed_by`, so an aborted run another worker now owns
 *   is not finalized by this one.
 *
 * Only a definite `false` aborts. A renew that **throws** stops the heartbeat and reports as before
 * but does not abort, because the lease may well still be held — and an aborted handler under a lease
 * this worker still holds is finalized `cancelled`, a terminal answer for a database blip.
 */
export async function renewWhile<T>(
  task: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  opts: RenewWhileOptions,
): Promise<T> {
  const controller = typeof task === "function" ? new AbortController() : null;
  const running = typeof task === "function" ? task((controller as AbortController).signal) : task;
  let done = false;
  const heartbeat = (async () => {
    while (!done) {
      await opts.sleep(opts.intervalMs);
      if (done) break;
      let ok = false;
      let threw = false;
      try {
        ok = await opts.renewer.renew({
          timerId: opts.timerId,
          workerId: opts.workerId,
          tenantId: opts.tenantId,
        });
      } catch {
        ok = false;
        threw = true;
      }
      if (!ok) {
        if (!threw && controller !== null) controller.abort(new LeaseLostError(opts.timerId));
        opts.onLeaseLost?.();
        break;
      }
    }
  })();
  try {
    return await running;
  } finally {
    done = true;
    await heartbeat;
  }
}
