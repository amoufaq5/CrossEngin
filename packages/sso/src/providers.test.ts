import { describe, expect, it } from "vitest";
import {
  IDP_VENDORS,
  PROTOCOLS,
  PROVIDER_STATUSES,
  PROVIDER_TRANSITIONS,
  SsoProviderSchema,
  canTransitionProvider,
  isTenantScopedProvider,
  requiresMandatoryRetest,
  type SsoProvider,
} from "./providers.js";

const baseSaml: SsoProvider = {
  id: "sso_acmesaml1",
  tenantId: "11111111-1111-1111-1111-111111111111",
  vendor: "okta",
  label: "Acme Okta",
  status: "active",
  enabled: true,
  allowWeakSignatures: false,
  createdAt: "2026-05-15T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  updatedAt: "2026-05-15T10:00:00.000Z",
  lastTestedAt: "2026-05-10T10:00:00.000Z",
  lastTestOutcome: "round_trip_ok",
  config: {
    protocol: "saml",
    idpEntityId: "https://okta.acme.com",
    idpSsoUrl: "https://okta.acme.com/saml/sso",
    idpSigningCertificateSha256: "a".repeat(64),
    spEntityId: "https://crossengin.io/sp/acme",
    spAcsUrl: "https://crossengin.io/sso/acme/acs",
    signatureAlgorithm:
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    allowedNameIdFormats: [
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    ],
    preferredBinding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    wantAssertionsSigned: true,
    wantResponseSigned: true,
    encryptAssertions: false,
    audienceUri: "https://crossengin.io/sp/acme",
    clockSkewSeconds: 60,
  },
};

const baseOidc: SsoProvider = {
  ...baseSaml,
  id: "sso_acmeoidc1",
  vendor: "auth0",
  config: {
    protocol: "oidc",
    issuer: "https://acme.auth0.com",
    authorizationEndpoint: "https://acme.auth0.com/authorize",
    tokenEndpoint: "https://acme.auth0.com/oauth/token",
    jwksUri: "https://acme.auth0.com/.well-known/jwks.json",
    clientId: "client123",
    clientSecretSha256: "b".repeat(64),
    isPublicClient: false,
    scopes: ["openid", "email", "profile"],
    responseTypes: ["code"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenAuthMethod: "client_secret_basic",
    pkceMethod: "S256",
    redirectUris: ["https://app.crossengin.io/callback"],
    postLogoutRedirectUris: [],
    idTokenSignAlg: "RS256",
    idTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 2592000,
    clockSkewSeconds: 60,
  },
};

describe("constants", () => {
  it("has 2 protocols", () => {
    expect(PROTOCOLS).toHaveLength(2);
  });
  it("has 10 IdP vendors", () => {
    expect(IDP_VENDORS).toHaveLength(10);
  });
  it("has 5 provider statuses", () => {
    expect(PROVIDER_STATUSES).toHaveLength(5);
  });
});

describe("canTransitionProvider", () => {
  it("allows draft → testing", () => {
    expect(canTransitionProvider("draft", "testing")).toBe(true);
  });
  it("blocks draft → active (must test first)", () => {
    expect(canTransitionProvider("draft", "active")).toBe(false);
  });
  it("allows testing → active", () => {
    expect(canTransitionProvider("testing", "active")).toBe(true);
  });
  it("archived is terminal", () => {
    expect(PROVIDER_TRANSITIONS.archived).toEqual([]);
  });
});

describe("SsoProviderSchema", () => {
  it("accepts a valid SAML provider", () => {
    expect(() => SsoProviderSchema.parse(baseSaml)).not.toThrow();
  });

  it("accepts a valid OIDC provider", () => {
    expect(() => SsoProviderSchema.parse(baseOidc)).not.toThrow();
  });

  it("rejects public OIDC client without PKCE S256", () => {
    expect(() =>
      SsoProviderSchema.parse({
        ...baseOidc,
        config: {
          ...baseOidc.config,
          isPublicClient: true,
          clientSecretSha256: null,
          pkceMethod: "plain",
        },
      }),
    ).toThrow(/PKCE S256/);
  });

  it("rejects confidential OIDC client missing clientSecretSha256", () => {
    expect(() =>
      SsoProviderSchema.parse({
        ...baseOidc,
        config: {
          ...baseOidc.config,
          isPublicClient: false,
          clientSecretSha256: null,
        },
      }),
    ).toThrow(/clientSecretSha256/);
  });

  it("rejects active provider that is disabled", () => {
    expect(() =>
      SsoProviderSchema.parse({ ...baseSaml, status: "active", enabled: false }),
    ).toThrow(/active provider must be enabled/);
  });

  it("requires sha256 hex pattern on the signing certificate fingerprint", () => {
    expect(() =>
      SsoProviderSchema.parse({
        ...baseSaml,
        config: {
          ...baseSaml.config,
          protocol: "saml",
          idpSigningCertificateSha256: "not-hex-not-64-chars",
        },
      }),
    ).toThrow();
  });
});

describe("isTenantScopedProvider", () => {
  it("returns true when tenant_id is set", () => {
    expect(isTenantScopedProvider(baseSaml)).toBe(true);
  });
  it("returns false for platform-wide providers", () => {
    expect(isTenantScopedProvider({ ...baseSaml, tenantId: null })).toBe(false);
  });
});

describe("requiresMandatoryRetest", () => {
  const now = new Date("2026-05-15T10:00:00Z");
  it("returns true when never tested", () => {
    expect(
      requiresMandatoryRetest({ ...baseSaml, lastTestedAt: null }, now),
    ).toBe(true);
  });
  it("returns true when last test exceeds threshold", () => {
    expect(
      requiresMandatoryRetest(
        { ...baseSaml, lastTestedAt: "2026-01-01T00:00:00.000Z" },
        now,
        90,
      ),
    ).toBe(true);
  });
  it("returns false within threshold", () => {
    expect(requiresMandatoryRetest(baseSaml, now, 90)).toBe(false);
  });
});
