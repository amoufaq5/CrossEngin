import { truncateErrorMessage, type FetchLike } from "./email-ses.js";
import {
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  systemTokenClock,
  TOKEN_EXPIRY_SKEW_SECONDS,
  type FcmTokenClock,
} from "./fcm-token.js";

/*
 * The second implementation of ADR-0310's `FcmAccessTokenProvider` seam: the GCE/GKE instance
 * metadata server.
 *
 * `fcm-token.ts` covers the service-account-key route and says in its own header that the other
 * route "wants a second, much smaller provider against that endpoint, not a flag on this one". This
 * is that provider. It is the route Google actually recommends on GKE, Cloud Run and GCE, and the
 * one where there *is* no key file to supply: with workload identity the platform holds the
 * credential and hands out tokens directly, so none of `fcm-token.ts`'s signing exists here. A
 * deployment on those hosts could otherwise not use push at all.
 *
 * **The network position is the credential.** We send no secret of our own — no key, no assertion,
 * no authorization header. Whoever can make this request from this network namespace is, as far as
 * Google is concerned, this workload. Three consequences follow, and all three are enforced below
 * rather than documented:
 *
 *   1. The endpoint is plain `http://`, and that is correct rather than an oversight. The metadata
 *      server lives on a link-local address (169.254.169.254, aliased as `metadata.google.internal`)
 *      that is not routable off the instance, so there is no network segment for TLS to protect and
 *      no certificate authority that could vouch for a link-local name. Nothing here "upgrades" the
 *      scheme, and nothing rejects it for being http — a provider that insisted on https would
 *      simply never obtain a token on the hosts this module exists for.
 *   2. `Metadata-Flavor: Google` is **mandatory on every request**. Google requires it precisely
 *      because it cannot be set by a form post or an image tag: it is the server's defence against a
 *      confused deputy — a browser on the instance, or an SSRF in a process on it, tricked into
 *      fetching the token URL. Omitting it means the server refuses. `metadataRequestHeaders()` is
 *      the only place a header set is built, so there is no path that could forget it.
 *   3. The timeout is short and non-negotiable. Off GCE the address is simply unroutable, so a
 *      generous timeout turns "this deployment is not on GCE" into a stalled send; on GCE the
 *      metadata server answers in single-digit milliseconds.
 *
 * Only the cache is shared with `fcm-token.ts` — the skew, the lifetime ceiling and the clock seam,
 * imported rather than restated so the two providers age tokens identically. The failure vocabulary
 * is this module's own, because the questions are different: there is no `invalid_grant` here and
 * there is no service account to be wrong, but there *is* "you are not on GCE", which the
 * service-account route cannot express.
 */

/** The DNS alias Google publishes inside every instance. Resolves to the link-local address below. */
export const GCE_METADATA_HOST = "metadata.google.internal";

/** The link-local address the alias resolves to. Unroutable off the instance, by design. */
export const GCE_METADATA_ADDRESS = "169.254.169.254";

/**
 * Plain http, deliberately. See the header note: this is a link-local address, TLS has nothing to
 * protect on it, and no CA can certify a link-local name. A test pins this exact string so that
 * nobody "fixes" it into https and silently breaks every GKE deployment.
 */
export const GCE_METADATA_BASE_URL = `http://${GCE_METADATA_HOST}`;

export const METADATA_TOKEN_PATH_PREFIX = "/computeMetadata/v1/instance/service-accounts";

/** The attached service account, whichever it is. The name GKE's workload identity binds. */
export const DEFAULT_METADATA_SERVICE_ACCOUNT = "default";

export const METADATA_FLAVOR_HEADER = "metadata-flavor";
export const METADATA_FLAVOR_VALUE = "Google";

/**
 * How long to wait for the metadata server.
 *
 * Short on purpose. On GCE this is a link-local request answered in milliseconds; off GCE the
 * address is unroutable and the only thing a longer wait buys is a stalled notification drain. Three
 * seconds absorbs a cold DNS lookup and a loaded node without turning a misconfiguration into a
 * hang.
 */
