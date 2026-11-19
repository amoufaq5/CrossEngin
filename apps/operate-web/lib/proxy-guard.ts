// The decisions the `/api/[...path]` proxy and the two `/api/auth/*` handlers make before they
// spend a credential: whether a state-changing request came from this app's own pages, how much
// body it may carry, and how long the API may take. Pure and import-free, so it is testable from
// outside this app (packages/testing/src/operate-web.test.ts) — operate-web has no test runner of its own —
// and so the edge and node runtimes can both load it.

/** Methods that must not change state, and so carry no cross-site risk worth refusing. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export const CROSS_SITE_REFUSALS = [
  "cross_site_request",
  "origin_absent",
  "origin_mismatch",
] as const;
export type CrossSiteRefusal = (typeof CROSS_SITE_REFUSALS)[number];

export interface RequestProvenance {
  readonly method: string;
  readonly secFetchSite: string | null;
  readonly origin: string | null;
  readonly host: string | null;
}

/**
 * Why a state-changing request is refused as not having come from this app, or `null`.
 *
 * The session cookie is `SameSite=Strict`, which stops a *cross-site* page from riding it but not a
 * *same-site* one: `api.{DOMAIN}` and any sibling subdomain are same-site with the console, so a
 * page there could POST through this proxy carrying the cookie. The question that is actually wanted
 * is "same origin", and the browser states it:
 *
 * - **`Sec-Fetch-Site`** first, because a page cannot set or forge it (a forbidden header name) and
 *   every current engine sends it. Only `same-origin` is admitted — `same-site` is the hole above,
 *   and `none` is a user-initiated navigation, which no form or fetch on this app's pages produces
 *   for a non-GET.
 * - **`Origin`** when that is absent (an engine that predates it), compared on **host** against the
 *   request's own `Host`. The host and not the full origin, because TLS terminates at the edge
 *   (Caddy) and this process sees plain HTTP: comparing schemes would refuse every request on the
 *   shipped stack. Caddy passes `Host` through unchanged, and `Host` is forbidden to a page too.
 * - **Neither**: refused. Every engine that sends neither on a state-changing fetch is one that
 *   also predates `SameSite`, and a non-browser client has no business replaying a browser's cookie
 *   here — it has the API, which takes its own credentials.
 */
export function crossSiteRefusal(req: RequestProvenance): CrossSiteRefusal | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (req.secFetchSite !== null && req.secFetchSite.trim() !== "") {
    return req.secFetchSite.trim().toLowerCase() === "same-origin" ? null : "cross_site_request";
  }
  if (req.origin === null || req.origin.trim() === "") return "origin_absent";
  if (req.host === null || req.host.trim() === "") return "origin_mismatch";
  let originHost: string;
  try {
    originHost = new URL(req.origin).host;
  } catch {
    // Includes the literal `null` origin a sandboxed frame or a `data:` page sends.
    return "origin_mismatch";
  }
  return originHost.toLowerCase() === req.host.trim().toLowerCase() ? null : "origin_mismatch";
}

/** The four facts `crossSiteRefusal` reads, off a request. */
export function provenanceOf(req: Request): RequestProvenance {
  return {
    method: req.method,
    secFetchSite: req.headers.get("sec-fetch-site"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
  };
}

/** The sentence a refused request carries. It names the rule and nothing about the request. */
export const CROSS_SITE_REFUSAL_DETAIL =
  "State-changing requests are accepted only from this application's own pages.";

export interface ProxyLimits {
  readonly maxRequestBodyBytes: number;
  readonly upstreamTimeoutMs: number;
}

export const PROXY_LIMIT_ENV = {
  maxRequestBodyBytes: "OPERATE_WEB_MAX_REQUEST_BODY_BYTES",
  upstreamTimeoutMs: "OPERATE_WEB_UPSTREAM_TIMEOUT_MS",
} as const;

/**
 * The defaults, and why each is the number it is.
 *
 * 10 MiB is operate-server's own `--max-request-body` default, so the proxy refuses nothing the
 * API would accept out of the box; a deployment that raises the API's cap raises this beside it.
 * 60 s is longer than any synchronous route here needs (the slowest, a report over its 20,000-row
 * ceiling, is seconds) and short enough that a wedged API does not hold a browser's request — and a
 * node worker — for the minutes undici would otherwise wait.
 */
export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  maxRequestBodyBytes: 10 * 1024 * 1024,
  upstreamTimeoutMs: 60_000,
};

const LIMIT_BOUNDS: Readonly<Record<keyof ProxyLimits, { readonly min: number; readonly max: number }>> = {
  maxRequestBodyBytes: { min: 1024, max: 1024 * 1024 * 1024 },
  upstreamTimeoutMs: { min: 1000, max: 600_000 },
};

/**
 * The limits a deployment declared, or the defaults. A value that is set and not a whole number in
 * bounds **throws** naming the variable, rather than falling back: an operator who wrote
 * `OPERATE_WEB_UPSTREAM_TIMEOUT_MS=5m` believes they configured something, and serving the default
 * would make that belief false in silence.
 */
export function proxyLimitsFromEnv(env: Readonly<Record<string, string | undefined>>): ProxyLimits {
  const read = (key: keyof ProxyLimits): number => {
    const name = PROXY_LIMIT_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return DEFAULT_PROXY_LIMITS[key];
    const { min, max } = LIMIT_BOUNDS[key];
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(`${name} must be a whole number between ${min.toString()} and ${max.toString()}`);
    }
    const value = Number(raw.trim());
    if (value < min || value > max) {
      throw new Error(`${name} must be between ${min.toString()} and ${max.toString()}`);
    }
    return value;
  };
  return { maxRequestBodyBytes: read("maxRequestBodyBytes"), upstreamTimeoutMs: read("upstreamTimeoutMs") };
}

export type CappedBody =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false };

/**
 * A request's body, refused once it passes `cap` bytes.
 *
 * Read from the stream and counted as it arrives, because `Content-Length` is a claim: it settles
 * the cheap case (refused before a byte is read) and a chunked body has none. Bytes rather than
 * text, so a body is forwarded exactly as it was sent rather than round-tripped through a UTF-8
 * decode that would replace an invalid sequence.
 */
export async function readCappedBody(req: Request, cap: number): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > cap) {
    return { ok: false };
  }
  if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** The code the proxy answers with when operate-server took longer than the declared timeout. */
export const UPSTREAM_TIMEOUT = "upstream_timeout";

/** Whether a caught fetch error is the timeout signal firing, as opposed to a connection failure. */
export function isUpstreamTimeout(err: unknown): boolean {
  // `TimeoutError` alone: it is the reason `AbortSignal.timeout` aborts with, and an `AbortError`
  // would be some other abort, which is not the API being slow.
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}
