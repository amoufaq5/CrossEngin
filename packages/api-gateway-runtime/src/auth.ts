import {
  type AuthOutcome,
  type AuthScheme,
  type IncomingRequest,
  type ParsedAuthCredential,
  type ResolvedPrincipal,
} from "@crossengin/api-gateway";
import { constantTimeEqualHex, sha256, verifyEd25519 } from "@crossengin/crypto";

import type { PrincipalResolver } from "./stores.js";

export interface ParsedJwt {
  readonly headerB64: string;
  readonly payloadB64: string;
  readonly signatureB64: string;
  readonly header: { readonly alg: string; readonly kid?: string; readonly typ?: string };
  readonly payload: {
    readonly iss?: string;
    readonly aud?: string | readonly string[];
    readonly sub?: string;
    readonly exp?: number;
    readonly iat?: number;
    readonly nbf?: number;
    readonly scope?: string;
    readonly scp?: readonly string[];
    readonly tenant_id?: string;
    readonly [k: string]: unknown;
  };
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function safeJsonParse(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const headerObj = safeJsonParse(base64UrlDecode(headerB64));
  if (headerObj === null) return null;
  if (typeof headerObj["alg"] !== "string") return null;
  const payloadObj = safeJsonParse(base64UrlDecode(payloadB64));
  if (payloadObj === null) return null;
  return {
    headerB64,
    payloadB64,
    signatureB64,
    header: {
      alg: headerObj["alg"],
      kid: typeof headerObj["kid"] === "string" ? headerObj["kid"] : undefined,
      typ: typeof headerObj["typ"] === "string" ? headerObj["typ"] : undefined,
    },
    payload: payloadObj as ParsedJwt["payload"],
  };
}

export interface JwksProvider {
  getPublicKeyForKid(kid: string): Promise<string | null>;
}

export interface InMemoryJwksOptions {
  readonly keys: ReadonlyArray<{ readonly kid: string; readonly publicKeyBase64: string }>;
}

export class InMemoryJwksProvider implements JwksProvider {
  private readonly keys: Map<string, string>;
  constructor(opts: InMemoryJwksOptions) {
    this.keys = new Map();
    for (const k of opts.keys) {
      this.keys.set(k.kid, k.publicKeyBase64);
    }
  }
  async getPublicKeyForKid(kid: string): Promise<string | null> {
    return this.keys.get(kid) ?? null;
  }
}

export interface JwtVerificationOptions {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly clockSkewSeconds: number;
  readonly nowSeconds: number;
}

export interface JwtVerificationResult {
  readonly outcome: AuthOutcome;
  readonly reason?: string;
  readonly jwt?: ParsedJwt;
}

export async function verifyBearerJwt(input: {
  readonly token: string;
  readonly jwks: JwksProvider;
  readonly opts: JwtVerificationOptions;
}): Promise<JwtVerificationResult> {
  const jwt = parseJwt(input.token);
  if (jwt === null) {
    return { outcome: "credential_malformed", reason: "jwt is not a 3-part dot-separated string" };
  }
  if (jwt.header.alg !== "EdDSA") {
    return {
      outcome: "credential_malformed",
      reason: `unsupported alg ${jwt.header.alg}; only EdDSA is accepted`,
    };
  }
  if (jwt.header.kid === undefined) {
    return { outcome: "credential_malformed", reason: "jwt header missing 'kid'" };
  }
  const publicKey = await input.jwks.getPublicKeyForKid(jwt.header.kid);
  if (publicKey === null) {
    return { outcome: "credential_not_found", reason: `no public key for kid ${jwt.header.kid}` };
  }
  const signedPayload = new TextEncoder().encode(`${jwt.headerB64}.${jwt.payloadB64}`);
  const signatureBase64 = Buffer.from(base64UrlDecode(jwt.signatureB64)).toString("base64");
  if (!verifyEd25519(publicKey, signatureBase64, signedPayload)) {
    return { outcome: "invalid_signature", reason: "ed25519 signature did not verify" };
  }
  if (
    typeof jwt.payload.exp === "number" &&
    jwt.payload.exp + input.opts.clockSkewSeconds < input.opts.nowSeconds
  ) {
    return { outcome: "expired_token", reason: "exp is in the past" };
  }
  if (
    typeof jwt.payload.nbf === "number" &&
    jwt.payload.nbf - input.opts.clockSkewSeconds > input.opts.nowSeconds
  ) {
    return { outcome: "not_yet_valid_token", reason: "nbf is in the future" };
  }
  if (typeof jwt.payload.iss === "string" && jwt.payload.iss !== input.opts.expectedIssuer) {
    return {
      outcome: "issuer_mismatch",
      reason: `iss ${jwt.payload.iss} does not match expected ${input.opts.expectedIssuer}`,
    };
  }
  const aud = jwt.payload.aud;
  const audOk =
    typeof aud === "string"
      ? aud === input.opts.expectedAudience
      : Array.isArray(aud) && aud.includes(input.opts.expectedAudience);
  if (aud !== undefined && !audOk) {
    return { outcome: "audience_mismatch", reason: "aud does not include expected audience" };
  }
  return { outcome: "authenticated", jwt };
}

export interface ParseAuthHeaderResult {
  readonly scheme: AuthScheme | null;
  readonly token: string | null;
  readonly raw: string | null;
}

export function parseAuthHeader(request: IncomingRequest): ParseAuthHeaderResult {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const trimmed = header.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("bearer ")) {
      return { scheme: "bearer_jwt", token: trimmed.slice(7).trim(), raw: trimmed };
    }
    if (lower.startsWith("basic ")) {
      return { scheme: "basic", token: trimmed.slice(6).trim(), raw: trimmed };
    }
  }
  const apiKeyHeader = request.headers["x-api-key"];
  if (apiKeyHeader !== undefined) {
    return { scheme: "api_key_header", token: apiKeyHeader.trim(), raw: apiKeyHeader.trim() };
  }
  if (header !== undefined) {
    return { scheme: null, token: null, raw: header.trim() };
  }
  return { scheme: null, token: null, raw: null };
}

export interface ResolvePrincipalInput {
  readonly request: IncomingRequest;
  readonly scheme: AuthScheme;
  readonly principalRef: string;
  readonly scopes: readonly string[];
  readonly resolver: PrincipalResolver;
  readonly nowIso: string;
}

export async function resolvePrincipalForCredential(
  input: ResolvePrincipalInput,
): Promise<{ readonly principal: ResolvedPrincipal | null; readonly outcome: AuthOutcome }> {
  const resolved = await input.resolver.resolve({
    tenantId: input.request.tenantHint ?? null,
    principalRef: input.principalRef,
    scopes: input.scopes,
    authScheme: input.scheme,
  });
  if (resolved === null) {
    return { principal: null, outcome: "principal_not_found" };
  }
  return {
    principal: { ...resolved, authScheme: input.scheme, resolvedAt: input.nowIso },
    outcome: "authenticated",
  };
}

export function buildOpaqueCredentialMatcher(
  opaqueTokenSha256: string,
): (presented: string) => boolean {
  return (presented: string) => constantTimeEqualHex(sha256(presented), opaqueTokenSha256);
}

export type { ParsedAuthCredential };