export const DEFAULT_METADATA_REQUEST_TIMEOUT_MS = 3_000;

/**
 * The hosts a plain-`http` endpoint override may name.
 *
 * An override exists for the reasons `FCM_TOKEN_ENDPOINT` does — a stand-in receiver, a sidecar that
 * proxies metadata — but it is the one knob that decides where a request carrying "give me this
 * workload's access token" goes, so it is not left open. An attacker who could set it could not read
 * a credential out of us (we send none), but they could *supply* one: point us at a host they
 * control and every push afterwards carries a bearer token they chose, to an FCM endpoint they may
 * also have chosen. They would already own the process's environment to do it, so this check is not
 * a defence against that attacker — it is what stops an ordinary misconfiguration from sending the
 * request off the instance in cleartext. So: http is allowed exactly where it is unroutable, and
 * anything beyond the loopback and the link-local address has to be https.
 */
export const PLAINTEXT_METADATA_HOSTS: readonly string[] = [
  GCE_METADATA_HOST,
  GCE_METADATA_ADDRESS,
  "localhost",
  "127.0.0.1",
  "::1",
];

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/*
 * The split this vocabulary exists for: **not on GCE** versus **on GCE and refused**.
 *
 * They arrive as the same symptom — no token, so no push — and they want opposite responses. "Not on
 * GCE" is a configuration fact: this deployment chose metadata credentials and is not running where
 * they exist, and the answer is to supply a service-account key instead. "Refused" means we *are* on
 * GCE and the instance's identity will not grant this token, which is an IAM problem. Classifying
 * them together would send an operator looking at IAM bindings for a deployment that is running on
 * their laptop.
 */
export const METADATA_TOKEN_ERROR_KINDS = [
  /** Refused at construction: an override that is not a URL, or plaintext off the instance. */
  "invalid_configuration",
  /**
   * The host does not resolve, or is unroutable. This deployment is **not on GCE** — the link-local
   * name exists only inside a Google instance. No retry can change it.
   */
  "metadata_server_unreachable",
  /**
   * Nothing answered within the timeout. Deliberately *not* folded into the kind above: a silence
   * cannot tell "not on GCE" from "the node is wedged", and the two want opposite answers. See
   * `RETRYABLE_METADATA_TOKEN_ERROR_KINDS` for which way the ambiguity is resolved and why.
   */
  "metadata_server_timeout",
  /** 404: no such service account is attached to this instance. On GCE, and refused. */
  "service_account_not_attached",
  /** Any other 4xx — a 403 from an org policy, or a scope the instance may not request. */
  "metadata_server_refused",
  /** 5xx: the metadata server is there and having a bad moment. */
  "metadata_server_unavailable",
  /** 429 from the metadata server. */
  "rate_limited",
  /** 2xx whose body is not a usable token response. */
  "malformed_token_response",
  /** The injected `fetch` threw for a reason that is not recognisably an unroutable host. */
  "network_error",
] as const;
export type MetadataTokenErrorKind = (typeof METADATA_TOKEN_ERROR_KINDS)[number];

/**
 * The kinds where another attempt can plausibly succeed without anything changing.
 *
 * `metadata_server_timeout` is **in** this set and `metadata_server_unreachable` is **not**, which
 * is the one judgement call in this module. A refused DNS lookup for `metadata.google.internal` is
 * unambiguous — the name exists only inside a Google instance, so nothing about this deployment will
 * make it resolve, and reporting it retryable would mean every push in the queue spends its whole
 * retry ladder on an address that cannot answer. A *timeout* is ambiguous, and the costs of the two
 * mistakes are not symmetric: calling a wedged node terminal **drops** a notification, while calling
 * an unroutable address retryable only delays one. So the ambiguous case is classified as the
 * recoverable one.
 *
 * Neither choice can cost the channel. A non-retryable mint ends one dispatch; `token()` is called
 * again on the next, and the operator learns they are not on GCE from the boot log and from the fact
 * that they *chose* this credential source, not from an error class.
 *
 * `malformed_token_response` is excluded for `fcm-token.ts`'s reason: the endpoint answered
 * successfully, so an identical request gets an identical body, and the overwhelmingly likely cause
 * is an override pointing at something that is not a metadata server.
 */
