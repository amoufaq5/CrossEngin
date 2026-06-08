import { generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import type { RawWebRequest } from "./http.js";
import { buildJwksProvider } from "./jwks.js";
import {
  ApiKeyRegistry,
  WebPrincipalResolver,
  parseApiKeySpec,
  parseJwksKeySpec,
  scopesToRoles,
  subjectToUuid,
  type JwtVerifyConfig,
} from "./principals.js";

describe("parseApiKeySpec", () => {
  it("parses key:role:tenant", () => {
    expect(parseApiKeySpec("k1:store_manager:t1")).toEqual({
      key: "k1",
      role: "store_manager",
      tenantId: "t1",
    });
  });

  it("rejects a wrong arity", () => {
    expect(() => parseApiKeySpec("k1:role")).toThrow();
    expect(() => parseApiKeySpec("k1:role:t:extra")).toThrow();
  });

  it("rejects an empty field", () => {
    expect(() => parseApiKeySpec("k1::t1")).toThrow();
  });
});

describe("ApiKeyRegistry", () => {
  const reg = new ApiKeyRegistry([
    { key: "mgr", role: "store_manager", tenantId: "t1" },
    { key: "csh", role: "cashier", tenantId: "t1" },
  ]);

  it("resolves a known x-api-key", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { "x-api-key": "mgr" } })).toEqual({
      roles: ["store_manager"],
      tenantId: "t1",
    });
  });

  it("resolves a Bearer token", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { authorization: "Bearer csh" } })).toEqual({
      roles: ["cashier"],
      tenantId: "t1",
    });
  });

  it("fails closed on an unknown / missing token", () => {
    expect(reg.resolve({ method: "GET", url: "/", headers: { "x-api-key": "nope" } })).toBeNull();
    expect(reg.resolve({ method: "GET", url: "/", headers: {} })).toBeNull();
  });
});

describe("subjectToUuid", () => {
  it("passes a UUID sub through (lowercased)", () => {
    expect(subjectToUuid("11111111-2222-4333-8444-555555555555")).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("hashes an opaque sub into a stable v5-shaped UUID", () => {
    const a = subjectToUuid("user-123");
    const b = subjectToUuid("user-123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("scopesToRoles", () => {
  it("prefers an explicit roles array", () => {
    expect(scopesToRoles({ roles: ["store_manager", "x"], scope: "cashier" })).toEqual(["store_manager", "x"]);
  });

  it("splits a space-delimited scope string", () => {
    expect(scopesToRoles({ scope: "store_manager cashier" })).toEqual(["store_manager", "cashier"]);
  });

  it("reads the scp array when no scope string", () => {
    expect(scopesToRoles({ scp: ["cashier"] })).toEqual(["cashier"]);
  });

  it("returns [] when no scope claim (fail-closed: public-only)", () => {
    expect(scopesToRoles({})).toEqual([]);
  });
});

describe("parseJwksKeySpec", () => {
  it("parses kid:base64", () => {
    expect(parseJwksKeySpec("key-1:AAAA")).toEqual({ kid: "key-1", publicKeyBase64: "AAAA" });
  });
  it("rejects a malformed spec", () => {
    expect(() => parseJwksKeySpec("noColon")).toThrow();
    expect(() => parseJwksKeySpec(":AAAA")).toThrow();
    expect(() => parseJwksKeySpec("key-1:")).toThrow();
  });
});

describe("WebPrincipalResolver — JWT", () => {
  const ISS = "https://idp.example.com/";
  const AUD = "https://api.example.com/";
  const KID = "key-1";
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const NOW_S = Math.floor(NOW.getTime() / 1000);
  const TENANT = "00000000-0000-4000-8000-000000000001";
  const keypair = generateEd25519Keypair();

  function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function buildJwt(
    claims: Record<string, unknown>,
    opts: { kid?: string; privateKeyBase64?: string; publicKeyBase64?: string } = {},
  ): string {
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: opts.kid ?? KID })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const sig = signEd25519(
      opts.privateKeyBase64 ?? keypair.privateKeyBase64,
      opts.publicKeyBase64 ?? keypair.publicKeyBase64,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  }

  function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: ISS,
      aud: AUD,
      sub: "user-123",
      scope: "store_manager",
      tenant_id: TENANT,
      exp: NOW_S + 3600,
      nbf: NOW_S - 60,
      ...overrides,
    };
  }

  function makeResolver(): WebPrincipalResolver {
    const jwt: JwtVerifyConfig = {
      jwksProvider: buildJwksProvider([{ kid: KID, publicKeyBase64: keypair.publicKeyBase64 }]),
      issuer: ISS,
      audience: AUD,
    };
    return new WebPrincipalResolver({
      apiKeys: new ApiKeyRegistry([{ key: "mgr", role: "store_manager", tenantId: "t1" }]),
      jwt,
      now: () => NOW,
    });
  }

  function bearer(token: string, extra: Record<string, string> = {}): RawWebRequest {
    return { method: "GET", url: "/ui/app", headers: { authorization: `Bearer ${token}`, ...extra } };
  }

  it("a registered api key still wins over JWT verification", async () => {
    const resolver = makeResolver();
    expect(await resolver.resolve({ method: "GET", url: "/", headers: { "x-api-key": "mgr" } })).toEqual({
      roles: ["store_manager"],
      tenantId: "t1",
    });
  });

  it("resolves a valid JWT — scopes → roles, tenant from the tenant_id claim", async () => {
    const resolver = makeResolver();
    const viewer = await resolver.resolve(bearer(buildJwt(validClaims())));
    expect(viewer).toEqual({ roles: ["store_manager"], tenantId: TENANT });
  });

  it("falls back to the x-tenant-id header when no tenant_id claim", async () => {
    const resolver = makeResolver();
    const viewer = await resolver.resolve(
      bearer(buildJwt(validClaims({ tenant_id: undefined })), { "x-tenant-id": "t-header" }),
    );
    expect(viewer).toEqual({ roles: ["store_manager"], tenantId: "t-header" });
  });

  it("401s an unknown-kid JWT (no key) — fail-closed", async () => {
    const resolver = makeResolver();
    expect(await resolver.resolve(bearer(buildJwt(validClaims(), { kid: "other" })))).toBeNull();
  });

  it("401s a wrong-issuer JWT", async () => {
    const resolver = makeResolver();
    expect(await resolver.resolve(bearer(buildJwt(validClaims({ iss: "https://evil/" }))))).toBeNull();
  });

  it("401s an expired JWT", async () => {
    const resolver = makeResolver();
    expect(await resolver.resolve(bearer(buildJwt(validClaims({ exp: NOW_S - 3600 }))))).toBeNull();
  });

  it("401s a JWT signed by an unknown key (bad signature)", async () => {
    const resolver = makeResolver();
    const wrong = generateEd25519Keypair();
    const token = buildJwt(validClaims(), {
      privateKeyBase64: wrong.privateKeyBase64,
      publicKeyBase64: wrong.publicKeyBase64,
    });
    expect(await resolver.resolve(bearer(token))).toBeNull();
  });

  it("with no JWT config, an unknown Bearer token is rejected", async () => {
    const resolver = new WebPrincipalResolver({
      apiKeys: new ApiKeyRegistry([{ key: "mgr", role: "store_manager", tenantId: "t1" }]),
    });
    expect(await resolver.resolve(bearer(buildJwt(validClaims())))).toBeNull();
  });
});
