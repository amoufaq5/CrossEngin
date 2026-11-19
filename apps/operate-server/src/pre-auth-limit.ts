/**
 * A request-rate bound that runs **before** authentication.
 *
 * The gateway's rate limit is stage 10, after `authenticate` and `resolve_principal`, keyed on the
 * principal it resolved — so every request that fails to authenticate costs a full auth stage
 * (a signature verification, an api-key lookup, a membership read) and is never counted at all.
 * This bounds that work by what is known before any of it runs: where the connection came from and
 * what *shape* of credential it carries.
 *
 * **The address is only as good as the edge declaration**, and on the shipped stack that makes this
 * nearly a global limiter. Every API request arrives through Caddy (or the web proxy), so the socket
 * peer is that container's address for every caller, and `x-forwarded-for` is believed only under a
 * declared trusted edge (`EdgeTrust`, ADR-0394) because it is otherwise a header the caller writes.
 * So without `--trusted-edge-client-cert` (the one edge declaration this binary has) one noisy client exhausts the budget for everyone behind the proxy —
 * which is why this is **off by default** and says so at boot rather than being turned on for a
 * deployment it would make worse. With a trusted edge the **rightmost** forwarded entry is the
 * address the edge itself observed; the leftmost is whatever the caller sent the edge.
 *
 * The credential *shape* is in the key and the credential is not: keying on the value would let a
 * caller reset its own budget by inventing a new token for every request, and a separate budget per
 * shape keeps an anonymous flood from consuming the budget of authenticated callers behind the same
 * address.
 */

import type { EdgeTrust } from "@crossengin/api-gateway-runtime";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";

export interface PreAuthLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export const PRE_AUTH_LIMIT_FLAG = "--pre-auth-rate-limit";

/** `<requests>/<windowSeconds>`, refused rather than clamped outside its bounds. */
export function parsePreAuthLimitPolicy(raw: string): PreAuthLimitPolicy {
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (match === null) {
    throw new Error(`${PRE_AUTH_LIMIT_FLAG} must be <requests>/<windowSeconds>, got "${raw}"`);
  }
  const limit = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (limit < 1 || limit > 1_000_000) {
    throw new Error(`${PRE_AUTH_LIMIT_FLAG} requests must be between 1 and 1000000, got ${match[1] ?? ""}`);
  }
  if (windowSeconds < 1 || windowSeconds > 3_600) {
    throw new Error(
      `${PRE_AUTH_LIMIT_FLAG} window must be between 1 and 3600 seconds, got ${match[2] ?? ""}`,
    );
  }
  return { limit, windowSeconds };
}

/**
 * A closed set, because the shape is half the key: an open one let a caller mint a fresh budget per
 * invented `Authorization` scheme token (`a1 x`, `a2 x`, …), and with the map bounded each new key
 * also evicts the oldest window — the caller's own spent `bearer` one among them. Only the two
 * schemes the gateway parses are named; every other token is one shape.
 */
export type CredentialShape =
  | "none"
  | "api_key"
  | "authorization:bearer"
  | "authorization:basic"
  | "authorization:other"
  | "request_signature";

const NAMED_AUTHORIZATION_SCHEMES: ReadonlySet<string> = new Set(["bearer", "basic"]);

