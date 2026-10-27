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
  type RequiredJwtClaim,
} from "@crossengin/api-gateway-runtime";
import { isEd25519PublicKeyBase64 } from "@crossengin/crypto";

/** One API key → (role, tenant) binding the server authenticates against. */
export interface ApiKeySpec {
  readonly key: string;
  readonly role: string;
  readonly tenantId: string;
  readonly principalId: string;
  /**
   * Whether the spec **named** the principal id, as opposed to falling back to the placeholder.
   *
   * This is what decides `principalKind`, and it has to be a separate field rather than a comparison
   * against `DEFAULT_PRINCIPAL_ID`: a spec is free to name that UUID explicitly, and then it means a
   * real provisioned user who happens to hold it.
   */
  readonly namesPrincipal: boolean;
}

/**
 * The principal id a `key:role:tenant` spec gets when it names none.
 *
 * It is **shared by every such key**, and that is not fixable here: a bare spec does not carry the
 * information to tell two keys apart, and the one thing that would — the key itself — must not be
 * hashed into an id, because a principal id is not a secret (it lands in `meta.audit_log`) and a
 * reversible-by-brute-force function of a credential turns an audit reader into an offline attacker.
 *
 * So the collision is declared rather than papered over: a spec that does not name a principal
 * resolves as a `service_account`, which is what any surface keyed on a *person* checks.
 */
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
  const named = principalId !== undefined && principalId.length > 0;
  return {
    key,
    role,
    tenantId,
    principalId: named ? principalId : DEFAULT_PRINCIPAL_ID,
    namesPrincipal: named,
  };
}

