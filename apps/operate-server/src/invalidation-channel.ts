import type { PgConnection, PgListener } from "@crossengin/kernel-pg";

/**
 * The Postgres NOTIFY channel a tenant-cache eviction is broadcast on. Every
 * operate-server instance LISTENs on it and evicts the named tenant from its
 * per-tenant gateway cache, so an install/uninstall on one instance is reflected
 * across the fleet — not just on the instance that handled the write (P5.6's
 * in-process invalidation).
 */
export const TENANT_INVALIDATION_CHANNEL = "crossengin_tenant_invalidate";

/**
 * A cross-process tenant-cache invalidation bus: `publish` broadcasts that a
 * tenant's install set changed; `start` subscribes a handler that runs on every
 * broadcast (including this instance's own). Decoupled from the transport so the
 * dispatcher wiring can be unit-tested with a fake.
 */
export interface TenantInvalidationChannel {
  publish(tenantId: string): Promise<void>;
  start(onInvalidate: (tenantId: string) => void): Promise<void>;
  close(): Promise<void>;
}

/** The minimal publish surface — satisfied by `PgConnection` (a pooled query is fine for NOTIFY). */
type InvalidationPublisher = Pick<PgConnection, "query">;

/**
 * Postgres `LISTEN/NOTIFY`-backed channel. `publish` runs `pg_notify(channel,
 * tenantId)` over the ordinary pooled connection; `start` LISTENs on a dedicated
 * `PgListener` connection and routes each payload (a tenant id) to the handler.
 * An empty payload is ignored (defensive).
 */
export class PostgresTenantInvalidationChannel implements TenantInvalidationChannel {
  private readonly publisher: InvalidationPublisher;
  private readonly listener: PgListener;
  private readonly channel: string;

  constructor(publisher: InvalidationPublisher, listener: PgListener, channel: string = TENANT_INVALIDATION_CHANNEL) {
    this.publisher = publisher;
    this.listener = listener;
    this.channel = channel;
  }

  async publish(tenantId: string): Promise<void> {
    await this.publisher.query("SELECT pg_notify($1, $2)", [this.channel, tenantId]);
  }

  async start(onInvalidate: (tenantId: string) => void): Promise<void> {
    await this.listener.listen(this.channel, (payload) => {
      if (payload.length > 0) onInvalidate(payload);
    });
  }

  async close(): Promise<void> {
    await this.listener.close();
  }
}
