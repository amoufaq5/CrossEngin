import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  InMemoryPrincipalResolver,
  type OpaqueTokenLookup,
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
  readonly principalResolver: InMemoryPrincipalResolver;
  readonly opaqueTokenLookup: OpaqueTokenLookup;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/**
 * Builds the gateway's auth wiring from a set of API keys: an opaque-token
 * lookup that maps a bearer/`x-api-key` token to its principal ref, a resolver
 * that returns the `ResolvedPrincipal`, and the scope→role bridge
 * (`grantedScopes[0]` is the primary role). A token not in the set resolves to
 * null, so the gateway returns 401 — fail-closed.
 */
export function buildPrincipalWiring(
  specs: readonly ApiKeySpec[],
  opts: { readonly now?: () => Date } = {},
): PrincipalWiring {
  const now = opts.now ?? (() => new Date());
  const resolver = new InMemoryPrincipalResolver();
  const byKey = new Map<string, ApiKeySpec>();
  for (const spec of specs) {
    byKey.set(spec.key, spec);
    const principal: ResolvedPrincipal = {
      principalId: spec.principalId,
      tenantId: spec.tenantId,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [spec.role],
      mfaProofAgeSeconds: null,
      resolvedAt: now().toISOString(),
    };
    resolver.register(spec.key, principal);
  }

  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const spec = byKey.get(token);
      return spec === undefined ? null : { principalRef: spec.key, scopes: [spec.role], tenantId: spec.tenantId };
    },
  };

  return {
    principalResolver: resolver,
    opaqueTokenLookup,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  };
}
