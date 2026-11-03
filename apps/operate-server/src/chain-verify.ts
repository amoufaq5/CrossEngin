import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  checkpointAnchorsBoundedProof,
  verifyChainIntegrity,
  type ChainCheckpoint,
  type ChainedLogEntry,
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
 * `IntegrityProofReport.anchorAudit`, which reads the whole table and so answers for a refused row
 * wherever it sits; this reason is about the **newest** row alone, because that is the one a bounded
 * fold would have taken its prefix from, and the two are deliberately not the same question
 * (ADR-0375).
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

// `CHAIN_FULL_REASON_BLOCKS_ANCHORING` and its one reader `anchoringWouldBury` stood here, and
// ADR-0375 **deletes** them rather than flipping the one member ADR-0374 said would be the one-line
// relaxation. That prediction is refused by the fence shipped beside it: `anchor_unreadable` was the
// map's only `true`, so flipping it leaves every member `false`, which `chain-verify.test.ts` calls a
// silently disarmed fence and asserts against. A judgement with no case left is not a judgement.
//
// What the map decided was that a fresh anchor at the tail would shadow a refused row, because the
// detector was `latest()` — **one** row, so the finding existed only while the refused row was the
// newest. Measured live as the non-owner `serving` role on one scope with anchors at 1, 3 and 4:
// `checkpointed_by := ''` at sequence 1 answered `verdict=verified anchorRefused=0`, and the
// identical statement at sequence 4 answered `verdict=compromised anchorRefused=1`. So the refusal
// protected exactly the one row a tamperer need not choose, and charged a permanent fold from
// genesis and an unanswerable truncation check for it.
//
// `anchor-audit.ts` reads the whole table instead, so a fresh anchor can hide nothing and the
// scheduler anchors again. ADR-0374's own reasoning anticipated this and named the level: the write
// was never wrong ("nothing about that write is wrong" — the fold earning `verified_full` covers the
// entire prefix), what was narrow was the detector, which makes it ADR-0361's class rather than a
// bad write. The ordering it shipped in was right under ADR-0340's rule — a refusal is correct
// whether or not the detector is later widened, while anchoring is correct only after it is.

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
 * A verification **and the entries it examined**, for a caller that also has to audit the anchor
 * table against the chain.
 *
 * It is a sibling return type rather than a field on `ChainVerificationReport`, and that is a
 * measurement rather than taste: `bin/operate-server.ts` prints `JSON.stringify(report, null, 2)`
 * for `--format json`, so an entries field would put the entire chain on stdout. Measured on real
 * rows through `PostgresChainLogReader`, **at the indentation the CLI actually uses**: 668 B per
 * entry at the report's top level, **692 B** one level in (where an `entries` field would sit) and
 * 716 B two in — so **66 MiB for a 100k-entry scope**, and 67 MiB with a gateway-shaped
 * `actorReference` rather than the fixture's short one. (An earlier draft of this comment said
 * ~656 B / ~63 MiB, which was the *compact* figure mislabelled: `JSON.stringify` with no indent
 * gives 578 B here, and the CLI never calls it that way. Both halves of a byte pair have to name
 * their indent or neither is checkable.) It would also travel through
 * `CheckpointSchedulerOptions.verify`'s seam type, where no caller wants it.
 *
 * `correspondenceChain` is `null` when this mode did not read the prefix, which is exactly the
 * bounded fold's one admitted-anchor path. ADR-0375's open end said *"neither fold hands its
 * entries back"*, which is true of the return **type** and false of the behaviour: `foldFromGenesis`
 * loads the whole chain at the top of this function and discarded it, and **five of the six
 * reachable paths go through it** (the full mode plus all four bounded fallbacks). So the
 * correspondence was free for every path but one, and the discriminator was already on the report —
 * `mode === "full"` iff the whole chain was read.
 */
