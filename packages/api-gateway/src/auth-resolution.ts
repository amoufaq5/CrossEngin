import { z } from "zod";

export const AUTH_SCHEMES = [
  "bearer_jwt",
  "bearer_opaque",
  "api_key_header",
  "api_key_query",
  "basic",
  "mtls",
  "hmac_signature",
  "anonymous",
] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/**
 * The schemes whose credential proves enough that a second factor is not owed.
 *
 * **Kept with no reader, deliberately, and this is the argument** -- ADR-0395 offered *delete, or
 * give them a reader* over this and `SCHEMES_REQUIRING_HTTPS`, and measurement splits the pair:
 * that one is wired to the boot survey (ADR-0398) and this one is not, because the surface that
 * would read it does not exist yet.
 *
 * It fails ADR-0337's deletion test, whose rule is *a second spelling of live code*. This is not
 * one: the criterion is what the credential **proves**, and an api key is a bearer secret that
 * proves possession of a long-lived string where the other three prove possession of a key used on
 * this request. `AUTH_SCHEME_SUPPORT` does not make that judgement -- the map says a scheme is
 * authenticated here -- and `auth-resolution.test.ts` argues in the source that the two may
 * legitimately disagree, asserting the set against the map rather than beside it for that reason.
 *
 * **It is currently equal to `SERVED_AUTH_SCHEMES` minus `api_key_header`, and that is a
 * coincidence rather than the definition.** An adversarial pass over ADR-0398 dated it: the
 * equality has held only since `mtls` was served on 2026-10-31, and before that `SERVED` was two or
 * three schemes against this set's three, so they were unequal for the whole of Phase 1 to 4. This
 * is a Phase-1 constant that `SERVED` grew into, the subtraction is **unfenced** (the test asserts
 * `STRONG ⊆ SERVED`, not the difference), and it is unstable in the unsafe direction: if `basic`
 * were ever served -- considered and refused in ADR-0395 -- the subtraction would include a
 * password re-sent on every request, failing the stated criterion by the **same** objection the
 * api-key exclusion rests on. So read the criterion, not the arithmetic.
 *
 * Its consumer would be `mfa_required`, the one `AuthOutcome` that could act on a credential
 * strength grade -- and that outcome has **no producer anywhere in the workspace**. So this is a
 * modelled judgement waiting on a step-up surface, and the keep has a **checkable expiry
 * condition** rather than being open-ended: when `mfa_required` gains a producer, this set is what
 * it reads, and if a step-up surface is ever declined on the record then both go together.
 *
 * `isStrongAuthScheme` below is callerless with it, as is `isAuthSuccess` -- three consecutive
 * one-line predicates over three sets, of which only `schemeRequiresHttps` now has a reader. They
 * are left as the sets' published shape rather than deleted for tidiness: the open end asked about
 * the **sets**, and an exported predicate removed is a breaking change made for no measured gain.
 */
export const STRONG_AUTH_SCHEMES: ReadonlySet<AuthScheme> = new Set([
  "bearer_jwt",
  "mtls",
  "hmac_signature",
]);

/**
 * The schemes whose credential must not travel in the clear.
 *
 * `mtls` is **deliberately absent** and serving it does not change that, which is worth writing
 * down because it reads as an omission and was twice taken for one. The predicate is *this
 * credential needs the transport encrypted*, and an mtls credential **is** the transport: the
 * certificate is presented inside the handshake, so there is no value that could travel in the
 * clear and the question is a category error rather than false. `auth-resolution.test.ts` has
 * carried that position in a test title since Phase 1 — *"mtls IS the auth + transport"*.
 *
 * I added `mtls` here while serving it, on a sentence in `CLAUDE.md` that says `hmac_signature`
 * "has been in `AUTH_SCHEMES` since Phase 1, in `STRONG_AUTH_SCHEMES` and in
 * `SCHEMES_REQUIRING_HTTPS`" — a claim about a **different scheme**, transposed onto this one and
 * then acted on. ADR-0384, which the transposition was attributed to, mentions neither constant.
 * The test refused the change; the measurement would have, had it been taken.
 */
export const SCHEMES_REQUIRING_HTTPS: ReadonlySet<AuthScheme> = new Set([
  "bearer_jwt",
  "bearer_opaque",
  "api_key_header",
  "api_key_query",
  "basic",
  "hmac_signature",
]);

/**
 * What happens to a request presenting a scheme — the axis the gateway's own behaviour turns on.
 *
 * `indistinguishable` is the member that earns its place rather than describing a gap: a request in
 * such a scheme cannot be *refused by name*, because nothing recognises it, so the honest answer is
 * that the position does not exist on the wire this gateway reads. Recording it as `refused` would
 * promise a denial no request can receive.
 */
export const AUTH_SCHEME_TREATMENTS = [
  /** Authenticated here: a credential in this scheme can yield a principal. */
  "served",
  /** Recognised and denied by name, so the refusal reaches the caller and the record. */
  "refused",
  /** Nothing on the wire recognises it, so no request in it can be named or refused. */
  "indistinguishable",
  /** Not a credential at all: the value recorded when nothing was presented. */
  "not_a_credential",
] as const;
export type AuthSchemeTreatment = (typeof AUTH_SCHEME_TREATMENTS)[number];

export interface AuthSchemeSupport {
  readonly treatment: AuthSchemeTreatment;
  /**
   * The request position a credential in this scheme is recognised from, or `null` when nothing
   * recognises it. `null` iff `treatment === "indistinguishable"`, which a test pins in both
   * directions — a scheme with a recognising position and no refusal, or a refusal with no position,
   * is one of the two halves of this increment's own defect.
   */
  readonly recognisedFrom: string | null;
  /**
   * The RFC 9110 §11.6.2 auth-scheme token that names this scheme in an `Authorization` header, or
   * `null` for a scheme recognised from some other position (`api_key_header`, `api_key_query`,
   * `mtls`, `hmac_signature`) or from none.
   *
   * It exists because `recognisedFrom` is **prose** and the request path needs the token as a
   * value: ADR-0398 gave a credential-less `Authorization: Basic` the refusal its scheme already
   * has, and deriving *which* scheme a bare token names cannot be done from a sentence. Structured
   * here rather than as a second constant beside `parseAuthHeader`, which would be ADR-0288's
   * maintained list -- and a test asserts each token against the prefix that arm matches, in both
   * directions, so the map and the recognition cannot come to disagree.
   *
   * Deliberately not used to *generate* the credential arms: their order is load-bearing
   * (Authorization before `x-api-key` before the query before the residual before `mtls`, each for
   * its own stated reason) and generating them would make that order a property of this map's
   * declaration order instead.
   */
  readonly authSchemeToken: string | null;
  /** Why this treatment and not another. Rendered to an operator, so it names a consequence. */
  readonly reason: string;
}

/**
 * The HTTP header `api_key_header` is presented in.
 *
 * One spelling, read by `authenticate`, by this module's own prose below and by anything describing
 * this surface. It was a bare literal in the request path with that prose beside it as a second
 * copy, so a third reader was one edit from disagreeing with the parser about which header carries
 * a credential — ADR-0288's maintained list, in a place where a stale copy reads as a documented
 * capability.
 */
