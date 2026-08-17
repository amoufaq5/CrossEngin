import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  verifyStoredChainSignatures,
  type ChainSignatureVerdict,
  type PostgresChainLogReader,
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
 * registry-backed signature check over a signer-free reader: load the chain, resolve each entry's
 * signing fingerprint to its registered public key, and verify the signature.
 */
export function verifyChainSignaturesAgainstRegistry(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): Promise<ChainSignatureVerdict> {
  return verifyStoredChainSignatures(reader, tenantId, keyRegistryResolver(registry));
}

export interface ChainVerificationReport {
  readonly tenantId: string | null;
  readonly ok: boolean;
  readonly integrity: { readonly valid: boolean; readonly brokenAt: number | null; readonly reason?: string };
  readonly signatures: ChainSignatureVerdict;
}

/**
 * The full audit-chain verification a `verify-chain` command runs over a signer-free reader: hash-chain
 * integrity (fold from genesis) AND per-entry signatures resolved through the key registry. `ok` requires
 * both.
 */
export async function verifyChainFull(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): Promise<ChainVerificationReport> {
  const integrity = await reader.verify(tenantId);
  const signatures = await verifyChainSignaturesAgainstRegistry(reader, registry, tenantId);
  return { tenantId, ok: integrity.valid && signatures.valid, integrity, signatures };
}

export function formatChainVerification(report: ChainVerificationReport): string {
  const scope = report.tenantId ?? "platform";
  const lines: string[] = [];
  lines.push(`chain verification: ${scope} — ${report.ok ? "OK" : "FAILED"}`);
  lines.push(
    `  integrity: ${report.integrity.valid ? "valid" : `BROKEN at ${String(report.integrity.brokenAt)}` +
      (report.integrity.reason ? ` (${report.integrity.reason})` : "")}`,
  );
  lines.push(
    `  signatures: ${report.signatures.valid ? "valid" : "INVALID"} (${report.signatures.checked.toString()} checked)`,
  );
  const bad = report.signatures.results.filter((r) => !r.ok);
  for (const r of bad) {
    lines.push(`    seq ${r.sequenceNumber.toString()}: ${r.reason ?? "invalid"} (fp ${r.fingerprint.slice(0, 12)})`);
  }
  if (report.signatures.unresolvedFingerprints.length > 0) {
    lines.push(`    unresolved keys: ${report.signatures.unresolvedFingerprints.length.toString()}`);
  }
  return lines.join("\n");
}
