import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const MIN_INTERVAL_MS = 1_000;

export interface ActivationWatermarkSource {
  /** Latest activation instant per tenant that currently has an active manifest. */
  activationWatermarks(): Promise<ReadonlyMap<string, string>>;
}

export interface PostgresActivationWatermarkSourceOptions {
  readonly schema?: string;
}

function isoOf(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * The activation watermark of every tenant with an active manifest, in ONE
 * cross-tenant aggregate — cost is one query per interval regardless of tenant
 * count. `meta.operate_tenant_manifests` carries tenant RLS, but this is a
 * platform-level sweep (like `PostgresTenantSource`), so it deliberately runs
 * OUTSIDE `withTenantContext`: binding one tenant would hide every other
 * tenant's activation from the poller.
 */
export class PostgresActivationWatermarkSource implements ActivationWatermarkSource {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: PostgresActivationWatermarkSourceOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.operate_tenant_manifests`;
  }

  async activationWatermarks(): Promise<ReadonlyMap<string, string>> {
    const result = await this.conn.query<{ tenant_id: unknown; watermark: unknown }>(
      `SELECT tenant_id, MAX(activated_at) AS watermark FROM ${this.table}` +
        ` WHERE status = 'active' AND activated_at IS NOT NULL GROUP BY tenant_id`,
    );
    const out = new Map<string, string>();
    for (const row of result.rows) {
      if (row.tenant_id == null || row.watermark == null) continue;
      const tenantId = String(row.tenant_id);
      const watermark = isoOf(row.watermark);
      if (tenantId.length === 0 || watermark === null) continue;
      out.set(tenantId, watermark);
    }
    return out;
  }
}

export interface ManifestActivationPollerOptions {
  readonly source: ActivationWatermarkSource;
  readonly cache: { invalidate(tenantId: string): void };
  readonly intervalMs: number;
  readonly onInvalidated?: (tenantId: string, watermark: string) => void;
  readonly onError?: (err: unknown) => void;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer?: (handle: unknown) => void;
}

function defaultSetTimer(fn: () => void, ms: number): { unref?: () => void } {
  return setInterval(fn, ms) as unknown as { unref?: () => void };
}

function defaultClearTimer(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

/**
 * Propagates manifest activations across replicas. A tenant activating a new
 * manifest on replica A leaves replicas B/C serving the old compiled gateway
 * until their TTL expires; this poller reads the activation watermarks for all
 * tenants on an interval and invalidates the local per-tenant cache entry for
 * every tenant whose watermark moved — or whose active manifest disappeared
 * (archived), which would otherwise keep an archived manifest in service.
 * Mirrors `JwksRefreshPoller`: injectable timer, `unref`'d so it never holds the
 * process open, idempotent start/stop, errors routed to `onError`.
 */
export class ManifestActivationPoller {
  private readonly opts: ManifestActivationPollerOptions;
  private readonly seen = new Map<string, string>();
  private handle: { unref?: () => void } | null = null;
  private primed = false;

  constructor(opts: ManifestActivationPollerOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`intervalMs must be at least ${MIN_INTERVAL_MS.toString()}ms`);
    }
    this.opts = opts;
  }

  start(): void {
    if (this.handle !== null) return;
    void this.poll();
    const set = this.opts.setTimer ?? defaultSetTimer;
    this.handle = set(() => void this.poll(), this.opts.intervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear = this.opts.clearTimer ?? defaultClearTimer;
    clear(this.handle);
    this.handle = null;
  }

  async poll(): Promise<void> {
    let current: ReadonlyMap<string, string>;
    try {
      current = await this.opts.source.activationWatermarks();
    } catch (err) {
      // Leave the baseline untouched, so the next successful poll still sees the change.
      this.opts.onError?.(err);
      return;
    }
    try {
      this.apply(current);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private apply(current: ReadonlyMap<string, string>): void {
    // The very first poll records the baseline silently: this replica's cache is
    // cold, so there is nothing stale to drop and every tenant would look "new".
    const baseline = !this.primed;
    this.primed = true;

    for (const [tenantId, watermark] of current) {
      const previous = this.seen.get(tenantId);
      this.seen.set(tenantId, watermark);
      if (baseline || previous === watermark) continue;
      this.invalidate(tenantId, watermark);
    }

    for (const [tenantId, watermark] of [...this.seen]) {
      if (current.has(tenantId)) continue;
      this.seen.delete(tenantId);
      if (baseline) continue;
      this.invalidate(tenantId, watermark);
    }
  }

  private invalidate(tenantId: string, watermark: string): void {
    this.opts.cache.invalidate(tenantId);
    this.opts.onInvalidated?.(tenantId, watermark);
  }
}