export const API_KEY_HEADER = "x-api-key";

/**
 * The header `hmac_signature` is presented in.
 *
 * Here and **not** in `@crossengin/crypto` beside the signer, and the split is the one this file
 * already draws for `API_KEY_HEADER`: crypto owns the *value* — the canonical message, the grammar,
 * the sign and the verify — and this package owns which position on the wire carries it. That is
 * also the only split the dependency graph permits in one spelling: `@crossengin/api-gateway` has
 * **no workspace dependencies at all** (measured: `zod` alone), so a constant declared in crypto
 * could only reach the support map and the security doc as a second copy, and the security doc's
 * `name` is a machine value a client generator emits code from.
 *
 * Deliberately **not** `CrossEngin-Signature`, which is the published *payload*-authenticity format
 * (`t=<unix>,v1=<hex>` over `"<unix>." || body`). A verifier holding a header value could not
 * otherwise tell which canonical message applies — the payload one covers two facts and this one
 * covers nine — and a payload signature names no principal, having no key-id field, which is
 * exactly why `AUTH_SCHEME_SUPPORT` was right that *that* format authenticates a payload rather
 * than a principal. The fix is a different format, not a second reading of that one.
 *
 * No `X-` prefix, following `SIGNATURE_HEADER_NAME` and RFC 6648, which deprecates it.
 */
export const REQUEST_SIGNATURE_HEADER = "CrossEngin-Request-Signature";

/** Lower-cased, because `IncomingRequest.headers` is normalised that way by the adapter. */
export const REQUEST_SIGNATURE_HEADER_LOWER = REQUEST_SIGNATURE_HEADER.toLowerCase();

/**
 * The header a **trusted edge** puts a verified client-certificate fingerprint in, for `mtls`.
 *
 * Fixed here rather than configurable, which is the one wire decision in that scheme and is a
 * security property rather than a convention. A configurable name invites an operator to point it at
 * a header their edge does not *overwrite*, and a header the edge merely forwards is one a caller
 * sets: the whole value of mutual TLS is that the fingerprint is the edge's assertion and not the
 * client's claim. Naming it here means the declaration an operator makes
 * (`--trusted-edge-client-cert`) is about their edge stripping **this** header, which is checkable
 * against a Caddyfile, where "whichever header you chose" is not.
 *
 * Same split as `API_KEY_HEADER` and `REQUEST_SIGNATURE_HEADER`: this package owns which position on
 * the wire carries a thing. It differs from both in who *computes* the value — a client computes an
 * api key's and a signature's, and here the client computes nothing and the edge computes everything,
 * which is why the header is only ever read under a trust declaration.
 *
 * No `X-` prefix (RFC 6648), following the two above.
 */
export const CLIENT_CERT_FINGERPRINT_HEADER = "CrossEngin-Client-Cert-Sha256";

/** Lower-cased, because `IncomingRequest.headers` is normalised that way by the adapter. */
export const CLIENT_CERT_FINGERPRINT_HEADER_LOWER = CLIENT_CERT_FINGERPRINT_HEADER.toLowerCase();

/** A client-certificate fingerprint as the contract requires it: lowercase hex sha256. */
export const CLIENT_CERT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * `sha256("")`, refused by name because **no certificate is zero bytes**.
 *
 * It passes the pattern above — 64 lowercase hex characters — and its only possible meaning is that
 * the edge was asked for a client certificate, got none, and hashed the nothing it had. So this is
 * the one value in the whole 2^256 space that is well-formed and cannot denote a certificate, and
 * refusing it can never refuse a real one.
 *
 * The refusal is **by value and not by enrolment**, which is the half that matters: an operator who
 * sees this digest in a log and enrols it with `--mtls-client` would otherwise authenticate *every
 * certificate-less request* as that principal. Reachable from `client_auth mode request`, where a
 * request with no certificate still reaches the proxy — `require_and_verify` refuses it at the
 * handshake, so the shipped recipe does not produce it, which bounds the exposure without closing
 * it. A shape test cannot see the one weakness this value has, which is that it is the digest of
 * nothing — ADR-0377's rule for the published placeholder, one credential over.
 */
export const EMPTY_CERTIFICATE_FINGERPRINT =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Normalises and validates a fingerprint an edge forwarded, answering `null` for anything else.
 *
 * Validated **here and not only in the schema**, because `IncomingRequestSchema` is never parsed on
 * the request path — see the note on its `superRefine` — so this is the only thing between a trusted
 * edge forwarding a malformed value and `parseAuthHeader` handing it to the `mtls` arm as a
 * credential. A trusted edge is trusted to be honest, not to be correctly configured.
 *
 * Case-folded first: Caddy's `{http.request.tls.client.fingerprint}` is lowercase hex, and an edge
 * emitting the uppercase spelling is naming the same certificate, so refusing it would be refusing a
 * correct deployment over a presentation detail. Folding before matching is why the pattern needs
 * only the one case.
 */
export function parseForwardedClientCertFingerprint(value: string | null): string | null {
  if (value === null) return null;
  const folded = value.trim().toLowerCase();
  if (!CLIENT_CERT_FINGERPRINT_PATTERN.test(folded)) return null;
  // After the shape test, because this value's problem is its *meaning* and not its form.
  if (folded === EMPTY_CERTIFICATE_FINGERPRINT) return null;
  return folded;
}

/**
 * How this gateway treats each of the eight `AUTH_SCHEMES`, as **one total map**.
 *
 * It is the map because the three things that used to be maintained separately are all derived from
 * it: which schemes `parseAuthHeader` recognises, which `AuthOutcome` a refusal records, and what a
 * boot line tells an operator. Before it there was no such declaration and the three disagreed —
 * `parseAuthHeader` emitted three of the eight, `basic` alone reached a named refusal, and the other
 * four resolved `scheme: null` and were served **anonymously**: measured on the committed tree, a
 * request carrying `Authorization: CE-HMAC-SHA256 keyId=k1,ts=1,sig=abc` traversed all 17 stages and
 * answered **201**, with `authOutcome: "anonymous"` and the two stage reasons `no_credential` and
 * `no_credential_skipped` — byte-identical to a request that presented nothing.
 *
 * `mtls` was `refused` here until its recognising field got a producer, on the stated ground that
 * "the refusal is reachable only once a terminator populates it" — and that reason **expired by being
 * acted on** rather than by being withdrawn. It is `served` now, and the thing worth keeping from the
 * old entry is that it was right to refuse a *fourth treatment* for it: the treatment was never the
 * distinction, the reason was. What separates `mtls` from the other three served schemes is not how
 * this gateway treats it but **who establishes the fact** — see its own entry — and that belongs in a
 * reason, which is where it is.
 *
 * An `indistinguishable` member is deliberately not given a wire position in order to be refused. A
 * refusal arm is a wire commitment too, and a *partial* one is the defect restated: a client using
 * the spelling we did not reserve is served anonymously again, which is what ADR-0384 exists to end.
 * So it says in its own `reason` what would have to be decided first, and the **residual** verdict —
 * an `Authorization` header in any scheme this gateway does not serve — is what covers an attempt in
 * it. `api_key_query` is the opposite case and is refused: reserving `?api_key=` commits only to
 * never *accepting* it, which is already the decision, so a client using another spelling is no
 * worse off than before.
 *
 * **Phrased for however many members the treatment has, rather than for a count**, because the count
 * has moved twice and the prose did not: this paragraph read "the two `indistinguishable` members"
 * from ADR-0384, when there genuinely were two, through ADR-0393 serving `hmac_signature` and
 * ADR-0394 serving `mtls` — so it asserted two where the live map has one, in the present tense,
 * two lines above an entry that contradicted it. `auth-scheme-survey.ts` already took this lesson
 * for the boot line it renders; this is the same correction on the declaration itself. The member
 * count is derivable from the map and is asserted in the tests; do not restate it here.
 */
