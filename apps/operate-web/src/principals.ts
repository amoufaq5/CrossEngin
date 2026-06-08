import { createHash } from "node:crypto";

import { verifyBearerJwt, type JwksProvider } from "@crossengin/api-gateway-runtime";

import { headerValue, type RawWebRequest } from "./http.js";

/** One API key → (role, tenant) binding the web server authenticates against. */
export interface ApiKeySpec {
  readonly key: string;
  readonly role: string;
  readonly tenantId: string;
}

/** The authenticated caller a dispatch runs as. */
export interface WebViewer {
  readonly roles: readonly string[];
  readonly tenantId: string;
}

/** Parses a `key:role:tenant` spec; throws on a malformed / empty field. */
export function parseApiKeySpec(raw: string): ApiKeySpec {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error(`invalid --api-key (expected key:role:tenant): ${JSON.stringify(raw)}`);
  }
  const [key, role, tenantId] = parts;
  if (!key || !role || !tenantId) {
    throw new Error(`invalid --api-key (empty field): ${JSON.stringify(raw)}`);
  }
  return { key, role, tenantId };
}

/**
 * A fail-closed API-key registry. A request authenticates with an `x-api-key`
 * header (or `Authorization: Bearer <key>`); an unknown / missing token resolves
 * to null → 401.
 */
export class ApiKeyRegistry {
  private readonly byKey: Map<string, ApiKeySpec> = new Map();

  constructor(specs: readonly ApiKeySpec[]) {
    for (const spec of specs) this.byKey.set(spec.key, spec);
  }

  /** Extracts the bearer/api-key token from a request, or null. */
  static tokenFrom(req: RawWebRequest): string | null {
    const apiKey = headerValue(req.headers, "x-api-key");
    if (apiKey !== null && apiKey.length > 0) return apiKey;
    const auth = headerValue(req.headers, "authorization");
    if (auth !== null && auth.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      return token.length > 0 ? token : null;
    }
    return null;
  }

  /** Resolves a request to a viewer, or null when the token is unknown/absent. */
  resolve(req: RawWebRequest): WebViewer | null {
    const token = ApiKeyRegistry.tokenFrom(req);
    if (token === null) return null;
    const spec = this.byKey.get(token);
    if (spec === undefined) return null;
    return { roles: [spec.role], tenantId: spec.tenantId };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maps a JWT subject to a UUID: a UUID `sub` is used as-is; any other `sub` is
 * hashed into a stable (v5-shaped) UUID, so an IdP's opaque subject still yields
 * a valid identifier. Mirrors `apps/operate-server`'s `subjectToUuid`.
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
 * Derives the viewer's roles from a JWT's claims. Scopes are the source of the
 * UI's roles (the view-model compiler keys redaction off `ViewerContext.roles`):
 * an explicit `roles` array claim wins, else the OIDC `scope` (space-delimited
 * string) / `scp` (array) claim, else `[]` (a roleless viewer sees only public
 * fields — fail-closed).
 */
export function scopesToRoles(payload: {
  readonly roles?: unknown;
  readonly scope?: unknown;
  readonly scp?: unknown;
}): readonly string[] {
  if (Array.isArray(payload.roles)) {
    const roles = payload.roles.filter((r): r is string => typeof r === "string");
    if (roles.length > 0) return roles;
  }
  if (typeof payload.scope === "string" && payload.scope.length > 0) {
    return payload.scope.split(/\s+/).filter((s) => s.length > 0);
  }
  if (Array.isArray(payload.scp)) {
    return payload.scp.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** One JWKS public key: a `kid` → base64 Ed25519 public key (the verify format). */
export interface JwksKeySpec {
  readonly kid: string;
  readonly publicKeyBase64: string;
}

/** Production identity config: a JWKS provider + the expected issuer/audience. */
export interface JwtVerifyConfig {
  readonly jwksProvider: JwksProvider;
  readonly issuer: string;
  readonly audience: string;
  /** Allowed clock skew when checking exp/nbf (default 60s). */
  readonly clockSkewSeconds?: number;
}

/** Parses a `kid:base64key` spec (the kid is everything before the first `:`). */
export function parseJwksKeySpec(raw: string): JwksKeySpec {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid --jwks-key (expected kid:base64): ${JSON.stringify(raw)}`);
  }
  return { kid: raw.slice(0, idx), publicKeyBase64: raw.slice(idx + 1) };
}

/**
 * Resolves a request to a `WebViewer`, or null when it can't be authenticated
 * (fail-closed → the server turns null into a 401). A registered `x-api-key` /
 * Bearer **api key** wins; otherwise, when a `JwtVerifyConfig` is wired, a Bearer
 * token is verified as an EdDSA JWT against the JWKS (signature + iss/aud/exp/nbf
 * via `@crossengin/api-gateway-runtime`'s `verifyBearerJwt`), and its claims
 * become the viewer statelessly: scopes → roles, `sub` → a UUID, tenant from the
 * `tenant_id` claim (else the `x-tenant-id` header). Dev (api-key) and prod (JWT)
 * auth coexist behind one resolver.
 */
export class WebPrincipalResolver {
  private readonly apiKeys: ApiKeyRegistry;
  private readonly jwt: JwtVerifyConfig | null;
  private readonly now: () => Date;

  constructor(opts: {
    readonly apiKeys: ApiKeyRegistry;
    readonly jwt?: JwtVerifyConfig;
    readonly now?: () => Date;
  }) {
    this.apiKeys = opts.apiKeys;
    this.jwt = opts.jwt ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  async resolve(req: RawWebRequest): Promise<WebViewer | null> {
    const apiKeyViewer = this.apiKeys.resolve(req);
    if (apiKeyViewer !== null) return apiKeyViewer;
    if (this.jwt === null) return null;
    const token = ApiKeyRegistry.tokenFrom(req);
    if (token === null) return null;
    // A JWT is a 3-part dot-separated string; an opaque api key isn't.
    if (token.split(".").length !== 3) return null;
    const result = await verifyBearerJwt({
      token,
      jwks: this.jwt.jwksProvider,
      opts: {
        expectedIssuer: this.jwt.issuer,
        expectedAudience: this.jwt.audience,
        clockSkewSeconds: this.jwt.clockSkewSeconds ?? 60,
        nowSeconds: Math.floor(this.now().getTime() / 1000),
      },
    });
    if (result.outcome !== "authenticated" || result.jwt === undefined) return null;
    const payload = result.jwt.payload;
    const headerTenant = headerValue(req.headers, "x-tenant-id");
    const claimTenant = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
    const tenantId = claimTenant ?? headerTenant;
    if (tenantId === null) return null; // can't scope reads without a tenant — fail-closed
    return { roles: scopesToRoles(payload), tenantId };
  }
}
