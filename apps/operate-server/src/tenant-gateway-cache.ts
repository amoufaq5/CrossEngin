import { ManifestSchema, tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { ApiKeySpec } from "./principals.js";
import type { OperateHttpServer } from "./server.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Resolves the tenant an incoming raw request belongs to. The authenticated
 * credential is authoritative: a registered API key token (`x-api-key` or
 * `authorization: Bearer <token>`) resolves to its bound tenant. The spoofable
 * `x-tenant-id` header is honored only for requests carrying a Bearer
 * credential the key set does not know (a JWT, whose tenant the gateway's
 * P1.18 cross-check will verify against the claim) and only when it is a
 * canonical UUID — so an unauthenticated flood of random tenant headers never
 * reaches the manifest source or the cache.
 */
export function resolveRequestTenant(raw: RawHttpRequest, apiKeys: readonly ApiKeySpec[]): string | null {
  const token = requestToken(raw);
  if (token !== null) {
    const spec = apiKeys.find((k) => k.key === token);
    if (spec !== undefined) return spec.tenantId;
  }
  const bearer = headerValue(raw.headers, "authorization");
  if (bearer === null || !/^bearer\s/i.test(bearer)) return null;
  const hint = headerValue(raw.headers, "x-tenant-id");
  if (hint === null || !UUID_RE.test(hint)) return null;
  return hint.toLowerCase();
}

export interface TenantGatewayCacheOptions {
  source: { activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null> };
  build: (manifest: Manifest) => OperateHttpServer;
  ttlMs?: number;
  now?: () => number;
  onInvalidManifest?: (tenantId: string, issues: readonly string[]) => void;
  /** Hard cap on cached entries; the oldest entry is evicted at capacity (default 1000). */
  maxEntries?: number;
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
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: TenantGatewayCacheOptions) {
    this.source = opts.source;
    this.build = opts.build;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.onInvalidManifest = opts.onInvalidManifest ?? null;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
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
    if (!this.entries.has(tenantId) && this.entries.size >= this.maxEntries) {
      const nowMs = this.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= nowMs) this.entries.delete(key);
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
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