export const AUTH_SCHEME_SUPPORT: Readonly<Record<AuthScheme, AuthSchemeSupport>> = Object.freeze({
  bearer_jwt: {
    treatment: "served",
    recognisedFrom: "an Authorization header with the Bearer auth-scheme",
    authSchemeToken: "Bearer",
    reason:
      "verified here: EdDSA signature against the configured JWKS, then exp, iss and aud; nbf is " +
      "honoured when present and never required",
  },
  api_key_header: {
    treatment: "served",
    recognisedFrom: `an ${API_KEY_HEADER} header`,
    authSchemeToken: null,
    reason: "resolved here against the deployment's opaque-token lookup",
  },
  anonymous: {
    treatment: "not_a_credential",
    recognisedFrom: "no credential in any recognised position",
    authSchemeToken: null,
    reason:
      "the absence of a credential, not one of its kinds — the value a principal and a pipeline row carry when nothing was presented",
  },
  /**
   * Refused on two measured grounds, and the reason is written for the audience that reads it:
   * **this string is interpolated verbatim into the 401 body** (`runtime.ts`'s scheme refusal →
   * `problems.ts`' `detail`), which `runtime-auth-schemes.test.ts` pins as a design property — "so
   * the body says why". A refusal reason here is therefore a client-facing security statement, not
   * a comment, and the previous one was **false**.
   *
   * What it said: that a Basic arm "would have to re-implement that route's lockout to avoid being
   * the way around it". That was wrong **when it was written**, not stale — `credentialIsLocked` was
   * exported from the login and already imported by a second credential surface 13 days and 49
   * commits earlier, so a Basic arm would have *reused* the lockout exactly as the password-change
   * route does. Measured, and it survived two increments that edited this very map because `basic`
   * was the only refused scheme whose reason **content** no test read (`api_key_query` has three
   * assertions on its own). The fence is now in `auth-resolution.test.ts`.
   *
   * What is true, and why neither clause is about implementation effort:
   *
   * 1. **Basic cannot name a tenant, and that is structural rather than unbuilt.** RFC 7617 carries
   *    a userid and a password and nothing else, while an authorization answer here is a function of
   *    (user, tenant): `meta.users` has no tenant column, one person legitimately holds different
   *    roles in different tenants, `membershipFor` needs the tenant for both its scope filter and
   *    its transaction context, and there is no by-user membership read and no default-tenant
   *    concept anywhere. A sub-grammar inside the userid is not available either, because the
   *    **first colon is RFC 7617's own delimiter** — so `tenant:user:password` is not
   *    representable. The login route takes the tenant as a third field for exactly this reason.
   * 2. **The cost is a property of the credential, not of this implementation.** A password
   *    verification is a deliberate scrypt derivation — measured here at a 105 ms median with a
   *    throughput ceiling of ~35/second on four cores, flat from 8 concurrent upward because the
   *    libuv pool is 4 wide and shared with fs and dns — and a scheme that re-presents the password
   *    on every request pays it on every request. Caching the decision is refused separately: the
   *    repo has four cached directories and all four cache a fact about a row keyed by something the
   *    caller *names*, with no precedent for caching a verdict derived from a secret the caller
   *    *sends*, and a positive cache is unsafe rather than merely unhelpful — a hit short-circuits
   *    `verifyLogin`, which is where `credentialIsLocked` is read and `recordSuccess` clears the
   *    counter, so a rotated password and a locked account would both keep being served for the TTL.
   *
   * Only **(1)** is published. The cost is a true ground for the decision and is deliberately not in
   * the body: a latency figure is an operational fact about this deployment that an anonymous caller
   * has no business being handed, and it is not a durable form of the measurement either — the three
   * Ed25519 numbers this repo holds span an order of magnitude (0.012 ms bare verify, 0.133 ms sign
   * with key construction, 0.152 ms per chain entry with canonicalisation), so "N times dearer"
   * reads as 693x, 793x or 8,770x on one true cost depending only on which is picked, and a draft of
   * this reason published the middle one as "about a thousand times" (ADR-0378's rule: record the
   * mechanism, not the figure). A third true fact — that nothing in the repo or its documentation
   * asks for this scheme — is withheld for a different reason: it argues against *building* it and
   * is no answer to the caller in front of you.
   *
   * What the reason does carry is what to send instead, which is the half a 401 exists to provide
   * (ADR-0334: a remedy that cannot work is worse than none, and no remedy at all is worse still).
   * It carries no ADR reference, unlike the string it replaces: an internal document number is
   * unactionable to an anonymous caller and is the one part of the old reason that could not have
   * been useful even had the rest been true.
   */
  basic: {
    treatment: "refused",
    recognisedFrom: "an Authorization header with the Basic auth-scheme",
    authSchemeToken: "Basic",
    reason:
      "not served: Basic carries a userid and a password and nothing else, while an authorization " +
      "answer here needs a tenant as well — one person holds different roles in different tenants " +
      "and the userid cannot name which, because the first colon is this scheme's own delimiter. " +
      `Send a machine credential in ${API_KEY_HEADER}, or exchange a password for a session token ` +
      "at the login route and send that",
  },
  hmac_signature: {
    treatment: "served",
    recognisedFrom: `a ${REQUEST_SIGNATURE_HEADER} header`,
    authSchemeToken: null,
    reason:
      `verified here at authenticate: the key id names the signing key, the timestamp is checked against a symmetric tolerance, and the HMAC-SHA256 is compared in constant time against a canonical message covering the method, path, sorted query, body digest, host and scheme. Reserving its own header rather than an Authorization auth-scheme token is why it did not need one chosen: ${REQUEST_SIGNATURE_HEADER} is distinct from CrossEngin-Signature, the payload-authenticity format, so no verifier has to guess which canonical message a value is over`,
  },
  api_key_query: {
    treatment: "refused",
    recognisedFrom: "an api_key query parameter",
    authSchemeToken: null,
    // The ADR citation this used to carry is gone for the reason given on `basic`: the string is
    // interpolated into the 401 body, and an internal document number is unactionable to the caller
    // reading it. The *rule* it referenced is restated in one clause instead, which is the half that
    // travels — a credential must not go where it will be copied — and the comparison to the argv
    // rule belongs here in the source rather than in the response.
    reason:
      `refused deliberately and not merely unbuilt: a credential in a URL is copied into access logs, proxy logs and Referer, and a credential must not travel where it will be copied — present the key in ${API_KEY_HEADER} instead`,
  },
  mtls: {
    treatment: "served",
    recognisedFrom: `a ${CLIENT_CERT_FINGERPRINT_HEADER} header from a trusted edge`,
    authSchemeToken: null,
    reason:
      `resolved here against the deployment's client-certificate registry — and it is the one served scheme this gateway does not *verify*. The other three establish the fact from bytes plus a key they hold: bearer_jwt checks a signature, api_key_header looks the token up, hmac_signature recomputes the MAC. A TLS handshake happens at the edge, so what arrives is the edge's assertion in ${CLIENT_CERT_FINGERPRINT_HEADER}, and the only decision available here is whether to believe it. So the scheme is reachable exactly when a deployment declares that its edge performs mutual TLS and overwrites that header, which is what makes the fingerprint the edge's statement rather than the caller's`,
  },
  bearer_opaque: {
    treatment: "indistinguishable",
    recognisedFrom: null,
    // `null` and not `"Bearer"`: the token it would name is the one `bearer_jwt` already claims,
    // which is this treatment's whole reason. A token here would assert a position it does not hold.
    authSchemeToken: null,
    reason:
      "the Bearer auth-scheme is claimed by bearer_jwt and nothing on the wire separates them; a token-shape test would *grant* rather than refuse, because the opaque lookup api_key_header already uses matches the whole api-key string, so routing a non-JWT bearer token to it would accept an api key presented in Authorization — a capability decision, not a parser one",
  },
});

