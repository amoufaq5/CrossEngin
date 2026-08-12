import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  PostgresUsageRecordStore,
  UsageStripeSync,
  staticSubscriptionItemResolver,
  type UsageReporter,
} from "@crossengin/billing-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

/**
 * Config for the periodic Stripe usage sync: which tenants to sync and the map
 * from a usage record's `"<subscriptionId>|<meter>"` to the Stripe subscription
 * item to report it against.
 */
export const StripeUsageSyncConfigSchema = z
  .object({
    intervalMs: z.number().int().positive().default(3_600_000),
    tenants: z.array(z.string().uuid()).min(1),
    subscriptionItems: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
export type StripeUsageSyncConfig = z.infer<typeof StripeUsageSyncConfigSchema>;

export function parseStripeUsageSyncConfig(json: unknown): StripeUsageSyncConfig {
  return StripeUsageSyncConfigSchema.parse(json);
}

export async function loadStripeUsageSyncConfig(path: string): Promise<StripeUsageSyncConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--stripe-usage-sync-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--stripe-usage-sync-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseStripeUsageSyncConfig(parsed);
}

export interface TenantSyncOutcome {
  readonly tenant: string;
  readonly synced: number;
  readonly skipped: number;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface StripeUsageSyncSchedulerOptions {
  readonly sync: UsageStripeSync;
  readonly tenants: readonly string[];
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onSync?: (outcome: TenantSyncOutcome) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically reports each configured tenant's un-synced usage to Stripe
 * (`PruneScheduler` shape: `unref`'d timer). A tenant whose sync throws is routed
 * to `onError` and does not abort the other tenants.
 */
export class StripeUsageSyncScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: StripeUsageSyncSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => void this.syncOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async syncOnce(): Promise<readonly TenantSyncOutcome[]> {
    const outcomes: TenantSyncOutcome[] = [];
    for (const tenant of this.opts.tenants) {
      try {
        const result = await this.opts.sync.syncTenant(tenant);
        const outcome: TenantSyncOutcome = { tenant, synced: result.synced, skipped: result.skipped };
        outcomes.push(outcome);
        this.opts.onSync?.(outcome);
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
    return outcomes;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface StripeUsageSync {
  readonly sync: UsageStripeSync;
  readonly scheduler: StripeUsageSyncScheduler;
}

export function buildStripeUsageSync(
  conn: PgConnection,
  reporter: UsageReporter,
  config: StripeUsageSyncConfig,
  opts: {
    readonly scheduler?: IntervalScheduler;
    readonly now?: () => Date;
    readonly onSync?: (outcome: TenantSyncOutcome) => void;
    readonly onError?: (err: unknown) => void;
  } = {},
): StripeUsageSync {
  const sync = new UsageStripeSync({
    store: new PostgresUsageRecordStore(conn),
    reporter,
    resolver: staticSubscriptionItemResolver(config.subscriptionItems),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const scheduler = new StripeUsageSyncScheduler({
    sync,
    tenants: config.tenants,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onSync !== undefined ? { onSync: opts.onSync } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });
  return { sync, scheduler };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
