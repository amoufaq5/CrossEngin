import type { JwksProvider } from "@crossengin/api-gateway-runtime";

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

/** Converts a base64url string (JWK `x`) to standard base64 (the gateway's key format). */
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

  private isStale(): boolean {
    return this.now() - this.fetchedAt >= this.ttl;
  }

  private canRefreshOnMiss(): boolean {
    return this.now() - this.fetchedAt >= this.minRefetch;
  }

  private async refresh(): Promise<void> {
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