function firstHeader(raw: RawHttpRequest, name: string): string | undefined {
  const v = raw.headers[name];
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** The kind of credential presented, never its value. */
export function credentialShape(raw: RawHttpRequest): CredentialShape {
  const authorization = firstHeader(raw, "authorization");
  if (authorization !== undefined) {
    const token = /^\s*([A-Za-z][A-Za-z0-9._~+/-]*)(?:\s|$)/.exec(authorization)?.[1]?.toLowerCase();
    return token !== undefined && NAMED_AUTHORIZATION_SCHEMES.has(token)
      ? (`authorization:${token}` as CredentialShape)
      : "authorization:other";
  }
  if (firstHeader(raw, "x-api-key") !== undefined) return "api_key";
  if (firstHeader(raw, "crossengin-request-signature") !== undefined) return "request_signature";
  return "none";
}

/**
 * Where the request came from, as this process can know it. Under a trusted edge the rightmost
 * `x-forwarded-for` entry — the one the edge appended for the peer it saw. Otherwise the socket
 * peer, because every forwarded entry is then a value the caller chose.
 */
export function clientAddress(raw: RawHttpRequest, edgeTrust: EdgeTrust): string {
  if (edgeTrust === "trusted") {
    const forwarded = raw.headers["x-forwarded-for"];
    const joined = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    if (joined !== undefined) {
      const entries = joined
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      const last = entries[entries.length - 1];
      if (last !== undefined) return last;
    }
  }
  return raw.remoteAddress ?? "unknown";
}

export const PRE_AUTH_LIMITED_TYPE = "https://crossengin.io/problems/pre-auth-rate-limited";

/**
 * The 429 for a request this bound refused. One builder, because the bound is enforced at two
 * positions — the gateway's dispatch and the login route, which is an interceptor in front of it and
 * is the password-verifying route the bound exists for.
 */
export function preAuthLimitedResponse(retryAfterSeconds: number): RawHttpResponse {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: PRE_AUTH_LIMITED_TYPE,
      title: "Too many requests",
      status: 429,
      detail:
        "this address has sent more requests with this kind of credential than the deployment allows" +
        " in the window; retry after the interval in retry-after",
      extensions: {},
    }),
  );
  return {
    status: 429,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
      "retry-after": String(retryAfterSeconds),
    },
    body,
  };
}

export type PreAuthDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly key: string };

/**
 * A fixed window per key, in this process. Per process on purpose: it bounds the work one process
 * does before authentication, which is the resource it protects, and a shared counter would put a
 * database round trip in front of the auth stage it exists to shield.
 *
 * Bounded in memory: past `maxKeys` the oldest window is evicted, which can only forget a count —
 * the permissive direction, and the one that keeps an address-spraying caller from growing the map
 * without limit.
 */
export class PreAuthLimiter {
  private readonly windows = new Map<string, { readonly startedAt: number; count: number }>();

  constructor(
    readonly policy: PreAuthLimitPolicy,
    private readonly edgeTrust: EdgeTrust,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 100_000,
  ) {}

  check(raw: RawHttpRequest): PreAuthDecision {
    const key = `${clientAddress(raw, this.edgeTrust)}|${credentialShape(raw)}`;
    const at = this.now();
    const windowMs = this.policy.windowSeconds * 1000;
    let window = this.windows.get(key);
    if (window === undefined || at - window.startedAt >= windowMs) {
      this.windows.delete(key);
      window = { startedAt: at, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
    }
    window.count += 1;
    if (window.count <= this.policy.limit) return { allowed: true };
    const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + windowMs - at) / 1000));
    return { allowed: false, retryAfterSeconds, key };
  }

  /** How many keys hold a live window; for the boot line and tests. */
  size(): number {
    return this.windows.size;
  }
}

export function formatPreAuthLimit(policy: PreAuthLimitPolicy | null, edgeTrust: EdgeTrust): string {
  if (policy === null) {
    return (
      `pre-auth rate limit: off — requests that fail to authenticate are bounded by nothing before` +
      ` the auth stage. ${PRE_AUTH_LIMIT_FLAG} <requests>/<seconds> turns it on` +
      (edgeTrust === "trusted"
        ? ""
        : "; without --trusted-edge-client-cert every caller behind the proxy shares one address, so it would act as one global budget")
    );
  }
  return (
    `pre-auth rate limit: ${String(policy.limit)} per ${String(policy.windowSeconds)} s per` +
    ` (address, credential shape), addresses from ` +
    (edgeTrust === "trusted"
      ? "the trusted edge's rightmost x-forwarded-for entry"
      : "the socket peer — behind a proxy that is one address for every caller, so this is one shared budget")
  );
}
