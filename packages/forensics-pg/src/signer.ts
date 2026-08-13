import type { KeyRecord, KeyStore } from "@crossengin/crypto";

/**
 * The signing capability the chain store needs, decoupled from any particular key backend: a stable
 * fingerprint (recorded on every entry) plus a sign function over the canonical entry bytes.
 */
export interface ChainSigner {
  readonly fingerprint: string;
  sign(canonicalBytes: Uint8Array): Promise<string>;
}

/**
 * Adapts a crypto `KeyStore` + an `evidence_sealing` Ed25519 key record into a `ChainSigner`. Enforces
 * the same algorithm/purpose guard the forensics chain builder does, so a mis-scoped key fails at wiring
 * time, not on first append.
 */
export function keyStoreChainSigner(
  store: KeyStore,
  record: KeyRecord,
  tenantId: string | null,
): ChainSigner {
  if (record.handle.algorithm !== "ed25519") {
    throw new Error(
      `chain signing requires an ed25519 key, got ${record.handle.algorithm}`,
    );
  }
  if (record.handle.purpose !== "evidence_sealing") {
    throw new Error(
      `chain signing requires an evidence_sealing key, got purpose ${record.handle.purpose}`,
    );
  }
  if (record.fingerprint === null) {
    throw new Error("chain signing key has no public fingerprint");
  }
  return {
    fingerprint: record.fingerprint,
    sign: (bytes) => store.signWith(record.handle, tenantId, bytes),
  };
}
