import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * The actors an unattended deletion runs as. Exported because `cli.ts` checks four-eyes against the
 * *resolved* pair — `--deletion-runner-executed-by system:retention-policy` alone would otherwise pass
 * the flag check and then throw at the runner's construction, i.e. at boot.
 */
export const DEFAULT_DELETION_EXECUTED_BY = "system:deletion-runner";
export const DEFAULT_DELETION_APPROVED_BY = "system:retention-policy";

/** Structural mirror of `DeletionRunner`'s one method, so this file imports no `tenant-lifecycle-pg`. */
export interface DeletionRunnerLike {
  runDue(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly outcome: string;
      readonly tombstoneId: string | null;
      readonly detail: string | null;
    }[]
  >;
}

/**
 * Structural mirror of `DeletionReconciler.reconcileStranded` (ADR-0322). Optional: a deployment with
 * no forensic chain has no tombstone store, so there is no evidence to reconcile from.
 */
export interface StrandedReconcilerLike {
  reconcileStranded(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly applied: boolean;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
    }[]
  >;
}

export interface DeletionSchedulerOptions {
  readonly runner: DeletionRunnerLike;
  /**
   * Repairs requests a previous run stranded, in the same tick. One interval and one log line for
   * one queue: a stranded request is the residue of the work this scheduler does, so a separate
   * cadence for it would be two knobs describing one thing.
   */
  readonly reconciler?: StrandedReconcilerLike;
  readonly intervalMs: number;
  /** Requests per tick. Each one is a whole tenant's data, so the default is deliberately small. */
  readonly batchSize?: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (results: readonly { readonly requestId: string; readonly outcome: string }[]) => void;
  readonly onReconciled?: (
    results: readonly { readonly requestId: string; readonly verdict: string }[],
  ) => void;
  /**
   * Given **every** result the pass produced, not just the applied ones, and awaited (ADR-0324).
   *
   * Escalation needs the verdicts that were *not* applied — `evidence_unverified` is the whole point
   * — so it cannot share `onReconciled`, whose rule is the opposite: log only what was written. It is
   * idempotent per episode by construction, which is what makes handing it the same finding on every
   * tick harmless.
   */
  readonly onEscalate?: (
    results: readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
    }[],
  ) => void | Promise<void>;
}

/**
 * Runs verified GDPR deletion requests out of band, on an interval.
 *
 * Two things it does differently from every sibling scheduler in this app, both deliberate.
 *
 * **It does not sweep on `start()`.** `JobScheduler`, `PruneScheduler` and `DeliveryScheduler` all run
 * once immediately, because a missed prune or a late notification costs nothing. This one waits a full
 * interval: a boot is the moment a misconfiguration is most likely — wrong flags, wrong actor, a
 * manifest that did not load — and the work here irreversibly destroys a tenant's data. An operator who
 * restarts the server to fix something gets an interval's grace, and no deletion is lost by waiting,
 * because the deadline is weeks away.
 *
 * **Two replicas running it is safe, and there is no lock here.** `PostgresDeletionRequestStore.transition`
 * re-asserts `status = 'verified'` inside the `UPDATE`, so of two schedulers claiming the same request
 * exactly one wins and the loser is told `not_claimed`. The row is the lock (ADR-0321).
 */
export class DeletionScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: DeletionSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async runOnce(): Promise<void> {
    try {
      const results = await this.opts.runner.runDue(this.opts.batchSize ?? 5);
      if (results.length > 0) this.opts.onRun?.(results);
    } catch (err) {
      // A failed tick must not throw out of the timer. The next one re-reads what is due, and a
      // request this tick claimed but did not finish stays `in_progress` until it is reconciled.
      this.opts.onError?.(err);
    }
    // Separately, and after: a reconciliation pass must still happen on a tick whose `runDue` threw,
    // because the most likely reason a request is stranded is that a run failed.
    try {
      const assessed = (await this.opts.reconciler?.reconcileStranded(this.opts.batchSize ?? 5)) ?? [];
      // Only what was actually written. A `too_recent` or an operator-owned verdict is a standing
      // fact about a row, so reporting it from here would repeat it every single tick for as long as
      // the row exists — that is what `GET /v1/platform/deletion-requests/stranded` is for.
      const repaired = assessed.filter((r) => r.applied);
      if (repaired.length > 0) this.opts.onReconciled?.(repaired);
      // Separately again, and awaited: a finding that warrants an incident must not be lost because
      // the logging callback threw, and escalation is given every result rather than the written ones.
      if (assessed.length > 0) await this.opts.onEscalate?.(assessed);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