export interface PrincipalWiring {
  readonly principalResolver: PrincipalResolver;
  readonly opaqueTokenLookup: OpaqueTokenLookup;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/** What `principalRoles` answers for a credential that carries no scope at all. */
export const ANONYMOUS_ROLE = "anonymous";

/**
 * The credential's granted scopes read as the roles it holds: the first is the primary, the rest
 * are secondary.
 *
 * **This function is the whole of ADR-0369's reader half.** It was
 * `(p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" })` -- inline, with no
 * `secondaryRoles` key at all -- so the tail of a list the type declares as
 * `readonly string[]` was dropped, and all 26 non-test readers that spread
 * `...(secondaryRoles ?? [])` took the empty arm unconditionally however many scopes a token
 * carried. ADR-0361's class, on a scope list rather than a field list: a reader whose aperture is
 * narrower than the writer's.
 *
 * It is extracted and exported so there is **one** spelling of the reading and a test can hold it
 * against the mint, which is the other half: `sessionScope` composes the claim and this decomposes
 * it, and a round trip through both is the property that matters.
 *
 * Deliberately total and uninterpreting -- no de-duplication, no filtering of names the manifest
 * does not declare, no case folding. It reports what the credential carries; deciding what a role
 * *means* belongs to `resolveEffectiveRoles` and to the gates, each of which already fails closed
 * on a name it does not know (an unknown role maps to the unprivileged sentinel in the redaction
 * path, is skipped by the role-graph walk, and answers false to every `.has`). A reader that
 * silently dropped an undeclared scope would make the fence that reports it unreachable.
 */
export function principalRolesFromScopes(scopes: readonly string[]): PrincipalRoles {
  return { primaryRole: scopes[0] ?? ANONYMOUS_ROLE, secondaryRoles: scopes.slice(1) };
}

/** A boot line and how loudly to say it. */
export interface ScopeRoleReading {
  readonly message: string;
  readonly level: "info" | "warn";
}

/**
 * The boot line for how this deployment reads a token's scopes, or `null` when no JWT path is
 * configured at all.
 *
 * It lives beside the reader whose behaviour it describes rather than with the other boot surveys,
 * which is ADR-0361's rule: the fact lands where the next reader is.
 *
 * The second clause is the increment's one behaviour change on a configuration that worked before
 * it, and it is a **warning** rather than a note, because the first draft of this comment got the
 * stake wrong in the reassuring direction. It argued that "an undeclared scope grants nothing
 * anywhere … and every platform gate is a `.has`", from which the only reachable change would be
 * an IdP emitting a second scope that *is* a declared manifest role. The third clause is a
 * non-sequitur: `.has` is the mechanism, not a guarantee, and the platform gates test
 * **CLI-supplied** sets rather than the manifest's role map — `new Set(options.platformAdminRoles)`
 * and a dozen siblings. Measured: `platform_admin` is **not** one of `erp-core`'s fifteen declared
 * roles, so under the old reasoning it was the safe case and it is in fact the dangerous one. An
 * IdP emitting `scope: "openid profile platform_admin"` used to resolve `primaryRole = "openid"`
 * and be refused everywhere; it now reaches `/v1/platform/tenants` — provision and delete.
 *
 * Still reported rather than refused, on a measurement and for want of a better instrument: no
 * shipped configuration passes a JWKS flag, and every alternative available without a contract
 * change is worse. Reading only the first scope when an external JWKS is configured would make a
 * `--credential-login` deployment's own secondary roles silently inert, which is this repo's
 * most-found class; refusing the combination would refuse a deployment that works. The fix that
 * would actually settle it is a reader that knows **which key verified the token**, and
 * `PrincipalResolverInput` does not carry the matched `kid`.
 *
 * RFC 6749 §3.3 also makes `scope` an unordered set, so on a foreign token the increment promotes
 * an arbitrary element's authority rather than widening an ordered list. Our own mint writes the
 * primary first by construction.
 *
 * There is deliberately no survey beside it and no affirmative line for an api-key-only
 * deployment. A survey of which memberships grant a secondary role is the unscoped census
 * ADR-0365 refused by measurement: `meta.user_tenant_membership` carries one `ALL`-scope isolation
 * policy and no platform read arm, so a non-owner session with no tenant context reads zero rows
 * and would report a clean deployment because it could see nothing.
 */
export function formatScopeRoleReading(opts: {
  readonly credentialLogin: boolean;
  readonly externalJwks: boolean;
}): ScopeRoleReading | null {
  const clauses: string[] = [];
  if (opts.credentialLogin) {
    clauses.push("a session carries every role its membership grants, primary role first");
  }
  if (opts.externalJwks) {
    clauses.push(
      "a token this deployment did not mint has its scopes past the FIRST read as secondary" +
        " roles, so a scope matching any role named in a --*-role flag now grants what that role" +
        " grants — including --platform-admin-role, which reaches tenant provision and delete." +
        " Emit exactly the roles you mean",
    );
  }
  if (clauses.length === 0) return null;
  return {
    message: `session roles: ${clauses.join("; ")}`,
    // The widening is the only clause worth interrupting an operator for.
    level: opts.externalJwks ? "warn" : "info",
  };
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
      // `user` only when the spec actually named a principal. A bare `key:role:tenant` names no
      // person and every one of them shares `DEFAULT_PRINCIPAL_ID`, so calling it a user was wrong
      // twice over: a surface keyed on a viewer accepted it, and `meta.notification_read_states`
      // then failed its `meta.users` foreign key — reported as a 503 for something permanent. Worse
      // than the 503, two keys in one tenant would have *shared* read state, so one person's clicks
      // marked another's notices read. `service_account` is the fact, and it is what a per-person
      // surface checks; a key that names its principal is unchanged.
      principalKind: spec.namesPrincipal ? "user" : "service_account",
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
    principalRoles: (p) => principalRolesFromScopes(p?.grantedScopes ?? []),
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
  /**
   * Which claims a token must carry, beyond matching when it carries them (ADR-0386).
   *
   * **Required**, so the one call site that builds this cannot omit it and inherit the permissive
   * behaviour: before this existed each guard was *present and wrong*, so a token with no `exp`, no
   * `iss` and no `aud` verified as `authenticated`. A deployment that relaxes one declares it with
   * `--jwt-optional-claim`, and the declaration is the relaxation rather than the requirement, so
   * silence is strict.
   */
  readonly requiredClaims: ReadonlySet<RequiredJwtClaim>;
}

/** Parses a `kid:base64key` spec (the kid is everything before the first `:`). */
export function parseJwksKeySpec(raw: string): JwksKeySpec {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid --jwks-key (expected kid:base64): ${JSON.stringify(raw)}`);
  }
  const publicKeyBase64 = raw.slice(idx + 1);
  // `isEd25519PublicKeyBase64` has existed since this module did and had **zero callers**, while
  // this parser validated nothing past the colon. So a typo'd or truncated key booted cleanly and
  // turned every Bearer request into an `invalid_signature` 401 whose body says only
  // "jwt verification failed" -- a deployment-wide auth outage whose cause is a boot-time
  // measurement nobody took. The key is public, so naming its length in the refusal discloses
  // nothing.
  if (!isEd25519PublicKeyBase64(publicKeyBase64)) {
    throw new Error(
      `invalid --jwks-key: the value after '${raw.slice(0, idx)}:' is not 32 bytes of standard` +
        " base64 (a raw Ed25519 public key)",
    );
  }
  return { kid: raw.slice(0, idx), publicKeyBase64 };
}

/** Builds an in-memory `JwksProvider` from a set of public keys (the IdP's signing keys). */
export function buildJwksProvider(keys: readonly JwksKeySpec[]): JwksProvider {
  return new InMemoryJwksProvider({ keys: keys.map((k) => ({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 })) });
}
