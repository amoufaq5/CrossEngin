import { createHash } from "node:crypto";

import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  InMemoryJwksProvider,
  InMemoryPrincipalResolver,
  type JwksProvider,
  type OpaqueTokenLookup,
  type PrincipalResolver,
  type PrincipalResolverInput,
  type PrincipalRoles,
} from "@crossengin/api-gateway-runtime";

/** One API key → (role, tenant) binding the server authenticates against. */
export interface ApiKeySpec {
  readonly key: string;
  readonly role: string;
  readonly tenantId: string;
  readonly principalId: string;
}

const DEFAULT_PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000aa";

/**
 * Parses a `key:role:tenant[:principalId]` spec. The principalId defaults to a
 * fixed placeholder UUID so the common `key:role:tenant` form just works.
 */
export function parseApiKeySpec(raw: string): ApiKeySpec {
  const parts = raw.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`invalid --api-key (expected key:role:tenant[:principalId]): ${JSON.stringify(raw)}`);
  }
  const [key, role, tenantId, principalId] = parts;
  if (!key || !role || !tenantId) {
    throw new Error(`invalid --api-key (empty field): ${JSON.stringify(raw)}`);
  }
  return { key, role, tenantId, principalId: principalId && principalId.length > 0 ? principalId : DEFAULT_PRINCIPAL_ID };
}

export interface PrincipalWiring {
  readonly principalResolver: PrincipalResolver;
  readonly opaqueTokenLookup: OpaqueTokenLookup;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maps a JWT subject to a UUID principal id: a UUID `sub` is used as-is; any
 * other `sub` is hashed into a stable (v5-shaped) UUID, so an IdP's opaque
 * subject still yields a valid `ResolvedPrincipal.principalId`.
 */
export function subjectToUuid(sub: string): string {
  if (UUID_RE.test(sub)) return sub.toLowerCase();
  const h = createHash("sha256").update(sub).digest("hex").slice(0, 32).split("");
  h[12] = "5"; // version 5
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Synthesizes a `ResolvedPrincipal` from a **verified** Bearer-JWT (the gateway
 * has already checked signature + iss/aud/exp/nbf). The subject → a UUID
 * principal id, the JWT scopes → granted scopes; the tenant comes from the
 * request's `tenantHint` (the `x-tenant-id` header), which the gateway threads
 * into `input.tenantId`. This is the stateless "the token is the principal"
 * model; a directory-backed resolver can replace it behind the same interface.
 */
export function principalFromJwtClaims(input: PrincipalResolverInput, now: () => Date): ResolvedPrincipal {
  return {
    principalId: subjectToUuid(input.principalRef),
    tenantId: input.tenantId !== null && UUID_RE.test(input.tenantId) ? input.tenantId.toLowerCase() : null,
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: input.scopes,
    mfaProofAgeSeconds: null,
    resolvedAt: now().toISOString(),
  };
}

/**
 * Builds the gateway's auth wiring. API keys register a `ResolvedPrincipal` by
 * token (opaque `x-api-key`); a **verified Bearer JWT** is resolved statelessly
 * from its claims (`principalFromJwtClaims`). A token not in the set / an
 * unverified JWT resolves to null → 401 (fail-closed).
 */
export function buildPrincipalWiring(
  specs: readonly ApiKeySpec[],
  opts: { readonly now?: () => Date } = {},
): PrincipalWiring {
  const now = opts.now ?? (() => new Date());
  const apiKeyResolver = new InMemoryPrincipalResolver();
  const byKey = new Map<string, ApiKeySpec>();
  for (const spec of specs) {
    byKey.set(spec.key, spec);
    apiKeyResolver.register(spec.key, {
      principalId: spec.principalId,
      tenantId: spec.tenantId,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [spec.role],
      mfaProofAgeSeconds: null,
      resolvedAt: now().toISOString(),
    });
  }

  const principalResolver: PrincipalResolver = {
    async resolve(input: PrincipalResolverInput): Promise<ResolvedPrincipal | null> {
      if (input.authScheme === "bearer_jwt") return principalFromJwtClaims(input, now);
      return apiKeyResolver.resolve(input);
    },
  };

  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const spec = byKey.get(token);
      return spec === undefined ? null : { principalRef: spec.key, scopes: [spec.role], tenantId: spec.tenantId };
    },
  };

  return {
    principalResolver,
    opaqueTokenLookup,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  };
}

/** One JWKS public key: a `kid` → base64 Ed25519 public key (the gateway's verify format). */
export interface JwksKeySpec {
  readonly kid: string;
  readonly publicKeyBase64: string;
}

/** Production identity config: a JWKS provider + the expected issuer/audience. */
export interface JwtVerifyConfig {
  readonly jwksProvider: JwksProvider;
  readonly issuer: string;
  readonly audience: string;
}

/** Parses a `kid:base64key` spec (the kid is everything before the first `:`). */
export function parseJwksKeySpec(raw: string): JwksKeySpec {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid --jwks-key (expected kid:base64): ${JSON.stringify(raw)}`);
  }
  return { kid: raw.slice(0, idx), publicKeyBase64: raw.slice(idx + 1) };
}

/** Builds an in-memory `JwksProvider` from a set of public keys (the IdP's signing keys). */
export function buildJwksProvider(keys: readonly JwksKeySpec[]): JwksProvider {
  return new InMemoryJwksProvider({ keys: keys.map((k) => ({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 })) });
}
