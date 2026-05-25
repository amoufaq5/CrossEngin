import { readFile } from "node:fs/promises";

import { InMemoryJwksProvider, type JwksProvider } from "@crossengin/api-gateway-runtime";

export interface JwksFile {
  readonly keys: ReadonlyArray<{
    readonly kid: string;
    readonly publicKeyBase64: string;
  }>;
}

export class JwksLoadError extends Error {
  readonly kind = "jwks_load_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "JwksLoadError";
  }
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export async function loadJwksFromFile(path: string): Promise<JwksProvider> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new JwksLoadError(
      `failed to read JWKS file '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JwksLoadError(
      `JWKS file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildJwksProvider(parsed, path);
}

export interface LoadJwksFromUrlOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 10_000;

export async function loadJwksFromUrl(
  url: string,
  opts: LoadJwksFromUrlOptions = {},
): Promise<JwksProvider> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JWKS_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    throw new JwksLoadError(
      `failed to fetch JWKS url '${url}': ${
        isTimeout
          ? `request timed out after ${timeoutMs.toString()}ms`
          : err instanceof Error
            ? err.message
            : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new JwksLoadError(`JWKS url '${url}' returned status ${response.status.toString()}`);
  }
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JwksLoadError(
      `JWKS url '${url}' returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildJwksProvider(parsed, url);
}

export function buildJwksProvider(value: unknown, source: string): JwksProvider {
  if (typeof value !== "object" || value === null) {
    throw new JwksLoadError(`JWKS '${source}' must be an object`);
  }
  const obj = value as { keys?: unknown };
  if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
    throw new JwksLoadError(`JWKS '${source}' must contain a non-empty 'keys' array`);
  }
  const keys: Array<{ kid: string; publicKeyBase64: string }> = [];
  for (let i = 0; i < obj.keys.length; i++) {
    keys.push(normalizeJwksEntry(obj.keys[i], i, source));
  }
  return new InMemoryJwksProvider({ keys });
}

export function normalizeJwksEntry(
  entry: unknown,
  index: number,
  source: string,
): { kid: string; publicKeyBase64: string } {
  if (typeof entry !== "object" || entry === null) {
    throw new JwksLoadError(`JWKS '${source}' keys[${index.toString()}] is not an object`);
  }
  const e = entry as Record<string, unknown>;
  const kid = e["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new JwksLoadError(
      `JWKS '${source}' keys[${index.toString()}].kid must be a non-empty string`,
    );
  }
  const native = e["publicKeyBase64"];
  if (typeof native === "string" && native.length > 0) {
    return { kid, publicKeyBase64: native };
  }
  if (e["kty"] === "OKP" && e["crv"] === "Ed25519") {
    const x = e["x"];
    if (typeof x !== "string" || x.length === 0) {
      throw new JwksLoadError(
        `JWKS '${source}' keys[${index.toString()}] has kty=OKP crv=Ed25519 but no 'x' base64url field`,
      );
    }
    if (typeof e["alg"] === "string" && e["alg"] !== "EdDSA") {
      throw new JwksLoadError(
        `JWKS '${source}' keys[${index.toString()}].alg must be 'EdDSA' for OKP/Ed25519 entries (got '${e["alg"]}')`,
      );
    }
    return { kid, publicKeyBase64: base64UrlToBase64(x) };
  }
  throw new JwksLoadError(
    `JWKS '${source}' keys[${index.toString()}] must have either 'publicKeyBase64' (CrossEngin-native) or 'kty=OKP, crv=Ed25519, x=<base64url>' (RFC 7517 Ed25519); other key types are not supported`,
  );
}

export function base64UrlToBase64(value: string): string {
  const replaced = value.replace(/-/g, "+").replace(/_/g, "/");
  const padNeeded = (4 - (replaced.length % 4)) % 4;
  return replaced + "=".repeat(padNeeded);
}

export interface RefreshableJwksProviderOptions {
  readonly initial: JwksProvider;
  readonly loader: () => Promise<JwksProvider>;
  readonly source: string;
}

export class RefreshableJwksProvider implements JwksProvider {
  private inner: JwksProvider;
  private readonly loader: () => Promise<JwksProvider>;
  readonly source: string;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastRefreshError: Error | null = null;
  private lastRefreshedAtMs: number;

  constructor(opts: RefreshableJwksProviderOptions) {
    this.inner = opts.initial;
    this.loader = opts.loader;
    this.source = opts.source;
    this.lastRefreshedAtMs = Date.now();
  }

  async getPublicKeyForKid(kid: string): Promise<string | null> {
    return this.inner.getPublicKeyForKid(kid);
  }

