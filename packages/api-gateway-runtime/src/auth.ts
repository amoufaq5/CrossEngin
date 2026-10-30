import {
  API_KEY_HEADER,
  type AuthOutcome,
  type AuthScheme,
  type IncomingRequest,
  type ParsedAuthCredential,
  type ResolvedPrincipal,
} from "@crossengin/api-gateway";
import {
  constantTimeEqualHex,
  sha256,
  verifyEd25519,
} from "@crossengin/crypto";

import type { PrincipalResolver } from "./stores.js";

export interface ParsedJwt {
  readonly headerB64: string;
  readonly payloadB64: string;
  readonly signatureB64: string;
  readonly header: { readonly alg: string; readonly kid?: string; readonly typ?: string };
  readonly payload: {
    readonly iss?: string;
    readonly aud?: string | readonly string[];
    readonly sub?: string;
    readonly exp?: number;
    readonly iat?: number;
    readonly nbf?: number;
    readonly scope?: string;
    readonly scp?: readonly string[];
    readonly tenant_id?: string;
    readonly [k: string]: unknown;
  };
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function safeJsonParse(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const headerObj = safeJsonParse(base64UrlDecode(headerB64));
  if (headerObj === null) return null;
  if (typeof headerObj["alg"] !== "string") return null;
  const payloadObj = safeJsonParse(base64UrlDecode(payloadB64));
  if (payloadObj === null) return null;
  return {
    headerB64,
    payloadB64,
    signatureB64,
    header: {
      alg: headerObj["alg"],
      kid: typeof headerObj["kid"] === "string" ? headerObj["kid"] : undefined,
      typ: typeof headerObj["typ"] === "string" ? headerObj["typ"] : undefined,
    },
    payload: payloadObj as ParsedJwt["payload"],
  };
}

export interface JwksProvider {
  getPublicKeyForKid(kid: string): Promise<string | null>;
}

export interface InMemoryJwksOptions {
  readonly keys: ReadonlyArray<{ readonly kid: string; readonly publicKeyBase64: string }>;
}

export class InMemoryJwksProvider implements JwksProvider {
  private readonly keys: Map<string, string>;
  constructor(opts: InMemoryJwksOptions) {
    this.keys = new Map();
    for (const k of opts.keys) {
      this.keys.set(k.kid, k.publicKeyBase64);
    }
  }
  async getPublicKeyForKid(kid: string): Promise<string | null> {
    return this.keys.get(kid) ?? null;
  }
}

/**
 * The JWT claims whose **absence** this gateway can be made to refuse, and what each absence costs.
 *
 * Three and not four: `nbf`'s absence means *valid from issuance*, which is coherent and is what
 * most minters emit, so there is nothing to refuse. The other three are each a guarantee silently
 * dropped, and the costs differ enough that an operator relaxing one must not be taken to have
 * relaxed the others — which is why the relaxation is declared per claim rather than as a boolean.
 *
 * A map rather than a list because the reason is the deliverable: this exists to be rendered into a
 * boot line and a refusal, and a fourth claim added here must say what its absence costs before it
 * can be required.
 */
export const REQUIRED_JWT_CLAIM_COSTS: Readonly<Record<"exp" | "iss" | "aud", string>> =
  Object.freeze({
    exp: "the token never expires, so --session-token-ttl and membership revocation bound nothing for it",
    iss: "nothing establishes which issuer minted it beyond the JWKS holding its key",
    aud: "nothing establishes which relying party it was minted for, so a token issued for another application sharing this key set is accepted here",
  });

export type RequiredJwtClaim = keyof typeof REQUIRED_JWT_CLAIM_COSTS;

export const REQUIRED_JWT_CLAIMS: readonly RequiredJwtClaim[] = Object.freeze(
  Object.keys(REQUIRED_JWT_CLAIM_COSTS) as RequiredJwtClaim[],
);

/**
 * Whether a claim is present **in a form the guard that reads it can use** — which is what
 * "present" has to mean here, and `!== undefined` is not it.
 *
 * Each predicate is exactly the type test its own guard below performs, and that correspondence is
 * the whole point: `exp: "soon"` is not `undefined`, so a presence check would admit it, and then
 * `typeof exp === "number"` is false so the expiry comparison is skipped — a token with an
 * unenforceable expiry, verified as `authenticated`. The same holds for a numeric `iss` and for an
 * `aud` that is an object. So requiring a claim and requiring it to be *usable* cannot be two
 * checks, or the first would hand the second a value it silently ignores: the defect this increment
 * closes, one step further in.
 *
 * A map so a fourth required claim must state its own usable form rather than inherit
 * `!== undefined`, which is the permissive answer.
 */
const CLAIM_IS_USABLE: Readonly<Record<RequiredJwtClaim, (v: unknown) => boolean>> = Object.freeze({
  exp: (v) => typeof v === "number",
  iss: (v) => typeof v === "string",
  // Both RFC 7519 §4.1.3 forms, matching the `audOk` computation below.
  aud: (v) => typeof v === "string" || Array.isArray(v),
});

export interface JwtVerificationOptions {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly clockSkewSeconds: number;
  readonly nowSeconds: number;
  /**
   * Which claims must be **present**, beyond being correct when present.
   *
   * Required and not optional, so no call site can forget it: before this existed every guard was
   * `present && wrong`, so a token carrying none of the three verified as `authenticated` — and an
   * optional field defaulting to *require nothing* would be that defect restated as a default
   * (ADR-0364's rule, ADR-0341's `abacAttributes` shape). A caller that means *require nothing*
   * passes an empty set and has said so.
   */
  readonly requiredClaims: ReadonlySet<RequiredJwtClaim>;
}

export interface JwtVerificationResult {
  readonly outcome: AuthOutcome;
  readonly reason?: string;
  readonly jwt?: ParsedJwt;
}

export async function verifyBearerJwt(input: {
  readonly token: string;
  readonly jwks: JwksProvider;
  readonly opts: JwtVerificationOptions;
}): Promise<JwtVerificationResult> {
  const jwt = parseJwt(input.token);
  if (jwt === null) {
    return { outcome: "credential_malformed", reason: "jwt is not a 3-part dot-separated string" };
  }
  if (jwt.header.alg !== "EdDSA") {
    return {
      outcome: "credential_malformed",
      reason: `unsupported alg ${jwt.header.alg}; only EdDSA is accepted`,
    };
  }
  if (jwt.header.kid === undefined) {
    return { outcome: "credential_malformed", reason: "jwt header missing 'kid'" };
  }
  const publicKey = await input.jwks.getPublicKeyForKid(jwt.header.kid);
  if (publicKey === null) {
    return { outcome: "credential_not_found", reason: `no public key for kid ${jwt.header.kid}` };
  }
  const signedPayload = new TextEncoder().encode(`${jwt.headerB64}.${jwt.payloadB64}`);
  const signatureBase64 = Buffer.from(base64UrlDecode(jwt.signatureB64)).toString("base64");
  if (!verifyEd25519(publicKey, signatureBase64, signedPayload)) {
    return { outcome: "invalid_signature", reason: "ed25519 signature did not verify" };
  }
  // Absence is checked **before** the three present-and-wrong guards below, and the ordering is the
  // decision rather than a style: a token missing a required claim cannot be compared, so running
  // the comparison first would answer `authenticated` for it — which is precisely the defect. Each
  // guard below therefore means *present and wrong*, and this one means *not present at all*, and
  // the two are different facts with different remedies (ADR-0384).
  //
  // Checked after the signature, not before, because an unsigned token establishes nothing at all
  // and reporting a missing claim for it would describe the shape of a credential this gateway has
  // not yet decided to believe — `rbacCheck`'s reason for evaluating an obligation only after the
  // role check (ADR-0340).
  for (const claim of REQUIRED_JWT_CLAIMS) {
    if (!input.opts.requiredClaims.has(claim)) continue;
    if (!CLAIM_IS_USABLE[claim](jwt.payload[claim])) {
      // The claim's own value is deliberately not in the reason: it reaches a log line and a
      // `StageResult.reason`, and a claim from an unverified-by-policy token is caller-controlled
      // (ADR-0367's rule, ADR-0373's `unreadableDetail`). "absent or not usable" rather than
      // "absent", because one branch covers both and claiming the narrower fact would be wrong for
      // a token carrying `exp: "soon"`.
      return { outcome: "required_claim_absent", reason: `${claim} is absent or not usable` };
    }
  }
  if (typeof jwt.payload.exp === "number" && jwt.payload.exp + input.opts.clockSkewSeconds < input.opts.nowSeconds) {
    return { outcome: "expired_token", reason: "exp is in the past" };
  }
  if (typeof jwt.payload.nbf === "number" && jwt.payload.nbf - input.opts.clockSkewSeconds > input.opts.nowSeconds) {
    return { outcome: "not_yet_valid_token", reason: "nbf is in the future" };
  }
  if (typeof jwt.payload.iss === "string" && jwt.payload.iss !== input.opts.expectedIssuer) {
    return { outcome: "issuer_mismatch", reason: `iss ${jwt.payload.iss} does not match expected ${input.opts.expectedIssuer}` };
  }
  const aud = jwt.payload.aud;
  const audOk =
    typeof aud === "string"
      ? aud === input.opts.expectedAudience
      : Array.isArray(aud) && aud.includes(input.opts.expectedAudience);
  if (aud !== undefined && !audOk) {
    return { outcome: "audience_mismatch", reason: "aud does not include expected audience" };
  }
  return { outcome: "authenticated", jwt };
}

/**
 * The query parameter `api_key_query` is recognised from.
 *
 * One spelling and not a set, and the asymmetry with the two `indistinguishable` schemes is
 * deliberate: reserving `?api_key=` commits only to never *accepting* it, which is already
 * `AUTH_SCHEME_SUPPORT`'s declared decision, so a client using some other spelling is no worse off
 * than before this existed. Reserving an `Authorization` auth-scheme token for HMAC would be the
 * opposite — a partial commitment whose unreserved half is served anonymously.
 */
export const API_KEY_QUERY_PARAM = "api_key";

/**
 * What `parseAuthHeader` found, as a discriminated union — so a reader cannot take the *scheme* and
 * leave the fact that a credential was presented.
 *
 * It was `{scheme: AuthScheme | null, token: string | null, raw: string | null}`, whose last two
 * arms differed only in `raw`: a presented-but-unrecognised header set it and an absent one did not.
 * `raw` had **zero readers** in this package (measured on the committed tree: no `.raw` outside the
 * tests, and `ctx.parsedAuth` was read at exactly one site), so both arms recorded
 * `parse_auth_credential` reason `no_credential` and `authenticate` outcome `pass` reason
 * `no_credential_skipped` — a request that presented an `Authorization` header was recorded as
 * having presented none, and an operator debugging it went to check a client that was working.
 *
 * `token` is non-nullable on the one arm that has it, which is the other half: the authenticate
 * stage used to test `parsed.token === null` alongside `parsed.scheme === null` and fold both into
 * the anonymous path.
 */
export type ParseAuthHeaderResult =
  | {
      /** A credential in a scheme this gateway can name — served or refused, which the support map decides. */
      readonly kind: "credential";
      readonly scheme: AuthScheme;
      readonly token: string;
    }
  | {
      /**
       * An `Authorization` header in no scheme this gateway serves. The **residual** verdict, and
       * the one that covers an attempt in either `indistinguishable` scheme: it is deliberately
       * wider than any per-scheme arm, because what makes it safe is that nothing credential-shaped
       * in this position falls through it.
       */
      readonly kind: "unrecognized";
      /**
       * The RFC 9110 `auth-scheme` token the caller used, or `null` when the header carried none.
       *
       * It replaces the `raw` header this arm used to carry, and the replacement is this
       * increment's own class caught on its own fix: `raw` was the field whose **zero readers**
       * made a presented credential read as absent, and an arm that carried it again and still
       * reported only `kind` would have reproduced that one field over. The scheme token is the
       * half an operator needs — *a client is sending `CE-HMAC-SHA256`* is the diagnosis that was
       * missing — and it is the half that is **not** the credential: everything after the first
       * `SP` is.
       *
       * `null` is therefore load-bearing rather than a convenience. A header with no space has no
       * auth-scheme, so its whole value may be the credential, and `authSchemeToken` refuses it
       * rather than reporting a prefix of a secret.
       */
      readonly schemeToken: string | null;
    }
  | { readonly kind: "absent" };

/** RFC 9110 `token = 1*tchar`, which is the whole grammar of an `auth-scheme`. */
const TCHAR_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Long enough for every registered scheme and every plausible vendor one (`Negotiate` is 9,
 * `CE-HMAC-SHA256` is 14); the grammar bounds a `token` nowhere and a log line is bounded
 * everywhere, so something has to.
 */
const MAX_AUTH_SCHEME_TOKEN = 40;

/**
 * The `auth-scheme` token of an `Authorization` header value, or `null` when there is none to read.
 *
 * Three refusals and each closes a way a credential could reach a log line. **No space** means no
 * auth-scheme (RFC 9110 §11.6.2: `credentials = auth-scheme [ 1*SP … ]`), so the value is
 * potentially a bare token and nothing is reported. A first word outside `tchar` is not a `token`
 * and so is not an auth-scheme, which keeps a crafted value from smuggling control bytes or
 * newlines into a log line. And an over-long first word is refused rather than **truncated**,
 * because a truncated prefix of a secret is still a prefix of a secret.
 */
export function authSchemeToken(headerValue: string): string | null {
  const space = headerValue.indexOf(" ");
  if (space <= 0) return null;
  const candidate = headerValue.slice(0, space);
  if (candidate.length > MAX_AUTH_SCHEME_TOKEN) return null;
  return TCHAR_TOKEN_RE.test(candidate) ? candidate : null;
}

export function parseAuthHeader(request: IncomingRequest): ParseAuthHeaderResult {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const trimmed = header.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("bearer ")) {
      return { kind: "credential", scheme: "bearer_jwt", token: trimmed.slice(7).trim() };
    }
    if (lower.startsWith("basic ")) {
      return { kind: "credential", scheme: "basic", token: trimmed.slice(6).trim() };
    }
  }
  const apiKeyHeader = request.headers[API_KEY_HEADER];
  if (apiKeyHeader !== undefined) {
    return { kind: "credential", scheme: "api_key_header", token: apiKeyHeader.trim() };
  }
  // An **empty** value stays `absent`, and that is not an oversight: ADR-0365 settled it for every
  // query parameter here, because a form serialises an unset field as `?k=`, so an empty value is
  // nothing supplied rather than something malformed. A review asked for presence-recognition
  // across all shapes; half of that is refused by this rule, and the two tests pinning it say so in
  // their own titles.
  //
  // A **repeated** parameter is the other half and the rule does not reach it: an array means the
  // caller did supply a credential, in a shape this gateway will not serve, and letting it fall
  // through to `absent` → anonymous 201 is the "partial wire commitment whose unreserved half is
  // silently anonymous again" that `auth-resolution.ts` refuses `hmac_signature` for — the same
  // rule, applied inconsistently one scheme over. So it is recognised, and the value is
  // deliberately **not** carried: nothing may use a refused scheme's credential, and a credential
  // in a URL is the exposure the refusal is about, so putting it on the parse result would hand it
  // to whatever records one.
  const apiKeyQuery = request.query[API_KEY_QUERY_PARAM];
  if (typeof apiKeyQuery === "string" && apiKeyQuery.length > 0) {
    return { kind: "credential", scheme: "api_key_query", token: apiKeyQuery };
  }
  if (Array.isArray(apiKeyQuery) && apiKeyQuery.some((v) => v.length > 0)) {
    return { kind: "credential", scheme: "api_key_query", token: "" };
  }
  // The residual comes **before** `mtls`, and that ordering is the whole of what "the message named
  // nothing" means. `x-api-key` was already ahead of it before this change — a request with an
  // unrecognised `Authorization` *and* an `x-api-key` resolved the api key — and the generalisation
  // is that a verdict meaning "nothing recognised this" must not outrank something that did.
  //
  // But an unrecognised `Authorization` header *is* the message naming something, so it must
  // outrank a property of the connection. With `mtls` first, `Authorization: Negotiate x` on a
  // cert-forwarding edge answered `mtls`: the caller asked to authenticate one way and was
  // authenticated another, silently — which is the shape this whole increment exists to refuse, and
  // which the comment below used to claim could not happen while the code above it did it.
  if (header !== undefined) {
    return { kind: "unrecognized", schemeToken: authSchemeToken(header.trim()) };
  }
  // `mtls` is **last**, and the order is load-bearing rather than arbitrary: an edge performing
  // mutual TLS sets `clientCertSha256` on *every* request it forwards, so checking it first would
  // make such a deployment refuse every request as `mtls` — including ones carrying a perfectly
  // good JWT. It is the one recognising position that is a property of the connection rather than
  // of the message, so it answers only when the message named nothing at all: no `Authorization`
  // header, no `x-api-key`, no `?api_key=`. Unreachable today — `clientCertSha256` has no producer
  // and the shipped Caddyfile has no `tls` directive — so this is the specification being made
  // consistent rather than a live refusal changing.
  if (request.clientCertSha256 !== null) {
    return { kind: "credential", scheme: "mtls", token: request.clientCertSha256 };
  }
  return { kind: "absent" };
}

