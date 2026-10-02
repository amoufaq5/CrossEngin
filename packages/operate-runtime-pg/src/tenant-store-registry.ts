import { manifestHash, type Manifest } from "@crossengin/kernel/manifest";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  isAssociationCounter,
  isAssociationReader,
  isAssociationWriter,
  isTransactional,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
  type TransactionalEntityStore,
} from "@crossengin/operate-runtime";

import { ColumnMappedEntityStore } from "./column-store.js";
import { tenantSchemaName, DEFAULT_TENANT_SCHEMA_PREFIX } from "./tenant-schema.js";
import { applyTenantManifestSchema, type TenantSchemaApplication } from "./tenant-schema-apply.js";

const DEFAULT_REFUSAL_RETRY_MS = 60_000;

/** A store that can answer whether two rows are linked. Structural, like `isAssociationReader`. */
interface LinkChecker {
  isLinked(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean>;
}

function isLinkChecker(store: unknown): store is LinkChecker {
  return typeof (store as { isLinked?: unknown } | null)?.isLinked === "function";
}

export interface TenantColumnStoreRegistryOptions {
  /** Prefix for tenant schema names (default `t_`). */
  readonly prefix?: string;
  /** SQL expression yielding the pgcrypto key, passed to each tenant's store. */
  readonly encryptionKeyRef?: string;
  /** Called once per *fresh* application (not on a memoised hit), for logging. */
  readonly onApplication?: (application: TenantSchemaApplication) => void;
  /**
   * How long a refused application is remembered before it is retried (default
   * 60s). A refusal is memoised at all so a tenant whose manifest needs a manual
   * type change does not make every request re-introspect their schema; it
   * *expires* so that an operator who runs the reported SQL is picked up without
   * restarting the process.
   */
  readonly refusalRetryMs?: number;
  readonly now?: () => number;
}

interface RegistryEntry {
  readonly manifestHash: string;
  readonly application: TenantSchemaApplication;
  /** Null when the application was refused — there is no schema to serve from. */
  readonly store: ColumnMappedEntityStore | null;
  /** When a refused entry stops being trusted; Infinity for an applied one. */
  readonly validUntil: number;
}

/**
 * Owns one `ColumnMappedEntityStore` per tenant that serves its own activated
 * manifest, each bound to that tenant's schema, plus the DDL application that
 * makes the schema real.
 *
 * `ensure` is the whole lifecycle: idempotent, memoised on the manifest hash, and
 * safe to call on every activation, every boot and every request. The first call
 * for a `(tenant, manifest)` pair applies the DDL; every later one is a map
 * lookup. A *changed* manifest has a different hash, so it re-applies — which is
 * how a tenant's second activation gains its new fields.
 *
 * `storeFor` is deliberately synchronous and deliberately does **not** provision:
 * it answers "is this tenant's schema known-good right now", so a request path
 * can route without an await and without a hidden DDL round trip. A tenant whose
 * manifest has not been ensured, or whose application was refused, reads as null
 * and the caller falls back.
 */
export class TenantColumnStoreRegistry {
  private readonly conn: PgConnection;
  private readonly prefix: string;
  private readonly encryptionKeyRef: string | undefined;
  private readonly onApplication: ((application: TenantSchemaApplication) => void) | null;
  private readonly refusalRetryMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, RegistryEntry>();
  /** In-flight applications, so concurrent first requests for one tenant do one apply. */
  private readonly inFlight = new Map<string, Promise<TenantSchemaApplication>>();