export const authSchemeTreatment = (scheme: AuthScheme): AuthSchemeTreatment =>
  AUTH_SCHEME_SUPPORT[scheme].treatment;

/**
 * How a *served* scheme is presented, in OpenAPI's Security Scheme vocabulary — the machine
 * spelling of `recognisedFrom`, kept beside it so the two cannot come to disagree.
 *
 * Field names are OpenAPI's own (`in`, and `name` for the header), so an emitter copies rather than
 * translates; `key` is the `components.securitySchemes` key a `security` requirement names and is
 * the one field that is not part of the object.
 *
 * A **total map with `null` for every scheme this build does not serve**, fenced in both directions
 * by `securityDocMatchesTreatment()`. Both halves are load-bearing and they fail oppositely: a
 * served scheme with no entry is a credential the API accepts and no client is told about, while a
 * refused scheme *with* an entry is the worse direction, because a `securitySchemes` entry is a
 * **definition** — a generator reads it as supported and emits a client method for it — so
 * publishing one for `api_key_query` would invite precisely the request ADR-0384 refuses, in the
 * document that exists to describe the refusal.
 */
export interface SecuritySchemeDoc {
  readonly key: string;
  /**
   * `mutualTLS` is OpenAPI 3.1's own type for a client certificate and takes **no** further fields —
   * which is the honest shape here and not a shortcut: the credential is the TLS connection, so
   * there is no header for a generated client to set. That the deployment reads a forwarded
   * fingerprint is an implementation detail of *this* gateway's position behind an edge, and
   * publishing `CrossEngin-Client-Cert-Sha256` as an `apiKey` header would be the falsely-true
   * direction — it would tell a generator the value is something a client may send, which is
   * precisely what the trust declaration exists to make false.
   */
  readonly type: "http" | "apiKey" | "mutualTLS";
  /** `http` only. */
  readonly scheme?: "bearer";
  /** `http` only. */
  readonly bearerFormat?: string;
  /** `apiKey` only. */
  readonly in?: "header";
  /** `apiKey` only — the header name. OpenAPI calls this field `name`. */
  readonly name?: string;
  readonly description: string;
}

export const AUTH_SCHEME_SECURITY_DOC: Readonly<Record<AuthScheme, SecuritySchemeDoc | null>> =
  Object.freeze({
    bearer_jwt: {
      key: "bearerAuth",
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      // `nbf` is deliberately absent from the required list, and saying "exp, nbf, iss and aud"
      // here was a false security statement in client-facing prose: `REQUIRED_JWT_CLAIM_COSTS` is
      // keyed on `exp | iss | aud` alone, so `nbf` is neither required by default nor relaxable —
      // `--jwt-optional-claim nbf` is refused **by name** with its reason, because an absent `nbf`
      // means *valid from issuance*, which is coherent. It is still checked when present. The wrong
      // list was copied from `AUTH_SCHEME_SUPPORT.bearer_jwt.reason`, which carried it too and is
      // corrected with it, so what was an internal inaccuracy did not become a published one.
      description:
        "An Ed25519-signed JWT in the Authorization header. Verified against the configured JWKS, " +
        "then exp, iss and aud — each required unless the deployment relaxes it by name. A `nbf` " +
        "claim is honoured when present and is never required.",
    },
    api_key_header: {
      key: "apiKeyAuth",
      type: "apiKey",
      in: "header",
      name: API_KEY_HEADER,
      description: "A deployment-issued opaque key. Resolved against the deployment's own lookup.",
    },
    hmac_signature: {
      key: "requestSignatureAuth",
      type: "apiKey",
      in: "header",
      name: REQUEST_SIGNATURE_HEADER,
      // `type: apiKey` and not `http`, because OpenAPI 3.1's `http` type takes a registered
      // auth-scheme token and this credential deliberately reserves its own header rather than one
      // — which is the whole reason it needed no namespace commitment. `apiKey` is the honest shape
      // for "a credential in a named header", and the grammar a client must produce goes in the
      // description, where `api_key_header` puts its own prose. A generator emits a header
      // parameter either way; what it cannot do is compute the signature, which is why the
      // description names the canonical message rather than implying the value is a static key.
      description:
        "An HMAC-SHA256 request signature, as `k=<keyId>,t=<unixSeconds>,v1=<hex64>`. The signature " +
        "covers a canonical JSON array of [domain, keyId, timestamp, method, path, sorted query, " +
        "body sha256 or null, host, scheme], so it is bound to one request rather than reusable: a " +
        "captured value replays only within the deployment's clock tolerance and only against the " +
        "identical request. Unlike a static key this cannot be sent as a literal — the client " +
        "computes it per request from its own copy of the signing key.",
    },
    mtls: {
      key: "mutualTlsAuth",
      type: "mutualTLS",
      // No `in`/`name`: see the note on `SecuritySchemeDoc.type`. The description is the one place a
      // client author learns that the certificate is presented to the *edge* — a generated client
      // configures a key pair in its TLS stack, which is not something an OpenAPI document can
      // express at all, so saying it in prose is the whole of what can be said.
      description:
        "A client certificate presented in the TLS handshake. The deployment's edge performs mutual " +
        "TLS and asserts the verified certificate's sha256 fingerprint to this gateway, which " +
        "resolves it against a registry of enrolled fingerprints. Present the certificate to the " +
        "edge; there is no header for a client to set, and the gateway reads the edge's assertion " +
        "only where the deployment has declared that edge trusted.",
    },
    anonymous: null,
    basic: null,
    api_key_query: null,
    bearer_opaque: null,
  });