  async refresh(): Promise<void> {
    try {
      const next = await this.loader();
      this.inner = next;
      this.lastRefreshError = null;
      this.lastRefreshedAtMs = Date.now();
    } catch (err) {
      this.lastRefreshError = err instanceof Error ? err : new Error(String(err));
      throw this.lastRefreshError;
    }
  }

  startPeriodicRefresh(opts: {
    readonly intervalMs: number;
    readonly onResult: (result: { ok: boolean; error?: string }) => void;
  }): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      void this.refresh().then(
        () => opts.onResult({ ok: true }),
        (err: unknown) =>
          opts.onResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }, opts.intervalMs);
    this.intervalHandle.unref();
  }

  stopPeriodicRefresh(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  status(): {
    readonly source: string;
    readonly lastRefreshedAtMs: number;
    readonly lastError: string | null;
  } {
    return {
      source: this.source,
      lastRefreshedAtMs: this.lastRefreshedAtMs,
      lastError: this.lastRefreshError?.message ?? null,
    };
  }
}

export interface JwtFlagsResult {
  readonly jwksProvider?: JwksProvider;
  readonly refreshable?: RefreshableJwksProvider;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  readonly clockSkewSeconds?: number;
}

export interface ResolveJwtFlagsInput {
  readonly jwksFile: string | null;
  readonly jwksUrl: string | null;
  readonly jwksRefreshSeconds: string | null;
  readonly jwtIssuer: string | null;
  readonly jwtAudience: string | null;
  readonly clockSkewSeconds: string | null;
  readonly fetch?: FetchLike;
}

export const DEFAULT_JWKS_REFRESH_SECONDS = 300;

export async function resolveJwtFlags(input: ResolveJwtFlagsInput): Promise<JwtFlagsResult> {
  if (input.jwksFile !== null && input.jwksUrl !== null) {
    throw new JwksLoadError("--jwks-file and --jwks-url are mutually exclusive");
  }
  const hasSource = input.jwksFile !== null || input.jwksUrl !== null;
  if (!hasSource) {
    if (
      input.jwtIssuer !== null ||
      input.jwtAudience !== null ||
      input.clockSkewSeconds !== null ||
      input.jwksRefreshSeconds !== null
    ) {
      throw new JwksLoadError(
        "JWT options (--jwt-issuer / --jwt-audience / --clock-skew-seconds / --jwks-refresh-seconds) require --jwks-file or --jwks-url",
      );
    }
    return {};
  }
  if (input.jwtIssuer === null || input.jwtIssuer.length === 0) {
    throw new JwksLoadError("--jwks-file / --jwks-url requires --jwt-issuer");
  }
  if (input.jwtAudience === null || input.jwtAudience.length === 0) {
    throw new JwksLoadError("--jwks-file / --jwks-url requires --jwt-audience");
  }
  let refreshSeconds: number | undefined;
  if (input.jwksRefreshSeconds !== null) {
    const parsed = Number.parseInt(input.jwksRefreshSeconds, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 86_400) {
      throw new JwksLoadError(
        `--jwks-refresh-seconds must be an integer in [0, 86400], got '${input.jwksRefreshSeconds}'`,
      );
    }
    refreshSeconds = parsed;
  }
  let clockSkew: number | undefined;
  if (input.clockSkewSeconds !== null) {
    const parsed = Number.parseInt(input.clockSkewSeconds, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 600) {
      throw new JwksLoadError(
        `--clock-skew-seconds must be an integer in [0, 600], got '${input.clockSkewSeconds}'`,
      );
    }
    clockSkew = parsed;
  }

  let jwksProvider: JwksProvider;
  let refreshable: RefreshableJwksProvider | undefined;
  if (input.jwksFile !== null) {
    if (refreshSeconds !== undefined && refreshSeconds > 0) {
      throw new JwksLoadError(
        "--jwks-refresh-seconds is only supported with --jwks-url (file mode uses SIGHUP for reload)",
      );
    }
    const initial = await loadJwksFromFile(input.jwksFile);
    refreshable = new RefreshableJwksProvider({
      initial,
      loader: () => loadJwksFromFile(input.jwksFile!),
      source: input.jwksFile,
    });
    jwksProvider = refreshable;
  } else {
    const url = input.jwksUrl!;
    const initial = await loadJwksFromUrl(url, { fetch: input.fetch });
    refreshable = new RefreshableJwksProvider({
      initial,
      loader: () => loadJwksFromUrl(url, { fetch: input.fetch }),
      source: url,
    });
    jwksProvider = refreshable;
  }
  return {
    jwksProvider,
    refreshable,
    jwtIssuer: input.jwtIssuer,
    jwtAudience: input.jwtAudience,
    ...(clockSkew !== undefined ? { clockSkewSeconds: clockSkew } : {}),
  };
}
