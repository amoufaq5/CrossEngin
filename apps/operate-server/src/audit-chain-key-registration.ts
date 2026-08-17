import { ed25519PublicKeyFingerprint } from "@crossengin/crypto";
import {
  KeyRegistryRecordSchema,
  PostgresKeyRegistry,
  type KeyRegistryRecord,
} from "@crossengin/crypto-pg";

import type { AuditChainConfig } from "./audit-chain.js";

// Crockford base32, uppercase. This alphabet is exactly the `crypto_keys.key_id` regex char class
// `[0-9A-HJKMNP-TV-Z]` (I, L, O, U excluded), so 26 symbols from it always satisfy the key_id check.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface AuditChainKeyRegistrationOptions {
  readonly tenantId?: string | null;
  readonly keyId?: string;
  readonly now?: () => Date;
}

/**
 * Deterministic, stable registry key id for a sealing key, derived from its fingerprint so the same key
 * always maps to the same `key_id` across restarts (making registration idempotent — register upserts on
 * key_id). The fingerprint is a 64-hex-char (256-bit) sha256; its leading 130 bits encode to exactly 26
 * Crockford-uppercase base32 chars (26 × 5 = 130), matching the `key_ed25519_<26 chars>` key_id shape.
 */
export function deriveAuditChainKeyId(fingerprintHex: string): string {
  const hexPrefix = fingerprintHex.slice(0, 33).padEnd(33, "0");
  const bits132 = BigInt(`0x${hexPrefix}`);
  let value = bits132 >> 2n;
  const chars: string[] = new Array<string>(26);
  for (let i = 25; i >= 0; i -= 1) {
    chars[i] = CROCKFORD.charAt(Number(value & 0x1fn));
    value >>= 5n;
  }
  return `key_ed25519_${chars.join("")}`;
}

/**
 * Builds the public/lifecycle registry record for the audit chain's Ed25519 sealing key. Only PUBLIC
 * material is registered — the public key, its fingerprint, and metadata — never the private key.
 */
export function auditChainKeyRegistryRecord(
  config: Pick<AuditChainConfig, "publicKeyBase64">,
  opts: AuditChainKeyRegistrationOptions = {},
): KeyRegistryRecord {
  const fingerprint = ed25519PublicKeyFingerprint(config.publicKeyBase64);
  const keyId = opts.keyId ?? deriveAuditChainKeyId(fingerprint);
  const createdAt = (opts.now ?? (() => new Date()))().toISOString();
  return KeyRegistryRecordSchema.parse({
    keyId,
    tenantId: opts.tenantId ?? null,
    algorithm: "ed25519",
    purpose: "evidence_sealing",
    publicKeyBase64: config.publicKeyBase64,
    fingerprint,
    keyVersion: 1,
    status: "active",
    createdAt,
  });
}

/**
 * Registers the audit chain's sealing public key into `meta.crypto_keys` via the platform key registry so
 * a chain entry's `signingKeyFingerprint` resolves to a registered public key for verification, and the
 * key's lifecycle is tracked. Idempotent by construction (register upserts on the deterministic key_id).
 */
export async function registerAuditChainKey(
  registry: PostgresKeyRegistry,
  config: Pick<AuditChainConfig, "publicKeyBase64">,
  opts: AuditChainKeyRegistrationOptions = {},
): Promise<KeyRegistryRecord> {
  const record = auditChainKeyRegistryRecord(config, opts);
  await registry.register(record);
  return record;
}