export interface ResolvePrincipalInput {
  readonly request: IncomingRequest;
  readonly scheme: AuthScheme;
  readonly principalRef: string;
  readonly scopes: readonly string[];
  readonly resolver: PrincipalResolver;
  readonly nowIso: string;
  /**
   * The tenant asserted by the *credential* (a JWT `tenant_id` claim or an
   * api-key binding). When present it is authoritative; the `x-tenant-id`
   * request header (`tenantHint`) is only a hint and must not contradict it.
   */
  readonly authenticatedTenantId?: string | null;
}

export async function resolvePrincipalForCredential(
  input: ResolvePrincipalInput,
): Promise<{ readonly principal: ResolvedPrincipal | null; readonly outcome: AuthOutcome }> {
  const headerTenant = input.request.tenantHint ?? null;
  const authTenant = input.authenticatedTenantId ?? null;
  // A spoofable header must not claim a different tenant than the credential.
  if (authTenant !== null && headerTenant !== null && authTenant !== headerTenant) {
    return { principal: null, outcome: "tenant_mismatch" };
  }
  const resolved = await input.resolver.resolve({
    tenantId: authTenant ?? headerTenant,
    principalRef: input.principalRef,
    scopes: input.scopes,
    authScheme: input.scheme,
  });
  if (resolved === null) {
    return { principal: null, outcome: "principal_not_found" };
  }
  return {
    principal: { ...resolved, authScheme: input.scheme, resolvedAt: input.nowIso },
    outcome: "authenticated",
  };
}

export function buildOpaqueCredentialMatcher(opaqueTokenSha256: string): (presented: string) => boolean {
  return (presented: string) => constantTimeEqualHex(sha256(presented), opaqueTokenSha256);
}

export type { ParsedAuthCredential };
