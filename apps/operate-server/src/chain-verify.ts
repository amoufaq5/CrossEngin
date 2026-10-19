import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import { checkpointAnchorsBoundedProof, verifyChainIntegrity } from "@crossengin/forensics";
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
 *
 * `tenantId` is the scope of the **chain being verified**, and it is now passed rather than left to
 * whatever the connection's role happens to see. `getByFingerprint` carries a scope predicate beside
 * RLS, and its tenant arm is `tenant_id = $n OR tenant_id IS NULL` — so a tenant's chain resolves
 * against that tenant's keys and the platform's, while a platform chain resolves against the
 * platform's alone. Unscoped, as the table's owner, a platform entry could be verified by a key any
 * tenant had registered, which is the forgery route `app.platform_key_write` exists to close.
 */
export function keyRegistryResolver(
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): PublicKeyResolver {
  return {
    resolveByFingerprint: async (fingerprint) =>
      (await registry.getByFingerprint(fingerprint, tenantId))?.publicKeyBase64 ?? null,
  };
}

/**
 * Verifies every entry of a scope's stored audit chain against the crypto-pg key registry — the
 * registry-backed signature check over a signer-free reader: load the chain, resolve each entry's
 * signing fingerprint to its registered public key, and verify the signature.
 *
 * The **store-reading** form, and the only one a caller outside this module has (it is re-exported
 * from `index.ts`). `foldFromGenesis` no longer uses it: it loads the chain once and runs the pure
 * `verifyChainSignatures` over that array, because asking this beside `reader.verify` read the table
 * twice for one fold.
 */
export function verifyChainSignaturesAgainstRegistry(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): Promise<ChainSignatureVerdict> {
  return verifyStoredChainSignatures(reader, tenantId, keyRegistryResolver(registry, tenantId));
}

/**
 * Why a report folded from genesis. `mode: "full"` alone cannot say, and the four facts it conflates
 * have different remedies: a caller that asked for a full fold has nothing to fix, a scope with no
 * checkpoint heals on the next scheduler pass, and an anchor the bounded path *declined* is a
 * finding.
 *
 * **Neither declining reason can come from `CheckpointScheduler`**, the workspace's only checkpoint
 * writer: it derives the provenance from the verification that cleared the anchor, so it writes only
 * `verified_full`/`verified_suffix`, and on a refused verification it writes no row at all. That is
 * deliberate rather than an omission — the store is append-only
 * (`ON CONFLICT (tenant_id, sequence_number) DO NOTHING` over an `INSERT`-arm-only platform table,
 * ADR-0332), so an `unverified` row at the tail would hold that sequence against the later good
 * anchor and turn a transient refusal into a permanent full fold whose only remedy is waiting for
 * the chain to grow (ADR-0334: a remedy that cannot work is worse than none).
 *
 * So `anchor_unverified` is reachable from a **hand-placed** anchor — `CheckpointMeta.provenance` is
 * required, so a caller placing one with no verification in hand has to declare that — while
 * `anchor_provenance_absent` is a row whose columns do not cover the question because an older
 * binary wrote it. The two stay apart for ADR-0331's reason: the first is somebody's claim about the
 * prefix, the second is a gap, and only a claim is a finding.
 */
export const CHAIN_FULL_REASONS = [
  "requested",
  "no_checkpoint",
  "anchor_unverified",
  "anchor_provenance_absent",
] as const;
export type ChainFullReason = (typeof CHAIN_FULL_REASONS)[number];

/**
 * What each reason prints. A total map so a fifth reason is a compile error here rather than one
 * that renders as nothing — which is what `Record<ChainFullReason, string>` buys and the whole of
 * it: a *missing* key will not compile, and an **empty** one compiles, renders `[full: ]` and is
 * caught only by the test asserting each phrase is non-empty. The type cannot say it; the comment
 * used to claim it did.
 */
export const CHAIN_FULL_REASON_PHRASES: Record<ChainFullReason, string> = {
  requested: "requested",
  no_checkpoint: "no checkpoint for this scope",
  anchor_unverified: "anchor records no verified prefix",
  anchor_provenance_absent: "anchor predates provenance",
};

export interface ChainVerificationReport {
  readonly tenantId: string | null;
  readonly ok: boolean;
  /** `full` folds from genesis; `from_checkpoint` verifies only the suffix after the latest checkpoint. */
  readonly mode: "full" | "from_checkpoint";
  /**
   * Why `mode` is `full`, and `null` exactly when it is `from_checkpoint`. Required, because "full"
   * on its own cannot distinguish a caller who asked for a full fold from a bounded verification
   * that refused its anchor — and the second is the one an operator has to act on.
   */
  readonly fullBecause: ChainFullReason | null;
  /** The anchoring checkpoint's sequence when `mode === "from_checkpoint"`, else null. */
  readonly checkpointSequence: number | null;
  readonly integrity: { readonly valid: boolean; readonly brokenAt: number | null; readonly reason?: string };
  readonly signatures: ChainSignatureVerdict;
}

