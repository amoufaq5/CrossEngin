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