/**
 * The schemes whose security doc and treatment disagree — empty, and asserted so.
 *
 * Returned rather than thrown because this is a fence over a constant: the value is what a test
 * asserts, and a thrown invariant at module load would take the whole gateway down for a
 * documentation defect.
 */
export const securityDocMatchesTreatment = (): readonly AuthScheme[] =>
  AUTH_SCHEMES.filter(
    (s) =>
      (AUTH_SCHEME_SECURITY_DOC[s] !== null) !== (AUTH_SCHEME_SUPPORT[s].treatment === "served"),
  );

/**
 * The schemes a credential can be recognised as. Derived, so widening the parser is a change to the
 * map and not to a second list beside it — ADR-0288's maintained-list shape, which this repo has
 * found wrong three times.
 */
export const RECOGNISABLE_AUTH_SCHEMES: readonly AuthScheme[] = Object.freeze(
  AUTH_SCHEMES.filter(
    (s) =>
      AUTH_SCHEME_SUPPORT[s].treatment === "served" ||
      AUTH_SCHEME_SUPPORT[s].treatment === "refused",
  ),
);

/** The schemes this binary can authenticate, before any deployment configuration narrows them. */
export const SERVED_AUTH_SCHEMES: readonly AuthScheme[] = Object.freeze(
  AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SUPPORT[s].treatment === "served"),
);

/**
 * The schemes a **bare** `Authorization` auth-scheme token is enough to name -- lowercased token to
 * scheme, derived and never listed (ADR-0398).
 *
 * `refused` and not `served`, and the line is drawn by the request path's own control flow rather
 * than by preference: `runtime.ts` answers `treatment !== "served"` with `scheme_not_supported`
 * **before** the credential is read, so for a refused scheme the credential is irrelevant -- it is
 * denied by name whatever it carries, and presence is therefore sufficient to answer. A served
 * scheme's answer depends entirely on the credential, so recognising presence there would hand its
 * verifier an empty string and record a claim about a credential nobody presented. The residual is
 * the honest answer for `Authorization: Bearer`, and that is why this is not symmetric.
 *
 * `api_key_query` contributes nothing because its token is `null`: it is recognised from a query
 * parameter, so there is no `Authorization` spelling of it to be bare. The live set is therefore
 * `{basic}` -- one member, derived, and it grows by itself if a scheme is ever refused with a token.
 */
export const BARE_AUTH_SCHEME_TOKENS: ReadonlyMap<string, AuthScheme> = new Map(
  AUTH_SCHEMES.flatMap((s) => {
    const { treatment, authSchemeToken } = AUTH_SCHEME_SUPPORT[s];
    return treatment === "refused" && authSchemeToken !== null
      ? ([[authSchemeToken.toLowerCase(), s]] as const)
      : [];
  }),
);

/**
 * The scheme a whole `Authorization` value names when it carries no credential at all, or `null`.
 *
 * Case-insensitive because RFC 9110 §11.6.2 makes the auth-scheme token case-insensitive, and the
 * value is compared **whole**: a bare token is exactly what `authSchemeToken` cannot report, since
 * its rule is *no space means no auth-scheme, so the value is potentially a bare credential and
 * nothing is named*. That rule is right for `ce_live_abc` and wrong for `Basic`, and the two are
 * separable only against the set of tokens this build knows -- which is what makes this a lookup
 * rather than a heuristic.
 */
export function bareAuthScheme(headerValue: string): AuthScheme | null {
  return BARE_AUTH_SCHEME_TOKENS.get(headerValue.trim().toLowerCase()) ?? null;
}

export const AUTH_OUTCOMES = [
  "anonymous",
  "authenticated",
  "credential_malformed",
  "credential_not_found",
  "invalid_signature",
  "expired_token",
  "not_yet_valid_token",
  "audience_mismatch",
  "issuer_mismatch",
  "tenant_mismatch",
  "principal_not_found",
  "principal_disabled",
  "principal_locked",
  "scope_insufficient",
  "mfa_required",
  "weak_tls_rejected",
  /**
   * This gateway does not accept that scheme. Appended rather than inserted, so the 16 members a
   * deployment's `auth_outcome` CHECK already admits keep their order and the emitted SQL moves only
   * by the two additions.
   *
   * It is its own member because the fact it records had been `credential_malformed`, which is a
   * claim about the *caller's* credential — so every pipeline row for an unimplemented scheme blamed
   * the caller for a gateway gap, and `idx_gateway_pipeline_auth_outcome` aggregated it beside
   * genuinely broken credentials. The remedy differs: present a scheme this gateway serves, or
   * configure its verifier.
   */
  "scheme_not_supported",
  /**
   * A credential was presented in no position this gateway can name. Distinct from
   * `scheme_not_supported`, whose scheme *is* named, and from `anonymous`, which says nothing was
   * presented — the remedy here is the client's, and it is the one an operator cannot infer, because
   * the pre-ADR-0384 record said `no_credential` for a request that carried an Authorization header.
   */
  "credential_unrecognized",
  /**
   * A JWT verified against this deployment's JWKS and does **not carry a claim this deployment
   * requires** — distinct from the three mismatch outcomes, which say a claim is present and wrong.
   *
   * Its own member because every alternative is a lie about one of the three. `expired_token` for a
   * token with no `exp` asserts an expiry that was never set; `issuer_mismatch` and
   * `audience_mismatch` assert a comparison that never happened. ADR-0384's rule read one layer in:
   * conflating *absent* with *wrong* is how `credential_malformed` came to describe an unimplemented
   * scheme. It also separates the two remedies a reader needs to tell apart — an IdP that omits a
   * claim is a configuration to fix at the minter, where a wrong claim is a token minted for
   * somebody else.
   *
   * Appended for `scheme_not_supported`'s reason: the 18 members a deployment's `auth_outcome` CHECK
   * already admits keep their order, so the emitted SQL moves only by this addition.
   */
  "required_claim_absent",
] as const;
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

/**
 * Whether each outcome lets the request proceed, as **one total map** over the enum.
 *
 * `AUTH_SUCCESS_OUTCOMES` is derived from it and still exported, so every existing reader and the
 * membership assertions over it keep working. The map is the shape because the `Set` it replaced was
 * hand-written and a member added to `AUTH_OUTCOMES` alone compiled, typechecked and passed every
 * test while silently joining the *refusing* side — the regression ADR-0351 measured for
 * `PROOF_VERSION_COVERAGE`, where a fourth proof tag added to the enum and to neither of its three
 * membership lists made a v4 record structurally a v1 record. Here the direction happens to be safe
 * and the silence is not: a map makes a new member a compile error until it says which side it is on.
 */
export const AUTH_OUTCOME_SUCCEEDS: Readonly<Record<AuthOutcome, boolean>> = Object.freeze({
  anonymous: true,
  authenticated: true,
  credential_malformed: false,
  credential_not_found: false,
  invalid_signature: false,
  expired_token: false,
  not_yet_valid_token: false,
  audience_mismatch: false,
  issuer_mismatch: false,
  tenant_mismatch: false,
  principal_not_found: false,
  principal_disabled: false,
  principal_locked: false,
  scope_insufficient: false,
  mfa_required: false,
  weak_tls_rejected: false,
  scheme_not_supported: false,
  credential_unrecognized: false,
  required_claim_absent: false,
});

