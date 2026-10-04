import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ASSERTION_LIFETIME_SECONDS,
  buildJwtAssertionClaims,
  classifyTokenEndpointFailure,
  FCM_MESSAGING_SCOPE,
  FCM_TOKEN_ERROR_KINDS,
  FcmTokenError,
  GOOGLE_TOKEN_URI,
  JWT_BEARER_GRANT_TYPE,
  jwtSigningInput,
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  normalizePrivateKeyPem,
  parseAccessTokenResponse,
  parseServiceAccountJson,
  parseTokenEndpointError,
  privateKeyDefect,
  RETRYABLE_FCM_TOKEN_ERROR_KINDS,
  serviceAccountDefects,
  serviceAccountFcmTokenProvider,
  ServiceAccountFcmTokenProvider,
  signJwtAssertion,
  TOKEN_EXPIRY_SKEW_SECONDS,
  tokenRequestForm,
  tokenUriDefect,
  type FcmTokenClock,
  type ServiceAccountCredentials,
} from "./fcm-token.js";
import type { FcmAccessTokenProvider } from "./push-fcm.js";
import { FakeFetch, throwingFetch } from "./test-fakes.js";

/*
 * One real 2048-bit RSA keypair, generated once for the file. The point of generating it rather
 * than pasting a fixture is the signature assertions below: a test that only checks a JWT has three
 * dot-separated base64url segments does not check that it was *signed*, which is the one thing this
 * module exists to do.
 */
const KEYPAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CLIENT_EMAIL = "fcm-sender@crossengin-prod.iam.gserviceaccount.com";

function credentials(
  overrides: Partial<ServiceAccountCredentials> = {},
): ServiceAccountCredentials {
  return {
    clientEmail: CLIENT_EMAIL,
    privateKeyPem: KEYPAIR.privateKey,
    ...overrides,
  };
}

/** Advanceable, so every expiry assertion is about an instant the test chose. */
class TestClock implements FcmTokenClock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

const T0 = Date.parse("2026-10-04T09:00:00.000Z");

function tokenResponse(accessToken = "ya29.first", expiresIn = 3599): string {
  return JSON.stringify({
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: "Bearer",
  });
}

function formFields(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? "");
}

/**
 * Every 24-character window of the key's base64 body. Used to assert that a refusal never carries
 * key material: a message that contains any one of these has leaked part of a private key into
 * whatever log, crash report or audit row the message reaches.
 */
const KEY_WINDOWS: readonly string[] = (() => {
  const body = KEYPAIR.privateKey
    .split("\n")
    .filter((line) => !line.startsWith("-----") && line.length > 0)
    .join("");
  const windows: string[] = [];
  for (let i = 0; i + 24 <= body.length; i += 1) windows.push(body.slice(i, i + 24));
  return windows;
})();

function expectNoKeyMaterial(message: string): void {
  const leaked = KEY_WINDOWS.find((window) => message.includes(window));
  expect(leaked).toBeUndefined();
}

// ---------------------------------------------------------------------------

