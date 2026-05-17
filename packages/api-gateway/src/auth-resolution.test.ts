import { describe, expect, it } from "vitest";
import {
  AUTH_OUTCOMES,
  AUTH_SCHEMES,
  AUTH_SUCCESS_OUTCOMES,
  ParsedAuthCredentialSchema,
  ResolvedPrincipalSchema,
  SCHEMES_REQUIRING_HTTPS,
  STRONG_AUTH_SCHEMES,
  isAuthSuccess,
  isStrongAuthScheme,
  resolveAuth,
  schemeRequiresHttps,
  type ParsedAuthCredential,
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
  it("has 15 auth outcomes", () => {
    expect(AUTH_OUTCOMES).toHaveLength(15);
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
    });
    expect(r.outcome).toBe("audience_mismatch");
  });

  it("returns credential_malformed when scheme not allowed", () => {
    const r = resolveAuth({
      credential: baseJwt,
      schemeAllowed: false,
      tlsAcceptable: true,
      now,
      expectedIssuer: "https://sso.acme.com",
      expectedAudience: "api.crossengin.io",
      clockSkewSeconds: 60,
      hmacSignatureMaxAgeSeconds: 300,
    });
    expect(r.outcome).toBe("credential_malformed");
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
