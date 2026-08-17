import { STAGE_OUTCOMES } from "@crossengin/api-gateway";
import type { AuditSamplingSettings, SettingsStore } from "@crossengin/operate-runtime";

import type { TenantAuditPolicy } from "./audit-chain.js";
import type { ActiveTenantSource } from "./checkpoint-scheduler.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(STAGE_OUTCOMES);

/**
 * Maps a tenant's stored `auditSampling` settings into a serving-edge `TenantAuditPolicy`. `operate-runtime`
 * keeps `outcomes` as free `string[]` (it doesn't own the gateway's stage-outcome enum), so this layer
 * filters it down to the outcomes the gateway actually recognizes; an outcomes list that maps to nothing is
 * dropped (treated as "no outcome filter") rather than silencing the tenant entirely. `operations` and
 * `sampleRate` pass through. Only fields present in the settings are set, so the observer's per-field merge
 * leaves the config value in place for anything the tenant didn't specify.
 */
export function auditPolicyFromSettings(settings: AuditSamplingSettings): TenantAuditPolicy {
  const policy: {
    outcomes?: (typeof STAGE_OUTCOMES)[number][];
    operations?: string[];
    sampleRate?: number;
  } = {};
  if (settings.outcomes !== undefined) {
    const recognized = settings.outcomes.filter((o): o is (typeof STAGE_OUTCOMES)[number] =>
      KNOWN_OUTCOMES.has(o),
    );
    if (recognized.length > 0) policy.outcomes = recognized;
  }
  if (settings.operations !== undefined) policy.operations = [...settings.operations];
  if (settings.sampleRate !== undefined) policy.sampleRate = settings.sampleRate;
  return policy;
}

export interface TenantAuditPolicyCacheOptions {
  /** Reads a tenant's settings document (per-tenant, RLS-scoped in the Postgres impl). */
  readonly settingsStore: Pick<SettingsStore, "get">;
  /** The active tenants to load policies for, re-queried on every refresh. */
  readonly tenants: ActiveTenantSource;
  /** Routes a per-tenant load failure so one tenant's settings error never aborts the whole refresh. */
  readonly onError?: (err: unknown, tenantId: string) => void;
}

/**
 * An in-memory snapshot of each active tenant's live audit sampling/filter policy, sourced from
 * `meta.operate_tenant_settings`. `refresh()` re-reads every active tenant off the settings store and swaps
 * in a fresh `Map` atomically — the request path only ever reads the previous complete snapshot, never a
 * half-built one. `get()` is synchronous, so the hot request path never awaits the database. A per-tenant
 * read failure is swallowed (routed to `onError`) and simply omits that tenant from the new snapshot, so one
 * tenant's settings error doesn't block the others.
 */
export class TenantAuditPolicyCache {
  private snapshot = new Map<string, TenantAuditPolicy>();

  constructor(private readonly opts: TenantAuditPolicyCacheOptions) {}

  async refresh(): Promise<void> {
    const ids = await this.opts.tenants.activeTenantIds();
    const next = new Map<string, TenantAuditPolicy>();
    for (const tenantId of ids) {
      try {
        const settings = await this.opts.settingsStore.get(tenantId);
        if (settings.auditSampling !== undefined) {
          next.set(tenantId, auditPolicyFromSettings(settings.auditSampling));
        }
      } catch (err) {
        this.opts.onError?.(err, tenantId);
      }
    }
    this.snapshot = next;
  }

  get(tenantId: string): TenantAuditPolicy | undefined {
    return this.snapshot.get(tenantId);
  }

  /** Number of tenants with a live policy in the current snapshot (observability / tests). */
  size(): number {
    return this.snapshot.size;
  }
}

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

export interface TenantAuditPolicyRefresherOptions {
  readonly cache: TenantAuditPolicyCache;
  readonly intervalMs: number;
  /** Refresh once immediately on start (default true). */
  readonly refreshOnStart?: boolean;
  readonly onError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

/**
 * Proactively refreshes a `TenantAuditPolicyCache` on an interval, so a tenant's settings change is picked up
 * within one interval without the request path ever awaiting the database. Mirrors `JwksRefreshPoller`: the
 * timer is `unref`'d so it never holds the process open, `start()` fires an immediate refresh before the
 * interval, and `stop()` clears it. Per-tenant load errors are handled inside `refresh()`; a refresh that
 * throws as a whole (e.g. the tenant source failing) is routed to `onError`.
 */
export class TenantAuditPolicyRefresher {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: TenantAuditPolicyRefresherOptions) {}

  start(): void {
    if (this.handle !== null) return;
    if (this.opts.refreshOnStart !== false) void this.tick();
    this.handle = this.scheduler().setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.opts.cache.refresh();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface TenantAuditPolicyLifecycle {
  readonly cache: TenantAuditPolicyCache;
  readonly refresher: TenantAuditPolicyRefresher;
}

export interface BuildTenantAuditPolicyCacheOptions extends TenantAuditPolicyCacheOptions {
  readonly intervalMs: number;
  readonly refreshOnStart?: boolean;
  readonly refreshOnError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

/**
 * One-call wiring for node.ts: builds the cache + a refresher over it. Call `refresher.start()` to begin the
 * background refresh loop and `refresher.stop()` on shutdown; read the live policy via `cache` (pass it as the
 * observer's `policyCache`).
 */
export function buildTenantAuditPolicyCache(
  opts: BuildTenantAuditPolicyCacheOptions,
): TenantAuditPolicyLifecycle {
  const cache = new TenantAuditPolicyCache({
    settingsStore: opts.settingsStore,
    tenants: opts.tenants,
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });
  const refresher = new TenantAuditPolicyRefresher({
    cache,
    intervalMs: opts.intervalMs,
    ...(opts.refreshOnStart !== undefined ? { refreshOnStart: opts.refreshOnStart } : {}),
    ...(opts.refreshOnError !== undefined ? { onError: opts.refreshOnError } : {}),
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
  });
  return { cache, refresher };
}
