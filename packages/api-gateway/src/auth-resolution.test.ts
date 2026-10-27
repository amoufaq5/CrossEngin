import { describe, expect, it } from "vitest";
import {
  AUTH_OUTCOMES,
  AUTH_OUTCOME_SUCCEEDS,
  AUTH_SCHEMES,
  AUTH_SCHEME_SUPPORT,
  AUTH_SCHEME_TREATMENTS,
  AUTH_SUCCESS_OUTCOMES,
  RECOGNISABLE_AUTH_SCHEMES,
  SERVED_AUTH_SCHEMES,
  authSchemeTreatment,
  ParsedAuthCredentialSchema,
  ResolvedPrincipalSchema,
  SCHEMES_REQUIRING_HTTPS,
  STRONG_AUTH_SCHEMES,
  isAuthSuccess,
  isStrongAuthScheme,
  principalAbacAttributes,
  resolveAuth,
  schemeRequiresHttps,
  type ParsedAuthCredential,
  type ResolvedPrincipal,
} from "./auth-resolution.js";

const baseJwt: ParsedAuthCredential = {
  scheme: "bearer_jwt",
  presentedAt: "2026-05-16T10:00:00.000Z",
  tokenSha256: "a".repeat(64),
  apiKeyPrefix: null,
  apiKeySecretSha256: null,
  basicUsername: null,
  basicPasswordSha256: null,
  clientCertSha256: null,
  hmacKeyId: null,
  hmacSignatureSha256: null,
  hmacSignedAt: null,
  jwtIssuer: "https://sso.acme.com",
  jwtAudience: ["api.crossengin.io"],
  jwtSubject: "alice@acme.com",
  jwtExpiresAt: "2026-05-16T11:00:00.000Z",
  jwtNotBefore: "2026-05-16T09:55:00.000Z",
  jwtScope: ["read", "write"],
};

describe("constants", () => {
  it("has 8 auth schemes", () => {
    expect(AUTH_SCHEMES).toHaveLength(8);
  });
  it("has 19 auth outcomes", () => {
    expect(AUTH_OUTCOMES).toHaveLength(19);
    expect(AUTH_OUTCOMES).toContain("tenant_mismatch");
  });

  // ADR-0384 and ADR-0386 appended rather than inserted, so an already-migrated deployment's
  // `auth_outcome` CHECK differs from the catalog's by trailing members only and the emitted SQL
  // moves nowhere else. `pg-value-set-domains.ts` compares the two as *sets*, so order is not what
  // that rule reads — the order matters to the SQL byte-identity the reconciler compares.
  //
  // Both this and the length above failed when ADR-0386 appended its member, which is the whole
  // reason they are written as literals: an outcome added without widening
  // `meta.gateway_pipeline_executions.auth_outcome` would otherwise reach a deployment as a `23514`
  // on the first request that produced it.
  it("appends the three added members at the end, in order", () => {
    expect(AUTH_OUTCOMES.slice(-3)).toEqual([
      "scheme_not_supported",
      "credential_unrecognized",
      "required_claim_absent",
    ]);
  });
  it("STRONG_AUTH_SCHEMES includes bearer_jwt + mtls + hmac_signature", () => {
    expect(STRONG_AUTH_SCHEMES.size).toBe(3);
    expect(STRONG_AUTH_SCHEMES.has("bearer_jwt")).toBe(true);
    expect(STRONG_AUTH_SCHEMES.has("basic")).toBe(false);
  });
  it("SCHEMES_REQUIRING_HTTPS excludes mtls + anonymous", () => {
    expect(SCHEMES_REQUIRING_HTTPS.has("mtls")).toBe(false);
    expect(SCHEMES_REQUIRING_HTTPS.has("anonymous")).toBe(false);
    expect(SCHEMES_REQUIRING_HTTPS.has("bearer_jwt")).toBe(true);
  });
  it("AUTH_SUCCESS_OUTCOMES has 2 entries", () => {
    expect(AUTH_SUCCESS_OUTCOMES.size).toBe(2);
  });
});

