import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  verifyStoredChainSignatures,
  type ChainSignatureVerdict,
  type PostgresChainLogStore,
  type PublicKeyResolver,
} from "@crossengin/forensics-pg";

/**
 * A forensics-pg `PublicKeyResolver` backed by the crypto-pg key registry: it resolves a chain entry's
 * `signingKeyFingerprint` to the registered public key, so historical audit-chain signatures can be
 * verified against the platform key registry rather than a locally-held key. Returns `null` for an
 * unknown fingerprint (verification then reports it as an unresolved key).
 */
export function keyRegistryResolver(registry: PostgresKeyRegistry): PublicKeyResolver {
  return {
    resolveByFingerprint: async (fingerprint) =>
      (await registry.getByFingerprint(fingerprint))?.publicKeyBase64 ?? null,
  };
}

/**
 * Verifies every entry of a scope's stored audit chain against the crypto-pg key registry — the
 * end-to-end registry-backed check: load the chain, resolve each entry's signing fingerprint to its
 * registered public key, and verify the signature.
 */
export function verifyChainAgainstRegistry(
  store: PostgresChainLogStore,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): Promise<ChainSignatureVerdict> {
  return verifyStoredChainSignatures(store, tenantId, keyRegistryResolver(registry));
}
