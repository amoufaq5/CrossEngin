import { createPrivateKey, createSign } from "node:crypto";

import { truncateErrorMessage, type FetchLike } from "./email-ses.js";

/*
 * The `FcmAccessTokenProvider` ADR-0310 left injected.
 *
 * FCM HTTP v1 authenticates with a short-lived OAuth2 access token, and the only way to get one for
 * a service account is the JWT-bearer flow (RFC 7523): build a JWT asserting "I am this service
 * account and I want this scope", RS256-sign it with the account's private key, POST it to Google's
 * token endpoint, and cache what comes back. That is a private key at rest, a second HTTP endpoint
 * and refresh state with a clock — which is exactly why ADR-0310 refused to put it inside
 * `push-fcm.ts` and made it a seam. This module is the seam's service-account implementation, and
 * nothing more: it does not send a push, it does not know what a `SendRequest` is, and it keeps the
 * package's rule that the only I/O is an injected `fetch`.
 *
 * It deliberately covers **only** the service-account route. The other route is the instance
 * metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/
 * default/token`), which is the correct source on GKE, Cloud Run and GCE because there is no key
 * file there at all — the platform holds the credential and hands out tokens directly, so none of
 * the signing below exists on that path. A deployment on those hosts wants a second, much smaller
 * provider against that endpoint, not a flag on this one; the two share only the cache, and the
 * cache is the easy part.
 *
 * Why `node:crypto` directly and not `@crossengin/crypto`: that package signs Ed25519 and HMACs
 * SHA-256, and Google requires RS256 over a 2048-bit RSA key. There is no primitive there to reuse,
 * so `createSign("RSA-SHA256")` is used as the primitive — and no JWT library is added, because the
 * whole of a signed JWT is two base64url segments, a dot, and one signature.
 */

/** The narrowest scope that can send a message. `cloud-platform` also works and grants far more. */
export const FCM_MESSAGING_SCOPE =
  "https://www.googleapis.com/auth/firebase.messaging";

export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** RFC 7523's grant type. Google accepts no other for a service-account assertion. */
export const JWT_BEARER_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * How long the signed assertion is valid.
 *
 * Google permits up to an hour. Ten minutes is used instead because the assertion is a **bearer
 * credential in its own right** — anyone holding it can exchange it for an access token with this
 * scope — and it is needed for exactly one round trip, so an hour of validity buys nothing and
 * leaves a usable credential in any proxy log, trace or crash dump that captured the request body
 * for the rest of that hour.
 *
 * It is not shorter than this for the opposite reason: `iat`/`exp` are checked against *Google's*
 * clock, and a host a few minutes adrift would have every mint refused with `invalid_grant` — the
 * non-retryable class, which would make a drifted NTP look exactly like a wrong service account.
 * Ten minutes absorbs that drift without being a long-lived secret.
 */
export const ASSERTION_LIFETIME_SECONDS = 600;

/**
 * How early a cached token stops being served.
 *
 * The cache must stop handing out a token *before* it expires, not when: between this provider
 * returning a token and FCM receiving it there is a queued send, a TLS handshake and possibly a
 * retry inside the sender, and a token that lapses in that gap is a 401 — which
 * `classifyFcmFailure` reads as `failed`, retryable, indistinguishable from a revoked service
 * account. Sixty seconds covers that gap plus plausible drift between our clock and Google's.
 *
 * The cost is bounded and small: Google issues ~3600-second tokens, so refreshing a minute early
 * is about one extra mint per hour per process, not one per send.
 */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/**
 * A ceiling on how long a response's `expires_in` may pin the cache.
 *
 * Google's tokens last an hour and nothing legitimate exceeds that, so a response claiming a week
 * is either a broken stand-in or an attacker who wants us to keep presenting one token. Capping
 * means the worst case is an extra mint, where trusting it means serving a stale credential long
 * after the service account was revoked.
 */
export const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;

export const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/*
 * The same shape `ai-providers-anthropic`'s `AnthropicError` uses: a closed kind vocabulary, an
 * explicit retryable set, and one error class carrying both. A caller needs the distinction because
 * the two failure families want opposite responses — "the token endpoint is unreachable" is worth
 * another attempt in a minute, and "this service account is wrong" will answer the same forever and
 * wants a human.
 */
