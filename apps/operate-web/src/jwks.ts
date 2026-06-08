import { InMemoryJwksProvider, type JwksProvider } from "@crossengin/api-gateway-runtime";

import type { JwksKeySpec } from "./principals.js";

/** Builds an in-memory `JwksProvider` from a set of public keys (the IdP's signing keys). */
export function buildJwksProvider(keys: readonly JwksKeySpec[]): JwksProvider {
  return new InMemoryJwksProvider({ keys: keys.map((k) => ({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 })) });
}

/** Minimal fetch shape (a real `fetch`/`undici` Response satisfies it). */
export interface FetchLike {
  (url: string): Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
}

export interface RemoteJwksProviderOptions {
  readonly url: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** How long a fetched key set is served before a refetch (default 5 min). */
  readonly cacheTtlMs?: number;
  /** Floor between refetches triggered by an unknown `kid` (default 10 s) — rate-limits rotation pickup. */
  readonly minRefetchMs?: number;
  readonly now?: () => number;
}

/** Converts a base64url string (JWK `x`) to standard base64 (the verify format). */
export function base64UrlToBase64(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const padNeeded = b.length % 4 === 0 ? 0 : 4 - (b.length % 4);
  return b + "=".repeat(padNeeded);
}

/**
 * Parses a JWKS document into a `kid → base64 Ed25519 public key` map. Only OKP
 * / Ed25519 keys with a `kid` + `x` are kept; other key types are ignored.
 */
export function parseJwksDocument(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (doc === null || typeof doc !== "object") return out;
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return out;
  for (const entry of keys) {
    if (entry === null || typeof entry !== "object") continue;
    const k = entry as Record<string, unknown>;
    if (k["kty"] === "OKP" && k["crv"] === "Ed25519" && typeof k["kid"] === "string" && typeof k["x"] === "string") {
      out.set(k["kid"], base64UrlToBase64(k["x"]));
    }
  }
  return out;
}

/**
 * A caching `JwksProvider` over a remote JWKS endpoint. Keys are fetched on
 * demand and cached for `cacheTtlMs`; an unknown `kid` (e.g. after the IdP
 * rotates) triggers a refetch, rate-limited by `minRefetchMs`. A failed refetch
 * keeps the last good key set (resilient) and falls back to a 401 only when no
 * key is available (fail-closed).
 */
export class RemoteJwksProvider implements JwksProvider {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly ttl: number;
  private readonly minRefetch: number;
  private readonly now: () => number;
  private keys: Map<string, string> = new Map();
  private fetchedAt = -Infinity;

  constructor(opts: RemoteJwksProviderOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetch ?? ((url: string) => globalThis.fetch(url));
    this.ttl = opts.cacheTtlMs ?? 300_000;
    this.minRefetch = opts.minRefetchMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async getPublicKeyForKid(kid: string): Promise<string | null> {
    if (this.isStale()) {
      await this.refresh();
    } else if (!this.keys.has(kid) && this.canRefreshOnMiss()) {
      await this.refresh();
    }
    return this.keys.get(kid) ?? null;
  }

  /** Number of cached keys (observability). */
  keyCount(): number {
    return this.keys.size;
  }

  private isStale(): boolean {
    return this.now() - this.fetchedAt >= this.ttl;
  }

  private canRefreshOnMiss(): boolean {
    return this.now() - this.fetchedAt >= this.minRefetch;
  }

  /** Fetches the JWKS and replaces the cache; a non-200 / error keeps the last good set. */
  async refresh(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url);
      if (!res.ok) return; // keep the last good key set
      const parsed = parseJwksDocument(await res.json());
      this.keys = parsed;
      this.fetchedAt = this.now();
    } catch {
      // network error: keep the last good key set; a miss falls back to 401
    }
  }
}

/** Anything the poller can periodically refresh (a `RemoteJwksProvider` satisfies it). */
export interface Refreshable {
  refresh(): Promise<void>;
}

export type IntervalHandle = unknown;

/** Injectable timer (defaults to the global one) so the poller is deterministic in tests. */
export interface IntervalScheduler {
  setInterval(handler: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
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

export interface JwksRefreshPollerOptions {
  readonly provider: Refreshable;
  readonly intervalMs: number;
  /** Refresh once immediately on start (default true). */
  readonly refreshOnStart?: boolean;
  readonly onError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

/**
 * Proactively refreshes a JWKS provider on an interval, so requests never pay
 * the fetch latency and key rotation is picked up before a request needs it.
 * Lazy refresh (the provider's TTL/miss logic) remains the fallback. The timer
 * is `unref`'d so it doesn't keep the process alive; `stop()` clears it.
 */
export class JwksRefreshPoller {
  private readonly opts: JwksRefreshPollerOptions;
  private handle: IntervalHandle | null = null;

  constructor(opts: JwksRefreshPollerOptions) {
    this.opts = opts;
  }

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
      await this.opts.provider.refresh();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
