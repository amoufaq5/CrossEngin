import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  signEd25519,
} from "@crossengin/crypto";
import type { RouteDefinition } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { buildIncomingRequest } from "./adapters.js";
import { InMemoryJwksProvider } from "./auth.js";
import { HandlerRegistry } from "./dispatcher.js";
import { GatewayRuntime } from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type PrincipalResolver,
  type PrincipalResolverInput,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const ISSUER = "https://issuer.example";
const AUDIENCE = "https://api.crossengin.io";
const NOW = "2026-05-16T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function token(kp: { privateKeyBase64: string; publicKeyBase64: string }, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const route: RouteDefinition = {
  id: "rt_route0001",
  operationId: "tenants.create",
  method: "POST",
  pathSegments: [
    { kind: "literal", value: "v1" },
    { kind: "literal", value: "tenants" },
  ],
  apiVersion: "v1",
  isDeprecated: false,
  deprecatedSince: null,
  sunsetAt: null,
  successorOperationId: null,
  requiredScopes: [],
  rateLimitPolicyId: null,
  idempotencyRequired: false,
  requestSchemaSha256: null,
  responseSchemaSha256: null,
};

function request(headers: Record<string, string>) {
  return buildIncomingRequest({
    id: "req_test00000001",
    receivedAt: NOW,
    method: "POST",
    path: "/v1/tenants",
    headers,
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    edgeTrust: "untrusted",
  });
}

function runtimeWith(resolver: PrincipalResolver, jwks: InMemoryJwksProvider): GatewayRuntime {
  return new GatewayRuntime({
    routes: new InMemoryRouteRegistry().register(route),
    handlers: new HandlerRegistry().register("tenants.create", () => ({ kind: "json", status: 201, body: {} })),
    principalResolver: resolver,
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
    jwksProvider: jwks,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    clockSkewSeconds: 30,
    clock: { now: () => new Date(NOW) },
  });
}

describe("a resolver is handed the verified bearer token", () => {
  it("carries the verifying kid and every claim, including ones the four fields do not", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const seen: PrincipalResolverInput[] = [];
    const resolver: PrincipalResolver = {
      async resolve(input) {
        seen.push(input);
        return {
          principalId: USER,
          tenantId: TENANT,
          principalKind: "user",
          authScheme: "bearer_jwt",
          grantedScopes: [],
          mfaProofAgeSeconds: null,
          resolvedAt: NOW,
        };
      },
    };
    const rt = runtimeWith(resolver, new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] }));
    const t = token(kp, kid, { iss: ISSUER, aud: AUDIENCE, sub: USER, tenant_id: TENANT, exp: NOW_SECONDS + 600, sep: 3 });
    const { response } = await rt.handleRequest(request({ authorization: `Bearer ${t}` }));
    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bearer?.kid).toBe(kid);
    expect(seen[0]!.bearer?.claims["sep"]).toBe(3);
    expect(seen[0]!.bearer?.claims["sub"]).toBe(USER);
  });

  it("refuses a token naming no tenant before the header's tenant can be used, by default", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    let resolved = 0;
    const resolver: PrincipalResolver = {
      async resolve() {
        resolved += 1;
        return null;
      },
    };
    const rt = runtimeWith(resolver, new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] }));
    const t = token(kp, kid, { iss: ISSUER, aud: AUDIENCE, sub: USER, exp: NOW_SECONDS + 600 });
    const { response, execution } = await rt.handleRequest(
      request({ authorization: `Bearer ${t}`, "x-tenant-id": TENANT }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("required_claim_absent");
    // Refused at `authenticate`, so the header never reached a resolver.
    expect(resolved).toBe(0);
  });
});