export const FCM_TOKEN_ERROR_KINDS = [
  /** The credentials were rejected at construction: shape, not Google's verdict. */
  "invalid_credentials",
  /** The PEM parsed as a PEM but OpenSSL would not sign with it. */
  "signing_failed",
  /** Google's `invalid_grant`: wrong account, revoked or deleted key, or a badly skewed clock. */
  "invalid_grant",
  /** Google's `unauthorized_client`: the account exists but may not have this scope. */
  "unauthorized_client",
  /** Any other 4xx from the token endpoint. */
  "token_endpoint_rejected",
  /** 5xx from the token endpoint. */
  "token_endpoint_unavailable",
  /** 429 from the token endpoint. */
  "rate_limited",
  /** 2xx whose body is not a usable token response. */
  "malformed_token_response",
  /** The injected `fetch` threw, or the request was aborted. */
  "network_error",
] as const;
export type FcmTokenErrorKind = (typeof FCM_TOKEN_ERROR_KINDS)[number];

/**
 * The kinds where another attempt can plausibly succeed without anything changing.
 *
 * `malformed_token_response` is deliberately **not** here even though a flaky proxy could cause it:
 * the endpoint answered successfully, so an identical request gets an identical body, and the
 * overwhelmingly likely cause is a `tokenUri` pointing at something that is not Google's token
 * endpoint. Retrying a misconfiguration only collects it again — the same reason the page
 * dispatcher retries `failed` and never `rejected`.
 */
export const RETRYABLE_FCM_TOKEN_ERROR_KINDS: ReadonlySet<FcmTokenErrorKind> =
  new Set(["token_endpoint_unavailable", "rate_limited", "network_error"]);

export class FcmTokenError extends Error {
  readonly kind: FcmTokenErrorKind;
  readonly status: number | null;

  constructor(input: {
    readonly kind: FcmTokenErrorKind;
    readonly message: string;
    readonly status?: number | null;
  }) {
    super(input.message);
    this.name = "FcmTokenError";
    this.kind = input.kind;
    this.status = input.status ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_FCM_TOKEN_ERROR_KINDS.has(this.kind);
  }
}

/**
 * Google's OAuth2 error codes, mapped to this vocabulary.
 *
 * The split that matters is `invalid_grant` versus a 5xx: both arrive as "no token", but one means
 * the deployment's service account is wrong and will never work, and the other means Google is
 * having a bad minute. Classifying them together would either retry a dead credential forever or
 * give up on a transient outage.
 */
export function classifyTokenEndpointFailure(
  status: number,
  code: string | null,
): FcmTokenErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "token_endpoint_unavailable";
  if (code === "invalid_grant") return "invalid_grant";
  if (code === "unauthorized_client") return "unauthorized_client";
  return "token_endpoint_rejected";
}

export interface TokenEndpointError {
  readonly code: string | null;
  readonly description: string | null;
}

/** RFC 6749 §5.2: `{"error":"invalid_grant","error_description":"…"}`. */
export function parseTokenEndpointError(body: string): TokenEndpointError {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { code: null, description: null };
    }
    const record = parsed as Record<string, unknown>;
    const code = record["error"];
    const description = record["error_description"];
    return {
      code: typeof code === "string" && code.length > 0 ? code : null,
      description:
        typeof description === "string" && description.length > 0
          ? description
          : null,
    };
  } catch {
    return { code: null, description: null };
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface ServiceAccountCredentials {
  readonly clientEmail: string;
  readonly privateKeyPem: string;
  /** Overridden for an egress proxy or a stand-in receiver; https only. */
  readonly tokenUri?: string;
}

const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
const PKCS8_FOOTER = "-----END PRIVATE KEY-----";
const PKCS1_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS1_FOOTER = "-----END RSA PRIVATE KEY-----";

/*
 * Shape only, and the local part is not pattern-matched beyond "no whitespace, one `@`, a dotted
 * domain". Google's own accounts are `<name>@<project>.iam.gserviceaccount.com`, but requiring that
 * suffix would refuse a perfectly valid stand-in endpoint in a staging deployment while catching
 * nothing a real defect produces — the defects this check exists for are an empty string, a project
 * id pasted into the wrong field, and a whole PEM pasted into the wrong field.
 */
const CLIENT_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Turns the two-character sequence `\n` into a real newline.
 *
 * This exists for one specific, extremely common deployment defect: a key file's JSON holds
 * `"-----BEGIN PRIVATE KEY-----\nMIIE…"`, where `\n` is a JSON escape that `JSON.parse` resolves —
 * but the same string lifted into an environment variable, a Kubernetes secret or a `.env` file
 * arrives with the backslash and the `n` as two literal characters, and OpenSSL then refuses a PEM
 * whose base64 body is one 1600-character line. Normalising here turns an inscrutable
 * `signing_failed` at the first push into a key that simply works.
 */
export function normalizePrivateKeyPem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

/**
 * Asks OpenSSL to decode the key and confirms it is RSA, returning a defect name or `null`.
 *
 * The PEM header check above cannot do this, and the gap matters: an EC key is also wrapped in
 * `-----BEGIN PRIVATE KEY-----`, so it passes every textual check — and then
 * `createSign("RSA-SHA256")` **succeeds** with it, because that name selects the digest and node
 * takes the algorithm from the key. The result is a valid ECDSA JWT that Google refuses with
 * `invalid_grant`: the non-retryable kind, reported as "this service account is wrong", for a key
 * that is merely the wrong type. Catching it here turns a 3am misdiagnosis into a boot refusal.
 *
 * Nothing is read out of the key or out of OpenSSL's error. The decode either works or does not.
 */
export function privateKeyDefect(pem: string): string | null {
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey(pem).asymmetricKeyType;
  } catch {
    return "privateKeyPem could not be decoded as a private key";
  }
  return keyType === "rsa"
    ? null
    : `privateKeyPem is a ${keyType ?? "unknown"} key; Google's JWT-bearer flow requires RS256 over an RSA key`;
}