export const RETRYABLE_METADATA_TOKEN_ERROR_KINDS: ReadonlySet<MetadataTokenErrorKind> =
  new Set([
    "metadata_server_timeout",
    "metadata_server_unavailable",
    "rate_limited",
    "network_error",
  ]);

export class MetadataTokenError extends Error {
  readonly kind: MetadataTokenErrorKind;
  readonly status: number | null;

  constructor(input: {
    readonly kind: MetadataTokenErrorKind;
    readonly message: string;
    readonly status?: number | null;
  }) {
    super(input.message);
    this.name = "MetadataTokenError";
    this.kind = input.kind;
    this.status = input.status ?? null;
  }

  /** The shape `push-fcm.ts` checks structurally, so this provider drops into the seam unchanged. */
  isRetryable(): boolean {
    return RETRYABLE_METADATA_TOKEN_ERROR_KINDS.has(this.kind);
  }
}

/**
 * Codes that mean the link-local host is not there: no DNS record, no route, nothing listening.
 *
 * `EAI_AGAIN` is deliberately absent — it is a *temporary* resolver failure, which on GCE is a blip
 * and not evidence about where we are running, so it falls through to `network_error`.
 */
export const NOT_ON_GCE_ERROR_CODES: readonly string[] = [
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "EHOSTDOWN",
];

/**
 * Digs a libuv error code out of whatever `fetch` threw.
 *
 * Needed because undici does not surface one: a failed connect arrives as `TypeError: fetch failed`
 * with the real `Error` carrying `code` nested in `cause`, sometimes two levels down inside an
 * `AggregateError`. Reading only the top-level error would classify every unroutable host as a
 * generic `network_error` — which is retryable — and that is exactly the case this module has to get
 * right.
 */
export function errorCodeOf(err: unknown, depth = 0): string | null {
  if (depth > 4 || typeof err !== "object" || err === null) return null;
  const record = err as {
    readonly code?: unknown;
    readonly cause?: unknown;
    readonly errors?: unknown;
  };
  if (typeof record.code === "string" && record.code.length > 0) return record.code;
  const fromCause = errorCodeOf(record.cause, depth + 1);
  if (fromCause !== null) return fromCause;
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const code = errorCodeOf(nested, depth + 1);
      if (code !== null) return code;
    }
  }
  return null;
}

function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { readonly name?: unknown };
  if (record.name === "AbortError" || record.name === "TimeoutError") return true;
  return errorCodeOf(err) === "ABORT_ERR";
}

/** Classifies a thrown transport failure into the not-on-GCE / ambiguous / transient split. */
export function classifyMetadataTransportFailure(
  err: unknown,
): MetadataTokenErrorKind {
  if (isAbort(err)) return "metadata_server_timeout";
  const code = errorCodeOf(err);
  if (code !== null && NOT_ON_GCE_ERROR_CODES.includes(code)) {
    return "metadata_server_unreachable";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "metadata_server_timeout";
  }
  return "network_error";
}

/** Classifies a non-2xx answer. The server answered, so we are on GCE and it said no. */
export function classifyMetadataResponse(status: number): MetadataTokenErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "metadata_server_unavailable";
  // 404 is specifically "that service account is not attached to this instance", which is the one
  // 4xx an operator can act on without reading documentation — so it is named rather than lumped in.
  if (status === 404) return "service_account_not_attached";
  return "metadata_server_refused";
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export function metadataTokenPath(
  serviceAccount: string = DEFAULT_METADATA_SERVICE_ACCOUNT,
): string {
  // Percent-encoded because a service account may be named by its full email address, whose `@` and
  // `.` are legal in a path segment but whose arrival here unencoded would be an assumption.
  return `${METADATA_TOKEN_PATH_PREFIX}/${encodeURIComponent(serviceAccount)}/token`;
}