describe("credential refusals", () => {
  it("accepts a well-formed service account", () => {
    expect(serviceAccountDefects(credentials())).toEqual([]);
  });

  it("names a missing client email", () => {
    expect(serviceAccountDefects(credentials({ clientEmail: "" }))).toEqual([
      "clientEmail is missing",
    ]);
  });

  it("names a client email that is not an email address", () => {
    expect(
      serviceAccountDefects(credentials({ clientEmail: "crossengin-prod" })),
    ).toEqual(["clientEmail is not an email address"]);
  });

  it("refuses an email with no dotted domain", () => {
    expect(
      serviceAccountDefects(credentials({ clientEmail: "sa@localhost" })),
    ).toEqual(["clientEmail is not an email address"]);
  });

  it("names a missing private key", () => {
    expect(serviceAccountDefects(credentials({ privateKeyPem: "" }))).toEqual([
      "privateKeyPem is missing",
    ]);
  });

  it("recognises the public half pasted into the private key field", () => {
    expect(
      serviceAccountDefects(credentials({ privateKeyPem: KEYPAIR.publicKey })),
    ).toEqual(["privateKeyPem is a public key, not a private key"]);
  });

  it("recognises a certificate pasted into the private key field", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(serviceAccountDefects(credentials({ privateKeyPem: pem }))).toEqual([
      "privateKeyPem is a certificate, not a private key",
    ]);
  });

  it("recognises something that is not a PEM at all", () => {
    expect(
      serviceAccountDefects(credentials({ privateKeyPem: "hunter2" })),
    ).toEqual(["privateKeyPem is not a PEM-encoded private key"]);
  });

  it("reports every defect at once rather than the first", () => {
    expect(
      serviceAccountDefects({ clientEmail: "", privateKeyPem: "" }),
    ).toEqual(["clientEmail is missing", "privateKeyPem is missing"]);
  });

  it("refuses an http token uri", () => {
    expect(tokenUriDefect("http://oauth2.googleapis.com/token")).toBe(
      "tokenUri must be https",
    );
  });

  it("refuses a token uri that is not a url", () => {
    expect(tokenUriDefect("oauth2.googleapis.com/token")).toBe(
      "tokenUri is not a URL",
    );
  });

  it("accepts an https token uri override", () => {
    expect(tokenUriDefect("https://token.internal.example/oauth2")).toBeNull();
  });
});

describe("private key type", () => {
  it("accepts an RSA key", () => {
    expect(privateKeyDefect(KEYPAIR.privateKey)).toBeNull();
  });

  /*
   * The defect this check exists for: an EC key is also wrapped in `BEGIN PRIVATE KEY`, so every
   * textual check passes and `createSign("RSA-SHA256")` happily produces an ECDSA signature that
   * Google refuses as `invalid_grant` — a wrong-key-type reported as a wrong service account.
   */
  it("refuses an EC key that passes every textual check", () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(privateKeyDefect(ec.privateKey)).toBe(
      "privateKeyPem is a ec key; Google's JWT-bearer flow requires RS256 over an RSA key",
    );
  });

  it("refuses a PEM whose body is corrupt", () => {
    const corrupt = "-----BEGIN PRIVATE KEY-----\nAAAAAAAA\n-----END PRIVATE KEY-----";
    expect(privateKeyDefect(corrupt)).toBe(
      "privateKeyPem could not be decoded as a private key",
    );
  });
});