export interface ChainVerificationWithEntries {
  readonly report: ChainVerificationReport;
  readonly correspondenceChain: readonly ChainedLogEntry[] | null;
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
): Promise<ChainVerificationWithEntries> {
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
    report: {
      tenantId,
      ok: integrity.valid && signatures.valid,
      mode: "full",
      fullBecause,
      checkpointSequence: null,
      integrity,
      signatures,
    },
    // The entries this fold examined, handed back rather than dropped — and `null` on a chain the
    // reader refused a row of, which is `proveScopeIntegrity`'s own provenance rule for the same
    // reason: the correspondence's lookup maps are built from the entries that *parsed*, so over an
    // incomplete chain an anchor pointing at the refused one reads as *the chain does not reach
    // this anchor*. That would hand it a witness it has not earned, or name it
    // `root_hash_mismatch` — a finding attributed to the wrong table.
    correspondenceChain: read.unreadable.length > 0 ? null : read.entries,
  };
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
  return (await foldFromGenesis(reader, registry, tenantId, "requested")).report;
}

/**
 * The verification a caller that must also audit the anchors runs: the same two folds, plus the
 * entries the fold examined where it read them.
 *
 * `verify-chain` is the caller, and the two findings it buys are the argument for the shape.
 * Measured through the built CLI against a real cluster as the non-owner `serving` role, on a chain
 * with every entry present, with and without this change:
 *
 *   - a **one-column lowering** (anchor 5 → 4, hash untouched) exited **0** with
 *     `witness 4 (unchecked)` and `truncation: none` — ADR-0375's *"hides a real truncation"* arm —
 *     and exits **1** now, naming `anchor at 4: sequence_relocated, whose root hash is the entry
 *     at 5`;
 *   - a **one-column raising** (5 → 99, hash untouched) printed a **false**
 *     `TRUNCATED: a checkpoint witnesses sequence 99 and the chain ends at 5` and still exits 1 —
 *     but with `sequence_relocated` and `truncation: none`, so the false truncation is
 *     **suppressed** and the real finding named in its place.
 *
 * So the correspondence is a false-positive **suppressor** as much as a detector, and the command an
 * operator runs by hand was the one without it. The suppression is **not general**, and the limit is
 * measured rather than implied: the **two-column** raising (5 → 99 *and* `root_hash := 'f'*64`)
 * still prints that false `TRUNCATED` both before and after, because nothing in the anchor table
 * contradicts it — ADR-0375's own first open end, which this change neither closes nor worsens.
 */
export async function verifyChainForAudit(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  checkpoints: PostgresChainCheckpointStore,
  tenantId: string | null,
  fromCheckpoint: boolean,
): Promise<ChainVerificationWithEntries> {
  return fromCheckpoint
    ? verifyChainFromCheckpointWithEntries(reader, registry, checkpoints, tenantId)
    : foldFromGenesis(reader, registry, tenantId, "requested");
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
  return (await verifyChainFromCheckpointWithEntries(reader, registry, checkpoints, tenantId))
    .report;
}

/** `verifyChainFromCheckpoint`'s body, keeping the entries where a fallback fold read them. */
async function verifyChainFromCheckpointWithEntries(
  reader: PostgresChainLogReader,
  registry: PostgresKeyRegistry,
  checkpoints: PostgresChainCheckpointStore,
  tenantId: string | null,
): Promise<ChainVerificationWithEntries> {
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
    // to put it on, and adding one would be a **second** derivation of the same fact, because every
    // surface that reports a refused anchor reads `auditAnchors`, which scans the whole table rather
    // than this one row. So the reason and the axis answer different questions — *can a bounded fold
    // use the newest anchor* against *does this scope hold an anchor row the contract refuses* — and
    // a report can carry `fullBecause: "anchor_unreadable"` beside an audit that found the row
    // somewhere other than the top, or (if the row is replaced between the two reads) nowhere at all.
    // Narrow, and in the safe direction: the surface that pages reads the audit, and this reason only
    // ever adds a sentence to a line a human reads.
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
    report: {
      tenantId,
      ok: integrity.valid && signatures.valid,
      mode: "from_checkpoint",
      fullBecause: null,
      checkpointSequence: checkpoint.sequenceNumber,
      integrity,
      signatures,
    },
    // The one path that genuinely has no prefix, and the only one ADR-0375's *"a bounded command
    // must not read the prefix"* covers: this fold read `loadFrom(anchor + 1)`, so an anchor below
    // the anchor it used is not in `suffix.entries` and comparing against it would report the
    // prefix as missing. `null` says the question was not asked.
    correspondenceChain: null,
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