export function defaultMetadataTokenUrl(
  serviceAccount: string = DEFAULT_METADATA_SERVICE_ACCOUNT,
): string {
  return `${GCE_METADATA_BASE_URL}${metadataTokenPath(serviceAccount)}`;
}

/**
 * Validates an endpoint override, returning a defect name or `null`.
 *
 * Split out for `tokenUriDefect`'s reason: it is the one option whose value decides where a request
 * for this workload's identity goes, so the rule lives in one named function a test can enumerate.
 */
export function metadataEndpointDefect(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol !== "http:") {
    return "endpoint must be http (link-local) or https";
  }
  // `hostname` and not `host`: the port is irrelevant to whether the request stays on the instance,
  // and `host` carries it, so a local stand-in on :8080 would otherwise be refused. WHATWG keeps an
  // IPv6 literal's brackets in `hostname`, so they come off before the comparison.
  const host = parsed.hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return PLAINTEXT_METADATA_HOSTS.includes(host)
    ? null
    : `endpoint may only use http for a link-local or loopback host (${PLAINTEXT_METADATA_HOSTS.join(", ")}); use https elsewhere`;
}

/**
 * The request headers, built in exactly one place.
 *
 * `Metadata-Flavor: Google` is not optional and not configurable. Google requires it so that a
 * request which *cannot* carry a custom header — a form post, an image tag, a redirect followed by a
 * browser on the instance — can never reach the token endpoint. A request without it is refused by
 * the server, and more to the point it is the thing that makes an SSRF against this URL harmless. So
 * there is no code path that builds a header set without it: everything that sends a request calls
 * this.
 */
export function metadataRequestHeaders(): Record<string, string> {
  return {
    [METADATA_FLAVOR_HEADER]: METADATA_FLAVOR_VALUE,
    accept: "application/json",
  };
}

// ---------------------------------------------------------------------------
// The token response
// ---------------------------------------------------------------------------

export interface MetadataAccessToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/**
 * Reads `{"access_token":"ya29…","expires_in":3599,"token_type":"Bearer"}` — the same shape the
 * OAuth2 token endpoint answers with.
 *
 * Parsed here rather than by `fcm-token.ts`'s `parseAccessTokenResponse` only because of the error
 * it raises: that one reports an `FcmTokenError`, whose kinds are the service-account route's, and a
 * caller that received one from this provider would be told to check a private key it does not have.
 * The duplicated twenty lines buy one coherent failure vocabulary per route.
 *
 * A missing or non-positive `expires_in` is malformed rather than a token with an assumed lifetime:
 * guessing would either re-mint on every send or cache a token past its real expiry and turn every
 * push into a 401. It is capped for the opposite reason — a response claiming a week is a broken
 * stand-in or a token somebody wants us to keep presenting long after the identity was unbound.
 */