describe("error messages never carry key material", () => {
  it("keeps the key out of a corrupt-PEM refusal", () => {
    const corrupt = `-----BEGIN PRIVATE KEY-----\n${KEY_WINDOWS[0] ?? ""}\n-----END PRIVATE KEY-----`;
    const defects = serviceAccountDefects(credentials({ privateKeyPem: corrupt }));
    expectNoKeyMaterial(defects.join("; "));
  });

  it("keeps the key out of a construction refusal", () => {
    let message = "";
    try {
      new ServiceAccountFcmTokenProvider({
        credentials: credentials({ clientEmail: "" }),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("clientEmail is missing");
    expectNoKeyMaterial(message);
  });

  it("keeps the key out of a signing failure", () => {
    const corrupt = "-----BEGIN PRIVATE KEY-----\nAAAAAAAA\n-----END PRIVATE KEY-----";
    const claims = buildJwtAssertionClaims({
      credentials: credentials(),
      tokenUri: GOOGLE_TOKEN_URI,
      nowMs: T0,
    });
    try {
      signJwtAssertion(claims, corrupt);
      expect.unreachable("signing a corrupt PEM must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FcmTokenError);
      expect((err as FcmTokenError).kind).toBe("signing_failed");
      expect((err as FcmTokenError).isRetryable()).toBe(false);
      expectNoKeyMaterial((err as FcmTokenError).message);
    }
  });

  it("keeps the key out of a parse refusal for the whole key file", () => {
    try {
      parseServiceAccountJson(
        JSON.stringify({ type: "service_account", private_key: KEYPAIR.privateKey }),
      );
      expect.unreachable("a key file with no client_email must be refused");
    } catch (err) {
      expectNoKeyMaterial((err as Error).message);
    }
  });
});

describe("parseServiceAccountJson", () => {
  it("reads Google's key file verbatim", () => {
    const parsed = parseServiceAccountJson(
      JSON.stringify({
        type: "service_account",
        project_id: "crossengin-prod",
        private_key_id: "abc",
        private_key: KEYPAIR.privateKey,
        client_email: CLIENT_EMAIL,
        token_uri: GOOGLE_TOKEN_URI,
      }),
    );
    expect(parsed.clientEmail).toBe(CLIENT_EMAIL);
    expect(parsed.tokenUri).toBe(GOOGLE_TOKEN_URI);
    expect(privateKeyDefect(parsed.privateKeyPem)).toBeNull();
  });

  /*
   * The literal-`\n` case: the file's own JSON escapes resolve, but the same string lifted into an
   * env var or a Kubernetes secret arrives with backslash-n as two characters.
   */
  it("normalises a private key whose newlines arrived as two characters", () => {
    const escaped = KEYPAIR.privateKey.replace(/\n/g, "\\n");
    const parsed = parseServiceAccountJson(
      JSON.stringify({ private_key: escaped, client_email: CLIENT_EMAIL }),
    );
    expect(privateKeyDefect(parsed.privateKeyPem)).toBeNull();
  });

  it("normalizePrivateKeyPem is idempotent on a real PEM", () => {
    expect(normalizePrivateKeyPem(KEYPAIR.privateKey)).toBe(
      KEYPAIR.privateKey.trim(),
    );
  });

  it("omits tokenUri when the file does not carry one", () => {
    const parsed = parseServiceAccountJson(
      JSON.stringify({ private_key: KEYPAIR.privateKey, client_email: CLIENT_EMAIL }),
    );
    expect(parsed.tokenUri).toBeUndefined();
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseServiceAccountJson("not json")).toThrow(
      /not valid JSON/,
    );
  });

  it("refuses JSON that is not an object", () => {
    expect(() => parseServiceAccountJson("[1,2]")).toThrow(/not a JSON object/);
  });

  it("refuses a key file declaring another credential type", () => {
    expect(() =>
      parseServiceAccountJson(JSON.stringify({ type: "authorized_user" })),
    ).toThrow(/'authorized_user' is not a service account/);
  });

  it("refuses with kind invalid_credentials, which is not retryable", () => {
    try {
      parseServiceAccountJson("{}");
      expect.unreachable("an empty key file must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(FcmTokenError);
      expect((err as FcmTokenError).kind).toBe("invalid_credentials");
      expect((err as FcmTokenError).isRetryable()).toBe(false);
    }
  });
});

describe("the assertion", () => {
  it("builds exactly the claim set Google checks", () => {
    const claims = buildJwtAssertionClaims({
      credentials: credentials(),
      tokenUri: GOOGLE_TOKEN_URI,
      nowMs: T0 + 400,
    });
    expect(claims).toEqual({
      iss: CLIENT_EMAIL,
      sub: CLIENT_EMAIL,
      aud: GOOGLE_TOKEN_URI,
      scope: FCM_MESSAGING_SCOPE,
      iat: Math.floor((T0 + 400) / 1000),
      exp: Math.floor((T0 + 400) / 1000) + ASSERTION_LIFETIME_SECONDS,
    });
  });

  it("scopes the assertion to firebase.messaging and nothing wider", () => {
    expect(FCM_MESSAGING_SCOPE).toBe(
      "https://www.googleapis.com/auth/firebase.messaging",
    );
  });

  it("keeps the assertion short-lived", () => {
    expect(ASSERTION_LIFETIME_SECONDS).toBeLessThanOrEqual(3600);
    expect(ASSERTION_LIFETIME_SECONDS).toBe(600);
  });

  it("base64url-encodes with no padding", () => {
    const input = jwtSigningInput(
      buildJwtAssertionClaims({
        credentials: credentials(),
        tokenUri: GOOGLE_TOKEN_URI,
        nowMs: T0,
      }),
    );
    expect(input).not.toContain("=");
    expect(input).not.toContain("+");
    expect(input).not.toContain("/");
  });

  it("declares RS256 in the header", () => {
    const [header] = jwtSigningInput(
      buildJwtAssertionClaims({
        credentials: credentials(),
        tokenUri: GOOGLE_TOKEN_URI,
        nowMs: T0,
      }),
    ).split(".");
    expect(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")),
    ).toEqual({ alg: "RS256", typ: "JWT" });
  });

  /*
   * The assertion that makes the rest of this file worth anything: the third segment is verified
   * against the public half of the keypair, over the exact first two segments as bytes.
   */
  it("produces a signature that verifies under the matching public key", () => {
    const claims = buildJwtAssertionClaims({
      credentials: credentials(),
      tokenUri: GOOGLE_TOKEN_URI,
      nowMs: T0,
    });
    const jwt = signJwtAssertion(claims, KEYPAIR.privateKey);
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${segments[0] ?? ""}.${segments[1] ?? ""}`, "utf8");
    expect(
      verifier.verify(KEYPAIR.publicKey, segments[2] ?? "", "base64url"),
    ).toBe(true);
  });

  it("does not verify once a claim is tampered with", () => {
    const claims = buildJwtAssertionClaims({
      credentials: credentials(),
      tokenUri: GOOGLE_TOKEN_URI,
      nowMs: T0,
    });
    const [, , signature] = signJwtAssertion(claims, KEYPAIR.privateKey).split(".");
    const forged = jwtSigningInput({ ...claims, scope: "https://example.test/all" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(forged, "utf8");
    expect(
      verifier.verify(KEYPAIR.publicKey, signature ?? "", "base64url"),
    ).toBe(false);
  });

  it("form-encodes the RFC 7523 grant type and the assertion", () => {
    const fields = formFields(tokenRequestForm("header.claims.sig"));
    expect(fields.get("grant_type")).toBe(JWT_BEARER_GRANT_TYPE);
    expect(fields.get("assertion")).toBe("header.claims.sig");
    expect([...fields.keys()]).toEqual(["grant_type", "assertion"]);
  });
});

describe("the token request", () => {
  it("posts form-encoded to Google's token endpoint by default", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    await provider.token();
    expect(fetch.only.url).toBe(GOOGLE_TOKEN_URI);
    expect(fetch.only.method).toBe("POST");
    expect(fetch.only.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(fetch.only.headers["accept"]).toBe("application/json");
  });

  it("sends no authorization header — the assertion is the credential", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    }).token();
    expect(fetch.only.headers["authorization"]).toBeUndefined();
  });

  it("sends an assertion that verifies and names the endpoint as its audience", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    }).token();
    const assertion = formFields(fetch.only.body).get("assertion") ?? "";
    const [header, payload, signature] = assertion.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header ?? ""}.${payload ?? ""}`, "utf8");
    expect(
      verifier.verify(KEYPAIR.publicKey, signature ?? "", "base64url"),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
    ).toEqual({
      iss: CLIENT_EMAIL,
      sub: CLIENT_EMAIL,
      aud: GOOGLE_TOKEN_URI,
      scope: FCM_MESSAGING_SCOPE,
      iat: T0 / 1000,
      exp: T0 / 1000 + ASSERTION_LIFETIME_SECONDS,
    });
  });

  it("uses the key file's token_uri when it carries one", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials({ tokenUri: "https://token.internal.example/oauth2" }),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(provider.tokenEndpoint()).toBe("https://token.internal.example/oauth2");
    await provider.token();
    expect(fetch.only.url).toBe("https://token.internal.example/oauth2");
  });

  it("lets an explicit endpoint override the key file, for a VPC endpoint or proxy", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials({ tokenUri: GOOGLE_TOKEN_URI }),
      endpoint: "https://egress.internal.example/google/token",
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    await provider.token();
    expect(fetch.only.url).toBe("https://egress.internal.example/google/token");
  });

  it("holds the override to the same https rule as the key file's token_uri", () => {
    expect(
      () =>
        new ServiceAccountFcmTokenProvider({
          credentials: credentials(),
          endpoint: "http://egress.internal.example/google/token",
        }),
    ).toThrow(/tokenUri must be https/);
  });

  it("refuses an assertion lifetime beyond Google's ceiling rather than clamping it", () => {
    expect(
      () =>
        new ServiceAccountFcmTokenProvider({
          credentials: credentials(),
          assertionLifetimeSeconds: 7200,
        }),
    ).toThrow(/between 1 and 3600/);
  });

  it("refuses a negative expiry skew", () => {
    expect(
      () =>
        new ServiceAccountFcmTokenProvider({
          credentials: credentials(),
          expirySkewSeconds: -1,
        }),
    ).toThrow(/must not be negative/);
  });
});

describe("the cache", () => {
  it("returns the minted token", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.minted") }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(await provider.token()).toBe("ya29.minted");
  });

  /* One queued response: a second request would throw `no queued response`, which is the assertion. */
  it("serves a second call from the cache without a second request", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.cached") }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(await provider.token()).toBe("ya29.cached");
    expect(await provider.token()).toBe("ya29.cached");
    expect(fetch.requests).toHaveLength(1);
  });

  it("keeps serving the cached token well before the skew window", async () => {
    const clock = new TestClock(T0);
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.cached", 3600) }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock,
    });
    await provider.token();
    clock.advanceSeconds(3600 - TOKEN_EXPIRY_SKEW_SECONDS - 1);
    expect(await provider.token()).toBe("ya29.cached");
    expect(fetch.requests).toHaveLength(1);
  });

  /*
   * The near edge. A token still technically valid for `skew` seconds is refreshed anyway, because
   * the gap between this answer and FCM receiving it is a queued send plus a TLS handshake, and a
   * token that lapses in that gap is a 401 indistinguishable from a revoked service account.
   */
  it("refreshes once inside the skew window, before the token has expired", async () => {
    const clock = new TestClock(T0);
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.first", 3600) },
      { status: 200, body: tokenResponse("ya29.second", 3600) },
    ]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock,
    });
    await provider.token();
    clock.advanceSeconds(3600 - TOKEN_EXPIRY_SKEW_SECONDS);
    expect(await provider.token()).toBe("ya29.second");
    expect(fetch.requests).toHaveLength(2);
  });

  it("reports when the cached token stops being servable, skew included", async () => {
    const clock = new TestClock(T0);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: new FakeFetch([{ status: 200, body: tokenResponse("ya29.first", 3600) }]).fn,
      clock,
    });
    expect(provider.cachedTokenServableUntilMs()).toBeNull();
    await provider.token();
    expect(provider.cachedTokenServableUntilMs()).toBe(
      T0 + (3600 - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    );
  });

  it("invalidate forces the next call to mint", async () => {
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.first") },
      { status: 200, body: tokenResponse("ya29.second") },
    ]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    await provider.token();
    provider.invalidate();
    expect(await provider.token()).toBe("ya29.second");
  });

  it("dates the cache from the response, not from when the assertion was signed", async () => {
    const clock = new TestClock(T0);
    /* `text()` is awaited after the fetch resolves, so advancing here stands in for a slow round trip. */
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      clock,
      fetch: async () => {
        clock.advanceSeconds(5);
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => tokenResponse("ya29.slow", 3600),
        };
      },
    });
    await provider.token();
    expect(provider.cachedTokenServableUntilMs()).toBe(
      T0 + 5000 + (3600 - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    );
  });
});

