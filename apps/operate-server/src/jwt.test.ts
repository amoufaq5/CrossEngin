import { generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack } from "./manifest-source.js";
import {
  buildJwksProvider,
  parseJwksKeySpec,
  principalFromJwtClaims,
  subjectToUuid,
  type JwtVerifyConfig,
} from "./principals.js";
import { buildOperateHttpServer, type OperateHttpServer } from "./server.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ISS = "https://idp.example.com/";
const AUD = "https://api.example.com/";
const KID = "key-1";
const NOW = new Date("2026-06-03T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

const manifest = await loadBuiltinPack("erp-retail");
const keypair = generateEd25519Keypair();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJwt(claims: Record<string, unknown>, opts: { kid?: string; privateKeyBase64?: string; publicKeyBase64?: string } = {}): string {
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
  return { iss: ISS, aud: AUD, sub: "user-123", scope: "store_manager", exp: NOW_S + 3600, nbf: NOW_S - 60, ...overrides };
}

function makeServer(): OperateHttpServer {
  const jwt: JwtVerifyConfig = {
    jwksProvider: buildJwksProvider([{ kid: KID, publicKeyBase64: keypair.publicKeyBase64 }]),
    issuer: ISS,
    audience: AUD,
  };
  return buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: [],
    jwt,
    now: () => NOW,
  }).httpServer;
}

function jwtReq(method: string, url: string, jwt: string, extraHeaders: Record<string, string> = {}): RawHttpRequest {
  return {
    method,
    url,
    headers: { authorization: `Bearer ${jwt}`, host: "api.example.com", "x-tenant-id": TENANT, ...extraHeaders },
    remoteAddress: "203.0.113.1",
  };
}

describe("subjectToUuid", () => {
  it("passes a UUID subject through (lowercased)", () => {
    expect(subjectToUuid("00000000-0000-4000-8000-0000000000AA")).toBe("00000000-0000-4000-8000-0000000000aa");
  });
  it("hashes a non-UUID subject into a stable v5-shaped UUID", () => {
    const a = subjectToUuid("user-123");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(subjectToUuid("user-123")).toBe(a); // stable
    expect(subjectToUuid("user-456")).not.toBe(a);
  });
});

describe("principalFromJwtClaims", () => {
  it("maps sub→principalId, scopes→grantedScopes, tenantHint→tenant", () => {
    const p = principalFromJwtClaims(
      { authScheme: "bearer_jwt", principalRef: "user-123", scopes: ["store_manager"], tenantId: TENANT },
      () => NOW,
    );
    expect(p.authScheme).toBe("bearer_jwt");
    expect(p.tenantId).toBe(TENANT);
    expect(p.grantedScopes).toEqual(["store_manager"]);
    expect(p.principalId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("nulls a non-UUID tenant hint", () => {
    const p = principalFromJwtClaims(
      { authScheme: "bearer_jwt", principalRef: "u", scopes: [], tenantId: "not-a-uuid" },
      () => NOW,
    );
    expect(p.tenantId).toBeNull();
  });
});

describe("parseJwksKeySpec", () => {
  it("splits kid:base64 on the first colon", () => {
    expect(parseJwksKeySpec("key-1:AAAxyz==")).toEqual({ kid: "key-1", publicKeyBase64: "AAAxyz==" });
  });
  it("rejects a malformed spec", () => {
    expect(() => parseJwksKeySpec("nokey")).toThrow(/invalid --jwks-key/);
  });
});

describe("operate-server — Bearer JWT auth (EdDSA via JWKS)", () => {
  it("authenticates a valid JWT and serves the list (scope → role)", async () => {
    const server = makeServer();
    const res = await server.dispatch(jwtReq("GET", "/v1/products", buildJwt(validClaims())), null);
    expect(res.status).toBe(200);
  });

  it("authorizes a write by the JWT's scope (store_manager creates a product)", async () => {
    const server = makeServer();
    const body = new TextEncoder().encode(JSON.stringify({ sku: "S1", name: "Milk", unit_price: 2, status: "active", category: "g" }));
    const raw = jwtReq("POST", "/v1/products", buildJwt(validClaims()), { "content-type": "application/json" });
    const res = await server.dispatch(raw, body);
    expect(res.status).toBe(201);
  });

  it("401s a JWT signed by an unknown key (bad signature)", async () => {
    const server = makeServer();
    const other = generateEd25519Keypair();
    const forged = buildJwt(validClaims(), { privateKeyBase64: other.privateKeyBase64, publicKeyBase64: other.publicKeyBase64 });
    const res = await server.dispatch(jwtReq("GET", "/v1/products", forged), null);
    expect(res.status).toBe(401);
  });

  it("401s a JWT with the wrong issuer", async () => {
    const server = makeServer();
    const res = await server.dispatch(jwtReq("GET", "/v1/products", buildJwt(validClaims({ iss: "https://evil/" }))), null);
    expect(res.status).toBe(401);
  });

  it("401s an expired JWT", async () => {
    const server = makeServer();
    // beyond the gateway's 30s clock-skew tolerance
    const res = await server.dispatch(jwtReq("GET", "/v1/products", buildJwt(validClaims({ exp: NOW_S - 120 }))), null);
    expect(res.status).toBe(401);
  });

  it("401s a request with no credential", async () => {
    const server = makeServer();
    const res = await server.dispatch(
      { method: "GET", url: "/v1/products", headers: { host: "api.example.com" }, remoteAddress: "203.0.113.1" },
      null,
    );
    expect(res.status).toBe(401);
  });
});