export function parseMetadataTokenResponse(body: string): MetadataAccessToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MetadataTokenError({
      kind: "malformed_token_response",
      message: "the metadata server answered 2xx with a body that is not JSON",
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MetadataTokenError({
      kind: "malformed_token_response",
      message: "the metadata server answered 2xx with a body that is not an object",
    });
  }
  const record = parsed as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new MetadataTokenError({
      kind: "malformed_token_response",
      message: "the metadata server response carries no access_token",
    });
  }
  const expiresIn = record["expires_in"];
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new MetadataTokenError({
      kind: "malformed_token_response",
      message: "the metadata server response carries no positive expires_in",
    });
  }
  return {
    accessToken,
    expiresInSeconds: Math.min(expiresIn, MAX_ACCESS_TOKEN_LIFETIME_SECONDS),
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export interface MetadataServerFcmTokenProviderOptions {
  readonly fetch?: FetchLike;
  readonly clock?: FcmTokenClock;
  /** A named service account instead of the attached `default`. */
  readonly serviceAccount?: string;
  /**
   * Scopes to narrow the token to. Omitted by default, which asks for the instance's own scopes —
   * what GKE workload identity grants. Requesting a scope the instance may not have is a 400, so a
   * deployment that does not know its bindings is better off not asking.
   */
  readonly scopes?: readonly string[];
  /** Full URL, overriding the link-local default. Validated by `metadataEndpointDefect`. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly expirySkewSeconds?: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * Fetches and caches FCM access tokens from the GCE/GKE instance metadata server.
 *
 * Not declared `implements FcmAccessTokenProvider`, for the reason
 * `ServiceAccountFcmTokenProvider` is not: that seam is the function type `() => Promise<string>`,
 * and TypeScript cannot have a class implement a bare call signature. The conformance is
 * `asProvider()`, which returns exactly that function with `this` bound — so the two providers are
 * interchangeable at `FcmPushSender`'s call site, which is the whole point of writing this one.
 */
export class MetadataServerFcmTokenProvider {
  private readonly fetchImpl: FetchLike;
  private readonly clock: FcmTokenClock;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly expirySkewMs: number;

  private cached: CachedToken | null = null;
  /** The fetch in flight, so N concurrent sends make one request. See `token()`. */
  private inFlight: Promise<string> | null = null;

  /*
   * Refused here, at construction, and never at the first push — `ServiceAccountFcmTokenProvider`'s
   * rule and ADR-0301's: a deployment whose configuration is wrong must find out when
   * `buildSenderRegistryFromEnv` runs, where the channel is skipped with a visible reason, rather
   * than at 03:00 when the first push of the night becomes an opaque failure.
   *
   * Note what is *not* checked: whether the metadata server is actually there. Probing it at
   * construction would make boot depend on a link-local request, add the timeout to every start, and
   * answer a question that is already settled — a deployment reaches this class because it *said* it
   * runs on GCE.
   */
  constructor(opts: MetadataServerFcmTokenProviderOptions = {}) {
    const serviceAccount = opts.serviceAccount ?? DEFAULT_METADATA_SERVICE_ACCOUNT;
    if (serviceAccount.length === 0) {
      throw new MetadataTokenError({
        kind: "invalid_configuration",
        message: "serviceAccount must not be empty",
      });
    }
    let url = opts.endpoint ?? defaultMetadataTokenUrl(serviceAccount);
    if (opts.endpoint !== undefined) {
      const defect = metadataEndpointDefect(opts.endpoint);
      if (defect !== null) {
        throw new MetadataTokenError({
          kind: "invalid_configuration",
          message: `metadata endpoint is unusable: ${defect}`,
        });
      }
    }
    if (opts.scopes !== undefined && opts.scopes.length > 0) {
      const query = new URLSearchParams({ scopes: opts.scopes.join(",") });
      url = `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_METADATA_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      // Unbounded is the one value this must not accept: off GCE the address never answers, and a
      // send that waits forever is worse than a send that fails.
      throw new MetadataTokenError({
        kind: "invalid_configuration",
        message: "timeoutMs must be a positive number of milliseconds",
      });
    }
    const skewSeconds = opts.expirySkewSeconds ?? TOKEN_EXPIRY_SKEW_SECONDS;
    if (skewSeconds < 0) {
      throw new MetadataTokenError({
        kind: "invalid_configuration",
        message: "expirySkewSeconds must not be negative",
      });
    }

    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.clock = opts.clock ?? systemTokenClock;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.expirySkewMs = skewSeconds * 1000;
  }

  /** The URL this provider will read tokens from. Readable for a boot-time log line. */
  tokenEndpoint(): string {
    return this.url;
  }

  /**
   * When the cached token stops being served — already skew-adjusted, so it answers "will the next
   * send fetch?" rather than being a figure a caller has to adjust. `null` means nothing cached.
   */
  cachedTokenServableUntilMs(): number | null {
    return this.cached === null
      ? null
      : this.cached.expiresAtMs - this.expirySkewMs;
  }

  /** Drops the cache, e.g. after FCM answered 401 — the next call fetches. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * A bearer token valid now, cached across calls and fetched once across concurrent ones.
   *
   * The in-flight promise carries the same weight it does on the service-account route, for a
   * different reason: these requests are cheap, but the metadata server is a single process on the
   * node shared by every workload on it, and a drain loop that asked it once per message in a batch
   * would be the one making it slow.
   *
   * A rejection must not be remembered: `inFlight` is cleared in `finally` and the cache is written
   * only on success, so the next caller retries rather than inheriting a failure.
   */
  async token(): Promise<string> {
    const nowMs = this.clock.nowMs();
    const cached = this.cached;
    if (cached !== null && nowMs + this.expirySkewMs < cached.expiresAtMs) {
      return cached.token;
    }
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const fetching = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = fetching;
    return fetching;
  }

  /** The seam `FcmPushSenderOptions.accessToken` declares, with `this` bound. */
  asProvider(): () => Promise<string> {
    return () => this.token();
  }

  private async fetchToken(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let ok: boolean;
    let body: string;
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        // The mandatory header, from the one function that builds it. No authorization header is
        // sent and none exists: the request's origin is the credential.
        headers: metadataRequestHeaders(),
        signal: controller.signal,
      });
      status = response.status;
      ok = response.ok;
      body = await response.text();
    } catch (err) {
      const kind = classifyMetadataTransportFailure(err);
      throw new MetadataTokenError({
        kind,
        message: truncateErrorMessage(
          kind === "metadata_server_unreachable"
            ? `the metadata server at ${GCE_METADATA_HOST} does not resolve or is unroutable: this deployment is not running on GCE/GKE, so supply a service-account key instead (${describe(err)})`
            : `could not read a token from the metadata server: ${describe(err)}`,
        ),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      throw new MetadataTokenError({
        kind: classifyMetadataResponse(status),
        status,
        // The body is a short diagnostic string here, not a credential — but it is still truncated
        // and not parsed for anything, because the status is what the classification turns on.
        message: truncateErrorMessage(
          `the metadata server answered ${status.toString()}`,
        ),
      });
    }

    const token = parseMetadataTokenResponse(body);
    // The clock is read again rather than before the request: `expires_in` is relative to the
    // server's answer, so dating the cache from the earlier instant would over-estimate the token's
    // remaining life — the same correction `fcm-token.ts` makes.
    this.cached = {
      token: token.accessToken,
      expiresAtMs: this.clock.nowMs() + token.expiresInSeconds * 1000,
    };
    return token.accessToken;
  }
}

/**
 * The one-line wiring an app wants: the `FcmAccessTokenProvider` function, straight out.
 *
 * Still refuses at construction — the refusal happens when this is called, which is boot — so using
 * it does not trade the fail-at-boot rule for brevity.
 */
export function metadataServerFcmTokenProvider(
  opts: MetadataServerFcmTokenProviderOptions = {},
): () => Promise<string> {
  return new MetadataServerFcmTokenProvider(opts).asProvider();
}

/*
 * Nothing about a credential appears in any message this module produces, because there is no
 * credential here to appear — which is the one genuine advantage of this route over a key file. What
 * `describe` does guard is the other direction: an arbitrary thrown value is rendered as its message
 * or its string form and nothing is read out of it, so a stand-in endpoint that throws an object
 * carrying a token cannot push it into a log line.
 */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCodeOf(err);
    return code === null ? err.message : `${code}: ${err.message}`;
  }
  return typeof err === "string" ? err : "a non-Error value was thrown";
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return { ok: response.ok, status: response.status, text: () => response.text() };
};
