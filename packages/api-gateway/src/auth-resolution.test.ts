import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_KEY_HEADER,
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
  CLIENT_CERT_FINGERPRINT_PATTERN,
  EMPTY_CERTIFICATE_FINGERPRINT,
  parseForwardedClientCertFingerprint,
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

  it("the served schemes are the ones the runtime authenticates", () => {
    expect(SERVED_AUTH_SCHEMES).toEqual([
      "bearer_jwt",
      "api_key_header",
      "mtls",
      "hmac_signature",
    ]);
  });

  /**
   * One, and the reason it is one rather than two is the whole of what `hmac_signature` needed: the
   * member's stated ground was that no wire position had been *chosen*, so reserving one in order to
   * refuse it would be a partial commitment. Choosing a **dedicated header** is a position that
   * commits to no shared namespace, so the scheme left this treatment by being served rather than by
   * the argument being withdrawn — `bearer_opaque` cannot follow it, because the position it would
   * need is `Authorization: Bearer`, which `bearer_jwt` already holds.
   */
  it("bearer_opaque is the one indistinguishable scheme", () => {
    const indistinguishable = AUTH_SCHEMES.filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment === "indistinguishable",
    );
    expect([...indistinguishable].sort()).toEqual(["bearer_opaque"]);
  });

  /**
   * The payload-versus-principal distinction that kept `hmac_signature` unserved is **kept and
   * answered** rather than dropped: the reason still names it, because the resolution is that the
   * two formats are separate headers, not that the distinction was imaginary. `CrossEngin-Signature`
   * remains the payload-authenticity format and `REQUEST_SIGNATURE_HEADER` is the credential, so no
   * verifier has to guess which canonical message a value is over — which is exactly the conflation
   * the old reason refused.
   *
   * `validate_request_signature` is deliberately **no longer named here**: that stage stays a stub,
   * and claiming it as this scheme's site would be false. Nothing can declare that a route requires
   * a signature — `RouteDefinition` has 14 fields and 0 signature-related, and `meta.gateway_routes`
   * 17 columns and 0 — so that stage is where a *per-route* policy would go once something can
   * declare one, and the measurement is in ADR-0393.
   */
  it("hmac_signature's reason keeps the payload-versus-principal distinction and answers it", () => {
    const reason = AUTH_SCHEME_SUPPORT.hmac_signature.reason;
    expect(reason).toContain("CrossEngin-Signature");
    expect(reason).toContain("payload");
    expect(reason).toContain("canonical message");
    // It must not claim the reserved stage, which is still a stub.
    expect(reason).not.toContain("validate_request_signature");
  });

  it("anonymous is the only scheme that is not a credential", () => {
    const notCredentials = AUTH_SCHEMES.filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment === "not_a_credential",
    );
    expect(notCredentials).toEqual(["anonymous"]);
  });

  /**
   * Two, and both are **reachable by any caller**, which is what makes the boot line's unconditional
   * "refusing … by name" clause true. ADR-0384 shipped that clause and recorded as its own unfixed
   * finding that it claimed a refusal no deployment could reach, because `mtls` was refused while
   * its recognising field had no producer. Serving `mtls` retired that by construction rather than
   * by a special case in the line, so this assertion is now also the fence over that claim: a
   * scheme added here whose refusal a caller cannot provoke makes the boot line false again.
   */
  /**
   * The one well-formed value that cannot denote a certificate, refused at both ends.
   *
   * Refused **by value**, so enrolling it does not make it work — which is the arm that matters: an
   * operator seeing this digest in a log from an edge in `client_auth mode request` could otherwise
   * enrol it and authenticate every certificate-less request as that principal.
   */
  it("refuses sha256(\"\") as a forwarded fingerprint, because no certificate is zero bytes", () => {
    expect(CLIENT_CERT_FINGERPRINT_PATTERN.test(EMPTY_CERTIFICATE_FINGERPRINT)).toBe(true);
    expect(parseForwardedClientCertFingerprint(EMPTY_CERTIFICATE_FINGERPRINT)).toBeNull();
    expect(parseForwardedClientCertFingerprint(EMPTY_CERTIFICATE_FINGERPRINT.toUpperCase())).toBeNull();
    // Non-vacuity: a different well-formed fingerprint is accepted, so the refusal is about this
    // value and not about the parser having stopped working.
    expect(parseForwardedClientCertFingerprint("a".repeat(64))).toBe("a".repeat(64));
    // And it really is the digest it claims to be, computed rather than copied.
    expect(createHash("sha256").update("").digest("hex")).toBe(EMPTY_CERTIFICATE_FINGERPRINT);
  });

  /**
   * **Retitled**, because the old title — "the refused schemes are named, and a caller can provoke
   * each" — claimed a behavioural property this body never checked and this *package* cannot: the
   * provocation needs `parseAuthHeader`, which lives in `@crossengin/api-gateway-runtime`, and
   * `@crossengin/api-gateway` has no workspace dependencies at all (zod only). A grep of the old
   * two-line body for `parseAuthHeader|request|handleRequest|authorization` returned zero hits.
   *
   * That is this repo's documented "documented the hazard and checked nothing" shape for the fourth
   * time (ADR-0351, ADR-0362, ADR-0372), and the dangerous part is that the claim was *true* — the
   * behavioural fence does exist, one package over, as `runtime-auth-schemes.test.ts`'s "every
   * recognisable scheme either authenticates or is refused by the stage", which drives each one
   * through the real 17 stages. So nothing was unchecked; a correct fact was attributed to a test
   * that did not establish it, which is worse than an absent fence because it reads as covered.
   */
  it("the refused set is exactly these two (provocation is fenced in the runtime package)", () => {
    const refused = AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SUPPORT[s].treatment === "refused");
    expect([...refused].sort()).toEqual(["api_key_query", "basic"]);
  });

  /**
   * The fence whose absence let a **false** refusal reason survive two increments that edited this
   * very map.
   *
   * `AUTH_SCHEME_SUPPORT.basic.reason` asserted that a Basic arm "would have to re-implement that
   * route's lockout" — wrong when it was written, because `credentialIsLocked` was exported and
   * already reused by a second credential surface 13 days earlier. Measured, 4 of the 8 schemes'
   * reasons were read by no test at all, and `basic` was the only **refused** one among them while
   * `api_key_query` carried three assertions. The one false reason was the one with no fence.
   *
   * A machine cannot check whether a reason is *true* — ADR-0384 says so in its own open questions,
   * and that remains the case. What it can check are the properties that make a reason *checkable
   * by a reader*, and the one that matters most is self-containment: these strings are interpolated
   * verbatim into the 401 body, so a reason that defers to an internal document number is
   * unactionable to the anonymous caller reading it and cannot be verified by anyone who does not
   * have the repository. Both halves of the old `basic` reason failed that — it cited ADR-0358 *and*
   * was false about what the citation would have shown.
   */
  it("every scheme's reason is substantive, and a refused one says what to send instead", () => {
    for (const scheme of AUTH_SCHEMES) {
      const { treatment, reason, recognisedFrom } = AUTH_SCHEME_SUPPORT[scheme];
      expect(reason.length, `${scheme}: reason is a placeholder`).toBeGreaterThan(40);
      expect(reason.trim(), `${scheme}: reason is padded`).toBe(reason);
      // `recognisedFrom` is nullable and the null is **load-bearing**: measured, it is null for
      // exactly one scheme, `bearer_opaque`, which is exactly the one `indistinguishable` member —
      // because having no wire position to be recognised from is what that treatment *means*. So
      // the invariant is the biconditional and not a non-empty check, which is what the first draft
      // of this fence asserted and what the suite refused with a TypeError on `null.length`. Note
      // `anonymous` is non-null and not recognisable, which is also right: its string describes the
      // *absence* of a credential rather than a position, so nullability tracks the treatment and
      // not recognisability.
      expect(
        recognisedFrom === null,
        `${scheme}: recognisedFrom null-ness must track the indistinguishable treatment`,
      ).toBe(treatment === "indistinguishable");
      if (recognisedFrom !== null) {
        expect(recognisedFrom.length, `${scheme}: recognisedFrom is a placeholder`).toBeGreaterThan(
          10,
        );
      }
      // No internal document reference in a string that reaches an unauthenticated caller. Checked
      // for every scheme and not only the refused ones, because the served reasons are published in
      // the OpenAPI document's security-scheme descriptions as well.
      expect(reason, `${scheme}: reason cites an ADR to an anonymous caller`).not.toMatch(
        /ADR-\d{4}/,
      );
      if (treatment === "refused") {
        // A refusal that names no alternative is ADR-0334's remedy-that-cannot-work with the remedy
        // left out entirely. Both refused schemes have a served sibling to point at, so this costs
        // nothing today and is the assertion that makes a third refusal state one.
        expect(
          reason.includes(API_KEY_HEADER) || /login route|session token/.test(reason),
          `${scheme}: refusal names no alternative credential`,
        ).toBe(true);
      }
    }
  });

  /**
   * `basic`'s reason, specifically — joining the set that has one, and asserting the two clauses
   * that are **measured** rather than the prose around them.
   *
   * The tenant clause is the structural half: RFC 7617 carries two fields, an authorization answer
   * here is a function of (user, tenant), and the first colon is the scheme's own delimiter so a
   * sub-grammar in the userid is unavailable. The cost clause is the measured half. Neither is a
   * statement about implementation effort, which is what the string this replaced was.
   */
  it("basic's refusal records the tenant, and neither the lockout nor a latency figure", () => {
    const reason = AUTH_SCHEME_SUPPORT.basic.reason;
    // The structural ground, which is the one of the two that is published: a Basic credential
    // cannot name a tenant, and the first colon is RFC 7617's own delimiter so a sub-grammar in the
    // userid is unavailable.
    expect(reason).toContain("tenant");
    expect(reason).toContain("colon");
    expect(reason).toContain(API_KEY_HEADER);
    // The false clause, by name. `lockout` must not come back: a Basic arm would reuse
    // `credentialIsLocked`, which is exported for exactly that, as the password-change route does.
    expect(reason).not.toMatch(/lockout|re-implement/);
    // And it must not claim the scheme is merely unbuilt, which is what "not implemented" said and
    // is the reading both measured grounds refute.
    expect(reason).not.toContain("not implemented");
    // The cost is a true ground and is deliberately **absent** from the body, so this is a fence
    // rather than an omission: `runtime.ts` interpolates the reason verbatim into the 401, and a
    // latency figure is an operational fact about this deployment that an anonymous caller has no
    // business being handed — and it is not durable either, since "N times dearer" reads as 693x,
    // 793x or 8,770x on one true cost depending on which Ed25519 figure is picked. A draft
    // published the middle one.
    expect(reason).not.toMatch(/\bms\b|millisecond|scrypt|per second|\/sec|times a signature/);
    expect(reason).not.toMatch(/\b\d{2,}x\b|thousand times|orders of magnitude/);
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

  it("RECOGNISABLE_AUTH_SCHEMES is served plus refused and excludes the other two", () => {
    expect([...RECOGNISABLE_AUTH_SCHEMES].sort()).toEqual(
      ["api_key_header", "api_key_query", "basic", "bearer_jwt", "hmac_signature", "mtls"].sort(),
    );
    expect(RECOGNISABLE_AUTH_SCHEMES).not.toContain("anonymous");
    expect(RECOGNISABLE_AUTH_SCHEMES).not.toContain("bearer_opaque");
  });

  it("authSchemeTreatment answers the map", () => {
    expect(authSchemeTreatment("bearer_jwt")).toBe("served");
    expect(authSchemeTreatment("basic")).toBe("refused");
    expect(authSchemeTreatment("hmac_signature")).toBe("served");
    expect(authSchemeTreatment("bearer_opaque")).toBe("indistinguishable");
    expect(authSchemeTreatment("anonymous")).toBe("not_a_credential");
  });

  /**
   * `STRONG_AUTH_SCHEMES` is asserted against the map rather than beside it, and the property is
   * that the two are *allowed* to disagree: strength is a property of the scheme and serving is a
   * property of this deployment, so a later reader must not "fix" one against the other.
   *
   * **This replaces a test whose subject no longer exists**, rather than relaxing it. That one was
   * titled "deliberately includes a scheme this gateway does not serve" and pinned
   * `strongUnserved === ["mtls"]`; it went two members → one → **zero** as `hmac_signature` and
   * then `mtls` were served, and a judgement with no case left is not a judgement (ADR-0375's
   * reason for deleting `anchoringWouldBury` rather than flipping its map). Relaxing it to `[]`
   * would have left an assertion that passes for every possible input, which reads as coverage it
   * does not provide.
   *
   * What is asserted instead is the stronger fact that became true: **every strong scheme is
   * served**, so the disagreement the set permits is currently empty. Written as an equality to the
   * whole set rather than as "unserved is empty", so the next strong scheme added has to be served
   * or say here why not — which is the same obligation the old test carried, pointing the other way.
   */
  it("every strong scheme is served, and the set may still disagree with the map", () => {
    const strongServed = [...STRONG_AUTH_SCHEMES].filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment === "served",
    );
    expect([...strongServed].sort()).toEqual([...STRONG_AUTH_SCHEMES].sort());
    // Non-vacuity: the set is not empty, so the equality above is a claim about three members and
    // not a tautology over none.
    expect(STRONG_AUTH_SCHEMES.size).toBe(3);
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
