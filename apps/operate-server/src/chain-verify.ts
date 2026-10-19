import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  checkpointAnchorsBoundedProof,
  verifyChainIntegrity,
  type ChainCheckpoint,
} from "@crossengin/forensics";
import {
  CheckpointRowUnreadable,
  unreadableEntryVerdict,
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
 * Why a report folded from genesis. `mode: "full"` alone cannot say, and the five facts it conflates
 * have different remedies: a caller that asked for a full fold has nothing to fix, a scope with no
 * checkpoint heals on the next scheduler pass, and the three ways an anchor can fail to answer for
 * its prefix are each a finding.
 *
 * **None of the three declining reasons can come from `CheckpointScheduler`**, the workspace's only
 * checkpoint writer: it derives the provenance from the verification that cleared the anchor, so it
 * writes only `verified_full`/`verified_suffix`; on a refused verification it writes no row at all;
 * and `record` begins `ChainCheckpointSchema.parse`, so no row it writes can be one this binary
 * cannot read back. That is deliberate rather than an omission — the store is append-only
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
 *
 * `anchor_unreadable` is the third and is **not** a gap: the row exists and this binary's own
 * contract refuses it, so it was written out of band or edited since — which, measured live as a
 * non-owner, a tenant-context session can do to its own checkpoint, because that table's isolation
 * policy is `ALL`-scope and its `USING` doubles as its `WITH CHECK` (ADR-0374). It is distinct from
 * `no_checkpoint` for the reason `CheckpointRowUnreadable` refuses to answer `null`: that one heals
 * on the next pass and this one cannot, since `DO NOTHING` leaves the refused row in place. Folding
 * from genesis is the right answer here for ADR-0371's own reason — an anchor that cannot be trusted
 * is not an anchor — and it is **not sufficient**, because the fold alone would make the pass read
 * as a healthy full verification. The refusal reaches the verdict by
 * `IntegrityProofReport.anchorRowsRefused`.
 */
export const CHAIN_FULL_REASONS = [
  "requested",
  "no_checkpoint",
  "anchor_unverified",
  "anchor_provenance_absent",
  "anchor_unreadable",
] as const;
export type ChainFullReason = (typeof CHAIN_FULL_REASONS)[number];

/**
 * What each reason prints. A total map so a sixth reason is a compile error here rather than one
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
  anchor_unreadable: "anchor is stored in a shape the contract refuses",
};

/**
 * Whether anchoring over this reason would destroy the evidence that produced it.
 *
 * **This exists because ADR-0374's first commit reproduced its own class inside its own fix.**
 * Before it, a refused anchor threw out of `verifyChainFromCheckpoint`, so `CheckpointScheduler`
 * filed `outcome: "error"` and wrote nothing. After it the function answers `ok: true`, the
 * scheduler's `if (!verification.ok)` falls through, and it records a **readable** checkpoint at the
 * current tail — which `latest()` then returns, because it orders by `sequence_number DESC`, so the
 * refused row sits below it and `IntegrityProofReport.anchorRowsRefused` goes back to empty. The
 * commit turned a loud scheduler error into a silent success that erases its own new finding.
 *
 * Measured live as a non-owner, additive writes only: `compromised` + `[onPass, onFinding,
 * escalate]` before one scheduler pass, and `verified` + `[onPass, escalate]` after it, with the
 * refused row still on disk. The bound is exact and is why this is not a narrow race — the finding
 * survives only while the tail is at or below the refused anchor's sequence (where `DO NOTHING`
 * fires) and is buried the moment the chain gains one entry, which on a serving deployment is every
 * audited request (ADR-0286). `node.ts` also starts the checkpoint lifecycle *before* the integrity
 * proof, both `runOnStart` and both hourly by default, so on the paired configuration the burial
 * happened milliseconds before the proof looked.
 *
 * It also refutes ADR-0374's own Option D reasoning, which argued that a refused row cannot heal
 * "because `record` is `ON CONFLICT … DO NOTHING` so the refused row stays where it is". `DO
 * NOTHING` blocks replacement **at that sequence**; the scheduler anchors at the **tail**, which is
 * a different sequence. The row stays and the finding does not.
 *
 * Only `anchor_unreadable` answers true, and the map is named for what it decides rather than for
 * ADR-0371's finding-versus-gap split, which it deliberately does not re-litigate: `requested` and
 * `no_checkpoint` have nothing to bury, and for `anchor_unverified` and `anchor_provenance_absent`
 * anchoring **is** the heal — a row stating that nothing vouched for its prefix, or one written
 * before the column existed, is superseded by a vouched anchor rather than hidden by it. A row this
 * binary cannot read is the only one whose masking costs a detector.
 */
export const CHAIN_FULL_REASON_BLOCKS_ANCHORING: Record<ChainFullReason, boolean> = {
  requested: false,
  no_checkpoint: false,
  anchor_unverified: false,
  anchor_provenance_absent: false,
  anchor_unreadable: true,
};

/**
 * The one reader of that map. `null` is a bounded pass, which carries no reason and buries nothing.
 */
export function anchoringWouldBury(fullBecause: ChainFullReason | null): boolean {
  return fullBecause === null ? false : CHAIN_FULL_REASON_BLOCKS_ANCHORING[fullBecause];
}

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
  const read = await reader.loadChain(tenantId);
  // A row the contract refuses fails **both** halves, and neither is redundant: the fold would
  // otherwise call it a `sequence gap` (true of the array it was handed, false of the table), and
  // the signature check is the only thing in this stack that binds a row's columns to its content,
  // so a refused row has failed that binding in the one way this check cannot examine. `ok` then
  // carries it to `integrityVerdictFor`, which answers `compromised` off `!chain.ok` with no change
  // of its own — which is what makes the hourly `sev1` fire where it used to log and skip.
  const integrity = unreadableEntryVerdict(read.unreadable) ?? verifyChainIntegrity(read.entries);
  const signatures = await verifyChainSignatures(
    read.entries,
    keyRegistryResolver(registry, tenantId),
    read.unreadable,
  );
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
  // The anchor read has three outcomes and this is the one that used to leave the pass with none.
  // `latest` throws `CheckpointRowUnreadable` for a stored row the contract refuses, and that throw
  // escaped `proveScopeIntegrity` — so the hourly pass filed `outcome: "error"`, which means no
  // verdict row, no `onFinding`, no `escalate` and no page, on a scope whose chain may hold the very
  // tamper the pass exists to find.
  //
  // Measured live as the non-owner `serving` role, on one scope holding **both** tampers — a blanked
  // `actor_reference` at sequence 1 and its own anchor refused — because an earlier version of this
  // comment asserted that pairing and no scope on the cluster had it. `UPDATE 1` for each. What the
  // measurement shows is sharper than the "cancelled an already-`compromised` verdict" it replaces:
  // the chain-row finding is a *field of a verdict*, so a pass that throws does not cancel it, it
  // never computes it. Post-fix the two coexist — `chainRefused=1 anchorRefused=1`, both named on
  // the unattended line — and the pass that reports them is the pass this `catch` lets happen.
  //
  // Caught here rather than inside the store, because the store's throw is correct (ADR-0373: a
  // single-row read must not serve its caller past the row it was asked about) and it is *this*
  // caller that has a sound answer to fall back on. Only this error is caught: anything else from
  // `latest` is a read that did not happen, and a fold claiming to replace it would assert a
  // verification over a scope whose anchor state is unknown.
  let checkpoint: ChainCheckpoint | null;
  try {
    checkpoint = await checkpoints.latest(tenantId);
  } catch (err) {
    if (!(err instanceof CheckpointRowUnreadable)) throw err;
    // The caught `err.row` is deliberately discarded: `ChainVerificationReport` has no refusal axis
    // to put it on, and adding one would be a **second** derivation of the same fact, because
    // `proveScopeIntegrity` catches its own `latest` and reports `anchorRowsRefused`. The cost is
    // that the two reads can disagree if the row changes between them, so `fullBecause:
    // "anchor_unreadable"` can coexist with an empty `anchorRowsRefused` — which is why the verdict
    // reads the **axis** and never this reason, and why `anchoringWouldBury` is a *scheduler* and
    // *CLI* predicate rather than a verdict one. Narrow, and in the safe direction: the surface that
    // pages reads the axis, and this reason only ever adds a sentence to a line a human reads.
    return foldFromGenesis(reader, registry, tenantId, "anchor_unreadable");
  }
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
  const integrity =
    unreadableEntryVerdict(suffix.unreadable) ??
    verifyChainSuffix(suffix.entries, { fromSequence, priorRootHash: checkpoint.rootHash });
  const signatures = await verifyChainSignatures(
    suffix.entries,
    keyRegistryResolver(registry, tenantId),
    suffix.unreadable,
  );
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
  // Named here because `results` cannot say it: a refused row never becomes an
  // `EntrySignatureResult`, so a verdict failing on this axis alone has `results.every(ok)` true
  // and would otherwise print `signatures: INVALID` followed by nothing — a verdict that reports a
  // failure and names no cause, which is the one shape an operator cannot act on.
  //
  // Parenthesised rather than colon-separated, like every other refused-row line in the stack: a
  // `detail` is itself `<path>: <code>`, so `row 2: operation: too_small` reads as three fields.
  for (const u of report.signatures.unreadable) {
    lines.push(`    unreadable row ${u.identity ?? "<unidentified>"} (${u.detail})`);
  }
  if (report.signatures.unresolvedFingerprints.length > 0) {
    lines.push(`    unresolved keys: ${report.signatures.unresolvedFingerprints.length.toString()}`);
  }
  return lines.join("\n");
}