export const AUTH_SUCCESS_OUTCOMES: ReadonlySet<AuthOutcome> = new Set(
  AUTH_OUTCOMES.filter((o) => AUTH_OUTCOME_SUCCEEDS[o]),
);

/**
 * What a presented credential *is*, per scheme — and deliberately **not** enough to verify one.
 *
 * Every secret-bearing field here is a **digest**: `tokenSha256`, `apiKeySecretSha256`,
 * `basicPasswordSha256`, `hmacSignatureSha256`. A digest of a signature cannot verify a signature,
 * and that is not an oversight to fix in place — it is what makes this schema safe to persist and to
 * put in a log line. So it is a *specification* of each scheme's shape, which is the only place the
 * repo writes down that an mtls credential needs a certificate digest and an hmac credential needs a
 * key id, a signature and a timestamp, and it is not an authenticator's input.
 *
 * It has no consumer outside `resolveAuth` and no structural reference anywhere: measured against
 * the committed tree, nothing in `META_TABLES` stores it, `pg-value-set-domains.ts` adjudicates no
 * column against it, and `PipelineExecution` carries none of its fields — the only non-test
 * reference outside this file is the type re-export in `api-gateway-runtime/src/auth.ts`. It is
 * kept rather than deleted because ADR-0337's test for a deletion is *a second spelling of live
 * code*, and this is the opposite: a specification of code that does not exist, which is what a
 * future implementer of the four refused schemes needs.
 */
export const ParsedAuthCredentialSchema = z
  .object({
    scheme: z.enum(AUTH_SCHEMES),
    presentedAt: z.string().datetime({ offset: true }),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    apiKeyPrefix: z
      .string()
      .regex(/^ce_(live|test)_[A-Za-z0-9]{8}$/)
      .nullable(),
    apiKeySecretSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    basicUsername: z.string().max(200).nullable(),
    basicPasswordSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    clientCertSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    hmacKeyId: z.string().max(120).nullable(),
    /**
     * `sha256` of the **lower-case hex signature as the header carries it**, which is a digest of a
     * signature and not the signature.
     *
     * Ambiguous by construction until the wire format existed: the regex admits 64 hex characters
     * and a raw HMAC-SHA256 *is* 64 hex characters, so the field's value and its digest are
     * indistinguishable by shape, and only the name and this schema's doc said which was meant. The
     * live format is `k=…,t=…,v1=<hex64>` and the `v1` field is the raw MAC, so populating this
     * field from it directly would put a replayable value — within the clock tolerance, against the
     * identical request — into something the doc above says is safe to persist and to log.
     *
     * The digest is over the **hex text** rather than the decoded 32 bytes, because the hex is what
     * the header carries and what a log line would otherwise hold, so the two cannot be confused
     * when a reader checks one against a captured header.
     */
    hmacSignatureSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    hmacSignedAt: z.string().datetime({ offset: true }).nullable(),
    jwtIssuer: z.string().max(500).nullable(),
    jwtAudience: z.array(z.string().max(500)).default([]),
    jwtSubject: z.string().max(500).nullable(),
    jwtExpiresAt: z.string().datetime({ offset: true }).nullable(),
    jwtNotBefore: z.string().datetime({ offset: true }).nullable(),
    jwtScope: z.array(z.string().max(200)).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.scheme === "bearer_jwt" && c.tokenSha256 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenSha256"],
        message: "bearer_jwt requires tokenSha256",
      });
    }
    if (c.scheme === "api_key_header" || c.scheme === "api_key_query") {
      if (c.apiKeyPrefix === null || c.apiKeySecretSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKeyPrefix"],
          message: "api_key schemes require apiKeyPrefix + apiKeySecretSha256",
        });
      }
    }
    if (c.scheme === "basic") {
      if (c.basicUsername === null || c.basicPasswordSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["basicUsername"],
          message:
            "basic auth requires basicUsername + basicPasswordSha256",
        });
      }
    }
    if (c.scheme === "mtls" && c.clientCertSha256 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientCertSha256"],
        message: "mtls requires clientCertSha256",
      });
    }
    if (c.scheme === "hmac_signature") {
      if (
        c.hmacKeyId === null ||
        c.hmacSignatureSha256 === null ||
        c.hmacSignedAt === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hmacSignatureSha256"],
          message:
            "hmac_signature requires hmacKeyId + hmacSignatureSha256 + hmacSignedAt",
        });
      }
    }
  });
export type ParsedAuthCredential = z.infer<typeof ParsedAuthCredentialSchema>;

export interface AuthResolutionInput {
  readonly credential: ParsedAuthCredential;
  readonly schemeAllowed: boolean;
  /**
   * Whether something else has already verified this credential's signature. **Required, with no
   * default**, and `false` is refused rather than ignored.
   *
   * It exists because `ParsedAuthCredential` carries digests and no signature, so `resolveAuth`
   * cannot perform that check and used to reach `{outcome: "authenticated"}` without it — for every
   * scheme. A comment would have recorded the hazard; a required field makes it a compile obligation
   * on every caller, and `false` makes the unsafe call *refuse* instead of grant. ADR-0341's
   * treatment of `Principal.abacAttributes`: an evaluator handed `{}` cannot tell *has none* from
   * *nobody looked*, so the input is required and the first arm settles it before any logic runs.
   */
  readonly signatureVerified: boolean;
  readonly tlsAcceptable: boolean;
  readonly now: Date;
  readonly expectedIssuer: string | null;
  readonly expectedAudience: string | null;
  readonly clockSkewSeconds: number;
  readonly hmacSignatureMaxAgeSeconds: number;
}

export interface AuthResolutionResult {
  readonly outcome: AuthOutcome;
  readonly reason: string;
}

/**
 * The claims-and-freshness adjudication over a credential **something else has already verified**.
 *
 * It has no caller on the request path and keeping it unwired is deliberate, so the reason belongs
 * here rather than in an ADR nobody reads at the call site. Of its clauses, six are duplicated by
 * `api-gateway-runtime`: the TLS floor by `stageValidateTls`, the anonymous arm by the authenticate
 * stage's no-credential path, and the JWT `exp`/`nbf`/`iss`/`aud` quartet by `verifyBearerJwt`. One
 * is unique to it — the scheme allow-list, which the runtime's stage now reads from
 * `AUTH_SCHEME_SUPPORT` instead.
 *
 * This sentence used to add "and again by `IncomingRequestSchema.superRefine`, which refuses
 * `tls_1_0`/`tls_1_1` at parse", and that was **false**: nothing parses `IncomingRequestSchema` on
 * the request path — its only non-test references are its own declaration, the `IncomingRequest`
 * type alias it infers, and comments like this one claiming it enforces something. So the TLS floor
 * had one implementation and not two, the duplication count was six and not seven, and the
 * refinement is a statement about what a well-formed request *is* rather than a check anything runs.
 *
 * The HMAC freshness window **used to be the second**, on the stated ground that no runtime path had
 * one because `hmac_signature` was refused. It is served now, so there is a live window, and the two
 * disagree in shape rather than in intent: this one is **asymmetric over two parameters**
 * (`hmacSignatureMaxAgeSeconds` for the past, `clockSkewSeconds` for the future) and compares
 * milliseconds parsed out of an ISO `hmacSignedAt`, while the wire format carries integer unix
 * seconds and `verifyRequestSignature` takes **one symmetric tolerance**, which is
 * `verifyWebhookSignature`'s shape. The live one is the one the wire can express; this one is kept
 * with the rest of the specification rather than reshaped to match, because its input
 * (`ParsedAuthCredential`) cannot carry a signature in the first place and so could never be the
 * authenticator — see the next paragraph.
 *
 * **Wiring it as the authenticator would be worse than leaving it unwired**, and that was true
 * before `signatureVerified` existed: the only signature material on its input is
 * `hmacSignatureSha256` / `tokenSha256`, which are digests, so a *forged* JWT whose claims happen to
 * be fresh reached the terminal `{outcome: "authenticated", reason: "credential_valid"}`. That is
 * ADR-0336's `PostgresIdempotencyStore` shape — a store whose wiring unfixed would have been worse
 * than the in-memory one it replaced. The required `signatureVerified` is what takes the trap out
 * rather than documenting it: the unsafe call no longer typechecks without stating the premise, and
 * stating it falsely answers `invalid_signature`.
 */