/**
 * Every way credentials can be unusable, named without ever quoting the key.
 *
 * Returned rather than thrown so that both `parseServiceAccountJson` and the constructor refuse in
 * the same words, and so the defects are a list a test can enumerate.
 *
 * **No refusal ever interpolates `privateKeyPem`**, or any slice of it. The one fact taken from the
 * key is whether a header line is present, which is a yes/no about its first line and not material.
 * A message that quoted the key would carry it into a boot log, a crash report and whatever
 * aggregates those — and a private key in a log is a private key that has to be rotated.
 */
export function serviceAccountDefects(
  input: Readonly<Partial<ServiceAccountCredentials>>,
): readonly string[] {
  const defects: string[] = [];

  const email = input.clientEmail ?? "";
  if (email.length === 0) {
    defects.push("clientEmail is missing");
  } else if (!CLIENT_EMAIL_PATTERN.test(email)) {
    defects.push("clientEmail is not an email address");
  }

  const pem = input.privateKeyPem ?? "";
  if (pem.length === 0) {
    defects.push("privateKeyPem is missing");
  } else {
    const hasPkcs8 = pem.includes(PKCS8_HEADER) && pem.includes(PKCS8_FOOTER);
    const hasPkcs1 = pem.includes(PKCS1_HEADER) && pem.includes(PKCS1_FOOTER);
    if (!hasPkcs8 && !hasPkcs1) {
      // Named separately because the three wrong things a deployment actually pastes here — the
      // public half, the certificate, or the whole JSON file — each have a recognisable first line,
      // and saying which one it is saves the operator a round trip.
      if (pem.includes("PUBLIC KEY")) {
        defects.push("privateKeyPem is a public key, not a private key");
      } else if (pem.includes("BEGIN CERTIFICATE")) {
        defects.push("privateKeyPem is a certificate, not a private key");
      } else {
        defects.push("privateKeyPem is not a PEM-encoded private key");
      }
    } else {
      const keyDefect = privateKeyDefect(pem);
      if (keyDefect !== null) defects.push(keyDefect);
    }
  }

  if (input.tokenUri !== undefined) {
    const uriDefect = tokenUriDefect(input.tokenUri);
    if (uriDefect !== null) defects.push(uriDefect);
  }

  return defects;
}

/** Split out because the constructor's `endpoint` override has to clear the same bar alone. */
export function tokenUriDefect(tokenUri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(tokenUri);
  } catch {
    return "tokenUri is not a URL";
  }
  // The assertion in the body is a bearer credential. Allowing http — even for a local stand-in —
  // would make "it works in staging" the reason production ships a plaintext credential exchange,
  // so the refusal has no escape hatch.
  return parsed.protocol === "https:" ? null : "tokenUri must be https";
}

function refuseCredentials(defects: readonly string[]): FcmTokenError {
  return new FcmTokenError({
    kind: "invalid_credentials",
    message: `service account credentials are unusable: ${defects.join("; ")}`,
  });
}

