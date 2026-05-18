import { readFile } from "node:fs/promises";

import {
  InMemoryJwksProvider,
  type JwksProvider,
} from "@crossengin/api-gateway-runtime";

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
    const entry = obj.keys[i] as Record<string, unknown> | undefined;
    if (typeof entry !== "object" || entry === null) {
      throw new JwksLoadError(`JWKS '${source}' keys[${i.toString()}] is not an object`);
    }
    const kid = entry["kid"];
    const pub = entry["publicKeyBase64"];
    if (typeof kid !== "string" || kid.length === 0) {
      throw new JwksLoadError(`JWKS '${source}' keys[${i.toString()}].kid must be a non-empty string`);
    }
    if (typeof pub !== "string" || pub.length === 0) {
      throw new JwksLoadError(
        `JWKS '${source}' keys[${i.toString()}].publicKeyBase64 must be a non-empty string`,
      );
    }
    keys.push({ kid, publicKeyBase64: pub });
  }
  return new InMemoryJwksProvider({ keys });
}

export interface JwtFlagsResult {
  readonly jwksProvider?: JwksProvider;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  readonly clockSkewSeconds?: number;
}

export interface ResolveJwtFlagsInput {
  readonly jwksFile: string | null;
  readonly jwtIssuer: string | null;
  readonly jwtAudience: string | null;
  readonly clockSkewSeconds: string | null;
}

export async function resolveJwtFlags(
  input: ResolveJwtFlagsInput,
): Promise<JwtFlagsResult> {
  if (input.jwksFile === null) {
    if (
      input.jwtIssuer !== null ||
      input.jwtAudience !== null ||
      input.clockSkewSeconds !== null
    ) {
      throw new JwksLoadError(
        "JWT options (--jwt-issuer / --jwt-audience / --clock-skew-seconds) require --jwks-file",
      );
    }
    return {};
  }
  if (input.jwtIssuer === null || input.jwtIssuer.length === 0) {
    throw new JwksLoadError("--jwks-file requires --jwt-issuer");
  }
  if (input.jwtAudience === null || input.jwtAudience.length === 0) {
    throw new JwksLoadError("--jwks-file requires --jwt-audience");
  }
  const jwksProvider = await loadJwksFromFile(input.jwksFile);
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
  return {
    jwksProvider,
    jwtIssuer: input.jwtIssuer,
    jwtAudience: input.jwtAudience,
    ...(clockSkew !== undefined ? { clockSkewSeconds: clockSkew } : {}),
  };
}
