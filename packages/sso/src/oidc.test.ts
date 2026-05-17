import { describe, expect, it } from "vitest";
import {
  ID_TOKEN_SIGN_ALGORITHMS,
  OIDC_GRANT_TYPES,
  OIDC_RESPONSE_TYPES,
  OIDC_TOKEN_AUTH_METHODS,
  OidcAuthorizeRequestSchema,
  OidcDiscoveryDocSchema,
  OidcIdTokenClaimsSchema,
  OidcTokenResponseSchema,
  PKCE_METHODS,
  STANDARD_OIDC_SCOPES,
  containsOpenidScope,
  isPublicClient,
  isValidRedirectUri,
  isWeakIdTokenSignAlgorithm,
  parseScopeString,
  validateIdTokenClaims,
} from "./oidc.js";

describe("constants", () => {
  it("has 5 response types", () => {
    expect(OIDC_RESPONSE_TYPES).toHaveLength(5);
  });
  it("has 5 grant types", () => {
    expect(OIDC_GRANT_TYPES).toHaveLength(5);
  });
  it("has 5 token auth methods including none", () => {
    expect(OIDC_TOKEN_AUTH_METHODS).toHaveLength(5);
    expect(OIDC_TOKEN_AUTH_METHODS).toContain("none");
  });
  it("PKCE methods are S256 and plain", () => {
    expect(PKCE_METHODS).toEqual(["S256", "plain"]);
  });
  it("standard scopes include openid, profile, email, offline_access", () => {
    expect(STANDARD_OIDC_SCOPES).toContain("openid");
    expect(STANDARD_OIDC_SCOPES).toContain("offline_access");
  });
  it("ID_TOKEN_SIGN_ALGORITHMS contains EdDSA and RS256", () => {
    expect(ID_TOKEN_SIGN_ALGORITHMS).toContain("EdDSA");
    expect(ID_TOKEN_SIGN_ALGORITHMS).toContain("RS256");
  });
});

describe("isWeakIdTokenSignAlgorithm", () => {
  it("HS256 is weak (symmetric)", () => {
    expect(isWeakIdTokenSignAlgorithm("HS256")).toBe(true);
  });
  it("RS256 is strong", () => {
    expect(isWeakIdTokenSignAlgorithm("RS256")).toBe(false);
  });
});

describe("OidcDiscoveryDocSchema", () => {
  it("accepts a typical discovery doc", () => {
    expect(() =>
      OidcDiscoveryDocSchema.parse({
        issuer: "https://acme.auth0.com",
        authorization_endpoint: "https://acme.auth0.com/authorize",
        token_endpoint: "https://acme.auth0.com/oauth/token",
        jwks_uri: "https://acme.auth0.com/.well-known/jwks.json",
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        subject_types_supported: ["public"],
      }),
    ).not.toThrow();
  });
});

describe("OidcAuthorizeRequestSchema", () => {
  const base = {
    clientId: "client123",
    redirectUri: "https://app.crossengin.io/callback",
    responseType: "code" as const,
    scope: "openid email",
    state: "abc12345",
    nonce: "noncenoncenonce",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256" as const,
  };

  it("accepts a typical PKCE-protected code request", () => {
    expect(() => OidcAuthorizeRequestSchema.parse(base)).not.toThrow();
  });

  it("rejects plain PKCE method when codeChallenge is set", () => {
    expect(() =>
      OidcAuthorizeRequestSchema.parse({
        ...base,
        codeChallengeMethod: "plain",
      }),
    ).toThrow(/plain PKCE/);
  });

  it("rejects code response without nonce", () => {
    const { nonce: _omit, ...withoutNonce } = base;
    expect(() => OidcAuthorizeRequestSchema.parse(withoutNonce)).toThrow(
      /nonce required/,
    );
  });

  it("rejects codeChallenge without method", () => {
    const { codeChallengeMethod: _omit, ...withoutMethod } = base;
    expect(() => OidcAuthorizeRequestSchema.parse(withoutMethod)).toThrow(
      /codeChallengeMethod required/,
    );
  });
});

