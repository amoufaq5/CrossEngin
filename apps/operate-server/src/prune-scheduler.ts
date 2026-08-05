import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import type { TenantSource } from "./scheduler.js";
import {
  sweepDanglingLinksForTenants,
  type DanglingLinkPruner,
  type MultiTenantSweepReport,
  type RelationPair,
} from "./link-sweep.js";

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

export interface PruneSchedulerOptions {
  readonly pruner: DanglingLinkPruner;
  /** The manifest's `many_to_many` relation pairs to sweep (via `relationPairsFromManifest`). */
  readonly pairs: readonly RelationPair[];
  readonly tenantSource: TenantSource;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onSwept?: (report: MultiTenantSweepReport) => void;
}

/**
 * Periodically sweeps every active tenant's dangling `many_to_many` association
 * links from the JSONB store, alongside the cron `JobScheduler`. Each tick
 * re-enumerates the active tenants and prunes each relation's orphaned links;
 * the timer is `unref`'d so it never holds the process open, and a failed sweep
 * is routed to `onError` rather than thrown out of the timer. Mirrors
 * `JobScheduler`.
 */
export class PruneScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: PruneSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.sweepOnce();
    this.handle = this.scheduler().setInterval(() => void this.sweepOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  private async sweepOnce(): Promise<void> {
    try {
      const tenantIds = await this.opts.tenantSource.activeTenantIds();
      const report = await sweepDanglingLinksForTenants(this.opts.pruner, this.opts.pairs, tenantIds, {});
      this.opts.onSwept?.(report);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
