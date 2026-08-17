import {
  verifyChainEntrySignature,
  type ChainedLogEntry,
} from "@crossengin/forensics";

import type { PostgresChainLogReader } from "./chain-log-store.js";

/**
 * Resolves a signing-key fingerprint to its base64 Ed25519 public key, or null when the fingerprint
 * is unknown. A thin adapter over `@crossengin/crypto-pg`'s `PostgresKeyRegistry` satisfies this —
 * `{ resolveByFingerprint: async (fp) => (await registry.getByFingerprint(fp))?.publicKeyBase64 ?? null }`
 * — kept as a structural interface here so forensics-pg stays decoupled from crypto-pg.
 */
export interface PublicKeyResolver {
  resolveByFingerprint(fingerprint: string): Promise<string | null>;
}

export interface EntrySignatureResult {
  readonly sequenceNumber: number;
  readonly fingerprint: string;
  readonly ok: boolean;
  readonly reason?: "unresolved_key" | "bad_signature";
}

export interface ChainSignatureVerdict {
  readonly valid: boolean;
  readonly checked: number;
  readonly results: readonly EntrySignatureResult[];
  readonly unresolvedFingerprints: readonly string[];
}

export async function verifyChainSignatures(
  entries: readonly ChainedLogEntry[],
  resolver: PublicKeyResolver,
): Promise<ChainSignatureVerdict> {
  const cache = new Map<string, string | null>();
  const results: EntrySignatureResult[] = [];
  const unresolved: string[] = [];
  let allOk = true;

  for (const entry of entries) {
    const fingerprint = entry.signingKeyFingerprint;
    let publicKey = cache.get(fingerprint);
    if (publicKey === undefined) {
      publicKey = await resolver.resolveByFingerprint(fingerprint);
      cache.set(fingerprint, publicKey);
    }

    if (publicKey === null) {
      allOk = false;
      results.push({
        sequenceNumber: entry.sequenceNumber,
        fingerprint,
        ok: false,
        reason: "unresolved_key",
      });
      if (!unresolved.includes(fingerprint)) unresolved.push(fingerprint);
      continue;
    }

    const ok = verifyChainEntrySignature(entry, publicKey);
    if (!ok) allOk = false;
    results.push({
      sequenceNumber: entry.sequenceNumber,
      fingerprint,
      ok,
      ...(ok ? {} : { reason: "bad_signature" as const }),
    });
  }

  return {
    valid: allOk,
    checked: entries.length,
    results,
    unresolvedFingerprints: unresolved,
  };
}

export async function verifyStoredChainSignatures(
  reader: PostgresChainLogReader,
  tenantId: string | null,
  resolver: PublicKeyResolver,
): Promise<ChainSignatureVerdict> {
  const entries = await reader.loadChain(tenantId);
  return verifyChainSignatures(entries, resolver);
}
