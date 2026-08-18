import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  verifyChainSignatures,
  verifyChainSuffix,
  verifyStoredChainSignatures,
  type ChainSignatureVerdict,
  type PostgresChainCheckpointStore,
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
  /** `full` folds from genesis; `from_checkpoint` verifies only the suffix after the latest checkpoint. */
  readonly mode: "full" | "from_checkpoint";
  /** The anchoring checkpoint's sequence when `mode === "from_checkpoint"`, else null. */
  readonly checkpointSequence: number | null;
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
  return {
    tenantId,
    ok: integrity.valid && signatures.valid,
    mode: "full",
    checkpointSequence: null,
    integrity,
    signatures,
  };
}

/**
 * Bounded re-verification: verifies ONLY the suffix after the scope's latest persisted checkpoint —
 * integrity from the checkpoint's `rootHash` anchor (not genesis) plus signatures over just those
 * entries — so re-verifying a long chain costs O(entries since the last checkpoint). Falls back to a
 * full verify when no checkpoint exists yet. Trust in the anchor comes from the earlier verification
 * that produced it (ADR-0252/0255); this does not re-fold the prefix.
 */
export async function verifyChainFromCheckpoint(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  checkpoints: PostgresChainCheckpointStore,
  tenantId: string | null,
): Promise<ChainVerificationReport> {
  const checkpoint = await checkpoints.latest(tenantId);
  if (checkpoint === null) {
    return verifyChainFull(reader, registry, tenantId);
  }
  const fromSequence = checkpoint.sequenceNumber + 1;
  const suffix = await reader.loadFrom(tenantId, fromSequence);
  const integrity = verifyChainSuffix(suffix, { fromSequence, priorRootHash: checkpoint.rootHash });
  const signatures = await verifyChainSignatures(suffix, keyRegistryResolver(registry));
  return {
    tenantId,
    ok: integrity.valid && signatures.valid,
    mode: "from_checkpoint",
    checkpointSequence: checkpoint.sequenceNumber,
    integrity,
    signatures,
  };
}

export function formatChainVerification(report: ChainVerificationReport): string {
  const scope = report.tenantId ?? "platform";
  const lines: string[] = [];
  const anchor =
    report.mode === "from_checkpoint"
      ? ` [from checkpoint seq ${String(report.checkpointSequence)}]`
      : " [full]";
  lines.push(`chain verification: ${scope}${anchor} — ${report.ok ? "OK" : "FAILED"}`);
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