export const resolveAuth = (
  input: AuthResolutionInput,
): AuthResolutionResult => {
  if (!input.tlsAcceptable) {
    return {
      outcome: "weak_tls_rejected",
      reason: "tls_below_acceptable_floor",
    };
  }
  if (!input.schemeAllowed) {
    // `scheme_not_supported` and not `credential_malformed`, which is what this arm answered and is
    // a claim about the caller's credential: the credential may be perfectly well formed and this
    // deployment simply does not accept its scheme. The contract modelled the decision — a
    // `schemeAllowed` input — and modelled it with the wrong outcome, which is why the runtime
    // reproducing the misattribution went unnoticed.
    return {
      outcome: "scheme_not_supported",
      reason: `scheme_${input.credential.scheme}_not_allowed`,
    };
  }
  if (input.credential.scheme === "anonymous") {
    return { outcome: "anonymous", reason: "no_credential_presented" };
  }
  // After the anonymous arm and before every claims check, which is the only correct position: an
  // absent credential has no signature to have verified, so asking first would refuse every
  // anonymous request; and a claims check that passed would otherwise be reported as an
  // authentication, which is the terminal line's whole defect.
  if (!input.signatureVerified) {
    return {
      outcome: "invalid_signature",
      reason: "signature_not_verified_by_caller",
    };
  }
  const nowMs = input.now.getTime();
  const skewMs = input.clockSkewSeconds * 1000;
  if (input.credential.scheme === "bearer_jwt") {
    if (input.credential.jwtExpiresAt !== null) {
      const expMs = Date.parse(input.credential.jwtExpiresAt);
      if (expMs + skewMs <= nowMs) {
        return { outcome: "expired_token", reason: "jwt_exp_passed" };
      }
    }
    if (input.credential.jwtNotBefore !== null) {
      const nbfMs = Date.parse(input.credential.jwtNotBefore);
      if (nbfMs - skewMs > nowMs) {
        return {
          outcome: "not_yet_valid_token",
          reason: "jwt_nbf_in_future",
        };
      }
    }
    if (
      input.expectedIssuer !== null &&
      input.credential.jwtIssuer !== input.expectedIssuer
    ) {
      return { outcome: "issuer_mismatch", reason: "jwt_iss_mismatch" };
    }
    if (
      input.expectedAudience !== null &&
      !input.credential.jwtAudience.includes(input.expectedAudience)
    ) {
      return {
        outcome: "audience_mismatch",
        reason: "jwt_aud_does_not_include_expected",
      };
    }
  }
  if (input.credential.scheme === "hmac_signature") {
    if (input.credential.hmacSignedAt !== null) {
      const signedMs = Date.parse(input.credential.hmacSignedAt);
      const ageMs = nowMs - signedMs;
      if (ageMs > input.hmacSignatureMaxAgeSeconds * 1000) {
        return {
          outcome: "expired_token",
          reason: "hmac_signature_too_old",
        };
      }
      if (ageMs < -skewMs) {
        return {
          outcome: "not_yet_valid_token",
          reason: "hmac_signed_in_future_beyond_skew",
        };
      }
    }
  }
  // Honest only because of the `signatureVerified` arm above: what this line now asserts is "the
  // caller verified the signature and every claim this function can read checks out", where before
  // it asserted an authentication over bytes that contain no signature.
  return { outcome: "authenticated", reason: "credential_valid" };
};

/**
 * The `AuthOutcome` members that are a statement about a principal that **exists** -- as against
 * `principal_not_found`, which says no principal was located at all (ADR-0398).
 *
 * The distinction had no channel to travel through: `PrincipalResolver.resolve` answered
 * `ResolvedPrincipal | null` and `resolvePrincipalForCredential` mapped every `null` to
 * `principal_not_found`, so ADR-0381's membership-revocation gate -- which returns `null` for a
 * person whose membership was revoked -- recorded *this principal does not exist* for one that
 * plainly does, while `principal_disabled` sat in `AUTH_OUTCOMES` with zero producers. That is
 * ADR-0384's finding one outcome across: `credential_malformed` was a claim about the caller's
 * credential for a gateway gap, and this was a claim about the directory for a deliberate
 * revocation. The caller is told the same thing either way (one 401, nothing about why -- the gate's
 * own decision); what changes is the **record**, which `idx_gateway_pipeline_auth_outcome`
 * aggregates, so a revocation was counted beside genuinely unknown principals.
 *
 * Both members are expressible by any resolver, which is the point of a set rather than one new
 * value: it stops the gateway modelling an outcome it has no way to produce.
 *
 * `principal_locked` keeps no producer, and the reason is a **refusal to wire one** rather than an
 * absence. The repo's only lockout is `credentialIsLocked`, a *login rate limiter*: its counter is
 * advanced by failed password attempts, which is to say by a party who does **not** hold the
 * credential. Promoting that to a session refusal would hand anyone who knows an email address a
 * remote session-kill -- a few wrong guesses and the real holder's live sessions stop. So the
 * outcome stays expressible and unproduced until something locks a *principal* rather than metering
 * a guesser.
 *
 * An earlier draft of this comment argued instead that "no request reaching this stage can be
 * carrying a locked account's session, because the lockout answers before a token is minted". That
 * is **false**, and measuring it is what produced the reason above: nothing on the request path
 * reads `credential_locked_until` (zero readers in either gateway package), `membershipFor` does not
 * join `meta.users`, and `--session-token-ttl` is unset on the shipped compose, so a lock at T1
 * leaves a session minted at T0 served for up to an hour. The conclusion survived; its premise did
 * not.
 *
 * The wider census, which is the item's real shape: **five** of the nineteen `AUTH_OUTCOMES` had no
 * producer -- these two plus `scope_insufficient`, `mfa_required` and `weak_tls_rejected` -- and
 * they are the contiguous tail of the original Phase-1 fifteen, while every outcome added since
 * arrived with one. So it is one declaration habit rather than five omissions. This gives one of the
 * five a producer and leaves **four**; the other three are recorded in *What's actually left* rather
 * than fixed here, because each belongs to a different stage, and two of them are worse than
 * unproduced: a weak-TLS denial records `anonymous`, and a scope denial would record
 * `authenticated` -- the success value.
 *
 * Two of those four are producerless for a reason that is easy to miss and worth stating, because a
 * plain grep reads them as produced. `weak_tls_rejected` *is* assigned, at `resolveAuth`'s TLS arm
 * below -- and `resolveAuth` is callerless, so the producer is unreachable (ADR-0336's distinction:
 * module reachability is not symbol reachability). And `mfa_required` matches four non-declaring
 * sites that belong to a **homonym**: `@crossengin/sso`'s own login-audit outcome enum, in a package
 * with zero importers. Counting those as producers is ADR-0354's bare-name-map defect, and this
 * census made it once before the figure was checked.
 */