describe("ParsedAuthCredentialSchema", () => {
  it("accepts a valid bearer_jwt credential", () => {
    expect(() => ParsedAuthCredentialSchema.parse(baseJwt)).not.toThrow();
  });

  it("rejects bearer_jwt without tokenSha256", () => {
    expect(() =>
      ParsedAuthCredentialSchema.parse({ ...baseJwt, tokenSha256: null }),
    ).toThrow(/bearer_jwt requires tokenSha256/);
  });

  it("rejects api_key_header without prefix + secret", () => {
    expect(() =>
      ParsedAuthCredentialSchema.parse({
        ...baseJwt,
        scheme: "api_key_header",
      }),
    ).toThrow(/api_key schemes require/);
  });

  it("rejects basic auth without username + password sha", () => {
    expect(() =>
      ParsedAuthCredentialSchema.parse({
        ...baseJwt,
        scheme: "basic",
      }),
    ).toThrow(/basic auth requires/);
  });

  it("rejects mtls without clientCertSha256", () => {
    expect(() =>
      ParsedAuthCredentialSchema.parse({
        ...baseJwt,
        scheme: "mtls",
      }),
    ).toThrow(/mtls requires clientCertSha256/);
  });

  it("rejects hmac_signature without keyId + signatureSha + signedAt", () => {
    expect(() =>
      ParsedAuthCredentialSchema.parse({
        ...baseJwt,
        scheme: "hmac_signature",
      }),
    ).toThrow(/hmac_signature requires/);
  });
});

describe("resolveAuth", () => {
  const now = new Date("2026-05-16T10:30:00Z");

  it("returns weak_tls_rejected when TLS unacceptable", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: false,
      now,
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("weak_tls_rejected");
  });

  it("returns authenticated for valid JWT in window", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: true,
      now,
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("authenticated");
  });

  it("returns expired_token when jwt past exp", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: true,
      now: new Date("2026-05-16T12:00:00Z"),
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("expired_token");
  });

  it("returns not_yet_valid_token when before nbf", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: true,
      now: new Date("2026-05-16T09:00:00Z"),
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("not_yet_valid_token");
  });

  it("returns issuer_mismatch", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: true,
      now,
      expectedIssuer: "https://other.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("issuer_mismatch");
  });

  it("returns audience_mismatch when aud array does not include expected", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: true,
      tlsAcceptable: true,
      now,
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "other.api",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("audience_mismatch");
  });

  it("returns scheme_not_supported when scheme not allowed", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: false,
      tlsAcceptable: true,
      now,
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("scheme_not_supported");
  });

  it("returns anonymous for anonymous scheme", () => {
    const r = resolveAuth({
      credential: {
        ...baseJwt,
        scheme: "anonymous",
        tokenSha256: null,
        jwtIssuer: null,
        jwtAudience: [],
        jwtSubject: null,
        jwtExpiresAt: null,
        jwtNotBefore: null,
        jwtScope: [],
      },
      schemeAllowed: true,
      tlsAcceptable: true,
      now,
      expectedIssuer: null,
      expectedAudience: null,
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("anonymous");
  });

  it("rejects hmac signature past max age", () => {
    const r = resolveAuth({
      credential: {
        ...baseJwt,
        scheme: "hmac_signature",
        tokenSha256: null,
        jwtIssuer: null,
        jwtAudience: [],
        jwtSubject: null,
        jwtExpiresAt: null,
        jwtNotBefore: null,
        jwtScope: [],
        hmacKeyId: "key-1",
        hmacSignatureSha256: "a".repeat(64),
        hmacSignedAt: "2026-05-16T09:00:00.000Z",
      },
      schemeAllowed: true,
      tlsAcceptable: true,
      now: new Date("2026-05-16T10:30:00Z"),
      expectedIssuer: null,
      expectedAudience: null,
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
      signatureVerified: true,
    });
    expect(r.outcome).toBe("expired_token");
  });
});