/**
 * Reads Google's service-account JSON key file verbatim — the file the console downloads, with its
 * `client_email`, `private_key` and `token_uri` fields — so a deployment supplies the file it has
 * rather than transcribing three fields out of it.
 *
 * Throws `FcmTokenError` with kind `invalid_credentials`, which is the same error the constructor
 * raises for the same reasons: a deployment that fails here has failed at boot, which is the point.
 * The raw text is never included in the message, because the raw text contains the key.
 */
export function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refuseCredentials(["the service account key is not valid JSON"]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refuseCredentials(["the service account key is not a JSON object"]);
  }
  const record = parsed as Record<string, unknown>;

  const type = record["type"];
  if (typeof type === "string" && type !== "service_account") {
    // Google's other key shapes (`authorized_user`, `external_account`) have different fields and
    // a different flow entirely; failing on the declared type beats failing on a missing field.
    throw refuseCredentials([`key type '${type}' is not a service account`]);
  }

  const clientEmail = record["client_email"];
  const privateKey = record["private_key"];
  const tokenUri = record["token_uri"];

  const candidate: Partial<ServiceAccountCredentials> = {
    clientEmail: typeof clientEmail === "string" ? clientEmail.trim() : "",
    privateKeyPem:
      typeof privateKey === "string" ? normalizePrivateKeyPem(privateKey) : "",
    ...(typeof tokenUri === "string" && tokenUri.length > 0
      ? { tokenUri }
      : {}),
  };

  const defects = serviceAccountDefects(candidate);
  if (defects.length > 0) throw refuseCredentials(defects);

  return {
    clientEmail: candidate.clientEmail as string,
    privateKeyPem: candidate.privateKeyPem as string,
    ...(candidate.tokenUri !== undefined ? { tokenUri: candidate.tokenUri } : {}),
  };
}

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

/** Injected so no test reads the wall clock, and so a mint is reproducible. */
export interface FcmTokenClock {
  nowMs(): number;
}

export const systemTokenClock: FcmTokenClock = { nowMs: () => Date.now() };

export interface JwtAssertionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly scope: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * The claim set Google checks.
 *
 * `aud` is the token endpoint itself — the assertion says "this is for exchanging at *this*
 * endpoint", which is what stops one captured at a proxy being replayed against another Google API.
 * `sub` equals `iss` deliberately: a `sub` naming a *different* principal is domain-wide
 * delegation, impersonating a Workspace user, which this provider does not do and must not be able
 * to do by accident.
 *
 * `iat`/`exp` are seconds, floored from the injected clock — a fractional `iat` is rejected.
 */
export function buildJwtAssertionClaims(input: {
  readonly credentials: ServiceAccountCredentials;
  readonly tokenUri: string;
  readonly nowMs: number;
  readonly lifetimeSeconds?: number;
}): JwtAssertionClaims {
  const iat = Math.floor(input.nowMs / 1000);
  return {
    iss: input.credentials.clientEmail,
    sub: input.credentials.clientEmail,
    aud: input.tokenUri,
    scope: FCM_MESSAGING_SCOPE,
    iat,
    exp: iat + (input.lifetimeSeconds ?? ASSERTION_LIFETIME_SECONDS),
  };
}

/** Node's `base64url` encoding is already unpadded, which is what RFC 7515 requires. */
function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export const JWT_HEADER = { alg: "RS256", typ: "JWT" } as const;

/** `base64url(header).base64url(claims)` — the bytes that are signed, and nothing else. */
export function jwtSigningInput(claims: JwtAssertionClaims): string {
  return `${base64UrlJson(JWT_HEADER)}.${base64UrlJson(claims)}`;
}

/**
 * RS256 over the signing input.
 *
 * The OpenSSL error is deliberately **not** forwarded. It does not contain key bytes today, but a
 * message built from a failing key's decode path is one library version away from carrying a
 * fragment of it, and the two causes worth naming — an EC or Ed25519 key where RSA is required, and
 * a PEM whose body is corrupt — are named here without reading anything out of the key.
 */
export function signJwtAssertion(
  claims: JwtAssertionClaims,
  privateKeyPem: string,
): string {
  const signingInput = jwtSigningInput(claims);
  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput, "utf8");
    signature = signer.sign(privateKeyPem);
  } catch {
    throw new FcmTokenError({
      kind: "signing_failed",
      message:
        "could not RS256-sign the assertion: the private key is not an RSA key, or its PEM body is corrupt",
    });
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** RFC 7523 §2.1: the grant type and the assertion, form-encoded. No client secret exists. */
export function tokenRequestForm(assertion: string): string {
  return new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion,
  }).toString();
}