  constructor(conn: PgConnection, opts: TenantColumnStoreRegistryOptions = {}) {
    this.conn = conn;
    this.prefix = opts.prefix ?? DEFAULT_TENANT_SCHEMA_PREFIX;
    this.encryptionKeyRef = opts.encryptionKeyRef;
    this.onApplication = opts.onApplication ?? null;
    this.refusalRetryMs = opts.refusalRetryMs ?? DEFAULT_REFUSAL_RETRY_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The schema this tenant's own tables live in. Throws on a non-UUID tenant id. */
  schemaFor(tenantId: string): string {
    return tenantSchemaName(tenantId, this.prefix);
  }

  /**
   * Applies `manifest` to this tenant's schema if it has not already been applied,
   * and returns what that application did. Memoised per `(tenantId, manifest
   * hash)`; a refusal is remembered for `refusalRetryMs` and then retried.
   */
  async ensure(tenantId: string, manifest: Manifest): Promise<TenantSchemaApplication> {
    const hash = manifestHash(manifest);
    const cached = this.entries.get(tenantId);
    if (cached !== undefined && cached.manifestHash === hash && cached.validUntil > this.now()) {
      return cached.application;
    }
    const pending = this.inFlight.get(tenantId);
    if (pending !== undefined) {
      const application = await pending;
      // Another caller may have been applying a *different* manifest; if so, fall
      // through and apply ours rather than reporting theirs as ours.
      if (application.manifestHash === hash) return application;
    }
    const run = this.apply(tenantId, manifest, hash);
    this.inFlight.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(tenantId) === run) this.inFlight.delete(tenantId);
    }
  }

  private async apply(tenantId: string, manifest: Manifest, hash: string): Promise<TenantSchemaApplication> {
    const application = await applyTenantManifestSchema(this.conn, tenantId, manifest, {
      prefix: this.prefix,
    });
    const store = application.applied
      ? new ColumnMappedEntityStore(this.conn, manifest, {
          schema: application.schema,
          ...(this.encryptionKeyRef !== undefined ? { encryptionKeyRef: this.encryptionKeyRef } : {}),
        })
      : null;
    this.entries.set(tenantId, {
      manifestHash: hash,
      application,
      store,
      validUntil: application.applied ? Number.POSITIVE_INFINITY : this.now() + this.refusalRetryMs,
    });
    this.onApplication?.(application);
    return application;
  }

  /**
   * The tenant's store, or null when their manifest has not been ensured, or its
   * application was refused. Synchronous and side-effect free.
   */
  storeFor(tenantId: string): ColumnMappedEntityStore | null {
    const entry = this.entries.get(tenantId);
    if (entry === undefined || entry.validUntil <= this.now()) return null;
    return entry.store;
  }

  /** The last application recorded for this tenant, for an admin or diagnostic read. */
  applicationFor(tenantId: string): TenantSchemaApplication | null {
    return this.entries.get(tenantId)?.application ?? null;
  }

  /**
   * Drops what is remembered about one tenant, so the next `ensure` re-applies and
   * re-introspects. Wire this to whatever notices an activation (the manifest
   * activation poller), so a manifest activated on another replica is re-applied
   * here rather than waiting on a hash comparison that would catch it anyway but
   * only once the new manifest is read.
   */
  forget(tenantId: string): void {
    this.entries.delete(tenantId);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * An `EntityStore` facade that sends each call to the schema of the tenant it is
 * for: a tenant with an ensured activated manifest is served from their own typed
 * tables, everyone else from `fallback`.
 *
 * It exists so the per-tenant gateway can be handed **one** store object. The
 * routing is per *call*, not per compiled gateway, so a tenant who re-activates
 * mid-TTL is served from their re-applied schema immediately — a store captured
 * at gateway-build time would have gone stale.
 *
 * It does not provision. A tenant only becomes routable once
 * `registry.ensure(tenantId, manifest)` has resolved, which is why the
 * recommended wiring calls `ensure` where the tenant's manifest is read, before
 * the gateway is built and before any request reaches a handler. A tenant who has
 * not been ensured — or whose application was refused — falls back, which is
 * exactly the behaviour that existed before any of this: served, from the
 * manifest-agnostic JSONB store, rather than 500ing on an unplanned entity.
 */
export interface TenantColumnStoreRouterOptions {
  readonly registry: TenantColumnStoreRegistry;
  /**
   * Where a tenant with no ensured column schema is served from — in practice the
   * JSONB `PostgresEntityStore`. Omit it and such a tenant is an error rather
   * than a silent miss.
   */
  readonly fallback?: EntityStore;
}

export class TenantColumnStoreRouter implements TransactionalEntityStore {
  private readonly registry: TenantColumnStoreRegistry;
  private readonly fallback: EntityStore | null;

  constructor(opts: TenantColumnStoreRouterOptions) {
    this.registry = opts.registry;
    this.fallback = opts.fallback ?? null;
  }

  /** Which store serves this tenant: their own column store, or the fallback. */
  storeFor(tenantId: string): EntityStore {
    const tenant = this.registry.storeFor(tenantId);
    if (tenant !== null) return tenant;
    if (this.fallback === null) {
      throw new Error(
        `tenant ${tenantId} has no applied column schema and no fallback store is configured`,
      );
    }
    return this.fallback;
  }

  /** Whether this tenant is being served from their own typed tables. */
  isTenantScoped(tenantId: string): boolean {
    return this.registry.storeFor(tenantId) !== null;
  }

  list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    return this.storeFor(tenantId).list(tenantId, entity);
  }

  listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return this.storeFor(tenantId).listPage(tenantId, entity, query);
  }

