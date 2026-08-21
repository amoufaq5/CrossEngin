import { ManifestSchema, tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { ApiKeySpec } from "./principals.js";
import type { OperateHttpServer } from "./server.js";

const DEFAULT_TTL_MS = 30_000;

function headerValue(headers: RawHttpRequest["headers"], name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function requestToken(raw: RawHttpRequest): string | null {
  const apiKey = headerValue(raw.headers, "x-api-key");
  if (apiKey !== null) return apiKey;
  const auth = headerValue(raw.headers, "authorization");
  if (auth === null) return null;
  const match = /^bearer\s+(.+)$/i.exec(auth);
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}

/**
 * Resolves the tenant an incoming raw request belongs to: the `x-tenant-id`
 * header wins; otherwise the API key token (`x-api-key` or `authorization:
 * Bearer <token>`) is matched against the registered key set and its bound
 * tenant is used; otherwise null.
 */
export function resolveRequestTenant(raw: RawHttpRequest, apiKeys: readonly ApiKeySpec[]): string | null {
  const hint = headerValue(raw.headers, "x-tenant-id");
  if (hint !== null) return hint;
  const token = requestToken(raw);
  if (token === null) return null;
  const spec = apiKeys.find((k) => k.key === token);
  return spec === undefined ? null : spec.tenantId;
}

export interface TenantGatewayCacheOptions {
  source: { activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null> };
  build: (manifest: Manifest) => OperateHttpServer;
  ttlMs?: number;
  now?: () => number;
  onInvalidManifest?: (tenantId: string, issues: readonly string[]) => void;
}

interface CacheEntry {
  readonly server: OperateHttpServer | null;
  readonly expiresAt: number;
}

/**
 * A TTL cache of per-tenant compiled `OperateHttpServer`s built from each
 * tenant's stored active manifest. Both positive entries (a compiled server)
 * and negative ones (no/invalid custom manifest → null, caller falls back to
 * the default server) are cached until ttl expiry. A stored manifest that
 * fails kernel validation reports via `onInvalidManifest` and caches null
 * (fail open to the default server); a source throw is treated as null for
 * that call only and NOT cached, so the next request retries the source.
 */
export class TenantGatewayCache {
  private readonly source: TenantGatewayCacheOptions["source"];
  private readonly build: (manifest: Manifest) => OperateHttpServer;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onInvalidManifest: ((tenantId: string, issues: readonly string[]) => void) | null;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: TenantGatewayCacheOptions) {
    this.source = opts.source;
    this.build = opts.build;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.onInvalidManifest = opts.onInvalidManifest ?? null;
  }

  async serverFor(tenantId: string): Promise<OperateHttpServer | null> {
    const cached = this.entries.get(tenantId);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.server;

    let stored: Record<string, unknown> | null;
    try {
      stored = await this.source.activeManifestFor(tenantId);
    } catch {
      // A source failure is transient: fall back to the default for this call
      // without caching, so the next request retries the source.
      return null;
    }
    if (stored === null) return this.remember(tenantId, null);

    const parsed = ManifestSchema.safeParse(stored);
    if (!parsed.success) {
      this.reportInvalid(
        tenantId,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
      return this.remember(tenantId, null);
    }
    const validated = tryValidateManifest(parsed.data);
    if (!validated.ok) {
      this.reportInvalid(
        tenantId,
        validated.errors.map((err) => `${err.path}: ${err.message}`),
      );
      return this.remember(tenantId, null);
    }
    return this.remember(tenantId, this.build(parsed.data));
  }

  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  private remember(tenantId: string, server: OperateHttpServer | null): OperateHttpServer | null {
    this.entries.set(tenantId, { server, expiresAt: this.now() + this.ttlMs });
    return server;
  }

  private reportInvalid(tenantId: string, issues: readonly string[]): void {
    if (this.onInvalidManifest !== null) this.onInvalidManifest(tenantId, issues);
  }
}

/**
 * Wraps a default dispatch with per-tenant routing: the request's tenant is
 * resolved (`resolveRequestTenant`), that tenant's compiled server is looked
 * up in the cache, and the request dispatches to it — falling back to the
 * default dispatch when no tenant resolves or the tenant has no valid custom
 * manifest.
 */
export function buildPerTenantDispatch(opts: {
  defaultDispatch: (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse>;
  cache: TenantGatewayCache;
  apiKeys: readonly ApiKeySpec[];
}): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse> {
  return async (raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> => {
    const tenantId = resolveRequestTenant(raw, opts.apiKeys);
    if (tenantId === null) return opts.defaultDispatch(raw, body);
    const server = await opts.cache.serverFor(tenantId);
    if (server === null) return opts.defaultDispatch(raw, body);
    return server.dispatch(raw, body);
  };
}
