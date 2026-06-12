import type { Manifest } from "@crossengin/kernel/manifest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { ApiKeySpec } from "./principals.js";
import { resolveInstalledManifests, type PackManifestResolver } from "./tenant-surface.js";
import type { PostgresPackInstallationStore } from "@crossengin/marketplace-pg";

/**
 * The dispatch surface the Node/edge listener needs — satisfied by both the base
 * `OperateHttpServer` and the per-tenant `TenantDispatcher`, so a dispatcher is a
 * drop-in for a server.
 */
export interface OperateDispatcher {
  dispatchWithMatch(
    raw: RawHttpRequest,
    body: Uint8Array | null,
  ): Promise<{ readonly response: RawHttpResponse; readonly matchedOperationId: string | null }>;
}

/** Resolves a tenant's installed packs to their manifests for the dispatcher. */
export interface TenantPackSource {
  installedManifests(tenantId: string): Promise<readonly Manifest[]>;
}

/**
 * The Postgres-backed pack source: reads the tenant's `installed` installations
 * (RLS-scoped) and resolves each to its manifest, dropping any that don't resolve.
 */
export function buildPgTenantPackSource(
  store: PostgresPackInstallationStore,
  resolver: PackManifestResolver,
): TenantPackSource {
  return {
    async installedManifests(tenantId: string): Promise<readonly Manifest[]> {
      const installed = await store.listForTenant(tenantId, { status: "installed" });
      const resolved = await resolveInstalledManifests(installed, resolver);
      return resolved.flatMap((r) => (r.manifest !== null ? [r.manifest] : []));
    },
  };
}

function bearerOrApiKey(raw: RawHttpRequest): string | null {
  const headers = raw.headers;
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

/**
 * Pre-resolves a request's tenant from an **opaque API-key** credential (a map
 * lookup, no crypto) so the dispatcher can pick the tenant's gateway before the
 * pipeline runs its full auth. A JWT bearer token isn't in the key map → `null`
 * (those callers fall through to the base server; per-tenant routing for JWT auth
 * is a follow-up). The chosen gateway still runs the real auth + RBAC.
 */
export function apiKeyTenantResolver(apiKeys: readonly ApiKeySpec[]): (raw: RawHttpRequest) => string | null {
  const byKey = new Map(apiKeys.map((k) => [k.key, k.tenantId]));
  return (raw) => {
    const token = bearerOrApiKey(raw);
    return token === null ? null : (byKey.get(token) ?? null);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pre-resolves a **Bearer-JWT** request's tenant for the dispatcher. operate-server's
 * gateway resolves a JWT caller's tenant from the `x-tenant-id` header (the tenantHint
 * threaded into `principalFromJwtClaims`), so this reads that same header — picking the
 * gateway the request will actually *run as*. It only fires for a request carrying a
 * 3-segment Bearer JWT (so an opaque API key still resolves via the key map), and
 * pre-resolution is purely **gateway selection**: the chosen gateway still verifies the
 * JWT signature + iss/aud/exp/nbf and runs RBAC, so a forged `x-tenant-id` only mis-picks
 * a gateway that then 401s the bad token — no data is served on an unverified claim.
 */
export function bearerJwtTenantResolver(): (raw: RawHttpRequest) => string | null {
  return (raw) => {
    const auth = raw.headers["authorization"];
    const isJwt =
      typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim().split(".").length === 3;
    if (!isJwt) return null;
    const tenant = raw.headers["x-tenant-id"];
    return typeof tenant === "string" && UUID_RE.test(tenant) ? tenant.toLowerCase() : null;
  };
}

/**
 * Composes tenant resolvers, returning the first non-null result. Used to try the
 * API-key map first, then the Bearer-JWT header path.
 */
export function firstTenantOf(
  resolvers: ReadonlyArray<(raw: RawHttpRequest) => string | null>,
): (raw: RawHttpRequest) => string | null {
  return (raw) => {
    for (const resolve of resolvers) {
      const tenant = resolve(raw);
      if (tenant !== null) return tenant;
    }
    return null;
  };
}

export interface TenantDispatcherOptions {
  /** The no-install server (also used for tenants with zero installs / unknown credentials). */
  readonly base: OperateDispatcher;
  /** Builds a dispatcher serving the composed (base + these packs) manifest. */
  readonly buildFor: (packs: readonly Manifest[]) => OperateDispatcher;
  /** Pre-resolves a request's tenant (e.g. from the API key), or `null`. */
  readonly tenantOf: (raw: RawHttpRequest) => string | null;
  readonly source: TenantPackSource;
  /** Per-tenant server cache TTL (default 30s) — bounds install-set staleness. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Routes each request to the gateway serving its tenant's composed surface
 * (base + the tenant's installed packs), so an installed pack's entities are
 * actually servable for that tenant — and unavailable (base 404/405) for tenants
 * that haven't installed it. The per-tenant server is cached (TTL-bounded; a tenant
 * with no installs reuses the base server). Tenants the credential can't pre-resolve
 * (e.g. JWT) fall through to the base server.
 */
export class TenantDispatcher implements OperateDispatcher {
  private readonly opts: TenantDispatcherOptions;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { server: OperateDispatcher; at: number }>();

  constructor(opts: TenantDispatcherOptions) {
    this.opts = opts;
    this.ttl = opts.cacheTtlMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async dispatchWithMatch(
    raw: RawHttpRequest,
    body: Uint8Array | null,
  ): Promise<{ readonly response: RawHttpResponse; readonly matchedOperationId: string | null }> {
    const tenantId = this.opts.tenantOf(raw);
    const server = tenantId === null ? this.opts.base : await this.serverFor(tenantId);
    return server.dispatchWithMatch(raw, body);
  }

  /**
   * Drops a tenant's cached server so the next request rebuilds it from the
   * current install set. Wired into the marketplace install/uninstall handlers so
   * a write is reflected immediately rather than only after the TTL bound.
   */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async serverFor(tenantId: string): Promise<OperateDispatcher> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && this.now() - cached.at < this.ttl) return cached.server;
    const packs = await this.opts.source.installedManifests(tenantId);
    const server = packs.length === 0 ? this.opts.base : this.opts.buildFor(packs);
    this.cache.set(tenantId, { server, at: this.now() });
    return server;
  }
}
