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

export const STRONG_AUTH_SCHEMES: ReadonlySet<AuthScheme> = new Set([
  "bearer_jwt",
  "mtls",
  "hmac_signature",
]);

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
  /** Why this treatment and not another. Rendered to an operator, so it names a consequence. */
  readonly reason: string;
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
 * A third member of `AUTH_SCHEME_TREATMENTS` would be tempting for `mtls`, whose recognising field
 * exists and has no producer. It is `refused` rather than a fourth kind because the *treatment* is
 * the same — refuse by name — and what differs is the reason, which the record carries. ADR-0331's
 * rule read the other way: two facts stay apart when their **remedies** differ, and both of these
 * have the same remedy for a caller (present a credential this gateway serves).
 *
 * The two `indistinguishable` members are deliberately not given a wire position in order to be
 * refused. A refusal arm is a wire commitment too, and a *partial* one is the defect restated: a
 * client using the spelling we did not reserve is served anonymously again, which is what this
 * increment exists to end. So each says in its own `reason` what would have to be decided first,
 * and the **residual** verdict — an `Authorization` header in any scheme this gateway does not
 * serve — is what covers an attempt in either of them. `api_key_query` is the opposite case and is
 * refused: reserving `?api_key=` commits only to never *accepting* it, which is already the
 * decision, so a client using another spelling is no worse off than before.
 */
export const AUTH_SCHEME_SUPPORT: Readonly<Record<AuthScheme, AuthSchemeSupport>> = Object.freeze({
  bearer_jwt: {
    treatment: "served",
    recognisedFrom: "an Authorization header with the Bearer auth-scheme",
    reason:
      "verified here: EdDSA signature against the configured JWKS, then exp, nbf, iss and aud",
  },
  api_key_header: {
    treatment: "served",
    recognisedFrom: "an x-api-key header",
    reason: "resolved here against the deployment's opaque-token lookup",
  },
  anonymous: {
    treatment: "not_a_credential",
    recognisedFrom: "no credential in any recognised position",
    reason:
      "the absence of a credential, not one of its kinds — the value a principal and a pipeline row carry when nothing was presented",
  },
  basic: {
    treatment: "refused",
    recognisedFrom: "an Authorization header with the Basic auth-scheme",
    reason:
      "not implemented: the deployment's password hashes back the login route (ADR-0358), which mints a session token, so a password-on-every-request scheme would be a second credential path over the same hashes and would have to re-implement that route's lockout to avoid being the way around it",
  },
  hmac_signature: {
    treatment: "indistinguishable",
    recognisedFrom: null,
    reason:
      "no Authorization auth-scheme token for HMAC request signing has been chosen here, and the repo's one HMAC wire format (CrossEngin-Signature, t=<unix>,v1=<hex>) authenticates a payload rather than a principal — which is why the pipeline reserves validate_request_signature as its own stage; reading that header as a principal credential would conflate the two. It is also the dearest of the unimplemented schemes: it needs a key-id-to-secret store, which does not exist, since meta.crypto_keys has no private-material column",
  },
  api_key_query: {
    treatment: "refused",
    recognisedFrom: "an api_key query parameter",
    reason:
      "refused deliberately and not merely unbuilt: a credential in a URL is copied into access logs, proxy logs and Referer, which is ADR-0301's argv rule one transport over — present the key in x-api-key instead",
  },
  mtls: {
    treatment: "refused",
    recognisedFrom: "the request's clientCertSha256",
    reason:
      "no edge forwards a client certificate: IncomingRequest.clientCertSha256 has no producer in this workspace and the shipped Caddyfile declares no client_auth, so the refusal is reachable only once a terminator populates it",
  },
  bearer_opaque: {
    treatment: "indistinguishable",
    recognisedFrom: null,
    reason:
      "the Bearer auth-scheme is claimed by bearer_jwt and nothing on the wire separates them; a token-shape test would *grant* rather than refuse, because the opaque lookup api_key_header already uses matches the whole api-key string, so routing a non-JWT bearer token to it would accept an api key presented in Authorization — a capability decision, not a parser one",
  },
});

export const authSchemeTreatment = (scheme: AuthScheme): AuthSchemeTreatment =>
  AUTH_SCHEME_SUPPORT[scheme].treatment;

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
 * `api-gateway-runtime`: the TLS floor by `stageValidateTls` (and again by
 * `IncomingRequestSchema.superRefine`, which refuses `tls_1_0`/`tls_1_1` at parse), the anonymous
 * arm by the authenticate stage's no-credential path, and the JWT `exp`/`nbf`/`iss`/`aud` quartet by
 * `verifyBearerJwt`. Two are unique to it — the scheme allow-list, which the runtime's stage now
 * reads from `AUTH_SCHEME_SUPPORT` instead, and the HMAC freshness window, which no runtime path has
 * because `hmac_signature` is refused.
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

export const isStrongAuthScheme = (scheme: AuthScheme): boolean =>
  STRONG_AUTH_SCHEMES.has(scheme);

export const schemeRequiresHttps = (scheme: AuthScheme): boolean =>
  SCHEMES_REQUIRING_HTTPS.has(scheme);

export const isAuthSuccess = (outcome: AuthOutcome): boolean =>
  AUTH_SUCCESS_OUTCOMES.has(outcome);