describe("concurrency", () => {
  /* One queued response again: a second mint would throw, so this asserts the in-flight share. */
  it("makes one request for many concurrent callers", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.shared") }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => provider.token()),
    );
    expect(tokens).toEqual(Array.from({ length: 8 }, () => "ya29.shared"));
    expect(fetch.requests).toHaveLength(1);
  });

  it("gives every concurrent caller the same rejection", async () => {
    const fetch = new FakeFetch([{ status: 503, body: "" }]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    const settled = await Promise.allSettled([provider.token(), provider.token()]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(fetch.requests).toHaveLength(1);
  });

  /*
   * A failed mint must not be remembered. If it were cached as a failure, one bad minute at the
   * token endpoint would take push down until the process restarted.
   */
  it("does not poison the cache: the next caller retries and succeeds", async () => {
    const fetch = new FakeFetch([
      { status: 500, body: "" },
      { status: 200, body: tokenResponse("ya29.after-retry") },
    ]);
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    await expect(provider.token()).rejects.toThrow(FcmTokenError);
    expect(await provider.token()).toBe("ya29.after-retry");
    expect(fetch.requests).toHaveLength(2);
  });
});

describe("token endpoint failures", () => {
  it("classifies 5xx as retryable", () => {
    expect(classifyTokenEndpointFailure(503, null)).toBe(
      "token_endpoint_unavailable",
    );
    expect(
      RETRYABLE_FCM_TOKEN_ERROR_KINDS.has("token_endpoint_unavailable"),
    ).toBe(true);
  });

  it("classifies 429 as rate limited and retryable", () => {
    expect(classifyTokenEndpointFailure(429, null)).toBe("rate_limited");
    expect(RETRYABLE_FCM_TOKEN_ERROR_KINDS.has("rate_limited")).toBe(true);
  });

  /* The distinction that matters: another attempt cannot fix a wrong service account. */
  it("classifies invalid_grant as terminal", () => {
    expect(classifyTokenEndpointFailure(400, "invalid_grant")).toBe(
      "invalid_grant",
    );
    expect(RETRYABLE_FCM_TOKEN_ERROR_KINDS.has("invalid_grant")).toBe(false);
  });

  it("classifies unauthorized_client as terminal", () => {
    expect(classifyTokenEndpointFailure(401, "unauthorized_client")).toBe(
      "unauthorized_client",
    );
  });

  it("falls back to a generic rejection for another 4xx", () => {
    expect(classifyTokenEndpointFailure(400, "invalid_request")).toBe(
      "token_endpoint_rejected",
    );
  });

  it("prefers the status over the code for a 5xx carrying one", () => {
    expect(classifyTokenEndpointFailure(500, "invalid_grant")).toBe(
      "token_endpoint_unavailable",
    );
  });

  it("parses an RFC 6749 error body", () => {
    expect(
      parseTokenEndpointError(
        '{"error":"invalid_grant","error_description":"Invalid JWT Signature."}',
      ),
    ).toEqual({ code: "invalid_grant", description: "Invalid JWT Signature." });
  });

  it("reads nothing out of an unparseable error body", () => {
    expect(parseTokenEndpointError("<html>502</html>")).toEqual({
      code: null,
      description: null,
    });
  });

  it("raises invalid_grant with the status and description attached", async () => {
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      clock: new TestClock(T0),
      fetch: new FakeFetch([
        {
          status: 400,
          body: '{"error":"invalid_grant","error_description":"Invalid JWT Signature."}',
        },
      ]).fn,
    });
    try {
      await provider.token();
      expect.unreachable("an invalid_grant must reject");
    } catch (err) {
      expect(err).toBeInstanceOf(FcmTokenError);
      const error = err as FcmTokenError;
      expect(error.kind).toBe("invalid_grant");
      expect(error.status).toBe(400);
      expect(error.isRetryable()).toBe(false);
      expect(error.message).toContain("Invalid JWT Signature.");
    }
  });

  it("classifies a dead socket as a retryable network error", async () => {
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      clock: new TestClock(T0),
      fetch: throwingFetch("ECONNRESET"),
    });
    try {
      await provider.token();
      expect.unreachable("a dead socket must reject");
    } catch (err) {
      const error = err as FcmTokenError;
      expect(error.kind).toBe("network_error");
      expect(error.isRetryable()).toBe(true);
      expect(error.message).toContain("ECONNRESET");
    }
  });

  it("passes an abort signal so a hung endpoint cannot hang every push", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const seen: (AbortSignal | undefined)[] = [];
    await new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      clock: new TestClock(T0),
      fetch: async (url, init) => {
        seen.push(init.signal);
        return fetch.fn(url, init);
      },
    }).token();
    expect(seen[0]?.aborted).toBe(false);
  });

  it("every declared kind is either retryable or not, and the set is a subset", () => {
    for (const kind of RETRYABLE_FCM_TOKEN_ERROR_KINDS) {
      expect(FCM_TOKEN_ERROR_KINDS).toContain(kind);
    }
    expect(RETRYABLE_FCM_TOKEN_ERROR_KINDS.size).toBeLessThan(
      FCM_TOKEN_ERROR_KINDS.length,
    );
  });
});

