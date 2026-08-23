import { drainTenants, type DeliveryDrainOptions, type MultiTenantDrainReport } from "./delivery-drain.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import type { TenantSource } from "./scheduler.js";

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

export interface DeliverySchedulerOptions {
  readonly drain: DeliveryDrainOptions;
  readonly tenantSource: TenantSource;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onDrained?: (report: MultiTenantDrainReport) => void;
}

/**
 * Periodically drains every active tenant's queued notification dispatches, alongside the cron
 * `JobScheduler` and the `PruneScheduler`. Each tick re-enumerates the active tenants, so a
 * newly-provisioned tenant is picked up on the next pass; the timer is `unref`'d so it never
 * holds the process open, and a failed sweep is routed to `onError` rather than thrown out of
 * the timer.
 */
export class DeliveryScheduler {
  private handle: IntervalHandle | null = null;
  private running = false;

  constructor(private readonly opts: DeliverySchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.drainOnce();
    this.handle = this.scheduler().setInterval(() => void this.drainOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async drainOnce(): Promise<MultiTenantDrainReport | null> {
    // A slow sweep must not overlap itself: two concurrent drains would race the same claim.
    if (this.running) return null;
    this.running = true;
    try {
      const tenantIds = await this.opts.tenantSource.activeTenantIds();
      const report = await drainTenants(this.opts.drain, tenantIds);
      this.opts.onDrained?.(report);
      return report;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    } finally {
      this.running = false;
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