/**
 * The fold from genesis, with the reason it is being run **required**: it is the one input a caller
 * could get wrong, and reporting `requested` for an anchor the bounded path declined is precisely
 * the conflation `fullBecause` exists to end. `verifyChainFull`'s exported signature is unchanged,
 * so the reason cannot be forgotten at the call sites that have no choice to make.
 */
async function foldFromGenesis(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
  fullBecause: ChainFullReason,
): Promise<ChainVerificationReport> {
  // One load, two pure folds over that one array. `reader.verify` and `verifyStoredChainSignatures`
  // each load the chain themselves, so asking both read the table twice and held two whole-chain
  // copies for one fold — and a refused anchor makes this the steady state for a scope rather than
  // the rare path, so the cost is paid every pass.
  const entries = await reader.loadChain(tenantId);
  const integrity = verifyChainIntegrity(entries);
  const signatures = await verifyChainSignatures(entries, keyRegistryResolver(registry, tenantId));
  return {
    tenantId,
    ok: integrity.valid && signatures.valid,
    mode: "full",
    fullBecause,
    checkpointSequence: null,
    integrity,
    signatures,
  };
}

/**
 * The full audit-chain verification a `verify-chain` command runs over a signer-free reader: hash-chain
 * integrity (fold from genesis) AND per-entry signatures resolved through the key registry. `ok` requires
 * both.
 */
export function verifyChainFull(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  tenantId: string | null,
): Promise<ChainVerificationReport> {
  return foldFromGenesis(reader, registry, tenantId, "requested");
}

/**
 * Bounded re-verification: verifies ONLY the suffix after the scope's latest persisted checkpoint —
 * integrity from the checkpoint's `rootHash` anchor (not genesis) plus signatures over just those
 * entries — so re-verifying a long chain costs O(entries since the last checkpoint).
 *
 * **The prefix is taken on trust only where the anchor records that something verified it**, which
 * `checkpointAnchorsBoundedProof` adjudicates over the checkpoint's `provenance`; an anchor that
 * cannot answer for its prefix folds from genesis, exactly as a scope with no checkpoint does. That
 * invariant was asserted here and established by nothing: trust was said to come from "the earlier
 * verification that produced it", while the workspace's only checkpoint writer reads the tail and
 * anchors it having verified nothing — so every bounded pass skipped a prefix on the strength of a
 * verification that had never run, and an audit row rewritten below the anchor read `verified`
 * (ADR-0371). Skipping the prefix is what made that invisible rather than merely unchecked, because
 * the signature is the only check in this stack binding an entry's stored columns to its content.
 */
export async function verifyChainFromCheckpoint(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  checkpoints: PostgresChainCheckpointStore,
  tenantId: string | null,
): Promise<ChainVerificationReport> {
  const checkpoint = await checkpoints.latest(tenantId);
  if (checkpoint === null) {
    return foldFromGenesis(reader, registry, tenantId, "no_checkpoint");
  }
  if (!checkpointAnchorsBoundedProof(checkpoint.provenance)) {
    // Both answers refuse the anchor; `provenance` itself is read because only it separates a row
    // stating that nothing verified the prefix from one written before the column existed.
    return foldFromGenesis(
      reader,
      registry,
      tenantId,
      checkpoint.provenance === undefined ? "anchor_provenance_absent" : "anchor_unverified",
    );
  }
  const fromSequence = checkpoint.sequenceNumber + 1;
  const suffix = await reader.loadFrom(tenantId, fromSequence);
  const integrity = verifyChainSuffix(suffix, { fromSequence, priorRootHash: checkpoint.rootHash });
  const signatures = await verifyChainSignatures(suffix, keyRegistryResolver(registry, tenantId));
  return {
    tenantId,
    ok: integrity.valid && signatures.valid,
    mode: "from_checkpoint",
    fullBecause: null,
    checkpointSequence: checkpoint.sequenceNumber,
    integrity,
    signatures,
  };
}

function anchorPhrase(report: ChainVerificationReport): string {
  if (report.mode === "from_checkpoint") {
    return `from checkpoint seq ${String(report.checkpointSequence)}`;
  }
  // Every report this module builds carries a reason; the type still permits `null` on a `full`
  // report, and printing the bare mode is honest where naming a reason nobody chose would not be.
  return report.fullBecause === null
    ? "full"
    : `full: ${CHAIN_FULL_REASON_PHRASES[report.fullBecause]}`;
}

export function formatChainVerification(report: ChainVerificationReport): string {
  const scope = report.tenantId ?? "platform";
  const lines: string[] = [];
  lines.push(`chain verification: ${scope} [${anchorPhrase(report)}] — ${report.ok ? "OK" : "FAILED"}`);
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
