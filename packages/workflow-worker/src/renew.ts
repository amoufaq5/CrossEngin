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
        ok = await opts.renewer.renew({
          timerId: opts.timerId,
          workerId: opts.workerId,
          tenantId: opts.tenantId,
        });
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