describe("the token response", () => {
  it("reads an access token and its lifetime", () => {
    expect(parseAccessTokenResponse(tokenResponse("ya29.x", 3599))).toEqual({
      accessToken: "ya29.x",
      expiresInSeconds: 3599,
    });
  });

  /* A response claiming a week would otherwise pin a revoked credential in the cache. */
  it("caps an implausible lifetime at an hour", () => {
    expect(
      parseAccessTokenResponse(tokenResponse("ya29.x", 604_800)).expiresInSeconds,
    ).toBe(MAX_ACCESS_TOKEN_LIFETIME_SECONDS);
  });

  it("refuses a 2xx body that is not JSON", () => {
    expect(() => parseAccessTokenResponse("<html>")).toThrow(/not JSON/);
  });

  it("refuses a 2xx body that is not an object", () => {
    expect(() => parseAccessTokenResponse('"ya29.x"')).toThrow(/not an object/);
  });

  it("refuses a response with no access token", () => {
    expect(() => parseAccessTokenResponse('{"expires_in":3599}')).toThrow(
      /no access_token/,
    );
  });

  /* Not assumed: a guessed lifetime either re-mints every send or caches past the real expiry. */
  it("refuses a response with no positive expires_in", () => {
    expect(() => parseAccessTokenResponse('{"access_token":"ya29.x"}')).toThrow(
      /no positive expires_in/,
    );
    expect(() =>
      parseAccessTokenResponse('{"access_token":"ya29.x","expires_in":0}'),
    ).toThrow(/no positive expires_in/);
    expect(() =>
      parseAccessTokenResponse('{"access_token":"ya29.x","expires_in":"3599"}'),
    ).toThrow(/no positive expires_in/);
  });

  it("raises a non-retryable malformed_token_response through the provider", async () => {
    const provider = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      clock: new TestClock(T0),
      fetch: new FakeFetch([{ status: 200, body: "<html>proxy</html>" }]).fn,
    });
    try {
      await provider.token();
      expect.unreachable("an unparseable 2xx must reject");
    } catch (err) {
      const error = err as FcmTokenError;
      expect(error.kind).toBe("malformed_token_response");
      expect(error.isRetryable()).toBe(false);
    }
  });
});