  get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    return this.storeFor(tenantId).get(tenantId, entity, id);
  }

  create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    return this.storeFor(tenantId).create(tenantId, entity, record);
  }

  update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    return this.storeFor(tenantId).update(tenantId, entity, id, patch);
  }

  remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    return this.storeFor(tenantId).remove(tenantId, entity, id);
  }

  /**
   * Routes the atomic unit to the tenant's store. A fallback that cannot offer one
   * runs the callback against itself unwrapped — the same non-atomic behaviour it
   * would have given on its own — rather than failing the request; the repo's only
   * fallback (`PostgresEntityStore`) is transactional, so this is a floor, not a path.
   */
  withTransaction<T>(tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T> {
    const store = this.storeFor(tenantId);
    return isTransactional(store) ? store.withTransaction(tenantId, fn) : fn(store);
  }

  // ----- many_to_many associations ------------------------------------------
  //
  // Structural, like the interfaces in `operate-runtime/association.ts`: the
  // router declares them so a tenant's own join tables are reachable, and reports
  // a store that cannot serve one instead of answering wrongly.

  link(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<void> {
    const store = this.storeFor(tenantId);
    if (!isAssociationWriter(store)) {
      throw new Error(`store serving tenant ${tenantId} does not support association writes`);
    }
    return store.link(tenantId, leftEntity, rightEntity, leftId, rightId);
  }

  unlink(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean> {
    const store = this.storeFor(tenantId);
    if (!isAssociationWriter(store)) {
      throw new Error(`store serving tenant ${tenantId} does not support association writes`);
    }
    return store.unlink(tenantId, leftEntity, rightEntity, leftId, rightId);
  }

  listLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string } = {},
  ): Promise<ReadonlyArray<{ readonly leftId: string; readonly rightId: string }>> {
    const store = this.storeFor(tenantId);
    if (!isAssociationReader(store)) {
      throw new Error(`store serving tenant ${tenantId} does not support association reads`);
    }
    return store.listLinks(tenantId, leftEntity, rightEntity, opts);
  }

  /**
   * Both stores carry `isLinked`; no route reads it structurally today, but
   * leaving it off the router would make the facade narrower than either thing it
   * routes to, which is the way a facade quietly loses a capability.
   */
  isLinked(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean> {
    const store = this.storeFor(tenantId);
    if (!isLinkChecker(store)) {
      throw new Error(`store serving tenant ${tenantId} does not support association checks`);
    }
    return store.isLinked(tenantId, leftEntity, rightEntity, leftId, rightId);
  }

  countLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string } = {},
  ): Promise<number> {
    const store = this.storeFor(tenantId);
    if (!isAssociationCounter(store)) {
      throw new Error(`store serving tenant ${tenantId} does not support association counts`);
    }
    return store.countLinks(tenantId, leftEntity, rightEntity, opts);
  }
}
