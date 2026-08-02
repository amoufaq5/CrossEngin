import { z } from "zod";

import { signEd25519, verifyEd25519 } from "@crossengin/crypto";

import type { Entitlement, EntitlementResolver, EntitlementStatus } from "./entitlement.js";

const ENTITLEMENT_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "unpaid",
  "incomplete",
] as const satisfies readonly EntitlementStatus[];

/**
 * The verifiable payload of an offline license token. A cloud-signed set of claims that a
 * local/on-prem deployment can validate without calling a billing API — Ed25519 over a
 * canonical-JSON payload proves authenticity + integrity, `expiresAt` bounds its lifetime.
 */
export const LicenseClaimsSchema = z.object({
  tenantId: z.string().min(1),
  status: z.enum(ENTITLEMENT_STATUSES),
  planId: z.string().min(1).optional(),
  features: z.array(z.string()).optional(),
  maxRecordsPerEntity: z.number().int().nonnegative().optional(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type LicenseClaims = z.infer<typeof LicenseClaimsSchema>;

/**
 * Deterministic JSON serialization: object keys are emitted in sorted order recursively, so
 * the same claims always canonicalize to the same string (and thus the same signature),
 * regardless of construction order. Arrays keep their order; primitives pass through.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** base64url-encode a UTF-8 string: standard base64 with `+`→`-`, `/`→`_`, padding stripped. */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** base64url-decode back to a UTF-8 string. Returns null on malformed input. */
export function b64urlDecode(encoded: string): string | null {
  if (!/^[A-Za-z0-9\-_]*$/.test(encoded)) return null;
  let padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Produce a signed license token `"<payload>.<signature>"` where payload is the
 * base64url-encoded canonical JSON of the claims and signature is the base64 Ed25519
 * signature over that payload *string*.
 */
export function signLicense(privateKeyBase64: string, publicKeyBase64: string, claims: LicenseClaims): string {
  const payload = b64urlEncode(canonicalJson(claims));
  const signature = signEd25519(privateKeyBase64, publicKeyBase64, payload);
  return `${payload}.${signature}`;
}

/** Split a token into its payload + signature halves, or null when malformed. */
export function parseLicenseToken(token: string): { payload: string; signature: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return null;
  return { payload: token.slice(0, dot), signature: token.slice(dot + 1) };
}

export type LicenseVerification =
  | { valid: true; claims: LicenseClaims }
  | { valid: false; reason: "malformed_token" | "bad_signature" | "malformed_claims" | "expired" };

/**
 * Verify a license token offline. Checks (in order): well-formed token, Ed25519 signature over
 * the payload, decodable + schema-valid claims, and non-expiry against `now` (default: current
 * time). Each failure carries a machine-readable reason; success returns the parsed claims.
 */
export function verifyLicense(
  token: string,
  publicKeyBase64: string,
  now: Date = new Date(),
): LicenseVerification {
  const parsed = parseLicenseToken(token);
  if (parsed === null) return { valid: false, reason: "malformed_token" };

  if (!verifyEd25519(publicKeyBase64, parsed.signature, parsed.payload)) {
    return { valid: false, reason: "bad_signature" };
  }

  const json = b64urlDecode(parsed.payload);
  if (json === null) return { valid: false, reason: "malformed_claims" };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { valid: false, reason: "malformed_claims" };
  }

  const result = LicenseClaimsSchema.safeParse(raw);
  if (!result.success) return { valid: false, reason: "malformed_claims" };

  const claims = result.data;
  if (now.getTime() >= Date.parse(claims.expiresAt)) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, claims };
}

/**
 * An `EntitlementResolver` backed by a single offline-verifiable license token. `resolve`
 * re-verifies the token on every call (so an expiring license fails closed the moment the
 * clock passes `expiresAt`) and only yields an entitlement when the token is valid *and* its
 * `tenantId` claim matches the requesting tenant; otherwise null, and the subscription gate
 * denies. Suitable for on-prem deployments with no billing-API reachability.
 */
export class LicenseEntitlementResolver implements EntitlementResolver {
  private readonly token: string;
  private readonly pub: string;
  private readonly clock?: { now(): Date };

  constructor(token: string, publicKeyBase64: string, clock?: { now(): Date }) {
    this.token = token;
    this.pub = publicKeyBase64;
    this.clock = clock;
  }

  async resolve(tenantId: string): Promise<Entitlement | null> {
    const verification = verifyLicense(this.token, this.pub, this.clock?.now());
    if (!verification.valid) return null;

    const claims = verification.claims;
    if (claims.tenantId !== tenantId) return null;

    const entitlement: {
      status: EntitlementStatus;
      planId?: string;
      features?: readonly string[];
      maxRecordsPerEntity?: number;
    } = { status: claims.status };
    if (claims.planId !== undefined) entitlement.planId = claims.planId;
    if (claims.features !== undefined) entitlement.features = claims.features;
    if (claims.maxRecordsPerEntity !== undefined) entitlement.maxRecordsPerEntity = claims.maxRecordsPerEntity;
    return entitlement;
  }
}