describe("the injected seam", () => {
  /*
   * `FcmAccessTokenProvider` is the function type `() => Promise<string>`, which a class cannot
   * `implements`. `asProvider` is the conformance, and it has to stay bound — an unbound method
   * handed to `FcmPushSender` would lose `this` and the cache with it.
   */
  it("asProvider hands back a bound function that caches", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.bound") }]);
    const accessToken = new ServiceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    }).asProvider();
    expect(await accessToken()).toBe("ya29.bound");
    expect(await accessToken()).toBe("ya29.bound");
    expect(fetch.requests).toHaveLength(1);
  });

  it("the one-line factory refuses at wiring time, not at the first push", () => {
    expect(() =>
      serviceAccountFcmTokenProvider({
        credentials: credentials({ privateKeyPem: "hunter2" }),
      }),
    ).toThrow(/not a PEM-encoded private key/);
  });

  /*
   * The assignment is the assertion, and it is checked by `typecheck` rather than at runtime: if
   * `FcmAccessTokenProvider` ever changes shape, this stops compiling — which is the warning we
   * want, since the orchestrator's `buildSenderRegistryFromEnv` makes exactly this assignment.
   */
  it("satisfies push-fcm's declared FcmAccessTokenProvider seam", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.seam") }]);
    const seam: FcmAccessTokenProvider = serviceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(await seam()).toBe("ya29.seam");
  });

  it("the one-line factory mints like the class", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.factory") }]);
    const accessToken = serviceAccountFcmTokenProvider({
      credentials: credentials(),
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(await accessToken()).toBe("ya29.factory");
  });
});