export const PRINCIPAL_REFUSAL_OUTCOMES = ["principal_disabled", "principal_locked"] as const;
export type PrincipalRefusalOutcome = (typeof PRINCIPAL_REFUSAL_OUTCOMES)[number];

/**
 * A resolver's third answer: the principal was located and must not be served.
 *
 * Returned rather than thrown, because a throw at this stage is a 500 and this is an ordinary
 * refusal; and a distinct shape rather than a nullable field on `ResolvedPrincipal`, so a caller
 * cannot read a refused principal's `principalId` by forgetting to check.
 */
export interface PrincipalRefused {
  readonly refusedAs: PrincipalRefusalOutcome;
}

/** Narrows a resolver's answer, since `null` and a refusal both mean *do not serve this*. */
export function isPrincipalRefused(
  value: ResolvedPrincipal | PrincipalRefused | null,
): value is PrincipalRefused {
  return value !== null && "refusedAs" in value;
}

export interface ResolvedPrincipal {
  readonly principalId: string;
  readonly tenantId: string | null;
  readonly principalKind: "user" | "service_account" | "ai_architect" | "system";
  readonly authScheme: AuthScheme;
  readonly grantedScopes: readonly string[];
  readonly mfaProofAgeSeconds: number | null;
  readonly resolvedAt: string;
  /**
   * The principal's ABAC attributes, resolved once in the auth stage by whatever directory the
   * deployment configured. **Absent means not resolved** and is not the same fact as `{}`, which
   * asserts this principal has none — `Principal.abacAttributes` carries that distinction as
   * `null` vs `{}`, and `dischargeAbac` refuses an obligation on the first without consulting a
   * policy.
   *
   * Resolved here rather than per handler because this is the one record a request already carries
   * for its identity, so the five places that build an `auth.Principal` read one answer instead of
   * each asking its own.
   */
  readonly abacAttributes?: Readonly<Record<string, unknown>>;
}

export const ResolvedPrincipalSchema = z.object({
  principalId: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  principalKind: z.enum([
    "user",
    "service_account",
    "ai_architect",
    "system",
  ]),
  authScheme: z.enum(AUTH_SCHEMES),
  grantedScopes: z.array(z.string().max(200)),
  mfaProofAgeSeconds: z.number().int().min(0).nullable(),
  resolvedAt: z.string().datetime({ offset: true }),
  // Optional, so every existing resolver and stored row still parses, and so an absent field keeps
  // meaning "not resolved" rather than being defaulted to an empty record nobody gathered.
  abacAttributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The resolved principal's attributes as an authorization input, mapping **absent to `null`** —
 * the one spelling of that step, because the tempting wrong form (`?? {}`) turns "no directory was
 * consulted" into an assertion that this principal has no attributes, and `auth.dischargeAbac`
 * refuses an obligation on the first while answering a policy from the second.
 */
export function principalAbacAttributes(
  principal: ResolvedPrincipal | null,
): Readonly<Record<string, unknown>> | null {
  return principal?.abacAttributes ?? null;
}

/**
 * Whether a principal kind names a **person** who could hold a `meta.users` row.
 *
 * A total map rather than a `!== "service_account"` comparison, so a fifth kind is a compile error
 * instead of a kind inheriting whichever answer the comparison happened to give it.
 * `service_account` is the load-bearing `false`: a bare `--api-key 'key:role:tenant'` names no
 * person and **every** such key in a deployment shares one placeholder principal id, so treating
 * that id as an identity would hand one placeholder's row to every service credential at once.
 * `ai_architect` and `system` are `false` for the weaker reason that neither has a row to join, so
 * a lookup could only ever resolve `null` at the cost of a query.
 *
 * A spec that *names* a principal resolves `principalKind: "user"` and is treated as a person even
 * where an operator means it as a service account — that is the operator's own declaration.
 *
 * It lives here, beside `ResolvedPrincipalSchema`, because it is a fact about
 * `ResolvedPrincipal["principalKind"]` and this package has no workspace dependencies — so every
 * reader can import it. Before that it was spelled **three** ways: this map in
 * `apps/operate-server`, an inline `principalKind !== "user"` in the read-state routes, and
 * nothing at all in the UI-schema handler, which is how that handler came to discard the id.
 */
export const PRINCIPAL_KIND_NAMES_A_PERSON: Readonly<
  Record<ResolvedPrincipal["principalKind"], boolean>
> = Object.freeze({
  user: true,
  service_account: false,
  ai_architect: false,
  system: false,
});

export function principalNamesAPerson(principal: ResolvedPrincipal): boolean {
  return PRINCIPAL_KIND_NAMES_A_PERSON[principal.principalKind];
}

const PRINCIPAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * This principal's id **as a user id**, or `null` when it does not name one.
 *
 * Two conjuncts, and the second is not belt-and-braces. `ResolvedPrincipalSchema` constrains
 * `principalId` to a uuid and has **no parse site anywhere in the workspace** — the resolvers
 * return their stored object and `resolvePrincipalForCredential` spreads without parsing — so the
 * shape is enforced incidentally and late, by `PipelineExecutionSchema` when the execution record
 * is built at the *end* of the request. A reader that wants to use the value as a key to
 * `meta.users` therefore has to check it, which is what `resolveViewer` already did inline and
 * what this converges.
 *
 * `null` rather than a throw, because "this credential is not a person" is an ordinary and correct
 * state for an api-key, not an error — and distinguishing it from a person's id is the whole point:
 * a shared placeholder rendered as an identity is the defect this exists to prevent.
 */
export function principalUserId(principal: ResolvedPrincipal | null): string | null {
  if (principal === null || !principalNamesAPerson(principal)) return null;
  return PRINCIPAL_UUID_RE.test(principal.principalId) ? principal.principalId : null;
}

export const isStrongAuthScheme = (scheme: AuthScheme): boolean =>
  STRONG_AUTH_SCHEMES.has(scheme);

export const schemeRequiresHttps = (scheme: AuthScheme): boolean =>
  SCHEMES_REQUIRING_HTTPS.has(scheme);

export const isAuthSuccess = (outcome: AuthOutcome): boolean =>
  AUTH_SUCCESS_OUTCOMES.has(outcome);
