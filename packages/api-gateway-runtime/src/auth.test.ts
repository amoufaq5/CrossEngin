import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  sha256,
  signEd25519,
} from "@crossengin/crypto";
import { readFileSync } from "node:fs";

import {
  AUTH_OUTCOMES,
  AUTH_OUTCOME_SUCCEEDS,
  AUTH_SCHEMES,
  AUTH_SCHEME_SECURITY_DOC,
  AUTH_SCHEME_SUPPORT,
  REQUEST_SIGNATURE_HEADER_LOWER,
  PRINCIPAL_REFUSAL_OUTCOMES,
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
   * The **argument** passed to `authSchemeToken`, which nothing checked. That function is
   * thoroughly tested as a pure transform — including `" Bearer abc"` → `null` — and its call site
   * here was `header.trim()`, which destroys the one character the transform reads: *no space means
   * no auth-scheme*. So `Authorization: Basic ` reported `schemeToken: null`, a record claiming no
   * scheme was named at all for a value that plainly named one.
   *
   * The caller these shapes come from is a **direct `buildIncomingRequest` caller**, not an HTTP
   * client: measured on a raw socket, Node's parser strips trailing OWS per RFC 9110 §5.5, and
   * `Headers` does the same on the Fetch path, so neither transport can carry one. `headers` on
   * that builder is a plain record and keeps it. That makes this fail-closed hardening at an
   * embedding seam rather than a live request-path fix, and the distinction is in the subject's own
   * comment because a first draft of it asserted the latter from a measurement of the former.
   *
   * The table is the comment's own claim made checkable: **`trimStart` is the only one of the three
   * that answers every shape**, and the two groups below are what refute the alternatives. `trim`
   * loses the trailing-space pair; leaving the value untrimmed loses the leading-space pair,
   * because a leading space puts the first space at index 0 and `authSchemeToken` refuses that. The
   * last group is the protection the rule exists for and is untouched by all three — a bare token
   * reports nothing, with or without surrounding space, because a truncated prefix of a secret is
   * still a prefix of a secret.
   */
  describe("the residual arm reads the scheme off a trimStart'd value", () => {
    const tokenFor = (authorization: string): string | null => {
      const result = parseAuthHeader(fixtureRequest({ headers: { authorization } }));
      expect(result.kind, `${JSON.stringify(authorization)} should reach the residual`).toBe(
        "unrecognized",
      );
      return result.kind === "unrecognized" ? result.schemeToken : null;
    };

    // Refutes `trim`: the caller's own trailing space is what used to hide the scheme.
    //
    // `"Basic "` has **left this table** since ADR-0398 and is asserted below instead: the presence
    // arm now claims it as the `basic` scheme, so it reaches `scheme_unsupported_basic` rather than
    // the residual. That is a deliberate improvement on ADR-0395's answer for the same shape and it
    // subsumes it -- but `"Bearer "` stays here, because `bearer_jwt` is **served** and presence
    // recognition would hand its verifier an empty credential. One table, two treatments, and the
    // difference between the rows is the whole rule.
    it.each([["Bearer ", "Bearer"]])(
      "reports the scheme for %j, which trim() loses, for a SERVED scheme",
      (header, expected) => {
        expect(tokenFor(header)).toBe(expected);
      },
    );

    // Refutes leaving it untrimmed: `indexOf(" ")` would answer 0 and the transform refuses that.
    // Deliberately not `"  Basic x"`, which the transform answers `"Basic"` for and which **never
    // reaches this arm** — `trim()` on it starts with `"basic "`, so it is recognised as a basic
    // credential two screens above. A leading-space shape only reaches the residual when its scheme
    // is one this gateway does not recognise, which is what these two are.
    it.each([
      ["  Negotiate x", "Negotiate"],
      ["\tNegotiate YIIZ", "Negotiate"],
    ])("reports the scheme for %j, which an untrimmed value loses", (header, expected) => {
      expect(tokenFor(header)).toBe(expected);
    });

    it.each([
      ["Negotiate YIIZ", "Negotiate"],
      ["Digest realm=x", "Digest"],
    ])("reports the scheme for %j, which every spelling gets", (header, expected) => {
      expect(tokenFor(header)).toBe(expected);
    });

    it.each([["ce_live_abc"], [" ce_live_abc"]])(
      "still reports nothing for the bare token %j",
      (header) => {
        expect(tokenFor(header)).toBeNull();
      },
    );
  });

  describe("an empty header value is nothing presented (ADR-0398)", () => {
    // ADR-0365's rule, which this function already states in its own words beside the
    // `api_key_query` arm and applied to two of its four message positions. Measured before the
    // fix: `Authorization: ""` answered `{kind:"unrecognized"}` -- recording
    // `credential_unrecognized`, a claim that a credential arrived in a scheme this build does not
    // know -- and `x-api-key: ""` answered a **served** credential with an empty token, so the
    // deployment's opaque matcher was invoked with `sha256("")`.
    it.each([
      ["authorization", ""],
      ["authorization", "   "],
      ["authorization", "\t"],
      ["x-api-key", ""],
      ["x-api-key", "  "],
      [REQUEST_SIGNATURE_HEADER_LOWER, ""],
    ])("treats %s: %j as absent", (name, value) => {
      expect(parseAuthHeader(fixtureRequest({ headers: { [name]: value } })).kind).toBe("absent");
    });

    it("no longer masks a later recognising position", () => {
      // The sharper half, and the inverse of ADR-0384's ordering rule: something that recognised
      // **nothing** outranked something that did, because both arms returned before `mtls`. So on a
      // cert-forwarding edge a client sending either empty header was refused rather than
      // authenticated by its certificate.
      const cert = "a".repeat(64);
      for (const name of ["authorization", "x-api-key"]) {
        const r = parseAuthHeader(
          fixtureRequest({ headers: { [name]: "" }, clientCertSha256: cert }),
        );
        expect(r.kind, name).toBe("credential");
        if (r.kind === "credential") {
          expect(r.scheme, name).toBe("mtls");
          expect(r.token, name).toBe(cert);
        }
      }
    });

    it("leaves every non-empty value exactly as it was", () => {
      // The non-vacuity floor: the rule must reach only the empty case.
      const cases: readonly [Record<string, string>, string][] = [
        [{ authorization: "Bearer abc.def.ghi" }, "bearer_jwt"],
        [{ authorization: "Basic Zm9vOmJhcg==" }, "basic"],
        [{ authorization: "Basic" }, "basic"],
        [{ "x-api-key": "ce_live_abc" }, "api_key_header"],
      ];
      for (const [headers, scheme] of cases) {
        const r = parseAuthHeader(fixtureRequest({ headers }));
        expect(r.kind, JSON.stringify(headers)).toBe("credential");
        if (r.kind === "credential") expect(r.scheme).toBe(scheme);
      }
      // And an unrecognised scheme still reaches the residual with its token reported.
      const residual = parseAuthHeader(fixtureRequest({ headers: { authorization: "Negotiate x" } }));
      expect(residual.kind).toBe("unrecognized");
      if (residual.kind === "unrecognized") expect(residual.schemeToken).toBe("Negotiate");
    });

    it("the predicate is one rule, read by every header position", () => {
      // Read as text, because a forwarded presence test is identical to a missing one from the type
      // system's point of view -- ADR-0386's class. Two positions tested `!== undefined` and two
      // spelled the rule inline; converging them is what stops them drifting apart again.
      const src = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
      const body = src.slice(src.indexOf("export function parseAuthHeader"));
      expect(body).not.toMatch(/\.trim\(\)\.length > 0/); // no second spelling survives
      expect((body.match(/headerPresents\(/g) ?? []).length).toBe(4);
    });
  });

  describe("a bare auth-scheme token for a refused scheme (ADR-0398)", () => {
    const schemeOf = (authorization: string): string | null => {
      const r = parseAuthHeader(fixtureRequest({ headers: { authorization } }));
      return r.kind === "credential" ? r.scheme : null;
    };

    // The reachable spelling, and the one ADR-0395's `trimStart` could not touch: a bare `Basic`
    // carries no whitespace for a parser to strip, so it arrives verbatim over both transports --
    // where `"Basic "` is normalised to it by Node's parser and by `Headers` (RFC 9110 §5.5).
    it.each([["Basic"], ["basic"], ["BASIC"], ["Basic "], ["  Basic"]])(
      "claims %j as the basic scheme, so it is refused by name",
      (header) => {
        expect(schemeOf(header)).toBe("basic");
      },
    );

    it("carries an empty token, which the refusal provably never reads", () => {
      const r = parseAuthHeader(fixtureRequest({ headers: { authorization: "Basic" } }));
      expect(r.kind).toBe("credential");
      if (r.kind === "credential") expect(r.token).toBe("");
    });

    // The asymmetry, asserted rather than described. A bare SERVED scheme must stay in the
    // residual: its verifier consumes the token, so claiming it would record a claim about a
    // credential nobody presented.
    it.each([["Bearer"], ["bearer"], ["Negotiate"], ["Digest"]])(
      "leaves %j to the residual",
      (header) => {
        expect(parseAuthHeader(fixtureRequest({ headers: { authorization: header } })).kind).toBe(
          "unrecognized",
        );
      },
    );

    it("does not disturb a credential-bearing value in either scheme", () => {
      expect(schemeOf("Basic Zm9vOmJhcg==")).toBe("basic");
      expect(schemeOf("Bearer abc.def.ghi")).toBe("bearer_jwt");
    });

    it("every declared auth-scheme token matches the prefix its own arm tests", () => {
      // The both-ways fence (`pg-record-retention.ts`' rule). `parseAuthHeader` keeps hardcoded
      // `"bearer "` / `"basic "` prefixes because their ORDER relative to `x-api-key`, the query
      // parameter, the residual and `mtls` is load-bearing and generating the arms would make that
      // order a property of the map's declaration order. So the map and the arms are compared as
      // text instead, in both directions: a token with no arm, and an arm with no token.
      const src = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
      const declared = AUTH_SCHEMES.flatMap((s) => {
        const t = AUTH_SCHEME_SUPPORT[s].authSchemeToken;
        return t === null ? [] : [[s, t.toLowerCase()] as const];
      });
      expect(declared.length).toBeGreaterThan(1); // non-vacuity floor
      for (const [scheme, token] of declared) {
        expect(src, `${scheme}: no arm matches the declared token`).toContain(
          `lower.startsWith("${token} ")`,
        );
      }
      // And no arm matches a prefix no scheme declares.
      const armed = [...src.matchAll(/lower\.startsWith\("([a-z-]+) "\)/g)].map((m) => m[1]!);
      expect(armed.sort()).toEqual(declared.map(([, t]) => t).sort());
    });
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
      fixtureRequest({
        headers: { "crossengin-request-signature": `k=k1,t=1700000000,v1=${"a".repeat(64)}` },
      }),
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

  it("passes a resolver's refusal through as its own outcome, not as principal_not_found", async () => {
    // ADR-0398. Before this there was no third answer, so ADR-0381's revocation gate returned
    // `null` and the record said *this principal does not exist* for one that does. Both members
    // are exercised, because the point of the set is that the gateway no longer models an outcome a
    // resolver has no way to produce.
    for (const refusedAs of PRINCIPAL_REFUSAL_OUTCOMES) {
      const result = await resolvePrincipalForCredential({
        request: fixtureRequest(),
        scheme: "bearer_jwt",
        principalRef: "u1",
        scopes: [],
        resolver: { resolve: () => Promise.resolve({ refusedAs }) },
        nowIso: "2026-05-16T12:00:00.000Z",
      });
      expect(result.outcome).toBe(refusedAs);
      expect(result.principal).toBeNull();
      // Not a success, which is what keeps the refusal fail-closed however it is routed.
      expect(AUTH_OUTCOME_SUCCEEDS[refusedAs]).toBe(false);
    }
  });

  it("every principal-refusal outcome is a real AuthOutcome the catalog already admits", () => {
    // The set is a subset of `AUTH_OUTCOMES` rather than a parallel vocabulary, so it needs no
    // `auth_outcome` CHECK migration -- both members were already catalogued with no producer,
    // which is the gap this closes. Asserted so a third member cannot be invented here and then
    // fail a write on every deployment (ADR-0384 had to widen that CHECK for exactly this reason).
    for (const o of PRINCIPAL_REFUSAL_OUTCOMES) {
      expect(AUTH_OUTCOMES).toContain(o);
    }
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

// ---------------------------------------------------------------------------------------------
// The published description of `bearer_jwt` against the claims this build can require.
//
// `AUTH_SCHEME_SECURITY_DOC.bearer_jwt.description` is **client-facing prose**: it is emitted into
// `components.securitySchemes` of this deployment's OpenAPI document, so a false statement in it is
// a false statement about this API's authentication. It said "exp, nbf, iss and aud — each required
// unless the deployment relaxes it by name", and `nbf` is in neither set: `REQUIRED_JWT_CLAIM_COSTS`
// is keyed on `exp | iss | aud`, and `--jwt-optional-claim nbf` is refused BY NAME because an
// absent `nbf` means *valid from issuance*. Nothing caught it, which is why this fence exists — the
// contradiction was between a published description and a refusal message in the same repository.
//
// The fence lives here rather than in `api-gateway` because this is the package where both facts
// are visible: `REQUIRED_JWT_CLAIMS` is declared here and `api-gateway` does not depend on it.
// ---------------------------------------------------------------------------------------------

describe("the published bearer_jwt description names the claims this build requires", () => {
  const description = AUTH_SCHEME_SECURITY_DOC.bearer_jwt?.description ?? "";

  it("names every requirable claim", () => {
    expect(description).not.toBe("");
    for (const claim of REQUIRED_JWT_CLAIMS) {
      expect(description, claim).toContain(claim);
    }
  });

  it("does not describe a claim this build cannot require as required or relaxable", () => {
    // The sentence promising "each required unless the deployment relaxes it by name" may only
    // enumerate `REQUIRED_JWT_CLAIMS`. `nbf` is checked when present and is never required, so
    // naming it in that clause tells a client a token without it is refused; it is accepted.
    const clause = /then ([^—]+)—\s*each required unless the deployment relaxes it by name/.exec(
      description,
    );
    expect(clause, "the required-claims clause must be present and parseable").not.toBeNull();
    const named = (clause?.[1] ?? "")
      .split(/,| and /)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    expect([...named].sort()).toEqual([...REQUIRED_JWT_CLAIMS].sort());
    expect(named).not.toContain("nbf");
  });

  it("still says nbf is honoured, because it is — the claim is checked when present", () => {
    // Not merely absent from the required list: `verifyBearerJwt` refuses a token whose `nbf` is in
    // the future, so a description silent about it would understate what this gateway enforces.
    expect(description).toContain("nbf");
    expect(description).toMatch(/nbf.*honoured when present/);
  });
});