// ---------------------------------------------------------------------------
// The token response
// ---------------------------------------------------------------------------

export interface AccessTokenResponse {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/**
 * Reads `{"access_token":"ya29…","expires_in":3599,"token_type":"Bearer"}`.
 *
 * A missing or non-positive `expires_in` is a malformed response rather than a token with an
 * assumed lifetime: guessing one would either re-mint on every send or, far worse, cache a token
 * past its real expiry and turn every push into a 401. `expires_in` is capped at
 * `MAX_ACCESS_TOKEN_LIFETIME_SECONDS` for the same reason in the other direction.
 */
export function parseAccessTokenResponse(body: string): AccessTokenResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new FcmTokenError({
      kind: "malformed_token_response",
      message: "the token endpoint answered 2xx with a body that is not JSON",
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FcmTokenError({
      kind: "malformed_token_response",
      message: "the token endpoint answered 2xx with a body that is not an object",
    });
  }
  const record = parsed as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new FcmTokenError({
      kind: "malformed_token_response",
      message: "the token endpoint response carries no access_token",
    });
  }
  const expiresIn = record["expires_in"];
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new FcmTokenError({
      kind: "malformed_token_response",
      message: "the token endpoint response carries no positive expires_in",
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

export interface ServiceAccountFcmTokenProviderOptions {
  readonly credentials: ServiceAccountCredentials;
  readonly fetch?: FetchLike;
  readonly clock?: FcmTokenClock;
  /** Full URL of the token endpoint; overrides the credentials' `token_uri` and the default. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly assertionLifetimeSeconds?: number;
  readonly expirySkewSeconds?: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * Mints and caches FCM access tokens from a service-account key.
 *
 * Not declared `implements FcmAccessTokenProvider`: that contract is the function type
 * `() => Promise<string>`, and TypeScript cannot have a class implement a bare call signature. The
 * conformance is `asProvider()`, which hands back exactly that function with `this` bound — so what
 * `FcmPushSender` receives is still the seam ADR-0310 declared, unchanged.
 */
export class ServiceAccountFcmTokenProvider {
  private readonly credentials: ServiceAccountCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly clock: FcmTokenClock;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly assertionLifetimeSeconds: number;
  private readonly expirySkewMs: number;

  private cached: CachedToken | null = null;
  /** The mint in flight, so N concurrent sends make one request. See `token()`. */
  private inFlight: Promise<string> | null = null;

  /*
   * Refused here, at construction, and never at the first push. This is the rule `SmsPageSender` and
   * `WebhookPageSender` follow and it is load-bearing for the same reason: a deployment whose key is
   * half configured must find out when `buildSenderRegistryFromEnv` runs — where ADR-0301's rule
   * then skips the provider and leaves a visible gap at boot — rather than at 03:00 when the first
   * push of the night turns into a retryable `failed` with an opaque cause.
   */
  constructor(opts: ServiceAccountFcmTokenProviderOptions) {
    const defects = serviceAccountDefects(opts.credentials);
    if (defects.length > 0) throw refuseCredentials(defects);

    const endpoint = opts.endpoint ?? opts.credentials.tokenUri ?? GOOGLE_TOKEN_URI;
    // An explicit `endpoint` bypasses the credentials, so it has to clear the same bar: otherwise
    // `tokenUri`'s https rule would be one option away from being optional.
    const endpointDefect = tokenUriDefect(endpoint);
    if (endpointDefect !== null) throw refuseCredentials([endpointDefect]);

    const skewSeconds = opts.expirySkewSeconds ?? TOKEN_EXPIRY_SKEW_SECONDS;
    if (skewSeconds < 0) {
      throw new FcmTokenError({
        kind: "invalid_credentials",
        message: "expirySkewSeconds must not be negative",
      });
    }
    const lifetime = opts.assertionLifetimeSeconds ?? ASSERTION_LIFETIME_SECONDS;
    if (lifetime <= 0 || lifetime > 3600) {
      // Google's hard ceiling. A longer assertion is refused outright rather than being silently
      // clamped, because a deployment that asked for two hours has a belief worth correcting.
      throw new FcmTokenError({
        kind: "invalid_credentials",
        message: "assertionLifetimeSeconds must be between 1 and 3600",
      });
    }

    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.clock = opts.clock ?? systemTokenClock;
    this.endpoint = endpoint;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
    this.assertionLifetimeSeconds = lifetime;
    this.expirySkewMs = skewSeconds * 1000;
  }

  /** The endpoint this provider will exchange assertions at. Readable for a boot-time log line. */
  tokenEndpoint(): string {
    return this.endpoint;
  }

  /**
   * When the cached token stops being served — already skew-adjusted, so it is the answer to "will
   * the next send mint?" rather than a figure a caller has to adjust. `null` means nothing cached.
   */
  cachedTokenServableUntilMs(): number | null {
    return this.cached === null
      ? null
      : this.cached.expiresAtMs - this.expirySkewMs;
  }

  /** Drops the cache, e.g. after FCM answered 401 — the next call mints. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * A bearer token valid now, cached across calls and minted once across concurrent ones.
   *
   * The in-flight promise is the whole of the concurrency rule: a drain loop sending a batch of
   * pushes calls this once per message, and without it every one of them would sign an assertion
   * and POST it — N round trips to mint N copies of the same token, and enough of them to meet
   * Google's rate limit on the token endpoint, turning a burst of pushes into a burst of failures.
   *
   * A rejection must not be remembered. `inFlight` is cleared in `finally`, and the cache is only
   * written on success, so the *next* caller retries rather than inheriting a failure — which is
   * what makes a 5xx at the token endpoint a delayed push rather than a dead channel.
   */
  async token(): Promise<string> {
    const nowMs = this.clock.nowMs();
    const cached = this.cached;
    if (cached !== null && nowMs + this.expirySkewMs < cached.expiresAtMs) {
      return cached.token;
    }
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const mint = this.mint().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = mint;
    return mint;
  }

  /** The seam `FcmPushSenderOptions.accessToken` declares, with `this` bound. */
  asProvider(): () => Promise<string> {
    return () => this.token();
  }

  private async mint(): Promise<string> {
    const claims = buildJwtAssertionClaims({
      credentials: this.credentials,
      tokenUri: this.endpoint,
      nowMs: this.clock.nowMs(),
      lifetimeSeconds: this.assertionLifetimeSeconds,
    });
    const assertion = signJwtAssertion(claims, this.credentials.privateKeyPem);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let ok: boolean;
    let body: string;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: tokenRequestForm(assertion),
        signal: controller.signal,
      });
      status = response.status;
      ok = response.ok;
      body = await response.text();
    } catch (err) {
      // Unlike the senders, a transport failure is classified rather than propagated raw: the
      // sender's contract says a throw from the provider becomes `failed` / `sender_threw`, which
      // loses the one fact a caller wants — whether retrying can help. `network_error` keeps it.
      throw new FcmTokenError({
        kind: "network_error",
        message: truncateErrorMessage(
          `could not reach the token endpoint: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      const parsed = parseTokenEndpointError(body);
      throw new FcmTokenError({
        kind: classifyTokenEndpointFailure(status, parsed.code),
        status,
        message: truncateErrorMessage(
          `the token endpoint answered ${status.toString()}${
            parsed.code === null ? "" : ` (${parsed.code})`
          }${parsed.description === null ? "" : `: ${parsed.description}`}`,
        ),
      });
    }

    const token = parseAccessTokenResponse(body);
    // The clock is read again rather than reusing the assertion's `iat`: the round trip took time,
    // and `expires_in` is relative to Google's answer, not to when we started signing. Dating the
    // cache from the earlier instant would over-estimate the token's remaining life.
    this.cached = {
      token: token.accessToken,
      expiresAtMs: this.clock.nowMs() + token.expiresInSeconds * 1000,
    };
    return token.accessToken;
  }
}

/**
 * The one-line wiring an app wants: credentials in, the `FcmAccessTokenProvider` function out.
 *
 * It still refuses at construction — the refusal happens when this is called, which is boot — so
 * using it does not trade the fail-at-boot rule for brevity.
 */
export function serviceAccountFcmTokenProvider(
  opts: ServiceAccountFcmTokenProviderOptions,
): () => Promise<string> {
  return new ServiceAccountFcmTokenProvider(opts).asProvider();
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return { ok: response.ok, status: response.status, text: () => response.text() };
};
