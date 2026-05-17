import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  sha256,
  signEd25519,
} from "@crossengin/crypto";
import type { IncomingRequest } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  InMemoryJwksProvider,
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
  exp?: number;
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

  async function makeJwksAndToken(opts: { exp?: number; nbf?: number; aud?: string | readonly string[]; iss?: string } = {}) {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const jwks = new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] });
    const token = buildJwt({
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      kid,
      iss: opts.iss ?? issuer,
      aud: opts.aud ?? audience,
      sub: USER,
      exp: opts.exp ?? NOW_SECONDS + 3_600,
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
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("expired_token");
  });

  it("rejects not_yet_valid_token (nbf in future)", async () => {
    const { jwks, token } = await makeJwksAndToken({ nbf: NOW_SECONDS + 3_600 });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("not_yet_valid_token");
  });

  it("rejects audience_mismatch", async () => {
    const { jwks, token } = await makeJwksAndToken({ aud: "https://other.example" });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("audience_mismatch");
  });

  it("rejects issuer_mismatch", async () => {
    const { jwks, token } = await makeJwksAndToken({ iss: "https://other-issuer.example" });
    const result = await verifyBearerJwt({
      token,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("issuer_mismatch");
  });

  it("rejects invalid_signature", async () => {
    const { jwks, token } = await makeJwksAndToken();
    const tampered = token.slice(0, -10) + "AAAAAAAAAA";
    const result = await verifyBearerJwt({
      token: tampered,
      jwks,
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
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
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("credential_malformed");
  });

  it("rejects credential_not_found when kid is unknown", async () => {
    const { token } = await makeJwksAndToken();
    const result = await verifyBearerJwt({
      token,
      jwks: new InMemoryJwksProvider({ keys: [] }),
      opts: { expectedIssuer: issuer, expectedAudience: audience, clockSkewSeconds: 30, nowSeconds: NOW_SECONDS },
    });
    expect(result.outcome).toBe("credential_not_found");
  });
});

describe("parseAuthHeader", () => {
  it("recognizes Bearer", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { authorization: "Bearer abc.def.ghi" } }));
    expect(result.scheme).toBe("bearer_jwt");
    expect(result.token).toBe("abc.def.ghi");
  });

  it("recognizes Basic", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { authorization: "Basic Zm9vOmJhcg==" } }));
    expect(result.scheme).toBe("basic");
    expect(result.token).toBe("Zm9vOmJhcg==");
  });

  it("recognizes x-api-key", () => {
    const result = parseAuthHeader(fixtureRequest({ headers: { "x-api-key": "ce_live_abcdef" } }));
    expect(result.scheme).toBe("api_key_header");
    expect(result.token).toBe("ce_live_abcdef");
  });

  it("returns null scheme when no credential present", () => {
    const result = parseAuthHeader(fixtureRequest());
    expect(result.scheme).toBeNull();
    expect(result.token).toBeNull();
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
});
