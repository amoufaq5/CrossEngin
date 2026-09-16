import { randomUUID } from "node:crypto";
import type { PostgresDesignJobStore } from "./design-jobs.js";
import type { ProgressingDesignerLike } from "./design-runner.js";
import type { PostgresDesignReservations } from "./ai-reservations.js";

/** Database leases, fenced completion, bounded retries, and progress heartbeats survive API restarts. */
export class DesignWorker {
  private stopped = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  constructor(private readonly opts: {
    jobs: PostgresDesignJobStore;
    tenants: { activeTenantIds(): Promise<readonly string[]> };
    designer: ProgressingDesignerLike;
    reservations: PostgresDesignReservations;
    onProposal?: (tenantId: string, id: string) => Promise<unknown>;
    onError: (err: unknown) => void;
  }) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped || this.active) return;
      this.active = this.tick().catch(this.opts.onError).finally(() => { this.active = null; });
    };
    this.timer = setInterval(tick, 2000);
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async tick(): Promise<void> {
    for (const tenant of await this.opts.tenants.activeTenantIds()) {
      if (this.stopped) return;
      const token = randomUUID();
      const job = await this.opts.jobs.claim(tenant, token, 60_000);
      if (!job) continue;
      const leased = this.opts.jobs.forLease(token);
      let leaseLost = false;
      let renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void leased.renew(tenant, job.id, 60_000).then(ok => { if (!ok) leaseLost = true; })
          .catch(err => { leaseLost = true; this.opts.onError(err); }).finally(() => { renewing = false; });
      }, 15_000);
      let progress = Promise.resolve();
      try {
        const result = await this.opts.reservations.run(tenant, () => this.opts.designer({
          name: job.name, description: job.description,
          onProgress: event => {
            progress = progress.then(async () => {
              if (!leaseLost) await leased.updateProgress(tenant, job.id, event);
            }).catch(this.opts.onError);
          },
        }));
        await progress;
        if (leaseLost) throw new Error("AI job lease lost; stale worker may not publish a proposal");
        if (!result.ok || !result.manifest || !result.manifestHash) {
          await leased.fail(tenant, job.id, { error: "design_failed", issues: result.issues });
        } else {
          const proposalId = await leased.completeWithProposal(tenant, job.id, result);
          if (proposalId && this.opts.onProposal) await this.opts.onProposal(tenant, proposalId);
        }
      } catch (err) {
        this.opts.onError(err);
        const retryable = typeof err === "object" && err !== null && "status" in err && err.status === 429;
        if (!leaseLost) {
          if (retryable) await leased.requeue(tenant, job.id);
          else await leased.fail(tenant, job.id, { error: err instanceof Error ? err.message.slice(0, 500) : "design_failed" });
        }
      } finally { clearInterval(heartbeat); }
    }
  }
}
