import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  sha256,
  signEd25519,
} from "@crossengin/crypto";
import {
  RECOGNISABLE_AUTH_SCHEMES,
  type IncomingRequest,
} from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  API_KEY_QUERY_PARAM,
  InMemoryJwksProvider,
  REQUIRED_JWT_CLAIMS,
  REQUIRED_JWT_CLAIM_COSTS,
  type RequiredJwtClaim,
  authSchemeToken,
  buildOpaqueCredentialMatcher,
  parseAuthHeader,
  parseJwt,
  resolvePrincipalForCredential,
  verifyBearerJwt,
} from "./auth.js";
import { InMemoryPrincipalResolver } from "./stores.js";

const NOW_SECONDS = 1_750_000_000;
const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJwt(opts: {
  privateKeyBase64: string;
  publicKeyBase64: string;
  kid: string;
  iss?: string;
  aud?: string | readonly string[];
  sub?: string;
  /**
   * `string` as well as `number`, because a wire JWT is JSON and a minter can put a string here —
   * which is the case the usability check exists for. Typing it `number` would make the one token
   * shape that exercises that check unbuildable, so the fixture could not be written and the hazard
   * would stay theoretical.
   */
  exp?: number | string;
  nbf?: number;
}): string {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: opts.kid })),
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: opts.iss,
        aud: opts.aud,
        sub: opts.sub,
        exp: opts.exp,
        nbf: opts.nbf,
      }),
    ),
  );
  const signedBytes = new TextEncoder().encode(`${header}.${payload}`);
  const sigBase64 = signEd25519(opts.privateKeyBase64, opts.publicKeyBase64, signedBytes);
  const sigB64Url = sigBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${payload}.${sigB64Url}`;
}

function fixtureRequest(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    id: "req_test0001",
    receivedAt: "2026-05-16T12:00:00.000Z",
    method: "POST",
    path: "/v1/tenants",
    query: {},
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: 0,
    bodySha256: null,
    clientIp: "203.0.113.1",
    forwardedFor: [],
    forwardedProto: null,
    forwardedHost: null,
    userAgent: null,
    tlsVersion: null,
    tlsCipher: null,
    clientCertSha256: null,
    correlationId: null,
    traceparent: null,
    tenantHint: null,
    edgeRegion: null,
    ...overrides,
  };
}

describe("parseJwt", () => {
  it("parses a well-formed token", () => {
    const kp = generateEd25519Keypair();
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid: "k1",
      iss: "https://issuer.example",
    });
    const parsed = parseJwt(token);
    expect(parsed?.header.alg).toBe("EdDSA");
    expect(parsed?.header.kid).toBe("k1");
    expect(parsed?.payload.iss).toBe("https://issuer.example");
  });

  it("returns null for non-3-part input", () => {
    expect(parseJwt("not.a.jwt.extra")).toBeNull();
    expect(parseJwt("only-one-part")).toBeNull();
  });
});

describe("verifyBearerJwt", () => {
  const issuer = "https://issuer.example";
  const audience = "https://api.crossengin.io";
  /** Derived, not listed: a fourth required claim is covered by every test below without an edit. */
  const ALL_CLAIMS: ReadonlySet<RequiredJwtClaim> = new Set(REQUIRED_JWT_CLAIMS);
  /** The pre-ADR-0386 behaviour, kept nameable so the new tests can assert against it. */
  const NO_CLAIMS: ReadonlySet<RequiredJwtClaim> = new Set();

  /**
   * `omit` bypasses the `??` defaults below, which is the only way to build a token that *lacks* a
   * claim: `opts.iss ?? issuer` cannot express absence, since passing `undefined` substitutes the
   * default. `buildJwt` then drops the key, because `JSON.stringify` omits an `undefined` value --
   * so the wire form really has no such claim rather than a null one.
   */
  async function makeJwksAndToken(
    opts: {
      exp?: number | string;
      nbf?: number;
      aud?: string | readonly string[];
      iss?: string;
      omit?: readonly RequiredJwtClaim[];
    } = {},
  ) {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const omitted = (c: RequiredJwtClaim) => opts.omit?.includes(c) === true;
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      iss: omitted("iss") ? undefined : (opts.iss ?? issuer),
      aud: omitted("aud") ? undefined : (opts.aud ?? audience),
      sub: USER,
      exp: omitted("exp") ? undefined : (opts.exp ?? NOW_SECONDS + 3_600),
      nbf: opts.nbf,
    });
    return { jwks, token, kp };
  }

  it("returns authenticated for a valid token", async () => {
    const { jwks, token } = await makeJwksAndToken();
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: {
        expectedIssuer: issuer,
        expectedAudience: audience,
        requiredClaims: ALL_CLAIMS,
        clockSkewSeconds: 30,
        nowSeconds: NOW_SECONDS,
      },
    });
    expect(result.outcome).toBe("authenticated");
  });

  it("rejects expired_token", async () => {
    const { jwks, token } = await makeJwksAndToken({ exp: NOW_SECONDS - 3_600 });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("expired_token");
  });

  it("rejects not_yet_valid_token (nbf in future)", async () => {
    const { jwks, token } = await makeJwksAndToken({ nbf: NOW_SECONDS + 3_600 });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("not_yet_valid_token");
  });

  it("rejects audience_mismatch", async () => {
    const { jwks, token } = await makeJwksAndToken({ aud: "https://other.example" });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("audience_mismatch");
  });

  it("rejects issuer_mismatch", async () => {
    const { jwks, token } = await makeJwksAndToken({ iss: "https://other-issuer.example" });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("issuer_mismatch");
  });

  it("rejects invalid_signature", async () => {
    const { jwks, token } = await makeJwksAndToken();
    const tampered = token.slice(0, -10) + "AAAAAAAAAA";
    const result = await verifyBearerJwt({
      token: tampered,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("invalid_signature");
  });

  it("rejects credential_malformed on non-EdDSA alg", async () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "k1" }), "utf8")
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const payloadB64 = "eyJzdWIiOiJ4In0";
    const fake = `${headerB64}.${payloadB64}.AAAA`;
    const result = await verifyBearerJwt({
      token: fake,
      jwks: new InMemoryJwksProvider({ keys: [] }),
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("credential_malformed");
  });

  it("rejects credential_not_found when kid is unknown", async () => {
    const { token } = await makeJwksAndToken();
    const result = await verifyBearerJwt({
      token,
      jwks: new InMemoryJwksProvider({ keys: [] }),
      opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("credential_not_found");
  });

  /**
   * The defect ADR-0386 closes, measured before the fix: all three guards were `present && wrong`,
   * so a token carrying none of the three verified as `authenticated` -- it never expired, named no
   * issuer, and named no audience, and the only thing established was that a key in the JWKS had
   * signed it. On a shared IdP key set that is cross-application replay with no expiry.
   *
   * Each case is asserted twice, against the strict set and against the empty one, because the
   * second arm is what the old behaviour was: without it these tests would pass for a build that
   * required nothing, which is the state they exist to refuse.
   */
  describe("a required claim that is absent", () => {
    for (const claim of REQUIRED_JWT_CLAIMS) {
      it(`refuses required_claim_absent when ${claim} is missing, and authenticates when not required`, async () => {
        const { jwks, token } = await makeJwksAndToken({ omit: [claim] });
        const base = { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS };

        const strict = await verifyBearerJwt({ token, jwks, opts: { ...base, requiredClaims: ALL_CLAIMS } });
        expect(strict.outcome).toBe("required_claim_absent");
        expect(strict.reason).toBe(`${claim} is absent or not usable`);

        const relaxed = await verifyBearerJwt({ token, jwks, opts: { ...base, requiredClaims: NO_CLAIMS } });
        expect(relaxed.outcome).toBe("authenticated");
      });
    }

    it("refuses a token carrying none of the three, naming the first in a fixed order", async () => {
      const { jwks, token } = await makeJwksAndToken({ omit: REQUIRED_JWT_CLAIMS });
      const result = await verifyBearerJwt({
        token,
        jwks,
        opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
      });
      expect(result.outcome).toBe("required_claim_absent");
      // Reported in `REQUIRED_JWT_CLAIMS` order rather than the payload's, so the reason is stable
      // across two tokens missing the same set.
      expect(result.reason).toBe("exp is absent or not usable");
    });

    it("relaxes per claim, so accepting one absence does not accept the others", async () => {
      const base = { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS };
      const only = new Set<RequiredJwtClaim>(["aud"]);

      const { jwks: j1, token: noExp } = await makeJwksAndToken({ omit: ["exp"] });
      expect((await verifyBearerJwt({ token: noExp, jwks: j1, opts: { ...base, requiredClaims: only } })).outcome)
        .toBe("authenticated");

      const { jwks: j2, token: noAud } = await makeJwksAndToken({ omit: ["aud"] });
      expect((await verifyBearerJwt({ token: noAud, jwks: j2, opts: { ...base, requiredClaims: only } })).outcome)
        .toBe("required_claim_absent");
    });

    /**
     * Presence is not `!== undefined`, and this is the case that forced the distinction: `exp:
     * "soon"` is present, so a presence check admits it, and then `typeof exp === "number"` is false
     * so the expiry comparison is skipped -- a token with an unenforceable expiry, authenticated.
     * Requiring a claim and requiring it to be usable cannot be two checks.
     */
    it("refuses a required claim present in a form its own guard cannot use", async () => {
      const { jwks, token } = await makeJwksAndToken({ exp: "soon" });
      const base = { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS };

      expect((await verifyBearerJwt({ token, jwks, opts: { ...base, requiredClaims: ALL_CLAIMS } })).outcome)
        .toBe("required_claim_absent");
      // The old behaviour, pinned so the hazard is legible: unrequired, a string `exp` is simply
      // never compared.
      expect((await verifyBearerJwt({ token, jwks, opts: { ...base, requiredClaims: NO_CLAIMS } })).outcome)
        .toBe("authenticated");
    });

    it("never puts the claim's own value in the reason", async () => {
      const { jwks, token } = await makeJwksAndToken({ exp: "tell-nobody" });
      const result = await verifyBearerJwt({
        token,
        jwks,
        opts: { expectedIssuer: issuer, expectedAudience: audience, requiredClaims: ALL_CLAIMS, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
      });
      expect(result.reason).not.toContain("tell-nobody");
    });

    it("declares a cost for every claim it can require, and requires no claim it cannot cost", () => {
      expect([...REQUIRED_JWT_CLAIMS].sort()).toEqual(Object.keys(REQUIRED_JWT_CLAIM_COSTS).sort());
      for (const claim of REQUIRED_JWT_CLAIMS) {
        const cost = REQUIRED_JWT_CLAIM_COSTS[claim];
        expect(cost.length).toBeGreaterThan(40);
        // A cost that merely restates its key tells an operator nothing.
        expect(cost).not.toBe(claim);
      }
      // `nbf` is deliberately absent: its absence means *valid from issuance*, which is coherent.
      expect(REQUIRED_JWT_CLAIMS).not.toContain("nbf" as RequiredJwtClaim);
    });
  });
});

describe("parseAuthHeader", () => {
  it("recognizes Bearer", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { authorization: "Bearer abc.def.ghi" } }));
    expect(result).toEqual({ kind: "credential", scheme: "bearer_jwt", token: "abc.def.ghi" });
  });

  it("recognizes Basic", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { authorization: "Basic Zm9vOmJhcg==" } }));
    expect(result).toEqual({ kind: "credential", scheme: "basic", token: "Zm9vOmJhcg==" });
  });

  it("recognizes x-api-key", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { "x-api-key": "ce_live_abcdef" } }));
    expect(result).toEqual({ kind: "credential", scheme: "api_key_header", token: "ce_live_abcdef" });
  });

  it("answers absent when no credential is present anywhere", () => {
    expect(parseAuthHeader(fixtureRequest())).toEqual({ kind: "absent" });
  });

  it("recognizes an api_key query parameter", () => {
    const result = parseAuthHeader(
      fixtureRequest({ query: { [API_KEY_QUERY_PARAM]: "ce_live_abcdef" } }),
    );
    expect(result).toEqual({
      kind: "credential",
      scheme: "api_key_query",
      token: "ce_live_abcdef",
    });
  });

  it("ignores an empty api_key parameter, which is a form field nobody filled in", () => {
    expect(parseAuthHeader(fixtureRequest({ query: { [API_KEY_QUERY_PARAM]: "" } }))).toEqual({
      kind: "absent",
    });
  });

  // A repeated parameter arrives as an array and names no single credential. The original reading
  // treated it as `absent` "rather than as the first element, because picking one would decide
  // which of two credentials the caller meant" — sound about not picking one, and it conflated
  // *don't choose a credential* with *don't name the scheme*. This scheme is `refused`, so no
  // credential is ever chosen from it; recognising it only names the refusal. The old comment
  // conceded the gap in its own last clause — "the residual still catches it when an Authorization
  // header is present" — and with no such header nothing caught it, so `?api_key=a&api_key=b`
  // answered anonymous 201.
  //
  // So: recognised, with **no token**, which is "do not pick one" made structural rather than
  // promised. An empty value is still `absent`, by ADR-0365's rule for every query parameter here.
  it("recognizes a repeated api_key parameter, carrying none of the values", () => {
    expect(
      parseAuthHeader(fixtureRequest({ query: { [API_KEY_QUERY_PARAM]: ["a", "b"] } })),
    ).toEqual({ kind: "credential", scheme: "api_key_query", token: "" });
  });

  // The complement, and the reason the array arm tests `some((v) => v.length > 0)`: two empty
  // repeats are two unfilled form fields, not two credentials.
  it("ignores a repeated api_key parameter whose values are all empty", () => {
    expect(parseAuthHeader(fixtureRequest({ query: { [API_KEY_QUERY_PARAM]: ["", ""] } }))).toEqual({
      kind: "absent",
    });
  });

  it("recognizes a forwarded client certificate as mtls", () => {
    const result = parseAuthHeader(fixtureRequest({ clientCertSha256: "b".repeat(64) }));
    expect(result).toEqual({ kind: "credential", scheme: "mtls", token: "b".repeat(64) });
  });

  /**
   * The ordering invariant that is load-bearing rather than cosmetic: an edge performing mutual TLS
   * sets `clientCertSha256` on **every** request it forwards, so an `mtls` check ahead of the
   * message's own credentials would refuse a perfectly good JWT on every such deployment.
   */
  it("a client certificate does not mask a Bearer token", () => {
    const result = parseAuthHeader(
      fixtureRequest({
        headers: { authorization: "Bearer abc.def.ghi" },
        clientCertSha256: "b".repeat(64),
      }),
    );
    expect(result).toEqual({ kind: "credential", scheme: "bearer_jwt", token: "abc.def.ghi" });
  });

  it("a client certificate does not mask an api key", () => {
    const result = parseAuthHeader(
      fixtureRequest({
        headers: { "x-api-key": "ce_live_abcdef" },
        clientCertSha256: "b".repeat(64),
      }),
    );
    expect(result).toEqual({
      kind: "credential",
      scheme: "api_key_header",
      token: "ce_live_abcdef",
    });
  });

  it("answers unrecognized with the auth-scheme token, never the credential", () => {
    const result = parseAuthHeader(
      fixtureRequest({ headers: { authorization: "CE-HMAC-SHA256 keyId=k1,ts=1,sig=SECRET" } }),
    );
    expect(result).toEqual({ kind: "unrecognized", schemeToken: "CE-HMAC-SHA256" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  /**
   * A header with no `SP` carries no auth-scheme (RFC 9110 §11.6.2), so its whole value may be the
   * credential and nothing is reported — the one case where reporting a prefix would be reporting a
   * prefix of a secret.
   */
  it("answers a null schemeToken for a bare token with no auth-scheme", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { authorization: "abcdef" } }));
    expect(result).toEqual({ kind: "unrecognized", schemeToken: null });
  });

  /**
   * The residual is last, which this pins: the pre-ADR-0384 parser already placed `x-api-key` ahead
   * of it, and the generalisation is that a verdict meaning *nothing recognised this* must not
   * outrank something that did.
   */
  it("an unrecognized Authorization header does not mask an x-api-key", () => {
    const result = parseAuthHeader(
      fixtureRequest({
        headers: { authorization: "Negotiate YIIZ", "x-api-key": "ce_live_abcdef" },
      }),
    );
    expect(result).toEqual({
      kind: "credential",
      scheme: "api_key_header",
      token: "ce_live_abcdef",
    });
  });

  it("an unrecognized Authorization header does not mask an api_key parameter", () => {
    const result = parseAuthHeader(
      fixtureRequest({
        headers: { authorization: "Negotiate YIIZ" },
        query: { [API_KEY_QUERY_PARAM]: "ce_live_abcdef" },
      }),
    );
    expect(result).toEqual({
      kind: "credential",
      scheme: "api_key_query",
      token: "ce_live_abcdef",
    });
  });

  it("the auth-scheme match is case-insensitive, as RFC 9110 requires", () => {
    expect(parseAuthHeader(fixtureRequest({ headers: { authorization: "bEaReR x.y.z" } }))).toEqual(
      { kind: "credential", scheme: "bearer_jwt", token: "x.y.z" },
    );
    expect(parseAuthHeader(fixtureRequest({ headers: { authorization: "BASIC abc" } }))).toEqual({
      kind: "credential",
      scheme: "basic",
      token: "abc",
    });
  });

  /**
   * Every scheme this parser can emit must be one `AUTH_SCHEME_SUPPORT` calls recognisable, in both
   * directions — the join that makes the map the single declaration rather than a list beside the
   * parser. A scheme recognised here and absent from `RECOGNISABLE_AUTH_SCHEMES` would be served or
   * refused by a rule the boot line does not report; one in that list with no arm here is a refusal
   * no request can receive.
   */
  it("the parser's schemes are exactly RECOGNISABLE_AUTH_SCHEMES", () => {
    const emitted = new Set<string>();
    const samples: IncomingRequest[] = [
      fixtureRequest({ headers: { authorization: "Bearer a.b.c" } }),
      fixtureRequest({ headers: { authorization: "Basic abc" } }),
      fixtureRequest({ headers: { "x-api-key": "k" } }),
      fixtureRequest({ query: { [API_KEY_QUERY_PARAM]: "k" } }),
      fixtureRequest({ clientCertSha256: "c".repeat(64) }),
    ];
    for (const request of samples) {
      const parsed = parseAuthHeader(request);
      if (parsed.kind === "credential") emitted.add(parsed.scheme);
    }
    expect([...emitted].sort()).toEqual([...RECOGNISABLE_AUTH_SCHEMES].sort());
  });
});

describe("buildOpaqueCredentialMatcher", () => {
  it("matches the same token + rejects others (constant-time compare)", () => {
    const expected = "expected-token-value";
    const matcher = buildOpaqueCredentialMatcher(sha256(expected));
    expect(matcher(expected)).toBe(true);
    expect(matcher("expected-token-valuf")).toBe(false);
    expect(matcher("not the same")).toBe(false);
  });
});

describe("resolvePrincipalForCredential", () => {
  it("returns principal_not_found when resolver returns null", async () => {
    const resolver = new InMemoryPrincipalResolver();
    const result = await resolvePrincipalForCredential({
      request: fixtureRequest(),
      scheme: "bearer_jwt",
      principalRef: "unknown",
      scopes: [],
      resolver,
      nowIso: "2026-05-16T12:00:00.000Z",
    });
    expect(result.outcome).toBe("principal_not_found");
    expect(result.principal).toBeNull();
  });

  it("returns authenticated + populated principal when resolver finds them", async () => {
    const resolver = new InMemoryPrincipalResolver().register("u1", {
      principalId: USER,
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: ["tenants:write"],
      mfaProofAgeSeconds: 30,
      resolvedAt: "2026-05-16T11:59:00.000Z",
    });
    const result = await resolvePrincipalForCredential({
      request: fixtureRequest({ tenantHint: TENANT }),
      scheme: "bearer_jwt",
      principalRef: "u1",
      scopes: ["tenants:write"],
      resolver,
      nowIso: "2026-05-16T12:00:00.000Z",
    });
    expect(result.outcome).toBe("authenticated");
    expect(result.principal?.principalId).toBe(USER);
    expect(result.principal?.resolvedAt).toBe("2026-05-16T12:00:00.000Z");
  });

  it("denies tenant_mismatch when the credential tenant differs from the x-tenant-id header", async () => {
    const resolver = new InMemoryPrincipalResolver();
    const result = await resolvePrincipalForCredential({
      request: fixtureRequest({ tenantHint: "11111111-1111-4111-8111-111111111111" }),
      scheme: "bearer_jwt",
      principalRef: "u1",
      scopes: [],
      resolver,
      nowIso: "2026-05-16T12:00:00.000Z",
      authenticatedTenantId: TENANT, // credential asserts a different tenant
    });
    expect(result.outcome).toBe("tenant_mismatch");
    expect(result.principal).toBeNull();
  });

  it("passes the authenticated tenant (not the header) to the resolver", async () => {
    let seenTenant: string | null = "unset";
    const resolver = {
      async resolve(input: { tenantId: string | null }) {
        seenTenant = input.tenantId;
        return null;
      },
    };
    await resolvePrincipalForCredential({
      request: fixtureRequest({ tenantHint: TENANT }),
      scheme: "bearer_jwt",
      principalRef: "u1",
      scopes: [],
      resolver: resolver as never,
      nowIso: "2026-05-16T12:00:00.000Z",
      authenticatedTenantId: TENANT, // matches header → resolver sees the credential tenant
    });
    expect(seenTenant).toBe(TENANT);
  });
});

describe("authSchemeToken", () => {
  it("reads the token of a well-formed credentials production", () => {
    expect(authSchemeToken("Negotiate YIIZgYIZ")).toBe("Negotiate");
    expect(authSchemeToken("CE-HMAC-SHA256 keyId=k1")).toBe("CE-HMAC-SHA256");
  });

  it("answers null when there is no SP, so no auth-scheme exists to read", () => {
    expect(authSchemeToken("abcdef")).toBeNull();
    expect(authSchemeToken("")).toBeNull();
  });

  // A leading space means the first token is empty, which is not a `token` (`1*tchar`).
  it("answers null for a leading space", () => {
    expect(authSchemeToken(" Bearer abc")).toBeNull();
  });

  /**
   * The charset refusal is what keeps a crafted header out of a log line: a newline or a control
   * byte in the first word means it is not an RFC 9110 `token`, so it is not an auth-scheme and is
   * not reported.
   */
  it("refuses a first word outside tchar", () => {
    expect(authSchemeToken("Bea\nrer abc")).toBeNull();
    expect(authSchemeToken('Bear"er abc')).toBeNull();
    expect(authSchemeToken("Bear(er abc")).toBeNull();
    expect(authSchemeToken("Bear,er abc")).toBeNull();
  });

  it("accepts the full tchar set, which includes punctuation a reader may not expect", () => {
    expect(authSchemeToken("!#$%&'*+-.^_`|~0aZ x")).toBe("!#$%&'*+-.^_`|~0aZ");
  });

  // Refused rather than truncated: a truncated prefix of a secret is still a prefix of a secret,
  // and the grammar bounds a `token` nowhere while a log line is bounded everywhere.
  it("refuses an over-long first word rather than truncating it", () => {
    expect(authSchemeToken(`${"A".repeat(41)} abc`)).toBeNull();
    expect(authSchemeToken(`${"A".repeat(40)} abc`)).toBe("A".repeat(40));
  });
});