describe("OidcTokenResponseSchema", () => {
  it("accepts a Bearer token response", () => {
    expect(() =>
      OidcTokenResponseSchema.parse({
        accessToken: "at-xxx",
        tokenType: "Bearer",
        expiresIn: 3600,
        idToken: "id-xxx",
        refreshToken: "rt-xxx",
        scope: "openid email",
      }),
    ).not.toThrow();
  });
});

describe("validateIdTokenClaims", () => {
  const now = new Date("2026-05-15T10:00:00Z");
  const exp = Math.floor(now.getTime() / 1000) + 600;
  const iat = Math.floor(now.getTime() / 1000) - 5;
  const claims = OidcIdTokenClaimsSchema.parse({
    iss: "https://acme.auth0.com",
    sub: "alice",
    aud: "client123",
    exp,
    iat,
    nonce: "noncenoncenonce",
  });

  it("accepts a valid token", () => {
    const result = validateIdTokenClaims(claims, {
      expectedIssuer: "https://acme.auth0.com",
      expectedAudience: "client123",
      expectedNonce: "noncenoncenonce",
      now,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects issuer mismatch", () => {
    const result = validateIdTokenClaims(claims, {
      expectedIssuer: "https://attacker.com",
      expectedAudience: "client123",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("issuer_mismatch");
  });

  it("rejects expired token", () => {
    const expiredClaims = OidcIdTokenClaimsSchema.parse({
      ...claims,
      exp: Math.floor(now.getTime() / 1000) - 600,
    });
    const result = validateIdTokenClaims(expiredClaims, {
      expectedIssuer: "https://acme.auth0.com",
      expectedAudience: "client123",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("id_token_expired");
  });

  it("rejects audience mismatch", () => {
    const result = validateIdTokenClaims(claims, {
      expectedIssuer: "https://acme.auth0.com",
      expectedAudience: "different-client",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("audience_mismatch");
  });

  it("rejects nonce mismatch when expected", () => {
    const result = validateIdTokenClaims(claims, {
      expectedIssuer: "https://acme.auth0.com",
      expectedAudience: "client123",
      expectedNonce: "different-nonce",
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nonce_mismatch");
  });

  it("accepts array audience containing expected", () => {
    const arrayAud = OidcIdTokenClaimsSchema.parse({
      ...claims,
      aud: ["client123", "other"],
    });
    const result = validateIdTokenClaims(arrayAud, {
      expectedIssuer: "https://acme.auth0.com",
      expectedAudience: "client123",
      now,
    });
    expect(result.ok).toBe(true);
  });
});

describe("isPublicClient", () => {
  it("returns true for client without secret + flag set", () => {
    expect(
      isPublicClient({ isPublicClient: true, clientSecretSha256: null }),
    ).toBe(true);
  });
  it("returns false for confidential client", () => {
    expect(
      isPublicClient({
        isPublicClient: false,
        clientSecretSha256: "a".repeat(64),
      }),
    ).toBe(false);
  });
});

describe("isValidRedirectUri", () => {
  it("returns true for exact match", () => {
    expect(
      isValidRedirectUri("https://app.crossengin.io/callback", [
        "https://app.crossengin.io/callback",
      ]),
    ).toBe(true);
  });
  it("returns false on no match (no wildcards)", () => {
    expect(
      isValidRedirectUri("https://app.crossengin.io/callback?evil=1", [
        "https://app.crossengin.io/callback",
      ]),
    ).toBe(false);
  });
});

describe("parseScopeString and containsOpenidScope", () => {
  it("splits on whitespace", () => {
    expect(parseScopeString("openid email profile")).toEqual([
      "openid",
      "email",
      "profile",
    ]);
  });
  it("containsOpenidScope returns true when present", () => {
    expect(containsOpenidScope("openid email")).toBe(true);
  });
  it("containsOpenidScope returns false when absent", () => {
    expect(containsOpenidScope("email profile")).toBe(false);
  });
});