describe("ResolvedPrincipalSchema", () => {
  it("accepts a valid resolved principal", () => {
    expect(() =>
      ResolvedPrincipalSchema.parse({
        principalId: "11111111-1111-1111-1111-111111111111",
        tenantId: "22222222-2222-2222-2222-222222222222",
        principalKind: "user",
        authScheme: "bearer_jwt",
        grantedScopes: ["read"],
        mfaProofAgeSeconds: 300,
        resolvedAt: "2026-05-16T10:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

const PRINCIPAL_FIXTURE = {
  principalId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  principalKind: "user",
  authScheme: "bearer_jwt",
  grantedScopes: [],
  mfaProofAgeSeconds: null,
  resolvedAt: "2026-05-16T10:00:00.000Z",
};

describe("principalAbacAttributes", () => {
  const PRINCIPAL = {
    principalId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-05-16T10:00:00.000Z",
  } as const satisfies ResolvedPrincipal;

  it("maps an absent field to null, not an empty record", () => {
    // The distinction the whole wire turns on: nobody looked, so no policy over attributes can be
    // answered. `{}` would assert this principal has none.
    expect(principalAbacAttributes(PRINCIPAL)).toBeNull();
  });

  it("maps a null principal to null", () => {
    expect(principalAbacAttributes(null)).toBeNull();
  });

  it("passes an empty resolved record through as itself", () => {
    const attrs = principalAbacAttributes({ ...PRINCIPAL, abacAttributes: {} });
    expect(attrs).toEqual({});
    expect(attrs).not.toBeNull();
  });

  it("passes a populated record through unchanged", () => {
    expect(
      principalAbacAttributes({ ...PRINCIPAL, abacAttributes: { department: "clinical" } }),
    ).toEqual({ department: "clinical" });
  });
});

describe("ResolvedPrincipalSchema abacAttributes", () => {
  it("accepts a principal with no abacAttributes (absent = not resolved)", () => {
    expect(ResolvedPrincipalSchema.parse(PRINCIPAL_FIXTURE).abacAttributes).toBeUndefined();
  });

  it("accepts and preserves a resolved attribute record", () => {
    const parsed = ResolvedPrincipalSchema.parse({
      ...PRINCIPAL_FIXTURE,
      abacAttributes: { department: "clinical", clearance: 3 },
    });
    expect(parsed.abacAttributes).toEqual({ department: "clinical", clearance: 3 });
  });

  it("refuses a non-object abacAttributes", () => {
    expect(() =>
      ResolvedPrincipalSchema.parse({ ...PRINCIPAL_FIXTURE, abacAttributes: "clinical" }),
    ).toThrow();
  });
});

describe("isStrongAuthScheme / schemeRequiresHttps / isAuthSuccess", () => {
  it("bearer_jwt is strong", () => {
    expect(isStrongAuthScheme("bearer_jwt")).toBe(true);
  });
  it("basic is not strong", () => {
    expect(isStrongAuthScheme("basic")).toBe(false);
  });
  it("api_key_header requires https", () => {
    expect(schemeRequiresHttps("api_key_header")).toBe(true);
  });
  it("mtls does not require https (mtls IS the auth + transport)", () => {
    expect(schemeRequiresHttps("mtls")).toBe(false);
  });
  it("authenticated and anonymous are success outcomes", () => {
    expect(isAuthSuccess("authenticated")).toBe(true);
    expect(isAuthSuccess("anonymous")).toBe(true);
    expect(isAuthSuccess("expired_token")).toBe(false);
  });
});

describe("AUTH_SCHEME_SUPPORT", () => {
  it("is total over AUTH_SCHEMES and nothing else", () => {
    expect(Object.keys(AUTH_SCHEME_SUPPORT).sort()).toEqual([...AUTH_SCHEMES].sort());
  });

  it("is frozen, so a reader cannot be handed a mutated treatment", () => {
    expect(Object.isFrozen(AUTH_SCHEME_SUPPORT)).toBe(true);
  });

  it("every treatment is a declared member", () => {
    for (const scheme of AUTH_SCHEMES) {
      expect(AUTH_SCHEME_TREATMENTS).toContain(AUTH_SCHEME_SUPPORT[scheme].treatment);
    }
  });

  /**
   * The biconditional is the fence, in both directions. A scheme with a recognising position and no
   * refusal is half of this increment's defect (four schemes were recognisable from the request and
   * served anonymously); a refusal naming no position is the other half (a denial no request can
   * ever receive, because nothing recognises it).
   */
  it("recognisedFrom is null exactly for the indistinguishable schemes", () => {
    for (const scheme of AUTH_SCHEMES) {
      const support = AUTH_SCHEME_SUPPORT[scheme];
      expect(support.recognisedFrom === null).toBe(support.treatment === "indistinguishable");
    }
  });

  it("every reason is prose and none merely restates its own key", () => {
    for (const scheme of AUTH_SCHEMES) {
      const support = AUTH_SCHEME_SUPPORT[scheme];
      expect(support.reason.length).toBeGreaterThan(30);
      expect(support.reason).not.toBe(support.treatment);
      expect(support.reason).not.toBe(scheme);
    }
  });

  it("the two served schemes are the two the runtime authenticates", () => {
    expect(SERVED_AUTH_SCHEMES).toEqual(["bearer_jwt", "api_key_header"]);
  });

  /**
   * Two, and both for the same stated reason: no wire position has been *chosen* for them here, so
   * reserving one in order to refuse it would be a partial commitment, and a client using the
   * spelling we did not reserve is served anonymously — the defect restated one spelling over.
   */
  it("bearer_opaque and hmac_signature are the indistinguishable schemes", () => {
    const indistinguishable = AUTH_SCHEMES.filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment === "indistinguishable",
    );
    expect([...indistinguishable].sort()).toEqual(["bearer_opaque", "hmac_signature"]);
  });

  /**
   * The finding that moved `hmac_signature` off `refused`: the repo's one HMAC wire format is
   * `SIGNATURE_HEADER_NAME` (`packages/sdk/src/webhooks.ts:251`) over `crypto/hmac.ts`'s
   * `t=<unix>,v1=<hex>`, and it authenticates a *payload*. `PIPELINE_STAGES` reserves
   * `validate_request_signature` for exactly that, so reading it as a principal credential would
   * conflate request authentication with message authenticity.
   */
  it("hmac_signature's reason names the payload-versus-principal conflation", () => {
    const reason = AUTH_SCHEME_SUPPORT.hmac_signature.reason;
    expect(reason).toContain("validate_request_signature");
    expect(reason).toContain("payload");
  });

  it("anonymous is the only scheme that is not a credential", () => {
    const notCredentials = AUTH_SCHEMES.filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment === "not_a_credential",
    );
    expect(notCredentials).toEqual(["anonymous"]);
  });

  it("the three refused schemes are named", () => {
    const refused = AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SUPPORT[s].treatment === "refused");
    expect([...refused].sort()).toEqual(["api_key_query", "basic", "mtls"]);
  });

  /**
   * ADR-0301's argv rule one transport over. `api_key_query` is the one refused scheme whose
   * *implementation* would be the regression — `query` is already on `IncomingRequest`, so it is a
   * three-line change — and before this increment nothing anywhere in the repo recorded why it had
   * not been made. The assertion is on the reason because the reason is the deliverable.
   */
  it("api_key_query's refusal records that the implementation is the regression", () => {
    const reason = AUTH_SCHEME_SUPPORT.api_key_query.reason;
    expect(reason).toContain("access logs");
    expect(reason).toContain("x-api-key");
  });

  it("bearer_opaque's reason records why a token-shape test would grant rather than refuse", () => {
    expect(AUTH_SCHEME_SUPPORT.bearer_opaque.reason).toContain("grant");
  });

  it("RECOGNISABLE_AUTH_SCHEMES is served plus refused and excludes the other three", () => {
    expect([...RECOGNISABLE_AUTH_SCHEMES].sort()).toEqual(
      ["api_key_header", "api_key_query", "basic", "bearer_jwt", "mtls"].sort(),
    );
    expect(RECOGNISABLE_AUTH_SCHEMES).not.toContain("anonymous");
    expect(RECOGNISABLE_AUTH_SCHEMES).not.toContain("bearer_opaque");
    expect(RECOGNISABLE_AUTH_SCHEMES).not.toContain("hmac_signature");
  });

  it("authSchemeTreatment answers the map", () => {
    expect(authSchemeTreatment("bearer_jwt")).toBe("served");
    expect(authSchemeTreatment("basic")).toBe("refused");
    expect(authSchemeTreatment("hmac_signature")).toBe("indistinguishable");
    expect(authSchemeTreatment("bearer_opaque")).toBe("indistinguishable");
    expect(authSchemeTreatment("anonymous")).toBe("not_a_credential");
  });

  /**
   * Both of this repo's existing scheme sets are asserted against the new map rather than beside
   * it: `STRONG_AUTH_SCHEMES` names two schemes this gateway refuses (`mtls`, `hmac_signature`),
   * which is coherent — strength is a property of the scheme and serving is a property of this
   * deployment — and the assertion pins that they are *allowed* to disagree, so a later reader does
   * not "fix" one against the other.
   */
  it("STRONG_AUTH_SCHEMES deliberately includes schemes this gateway does not serve", () => {
    const strongUnserved = [...STRONG_AUTH_SCHEMES].filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment !== "served",
    );
    expect([...strongUnserved].sort()).toEqual(["hmac_signature", "mtls"]);
  });
});

describe("AUTH_OUTCOME_SUCCEEDS", () => {
  it("is total over AUTH_OUTCOMES and nothing else", () => {
    expect(Object.keys(AUTH_OUTCOME_SUCCEEDS).sort()).toEqual([...AUTH_OUTCOMES].sort());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(AUTH_OUTCOME_SUCCEEDS)).toBe(true);
  });

  /**
   * The derivation is the fence, and the direction matters: before ADR-0384 `AUTH_SUCCESS_OUTCOMES`
   * was a hand-written `Set` of two, so a member added to `AUTH_OUTCOMES` alone typechecked and
   * joined the refusing side in silence. Deriving it makes a new member a compile error at the map
   * until it says which side it is on, which is `PROOF_VERSION_COVERAGE`'s shape (ADR-0351).
   */
  it("AUTH_SUCCESS_OUTCOMES is exactly the map's true members", () => {
    expect([...AUTH_SUCCESS_OUTCOMES].sort()).toEqual(
      AUTH_OUTCOMES.filter((o) => AUTH_OUTCOME_SUCCEEDS[o]).sort(),
    );
    expect([...AUTH_SUCCESS_OUTCOMES].sort()).toEqual(["anonymous", "authenticated"]);
  });

  it("both ADR-0384 members refuse", () => {
    expect(isAuthSuccess("scheme_not_supported")).toBe(false);
    expect(isAuthSuccess("credential_unrecognized")).toBe(false);
  });
});

describe("resolveAuth — the signature premise", () => {
  const now = new Date("2026-05-16T10:30:00Z");
  const input = (overrides: Partial<Parameters<typeof resolveAuth>[0]>) => ({
    credential: baseJwt,
    schemeAllowed: true,
    tlsAcceptable: true,
    signatureVerified: true,
    now,
    expectedIssuer: "https://sso.acme.com",
    expectedAudience: "api.crossengin.io",
    clockSkewSeconds: 60,
    hmacSignatureMaxAgeSeconds: 300,
    ...overrides,
  });

  /**
   * The arm that takes the trap out. Before it, this exact input — fresh claims, correct issuer and
   * audience, and a `tokenSha256` that is a *digest* rather than a signature — answered
   * `authenticated`, which is what made wiring the function worse than leaving it unwired
   * (ADR-0336).
   */
  it("refuses invalid_signature when the caller has not verified one", () => {
    const r = resolveAuth(input({ signatureVerified: false }));
    expect(r.outcome).toBe("invalid_signature");
    expect(r.reason).toBe("signature_not_verified_by_caller");
  });

  it("answers anonymous for an absent credential even with no signature verified", () => {
    const r = resolveAuth(
      input({
        credential: {
          ...baseJwt,
          scheme: "anonymous",
          tokenSha256: null,
          jwtIssuer: null,
          jwtAudience: [],
          jwtSubject: null,
          jwtExpiresAt: null,
          jwtNotBefore: null,
          jwtScope: [],
        },
        signatureVerified: false,
        expectedIssuer: null,
        expectedAudience: null,
      }),
    );
    expect(r.outcome).toBe("anonymous");
  });

  // The TLS floor outranks the signature premise: a weak channel is a fact about the connection and
  // is true whatever the credential turns out to be.
  it("weak TLS outranks the signature premise", () => {
    const r = resolveAuth(input({ tlsAcceptable: false, signatureVerified: false }));
    expect(r.outcome).toBe("weak_tls_rejected");
  });

  // And the scheme allow-list outranks it too, for the reason the runtime's stage orders the same
  // way: there is nothing to learn from examining a credential in a scheme this gateway will not
  // accept whatever it says.
  it("a disallowed scheme outranks the signature premise", () => {
    const r = resolveAuth(input({ schemeAllowed: false, signatureVerified: false }));
    expect(r.outcome).toBe("scheme_not_supported");
    expect(r.reason).toBe("scheme_bearer_jwt_not_allowed");
  });

  it("an expired token still reports expiry once the signature premise holds", () => {
    const r = resolveAuth(input({ now: new Date("2026-05-16T12:00:00Z") }));
    expect(r.outcome).toBe("expired_token");
  });

  // Every outcome this function can return is a declared member, which is what `pipeline.ts`'s
  // `z.enum(AUTH_OUTCOMES)` and the catalogued CHECK both require of anything that reaches a row.
  it("never returns an outcome outside the enum", () => {
    const results = [
      resolveAuth(input({})),
      resolveAuth(input({ signatureVerified: false })),
      resolveAuth(input({ schemeAllowed: false })),
      resolveAuth(input({ tlsAcceptable: false })),
    ];
    for (const r of results) {
      expect(AUTH_OUTCOMES).toContain(r.outcome);
    }
  });
});
